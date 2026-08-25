/**
 * 网际快车 (wjkc) 自动签到 - Cloudflare Workers 版
 *
 * 与 Node 版 index.js 功能保持一致：
 *   - 模拟登录提取 Token（MD5 密码）
 *   - 自动签到、多账号支持
 *   - 多渠道通知（企业微信/钉钉/飞书/云湖/Server酱/PushPlus/Telegram/Bark/Discord）
 *
 * 因 Workers 运行时无 Node 原生模块，做了如下适配：
 *   - 使用纯 JS 实现的 MD5（WebCrypto 不提供 MD5）
 *   - 使用 Web Crypto (crypto.subtle) 计算钉钉 HMAC-SHA256 签名
 *   - 邮箱 SMTP 渠道无法在 Workers 上使用（依赖原生 TCP），故移除
 *   - 子请求不再携带被禁止的请求头（Host/Connection/Sec-Fetch-*）
 *   - 配置通过 Worker 的 环境变量绑定 读取
 *
 * 环境变量（绑定设置）：
 *   admin             管理面板登录密码（用于手动触发时鉴权，未配置则面板无法登录）
 *   WJKC_CREDENTIALS  必需。账号间用「;」分隔（Cloudflare Secret 不支持换行），
 *                     每账号字段用「,」分隔：邮箱,密码,别名。示例：
 *                     a@x.com,pass1,主号;b@x.com,pass2
 *   其余通知渠道变量均为可选（同 Node 版，未配置则不启用）
 *
 * 管理面板说明：
 *   - 面板需输入 admin 密码登录，登录采用 SHA-256 摘要鉴权，不在网络中传输明文密码
 *   - 出于隐私保护，面板仅展示脱敏后的账号，绝不回传账号明文或签到密码
 */

export default {
  /**
   * 定时任务入口（与 cron 触发器绑定的 Scheduled Handler）
   */
  async scheduled(controller, env, ctx) {
    console.log('--- 网际快车自动签到任务开始 ---');
    const config = initializeConfig(env);
    try {
      const report = await runCheckins(config);
      console.log('--- 任务执行完毕 ---');
      console.log('签到结果:', report.body);
      // 用 waitUntil 保活，确保所有已启用渠道的通知子请求都执行完成，
      // 否则 cron 处理函数返回后进程可能被回收，导致推送部分丢失
      ctx.waitUntil(notify(report.title, report.body, config, ctx));
    } catch (error) {
      console.error('--- 任务执行异常 ---:', error.message);
      ctx.waitUntil(notify('网际快车签到异常', `❌ 流程异常: ${error.message}`, config, ctx));
    }
  },

  /**
   * HTTP 入口：提供前端管理面板与手动触发 API
   */
  async fetch(request, env, ctx) {
    const config = initializeConfig(env);
    const url = new URL(request.url);

    // 管理面板页面
    if (url.pathname === '/') {
      if (request.method === 'GET') {
        return new Response(HTML_TEMPLATE, {
          headers: { 'Content-Type': 'text/html;charset=UTF-8' },
        });
      }
      return new Response('Method Not Allowed', { status: 405 });
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, url.pathname, config);
    }

    return new Response('Not Found', { status: 404 });
  },
};

/* ------------------------------------------------------------------ */
/*  配置                                                               */
/* ------------------------------------------------------------------ */

function initializeConfig(env) {
  return {
    admin: env.admin || env.ADMIN || '',
    credentials: env.WJKC_CREDENTIALS || '',
    wecomBotKey: env.WECOM_BOT_KEY || '',
    dingtalkBotKey: env.DINGTALK_BOT_KEY || '',
    dingtalkSecret: env.DINGTALK_SECRET || '',
    feishuBotKey: env.FEISHU_BOT_KEY || '',
    yunhuBotKey: env.YUNHU_BOT_KEY || '',
    serverchanSendkey: env.SERVERCHAN_SENDKEY || '',
    pushplusToken: env.PUSHPLUS_TOKEN || '',
    pushplusTopic: env.PUSHPLUS_TOPIC || '',
    tgBotToken: env.TG_BOT_TOKEN || '',
    tgChatId: env.TG_CHAT_ID || '',
    barkKey: env.BARK_KEY || '',
    barkGroup: env.BARK_GROUP || '',
    discordWebhook: env.DISCORD_WEBHOOK || '',
  };
}

/* ------------------------------------------------------------------ */
/*  常量                                                               */
/* ------------------------------------------------------------------ */

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36 EdgA/143.0.0.0';
const HOST = 'wjkc.click';
const ORIGIN = `https://${HOST}`;

/* ------------------------------------------------------------------ */
/*  工具函数                                                           */
/* ------------------------------------------------------------------ */

// 从响应头中提取 Set-Cookie 字符串（兼容 HttpOnly 多 Set-Cookie 的情况）
function getSetCookieHeader(res) {
  if (typeof res.headers.getSetCookie === 'function') {
    return res.headers.getSetCookie().join('; ');
  }
  return res.headers.get('set-cookie') || '';
}

// UTF-8 编码为单字节字符串（供 MD5 / base64 使用）
function utf8ToLatin1(str) {
  const bytes = new TextEncoder().encode(str);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

const base64Encode = (str) => btoa(utf8ToLatin1(str));
const base64Decode = (str) => atob(str);

/* 纯 JS MD5 实现（输出小写 hex），兼容 Node crypto.createHash('md5') */
function md5(input) {
  const RotateLeft = (lValue, iShiftBits) => (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits));
  const AddUnsigned = (lX, lY) => {
    let lX8 = lX & 0x80000000, lY8 = lY & 0x80000000;
    let lX4 = lX & 0x40000000, lY4 = lY & 0x40000000;
    const lResult = (lX & 0x3FFFFFFF) + (lY & 0x3FFFFFFF);
    if (lX4 & lY4) return (lResult ^ 0x80000000 ^ lX8 ^ lY8);
    if (lX4 | lY4) {
      if (lResult & 0x40000000) return (lResult ^ 0xC0000000 ^ lX8 ^ lY8);
      else return (lResult ^ 0x40000000 ^ lX8 ^ lY8);
    }
    return (lResult ^ lX8 ^ lY8);
  };
  const F = (x, y, z) => (x & y) | (~x & z);
  const G = (x, y, z) => (x & z) | (y & ~z);
  const H = (x, y, z) => x ^ y ^ z;
  const I = (x, y, z) => y ^ (x | ~z);
  const FF = (a, b, c, d, x, s, ac) => AddUnsigned(RotateLeft(AddUnsigned(AddUnsigned(AddUnsigned(a, F(b, c, d)), x), ac), s), b);
  const GG = (a, b, c, d, x, s, ac) => AddUnsigned(RotateLeft(AddUnsigned(AddUnsigned(AddUnsigned(a, G(b, c, d)), x), ac), s), b);
  const HH = (a, b, c, d, x, s, ac) => AddUnsigned(RotateLeft(AddUnsigned(AddUnsigned(AddUnsigned(a, H(b, c, d)), x), ac), s), b);
  const II = (a, b, c, d, x, s, ac) => AddUnsigned(RotateLeft(AddUnsigned(AddUnsigned(AddUnsigned(a, I(b, c, d)), x), ac), s), b);

  const ConvertToWordArray = (str) => {
    let lWordCount;
    const lMessageLength = str.length;
    const lNumberOfWords_temp1 = lMessageLength + 8;
    const lNumberOfWords_temp2 = (lNumberOfWords_temp1 - (lNumberOfWords_temp1 % 64)) / 64;
    const lNumberOfWords = (lNumberOfWords_temp2 + 1) * 16;
    const lWordArray = Array(lNumberOfWords - 1);
    let lBytePosition = 0, lByteCount = 0;
    while (lByteCount < lMessageLength) {
      lWordCount = (lByteCount - (lByteCount % 4)) / 4;
      lBytePosition = (lByteCount % 4) * 8;
      lWordArray[lWordCount] = (lWordArray[lWordCount] | (str.charCodeAt(lByteCount) << lBytePosition)) >>> 0;
      lByteCount++;
    }
    lWordCount = (lByteCount - (lByteCount % 4)) / 4;
    lBytePosition = (lByteCount % 4) * 8;
    lWordArray[lWordCount] = (lWordArray[lWordCount] | (0x80 << lBytePosition)) >>> 0;
    lWordArray[lNumberOfWords - 2] = (lMessageLength << 3) >>> 0;
    lWordArray[lNumberOfWords - 1] = (lMessageLength >>> 29);
    return lWordArray;
  };

  const WordToHex = (lValue) => {
    let value = '';
    for (let count = 0; count <= 3; count++) {
      const lByte = (lValue >>> (count * 8)) & 255;
      value += ('0' + lByte.toString(16)).slice(-2);
    }
    return value;
  };

  const str = utf8ToLatin1(input);
  const S11 = 7, S12 = 12, S13 = 17, S14 = 22;
  const S21 = 5, S22 = 9, S23 = 14, S24 = 20;
  const S31 = 4, S32 = 11, S33 = 16, S34 = 23;
  const S41 = 6, S42 = 10, S43 = 15, S44 = 21;

  const x = ConvertToWordArray(str);
  let a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;

  for (let k = 0; k < x.length; k += 16) {
    const AA = a, BB = b, CC = c, DD = d;
    a = FF(a, b, c, d, x[k + 0], S11, 0xD76AA478);
    d = FF(d, a, b, c, x[k + 1], S12, 0xE8C7B756);
    c = FF(c, d, a, b, x[k + 2], S13, 0x242070DB);
    b = FF(b, c, d, a, x[k + 3], S14, 0xC1BDCEEE);
    a = FF(a, b, c, d, x[k + 4], S11, 0xF57C0FAF);
    d = FF(d, a, b, c, x[k + 5], S12, 0x4787C62A);
    c = FF(c, d, a, b, x[k + 6], S13, 0xA8304613);
    b = FF(b, c, d, a, x[k + 7], S14, 0xFD469501);
    a = FF(a, b, c, d, x[k + 8], S11, 0x698098D8);
    d = FF(d, a, b, c, x[k + 9], S12, 0x8B44F7AF);
    c = FF(c, d, a, b, x[k + 10], S13, 0xFFFF5BB1);
    b = FF(b, c, d, a, x[k + 11], S14, 0x895CD7BE);
    a = FF(a, b, c, d, x[k + 12], S11, 0x6B901122);
    d = FF(d, a, b, c, x[k + 13], S12, 0xFD987193);
    c = FF(c, d, a, b, x[k + 14], S13, 0xA679438E);
    b = FF(b, c, d, a, x[k + 15], S14, 0x49B40821);

    a = GG(a, b, c, d, x[k + 1], S21, 0xF61E2562);
    d = GG(d, a, b, c, x[k + 6], S22, 0xC040B340);
    c = GG(c, d, a, b, x[k + 11], S23, 0x265E5A51);
    b = GG(b, c, d, a, x[k + 0], S24, 0xE9B6C7AA);
    a = GG(a, b, c, d, x[k + 5], S21, 0xD62F105D);
    d = GG(d, a, b, c, x[k + 10], S22, 0x02441453);
    c = GG(c, d, a, b, x[k + 15], S23, 0xD8A1E681);
    b = GG(b, c, d, a, x[k + 4], S24, 0xE7D3FBC8);
    a = GG(a, b, c, d, x[k + 9], S21, 0x21E1CDE6);
    d = GG(d, a, b, c, x[k + 14], S22, 0xC33707D6);
    c = GG(c, d, a, b, x[k + 3], S23, 0xF4D50D87);
    b = GG(b, c, d, a, x[k + 8], S24, 0x455A14ED);
    a = GG(a, b, c, d, x[k + 13], S21, 0xA9E3E905);
    d = GG(d, a, b, c, x[k + 2], S22, 0xFCEFA3F8);
    c = GG(c, d, a, b, x[k + 7], S23, 0x676F02D9);
    b = GG(b, c, d, a, x[k + 12], S24, 0x8D2A4C8A);

    a = HH(a, b, c, d, x[k + 5], S31, 0xFFFA3942);
    d = HH(d, a, b, c, x[k + 8], S32, 0x8771F681);
    c = HH(c, d, a, b, x[k + 11], S33, 0x6D9D6122);
    b = HH(b, c, d, a, x[k + 14], S34, 0xFDE5380C);
    a = HH(a, b, c, d, x[k + 1], S31, 0xA4BEEA44);
    d = HH(d, a, b, c, x[k + 4], S32, 0x4BDECFA9);
    c = HH(c, d, a, b, x[k + 7], S33, 0xF6BB4B60);
    b = HH(b, c, d, a, x[k + 10], S34, 0xBEBFBC70);
    a = HH(a, b, c, d, x[k + 13], S31, 0x289B7EC6);
    d = HH(d, a, b, c, x[k + 0], S32, 0xEAA127FA);
    c = HH(c, d, a, b, x[k + 3], S33, 0xD4EF3085);
    b = HH(b, c, d, a, x[k + 6], S34, 0x04881D05);
    a = HH(a, b, c, d, x[k + 9], S31, 0xD9D4D039);
    d = HH(d, a, b, c, x[k + 12], S32, 0xE6DB99E5);
    c = HH(c, d, a, b, x[k + 15], S33, 0x1FA27CF8);
    b = HH(b, c, d, a, x[k + 2], S34, 0xC4AC5665);

    a = II(a, b, c, d, x[k + 0], S41, 0xF4292244);
    d = II(d, a, b, c, x[k + 7], S42, 0x432AFF97);
    c = II(c, d, a, b, x[k + 14], S43, 0xAB9423A7);
    b = II(b, c, d, a, x[k + 5], S44, 0xFC93A039);
    a = II(a, b, c, d, x[k + 12], S41, 0x655B59C3);
    d = II(d, a, b, c, x[k + 3], S42, 0x8F0CCC92);
    c = II(c, d, a, b, x[k + 10], S43, 0xFFEFF47D);
    b = II(b, c, d, a, x[k + 1], S44, 0x85845DD1);
    a = II(a, b, c, d, x[k + 8], S41, 0x6FA87E4F);
    d = II(d, a, b, c, x[k + 15], S42, 0xFE2CE6E0);
    c = II(c, d, a, b, x[k + 6], S43, 0xA3014314);
    b = II(b, c, d, a, x[k + 13], S44, 0x4E0811A1);
    a = II(a, b, c, d, x[k + 4], S41, 0xF7537E82);
    d = II(d, a, b, c, x[k + 11], S42, 0xBD3AF235);
    c = II(c, d, a, b, x[k + 2], S43, 0x2AD7D2BB);
    b = II(b, c, d, a, x[k + 9], S44, 0xEB86D391);

    a = AddUnsigned(a, AA);
    b = AddUnsigned(b, BB);
    c = AddUnsigned(c, CC);
    d = AddUnsigned(d, DD);
  }

  return (WordToHex(a) + WordToHex(b) + WordToHex(c) + WordToHex(d)).toLowerCase();
}

/* ------------------------------------------------------------------ */
/*  API 路由与面板鉴权                                                 */
/* ------------------------------------------------------------------ */

// 对给定明文计算 SHA-256 hex（用于 admin 鉴权）
async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 鉴权：请求头传 Bearer <hash>，其中 hash = sha256(hostname + admin密码 + ua)
async function verifyAuth(request, config) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  if (!config.admin) return false;

  const clientHash = authHeader.split(' ')[1];
  // 与前端 window.location.hostname 保持一致，避免端口差异
  const hostname = new URL(request.url).hostname;
  const rawString = hostname + config.admin + (request.headers.get('User-Agent') || '');
  const serverHash = await sha256Hex(rawString);
  return clientHash === serverHash;
}

// 账号脱敏：邮箱形如 u***@domain.com，其余形如 p*****rd
function mask(str, isEmail = false) {
  if (!str) return '';
  if (isEmail && str.includes('@')) {
    const [local, domainPart] = str.split('@');
    const maskPart = (s) => (s.length <= 2 ? '*'.repeat(s.length) : s[0] + '*'.repeat(s.length - 2) + s[s.length - 1]);
    return maskPart(local) + '@' + domainPart;
  }
  if (str.length <= 2) return '*'.repeat(str.length);
  return str[0] + '*'.repeat(str.length - 2) + str[str.length - 1];
}

// 解析凭证，返回脱敏后的账号列表（用于面板展示，不回传明文/密码）
function maskedAccounts(config) {
  const lines = parseCredentials(config.credentials);
  return lines.map((line) => {
    const [email, , alias] = line.split(',').map((s) => s.trim());
    return alias || mask(email, true) || email;
  });
}

// 解析账号凭证：账号间用「;」分隔（Cloudflare Secret 变量不支持换行），
// 同时兼容换行分隔；每个账号字段用「,」分隔：邮箱,密码,别名
function parseCredentials(raw) {
  return (raw || '').split(/[\n\r;]+/).map((s) => s.trim()).filter(Boolean);
}

// 已启用的通知渠道名称列表
function getEnabledChannels(config) {
  const map = [
    ['企业微信', config.wecomBotKey],
    ['钉钉', config.dingtalkBotKey],
    ['飞书', config.feishuBotKey],
    ['云湖', config.yunhuBotKey],
    ['Server酱', config.serverchanSendkey],
    ['PushPlus', config.pushplusToken],
    ['Telegram', config.tgBotToken && config.tgChatId],
    ['Bark', config.barkKey],
    ['Discord', config.discordWebhook],
  ];
  return map.filter(([, v]) => v).map(([name]) => name);
}

async function handleApiRequest(request, pathname, config) {
  const isAuthEndpoint = pathname === '/api/login';

  // 除登录外，其余接口均需鉴权
  if (!isAuthEndpoint && !(await verifyAuth(request, config))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    switch (pathname) {
      case '/api/login':
        if (await verifyAuth(request, config)) {
          return Response.json({ success: true });
        }
        return new Response(JSON.stringify({ error: '密码错误' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

      case '/api/info':
        return Response.json({
          accounts: maskedAccounts(config),
          accountCount: parseCredentials(config.credentials).length,
          notifyEnabled: getEnabledChannels(config).length > 0,
          notifyChannels: getEnabledChannels(config),
        });

      case '/api/checkin':
        if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
        {
          const report = await runCheckins(config);
          const notifyResult = await notify(report.title, report.body, config);
          return Response.json({
            success: report.success,
            title: report.title,
            body: report.body,
            logs: report.logs,
            notify: notifyResult,
          });
        }

      case '/api/test_notify':
        if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
        return Response.json(await notify('🔔 这是来自自动签到管理面板的测试消息', '如果您能看到这条消息，说明推送配置正确！', config));

      default:
        return new Response(JSON.stringify({ error: 'API NotFound' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

/* ------------------------------------------------------------------ */
/*  核心签到逻辑（与 Node 版 index.js 一致）                            */
/* ------------------------------------------------------------------ */

// 步骤 1: 模拟登录并获取 Token
async function getTokenByLogin(email, password) {
  const hashedPassword = md5(password);
  const loginPayload = { email, password: hashedPassword };

  const requestBody = JSON.stringify({ data: base64Encode(JSON.stringify(loginPayload)) });

  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'User-Agent': UA,
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };

  const response = await fetch(`${ORIGIN}/api/user/login`, {
    method: 'POST',
    headers,
    body: requestBody,
  });

  const resultText = await response.text();
  let result;
  try {
    result = JSON.parse(resultText);
  } catch (e) {
    throw new Error(`登录接口返回非JSON数据（可能域名已变更或被拦截）: ${resultText.substring(0, 50)}`);
  }

  // 从响应头获取 Token
  const setCookieHeader = getSetCookieHeader(response);
  const tokenMatch = setCookieHeader ? setCookieHeader.match(/token=([^;]+)/) : null;

  if (tokenMatch && tokenMatch[1]) {
    return tokenMatch[1];
  } else if (result.data) {
    try {
      const decodedData = JSON.parse(base64Decode(result.data));
      throw new Error(`登录失败: ${decodedData.msg || '密码错误'}`);
    } catch (inner) {
      if (inner.message.startsWith('登录失败')) throw inner;
      throw new Error('无法解析登录返回的 Data 字段');
    }
  } else {
    throw new Error('未能在响应头中找到 Token');
  }
}

// 步骤 2: 核心签到函数
async function runCheckinForAccount(token) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'User-Agent': UA,
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Cookie: `token=${token}; platform=Android;`, // 必须包含 token
  };

  // 签到负载固定为 {"data":"e30="} 对应内容为 {}
  const payload = JSON.stringify({ data: 'e30=' });

  const response = await fetch(`${ORIGIN}/api/user/sign_use`, {
    method: 'POST',
    headers,
    body: payload,
  });

  const resultText = await response.text();
  let result;
  try {
    result = JSON.parse(resultText);
  } catch (e) {
    throw new Error(`签到接口返回异常: ${resultText.substring(0, 50)}`);
  }

  if (result && result.data) {
    const checkinResult = JSON.parse(base64Decode(result.data));

    if (checkinResult.code === 0 && checkinResult.msg === 'SUCCESS') {
      const addedTraffic = checkinResult.data.addTraffic || 0;
      const trafficInMB = (addedTraffic / 1024 / 1024).toFixed(0);
      return `✅ 签到成功: 获得 ${trafficInMB} MB 流量\n📅 连续签到: ${checkinResult.data.haveContinueSignUseData} 天`;
    } else {
      const message = checkinResult.msg || '';
      if (message.includes('SIGN_USE_MULTY_TIMES')) {
        return `✅ 今日已签到 (重复操作)`;
      }
      return `💡 结果: ${message}`;
    }
  }
  throw new Error('无法解析签到返回的 Data 字段');
}

// 遍历所有账号执行登录 + 签到
async function runCheckins(config) {
  const capturedLogs = [];
  const log = (msg) => {
    console.log(msg);
    capturedLogs.push(msg);
  };

  log(`--- 任务开始 ${new Date().toLocaleString()} ---`);
  if (!config.credentials) {
    const msg = '❌ 未配置环境变量 WJKC_CREDENTIALS';
    log(msg);
    return { success: false, title: '网际快车签到异常', body: msg, logs: capturedLogs };
  }

  const accounts = parseCredentials(config.credentials);
  const results = [];
  let successCount = 0;

  for (let i = 0; i < accounts.length; i++) {
    const [email, password, alias] = accounts[i].split(',').map((s) => s.trim());
    const accountName = alias || mask(email, true);

    log(`[${i + 1}/${accounts.length}] 正在处理: ${accountName}`);

    try {
      const token = await getTokenByLogin(email, password);
      const message = await runCheckinForAccount(token);
      const firstLine = message.split('\n')[0];
      log(`  ✓ 登录成功，${firstLine}`);
      results.push(`### ${accountName}\n${message}`);
      successCount++;
    } catch (error) {
      log(`  ✗ 失败: ${error.message}`);
      results.push(`### ${accountName}\n❌ 流程异常: ${error.message}`);
    }

    // 随机延迟防屏蔽
    if (i < accounts.length - 1) await new Promise((r) => setTimeout(r, 3000));
  }

  const allSuccess = successCount === accounts.length;
  const title = `网际快车签到${allSuccess ? '成功' : '异常'} ${new Date().toLocaleDateString()}`;
  let body = `📊 账号数: ${accounts.length}\n`;
  body += `✅ 成功: ${successCount}  ❌ 失败: ${accounts.length - successCount}\n`;
  body += `\n` + results.join('\n\n---\n\n');
  log('--- 任务执行完毕 ---');

  return { success: allSuccess, title, body, logs: capturedLogs };
}

/* ------------------------------------------------------------------ */
/*  多渠道通知（适配 Workers 运行时，不含邮箱 SMTP）                    */
/* ------------------------------------------------------------------ */

async function notify(title, content, config, ctx) {
  const channels = [];

  if (config.wecomBotKey) channels.push({ name: '企业微信', fn: () => sendWeCom(title, content, config.wecomBotKey) });
  if (config.dingtalkBotKey) channels.push({ name: '钉钉', fn: () => sendDingTalk(title, content, config.dingtalkBotKey, config.dingtalkSecret) });
  if (config.feishuBotKey) channels.push({ name: '飞书', fn: () => sendFeishu(title, content, config.feishuBotKey) });
  if (config.yunhuBotKey) channels.push({ name: '云湖', fn: () => sendYunhu(title, content, config.yunhuBotKey) });
  if (config.serverchanSendkey) channels.push({ name: 'Server酱', fn: () => sendServerChan(title, content, config.serverchanSendkey) });
  if (config.pushplusToken) channels.push({ name: 'PushPlus', fn: () => sendPushPlus(title, content, config.pushplusToken, config.pushplusTopic) });
  if (config.tgBotToken && config.tgChatId) channels.push({ name: 'Telegram', fn: () => sendTelegram(title, content, config.tgBotToken, config.tgChatId) });
  if (config.barkKey) channels.push({ name: 'Bark', fn: () => sendBark(title, content, config.barkKey, config.barkGroup) });
  if (config.discordWebhook) channels.push({ name: 'Discord', fn: () => sendDiscord(title, content, config.discordWebhook) });

  if (channels.length === 0) {
    return { success: false, message: '未配置任何通知渠道' };
  }

  const results = await Promise.allSettled(channels.map(async (ch) => ({ name: ch.name, ok: await ch.fn() })));

  let success = 0;
  const detail = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.ok) {
      success++;
      detail.push(`${r.value.name}✓`);
    } else {
      detail.push(`${r.status === 'fulfilled' ? r.value.name : '未知'}✗`);
    }
  }
  const message = `推送完成: ${success}/${channels.length} 成功 (${detail.join(', ')})`;
  console.log(message);

  // 定时任务里用 waitUntil 兜底，确保通知请求完成
  if (results.some((r) => r.status === 'rejected') && ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(Promise.resolve());
  }

  return { success: success > 0, message };
}

// 1. 企业微信机器人
async function sendWeCom(title, content, key) {
  const resp = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content: `${title}\n\n${content}` } }),
  });
  return resp.ok;
}

// 2. 钉钉机器人（支持加签，使用 Web Crypto 计算 HMAC-SHA256）
async function sendDingTalk(title, content, key, secret) {
  let url = `https://oapi.dingtalk.com/robot/send?access_token=${key}`;
  if (secret) {
    const timestamp = Date.now();
    const stringToSign = `${timestamp}\n${secret}`;
    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(stringToSign));
    const sign = btoa(String.fromCharCode(...new Uint8Array(signature)));
    url += `&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
  }
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { title, text: `### ${title}\n\n${content}` } }),
  });
  return resp.ok;
}

// 3. 飞书机器人
async function sendFeishu(title, content, key) {
  const resp = await fetch(`https://open.feishu.cn/open-apis/bot/v2/hook/${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'text', content: { text: `${title}\n\n${content}` } }),
  });
  return resp.ok;
}

// 4. 云湖机器人
async function sendYunhu(title, content, key) {
  const resp = await fetch(`https://www.yhchat.com/bot/send?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg: { text: `${title}\n\n${content}` } }),
  });
  return resp.ok;
}

// 5. Server酱
async function sendServerChan(title, content, sendkey) {
  const resp = await fetch(`https://sctapi.ftqq.com/${sendkey}.send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ title, desp: content }),
  });
  return resp.ok;
}

// 6. PushPlus
async function sendPushPlus(title, content, token, topic) {
  const body = { token, title, content, template: 'txt' };
  if (topic) body.topic = topic;
  const resp = await fetch('https://www.pushplus.plus/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.ok;
}

// 7. Telegram Bot
async function sendTelegram(title, content, botToken, chatId) {
  const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: `*${title}*\n\n${content}`, parse_mode: 'Markdown' }),
  });
  return resp.ok;
}

// 8. Bark (iOS 推送)
async function sendBark(title, content, key, group) {
  const base = key.startsWith('http') ? key : `https://api.day.app/${key}`;
  const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(content)}`;
  const params = new URLSearchParams();
  if (group) params.set('group', group);
  const finalUrl = params.toString() ? `${url}?${params}` : url;
  const resp = await fetch(finalUrl);
  return resp.ok;
}

// 9. Discord Webhook
async function sendDiscord(title, content, webhookUrl) {
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `**${title}**\n\n${content}`.slice(0, 2000) }),
  });
  return resp.ok;
}

/* ------------------------------------------------------------------ */
/*  管理面板                                                            */
/* ------------------------------------------------------------------ */

const HTML_TEMPLATE = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>网际快车自动签到面板</title>
  <style>
    :root {
      --bg-color: #0f172a;
      --panel-bg: rgba(30, 41, 59, 0.7);
      --border-color: rgba(255, 255, 255, 0.1);
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --success: #10b981;
      --danger: #ef4444;
      --radius: 12px;
      --font: 'Inter', system-ui, -apple-system, sans-serif;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--font);
      background-color: var(--bg-color);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      overflow-x: hidden;
      background-image:
        radial-gradient(circle at 15% 50%, rgba(59, 130, 246, 0.15) 0%, transparent 50%),
        radial-gradient(circle at 85% 30%, rgba(16, 185, 129, 0.15) 0%, transparent 50%);
    }

    .glass {
      background: var(--panel-bg);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--border-color);
      border-radius: var(--radius);
    }

    h1, h2, h3 { font-weight: 600; letter-spacing: -0.025em; }
    .hidden { display: none !important; }

    input {
      width: 100%;
      padding: 12px 16px;
      margin-bottom: 16px;
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid var(--border-color);
      color: var(--text-main);
      border-radius: 8px;
      font-size: 1rem;
      transition: all 0.2s;
    }
    input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(59,130,246,0.2); }

    button {
      background: var(--accent);
      color: white;
      border: none;
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      width: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 8px;
    }
    button:hover { background: var(--accent-hover); transform: translateY(-1px); }
    button:active { transform: translateY(0); }
    button:disabled { opacity: 0.7; cursor: not-allowed; }
    button.secondary { background: rgba(255,255,255,0.1); }
    button.secondary:hover { background: rgba(255,255,255,0.15); }

    /* Login View */
    #login-view {
      display: flex; justify-content: center; align-items: center; flex: 1; padding: 20px;
    }
    .login-box {
      width: 100%; max-width: 400px; padding: 40px 40px 24px; text-align: center; animation: fadeIn 0.5s ease-out;
    }
    .login-box h1 { margin-bottom: 8px; font-size: 1.5rem; }
    .login-box p { color: var(--text-muted); margin-bottom: 24px; font-size: 0.9rem; }
    .error-msg { color: var(--danger); font-size: 0.875rem; margin-top: 8px; min-height: 18px; }

    /* Dashboard View */
    #dashboard-view {
      padding: 30px; max-width: 1400px; margin: 0 auto; width: 100%;
      display: grid; grid-template-columns: 360px 1fr; gap: 24px; flex: 1; animation: slideUp 0.4s ease-out;
    }
    @media (max-width: 900px) { #dashboard-view { grid-template-columns: 1fr; } }

    .sidebar { display: flex; flex-direction: column; gap: 20px; }

    .info-card { padding: 24px; }
    .info-card h2 { font-size: 1.25rem; margin-bottom: 20px; display: flex; align-items: center; gap: 8px; }
    .info-group { margin-bottom: 16px; }
    .info-label { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
    .account-row {
      font-size: 0.9rem; background: rgba(0,0,0,0.2); padding: 8px 12px; border-radius: 6px;
      margin-bottom: 6px; word-break: break-all; font-family: monospace;
    }
    .status-badge {
      display: inline-block; padding: 4px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: 600;
      background: rgba(16, 185, 129, 0.2); color: var(--success);
    }
    .status-badge.disabled { background: rgba(239, 68, 68, 0.2); color: var(--danger); }
    .actions-card { padding: 24px; display: flex; flex-direction: column; gap: 12px; }

    /* Console */
    .console-wrapper { display: flex; flex-direction: column; height: 100%; min-height: 500px; }
    .console-header { padding: 16px 24px; border-bottom: 1px solid var(--border-color);
      display: flex; justify-content: space-between; align-items: center; }
    .console-header h2 { font-size: 1.1rem; }
    .clear-btn { background: transparent; padding: 4px 8px; width: auto; font-size: 0.8rem; color: var(--text-muted); border: 1px solid var(--border-color); }
    .clear-btn:hover { background: rgba(255,255,255,0.1); color: var(--text-main); }
    .console-body {
      flex: 1; padding: 20px; overflow-y: auto; font-family: monospace; font-size: 0.9rem;
      line-height: 1.6; background: rgba(0,0,0,0.3); border-radius: 0 0 var(--radius) var(--radius);
    }
    .log-entry { margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 8px;
      word-wrap: break-word; white-space: pre-wrap; }
    .log-time { color: var(--text-muted); font-size: 0.8em; margin-right: 12px; }
    .log-sys { color: #60a5fa; }
    .log-ok { color: #34d399; }
    .log-err { color: #f87171; }
    .log-warn { color: #fbbf24; }

    /* Header */
    .top-header { padding: 20px 30px; display: flex; justify-content: space-between; align-items: center;
      border-bottom: 1px solid rgba(255,255,255,0.05); }
    .logo { font-size: 1.2rem; font-weight: bold; background: linear-gradient(to right, #60a5fa, #34d399);
      -webkit-background-clip: text; color: transparent; }
    .logout-btn { background: transparent; color: var(--text-muted); width: auto; padding: 6px 12px; font-size: 0.9rem; }
    .logout-btn:hover { background: rgba(255,255,255,0.1); color: white; }

    .spinner { width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.3); border-radius: 50%;
      border-top-color: white; animation: spin 0.8s linear infinite; display: none; }
    .loading .spinner { display: inline-block; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
  </style>
</head>
<body>

  <div id="login-view">
    <div class="glass login-box">
      <h1>身份验证</h1>
      <p>请输入管理密码 (admin) 以访问面板</p>
      <form id="login-form">
        <input type="password" id="pwd-input" placeholder="输入管理密码" required autofocus autocomplete="current-password">
        <button type="submit" id="login-btn"><span>登录</span><div class="spinner"></div></button>
        <div id="login-error" class="error-msg"></div>
      </form>
    </div>
  </div>

  <div id="app-view" class="hidden">
    <header class="top-header">
      <div class="logo">网际快车自动签到面板</div>
      <button class="logout-btn" id="logout-btn">退出登录</button>
    </header>

    <div id="dashboard-view">
      <div class="sidebar">
        <div class="glass info-card">
          <h2>配置信息</h2>
          <div class="info-group">
            <div class="info-label">签到账号（已脱敏）</div>
            <div id="info-accounts"><div class="account-row">加载中...</div></div>
          </div>
          <div class="info-group" style="margin-top:20px;">
            <div class="info-label">推送状态</div>
            <div id="info-notify"><span class="status-badge" style="background:rgba(255,255,255,0.1);color:white;">检测中...</span></div>
          </div>
          <div class="info-group" style="margin-top:8px;">
            <div class="info-label">隐私说明</div>
            <div style="font-size:0.78rem;color:var(--text-muted);line-height:1.5;">出于安全考虑，面板不显示账号明文与签到密码，仅展示已脱敏信息。</div>
          </div>
        </div>

        <div class="glass actions-card">
          <button id="btn-checkin"><span>手动执行签到</span><div class="spinner"></div></button>
          <button id="btn-notify" class="secondary"><span>测试推送</span><div class="spinner"></div></button>
        </div>
      </div>

      <div class="glass console-wrapper">
        <div class="console-header">
          <h2>运行日志</h2>
          <button class="clear-btn" id="btn-clear-log">清空</button>
        </div>
        <div class="console-body" id="console-output">
          <div class="log-entry"><span class="log-time">[系统]</span><span class="log-sys">控制台初始化完成...等待操作。</span></div>
        </div>
      </div>
    </div>
  </div>

  <script>
    async function generateAuthHash(password) {
      const hostname = window.location.hostname;
      const ua = navigator.userAgent;
      const enc = new TextEncoder();
      const buf = await crypto.subtle.digest('SHA-256', enc.encode(hostname + password + ua));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    const loginView = document.getElementById('login-view');
    const appView = document.getElementById('app-view');
    const loginForm = document.getElementById('login-form');
    const pwdInput = document.getElementById('pwd-input');
    const loginBtn = document.getElementById('login-btn');
    const loginError = document.getElementById('login-error');
    const consoleOutput = document.getElementById('console-output');

    const AUTH_KEY = 'wjkc_auth_token';
    let currentToken = localStorage.getItem(AUTH_KEY);

    function appendLog(message, type = 'sys') {
      const entry = document.createElement('div');
      entry.className = 'log-entry';
      const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      const timeSpan = document.createElement('span');
      timeSpan.className = 'log-time';
      timeSpan.textContent = '[' + time + ']';
      const msgSpan = document.createElement('span');
      msgSpan.className = 'log-' + type;
      msgSpan.textContent = String(message);
      entry.appendChild(timeSpan);
      entry.appendChild(msgSpan);
      consoleOutput.appendChild(entry);
      consoleOutput.scrollTop = consoleOutput.scrollHeight;
    }

    async function apiCall(endpoint, options = {}) {
      if (!currentToken) throw new Error('未授权访问');
      const headers = { 'Authorization': 'Bearer ' + currentToken, ...(options.headers || {}) };
      const res = await fetch('/api' + endpoint, { ...options, headers });
      if (res.status === 401) { logout(); throw new Error('会话已过期或验证失败，请重新登录'); }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
      return data;
    }

    async function init() {
      if (currentToken) {
        try { await loadDashboardInfo(); showDashboard(); appendLog('已通过保存的凭证恢复会话', 'ok'); }
        catch (e) { localStorage.removeItem(AUTH_KEY); currentToken = null; }
      }
    }

    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      loginError.textContent = '';
      loginBtn.classList.add('loading');
      loginBtn.disabled = true;
      try {
        const hash = await generateAuthHash(pwdInput.value);
        const res = await fetch('/api/login', { method: 'POST', headers: { 'Authorization': 'Bearer ' + hash } });
        if (res.ok) {
          currentToken = hash;
          localStorage.setItem(AUTH_KEY, hash);
          pwdInput.value = '';
          await loadDashboardInfo();
          showDashboard();
          appendLog('您已成功登录管理面板', 'ok');
        } else {
          loginError.textContent = '密码错误或验证失败';
        }
      } catch (err) {
        loginError.textContent = '请求失败: ' + err.message;
      } finally {
        loginBtn.classList.remove('loading');
        loginBtn.disabled = false;
      }
    });

    function showDashboard() { loginView.classList.add('hidden'); appView.classList.remove('hidden'); }
    function logout() {
      localStorage.removeItem(AUTH_KEY);
      currentToken = null;
      appView.classList.add('hidden');
      loginView.classList.remove('hidden');
      consoleOutput.innerHTML = '';
      pwdInput.focus();
    }

    document.getElementById('logout-btn').addEventListener('click', logout);
    document.getElementById('btn-clear-log').addEventListener('click', () => { consoleOutput.innerHTML = ''; });

    async function loadDashboardInfo() {
      const data = await apiCall('/info');
      const accBox = document.getElementById('info-accounts');
      if (data.accounts && data.accounts.length) {
        accBox.innerHTML = data.accounts.map(a => '<div class="account-row">' + (a || '').replace(/</g, '&lt;') + '</div>').join('');
      } else {
        accBox.innerHTML = '<div class="account-row" style="color:#fbbf24;">未配置账号 (WJKC_CREDENTIALS)</div>';
      }
      const notifyElem = document.getElementById('info-notify');
      if (data.notifyEnabled) {
        notifyElem.innerHTML = '<span class="status-badge">✅ 已启用 (' + data.notifyChannels.join(', ') + ')</span>';
      } else {
        notifyElem.innerHTML = '<span class="status-badge disabled">❌ 未配置渠道</span>';
      }
    }

    document.getElementById('btn-checkin').addEventListener('click', async function () {
      this.classList.add('loading');
      this.disabled = true;
      appendLog('==== 开始手动签到 ====', 'sys');
      try {
        const data = await apiCall('/checkin', { method: 'POST' });
        appendLog((data.body || ''), data.success ? 'ok' : 'err');
        if (data.notify) appendLog('[通知] ' + data.notify.message, 'warn');
        if (data.logs && data.logs.length) {
          data.logs.filter(l => !(data.body || '').includes(l.split(' ')[0]) && !l.startsWith('---')).forEach(l => appendLog('> ' + l, 'sys'));
        }
      } catch (err) {
        appendLog('签到执行异常: ' + err.message, 'err');
      } finally {
        this.classList.remove('loading');
        this.disabled = false;
        appendLog('==== 签到流程结束 ====', 'sys');
      }
    });

    document.getElementById('btn-notify').addEventListener('click', async function () {
      this.classList.add('loading');
      this.disabled = true;
      appendLog('正在发送测试推送...', 'sys');
      try {
        const data = await apiCall('/test_notify', { method: 'POST' });
        appendLog('推送结果: ' + (data.message || ''), data.success ? 'ok' : 'err');
      } catch (err) {
        appendLog('推送调用异常: ' + err.message, 'err');
      } finally {
        this.classList.remove('loading');
        this.disabled = false;
      }
    });

    init();
  </script>
</body>
</html>
`;