/**
 * 网际快车 (wjkc.click) 自动化脚本 - 2025修复版
 * 
 * 功能：模拟登录、提取Token、自动签到、多账号支持、PushPlus推送
 * 环境要求：Node.js 18+ (自带 fetch)
 */

const crypto = require('crypto');

// 配置信息（可通过环境变量设置）
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36 EdgA/143.0.0.0';
const HOST = 'wjkc.click';
const ORIGIN = `https://${HOST}`;

/**
 * 工具函数：MD5 加密
 */
const md5 = (text) => {
    return crypto.createHash('md5').update(text).digest('hex');
};

/**
 * 工具函数：Base64 编解码
 */
const base64Encode = (str) => Buffer.from(str).toString('base64');
const base64Decode = (str) => Buffer.from(str, 'base64').toString('utf-8');

/**
 * 步骤 1: 模拟登录并获取 Token
 */
const getTokenByLogin = async (email, password) => {
    const hashedPassword = md5(password);
    const loginPayload = {
        email: email,
        password: hashedPassword,
    };
    
    // 构造请求体 {"data": "base64..."}
    const requestBody = JSON.stringify({ 
        data: base64Encode(JSON.stringify(loginPayload)) 
    });

    const headers = {
        'Host': HOST,
        'Connection': 'keep-alive',
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'User-Agent': UA,
        'Origin': ORIGIN,
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        'Referer': `${ORIGIN}/`,
        'Accept-Language': 'zh-CN,zh;q=0.9',
    };

    const response = await fetch(`${ORIGIN}/api/user/login`, {
        method: 'POST',
        headers: headers,
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
    const setCookieHeader = response.headers.get('set-cookie');
    const tokenMatch = setCookieHeader ? setCookieHeader.match(/token=([^;]+)/) : null;

    if (tokenMatch && tokenMatch[1]) {
        return tokenMatch[1];
    } else {
        // 如果 Cookie 里没找到，尝试解析 data 里的错误信息
        if (result.data) {
            const decodedData = JSON.parse(base64Decode(result.data));
            throw new Error(`登录失败: ${decodedData.msg || '密码错误'}`);
        }
        throw new Error('未能在响应头中找到 Token');
    }
};

/**
 * 步骤 2: 核心签到函数
 */
const runCheckinForAccount = async (token) => {
    const headers = {
        'Host': HOST,
        'Connection': 'keep-alive',
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'User-Agent': UA,
        'Origin': ORIGIN,
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        'Referer': `${ORIGIN}/`,
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Cookie': `token=${token}; platform=Android;` // 必须包含 token
    };

    // 签到负载固定为 {"data":"e30="} 对应内容为 {}
    const payload = JSON.stringify({ data: "e30=" });

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

        if (checkinResult.code === 0 && checkinResult.msg === "SUCCESS") {
            const addedTraffic = checkinResult.data.addTraffic || 0;
            const trafficInMB = (addedTraffic / 1024 / 1024).toFixed(0);
            return `✅ 签到成功: 获得 ${trafficInMB} MB 流量\n📅 连续签到: ${checkinResult.data.haveContinueSignUseData} 天`;
        } else {
            const message = checkinResult.msg || '';
            if (message.includes("SIGN_USE_MULTY_TIMES")) {
                return `✅ 今日已签到 (重复操作)`;
            }
            return `💡 结果: ${message}`;
        }
    }
    throw new Error('无法解析签到返回的 Data 字段');
};

/**
 * 推送通知
 */
/**
 * 推送通知 (飞书机器人版)
 */
const notify = async (title, body) => {
    const notifyConfig = process.env.NOTIFY;
    if (!notifyConfig || !body) return;

    // 1. 解析配置：寻找以 "feishu:" 开头的行
    // 假设你的 Secrets 格式为：feishu:https://open.feishu.cn/open-apis/bot/v2/hook/xxxx
    const feishuWebhook = notifyConfig.split('\n').find(line => line.startsWith('feishu:'))?.split(':')[1];
    
    if (!feishuWebhook) {
        console.log("未找到有效的飞书 Webhook 配置");
        return;
    }

    try {
        // 2. 构建飞书消息体
        // 飞书 Webhook 支持 text, post, image 等类型。这里使用 'post' 类型以支持标题和换行。
        const payload = {
            msg_type: "post",
            content: {
                post: {
                    zh_cn: {
                        title: title || "通知", // 飞书 Post 消息必须包含标题
                        content: [
                            [
                                {
                                    tag: "text",
                                    text: body.replace(/<br>/g, '\n') // 将 HTML 换行转回文本换行，适配飞书显示
                                }
                            ]
                        ]
                    }
                }
            }
        };

        // 3. 发送请求
        await fetch(feishuWebhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        
        console.log("飞书通知已发送。");
    } catch (e) {
        console.error("发送飞书通知失败:", e.message);
    }
};
/**
 * 程序入口
 */
const main = async () => {
    console.log(`--- 网际快车自动签到任务开始 (${new Date().toLocaleString()}) ---`);

    const credentials = process.env.WJKC_CREDENTIALS;
    if (!credentials) {
        console.error("错误: 未配置环境变量 WJKC_CREDENTIALS");
        return;
    }

    const accounts = credentials.split('\n').filter(line => line.trim() !== '');
    const results = [];
    let successCount = 0;

    for (let i = 0; i < accounts.length; i++) {
        const [email, password, alias] = accounts[i].split(',').map(s => s.trim());
        const accountName = alias || email;

        console.log(`[${i + 1}/${accounts.length}] 正在处理: ${accountName}`);

        try {
            // 登录
            const token = await getTokenByLogin(email, password);
            // 签到
            const message = await runCheckinForAccount(token);
            
            console.log(`   ${message.split('\n')[0]}`);
            results.push(`### ${accountName}\n${message}`);
            successCount++;
        } catch (error) {
            console.error(`   ❌ 失败: ${error.message}`);
            results.push(`### ${accountName}\n❌ 流程异常: ${error.message}`);
        }

        // 随机延迟防屏蔽
        if (i < accounts.length - 1) await new Promise(r => setTimeout(r, 3000));
    }

    const reportTitle = `网际快车签到: ${successCount}/${accounts.length} 成功`;
    const reportBody = results.join('\n\n---\n\n');
    
    await notify(reportTitle, reportBody);
    console.log("--- 任务执行完毕 ---");
};

// 启动
main();
