/**
 * 仓库保活执行成功通知脚本
 * 复用 utils/notify.js 的多渠道通知（飞书、钉钉、企业微信等）。
 * 未配置任何通知渠道时静默退出，不影响保活动作结果。
 */
const { sendNotify } = require('./utils/notify.js');

const title = '仓库保活执行成功';
const content = `📅 时间: ${new Date().toLocaleString()}\n✅ 仓库保活 Action 执行完成，仓库保持活跃。`;

sendNotify(title, content)
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('通知发送异常:', e.message);
    process.exit(0);
  })