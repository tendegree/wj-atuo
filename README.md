# WJKC Auto Check-in Action

这是一个基于 GitHub Actions 的自动化脚本，用于每日自动在**网际快车 (wj-kc.com)** 网站执行签到任务，以获取每日奖励。

源项目：https://github.com/ZZ0YY/wjkc-checkin

> **免责声明**: 本项目仅用于学习和技术研究。请在遵守目标网站用户协议的前提下使用。因使用本项目而导致的任何问题，项目作者概不负责。

---

## ✨ 功能特点

- **自动登录**：通过账号密码模拟登录，自动获取/刷新 Token，无需手动抓包。
- **全自动化**：一次配置，每日自动执行。
- **多账号支持**：支持配置多个账号，并为每个账号设置别名。
- **安全可靠**：使用 GitHub Secrets 存储账号密码，确保凭证安全。
- **实时通知**：支持**飞书、钉钉、企业微信、Server酱、PushPlus、Telegram、Bark、Discord、云湖、邮箱 SMTP** 等多种渠道通知签到结果。

---

## 🔧 部署指南

### 1. Fork 或克隆本项目

-   点击本仓库右上角的 **Fork** 按钮，将此项目复刻到你自己的 GitHub 账号下。
-   **重要**: 进入你 Fork 后的仓库，点击 `Settings`，将仓库的可见性设置为 **私有 (Private)**。

### 2. 添加仓库 Secrets

这是最关键的一步。进入你的仓库，依次点击 `Settings` -> `Secrets and variables` -> `Actions`，然后点击 `New repository secret` 按钮，添加以下 Secrets：

-   **`WJKC_CREDENTIALS` (必需)**
    -   **Name**: `WJKC_CREDENTIALS`
    -   **Value**: 填入你的账号信息，每行一个账号，格式为 `邮箱,密码,别名`。
    -   `邮箱` 和 `密码` 是必需的，用**英文逗号**隔开。
    -   `别名` 是可选的，用于在通知中区分账号。
      
      **格式示例**:
      ```
      user1@example.com,password123,我的主账号
      user2@example.com,another_password
      ```

### 3. （可选）配置通知渠道 🔔

> 通知功能完全可选。仅需要配置**一个或多个**你使用的渠道即可，其余渠道留空（不添加对应的 Secret）即可。所有渠道可同时启用。

下表列出了全部支持的通知渠道及其对应的 Secret（Name）。按需要逐个添加即可：

| 渠道 | Secret 名称 | 说明 |
| --- | --- | --- |
| 飞书机器人 | `FEISHU_BOT_KEY` | 飞书自定义机器人 Webhook 地址后的 token 部分 |
| 钉钉机器人 | `DINGTALK_BOT_KEY` | 钉钉自定义机器人 `access_token` |
| | `DINGTALK_SECRET` | （可选）钉钉机器人加签密钥，配置了启用加签 |
| 企业微信机器人 | `WECOM_BOT_KEY` | 企业微信群机器人 Webhook `key` |
| 云湖机器人 | `YUNHU_BOT_KEY` | 云湖机器人 Webhook key |
| Server酱 | `SERVERCHAN_SENDKEY` | Server酱 (sct) `SendKey` |
| PushPlus | `PUSHPLUS_TOKEN` | PushPlus Token（推荐） |
| | `PUSHPLUS_TOPIC` | （可选）PushPlus `topic` 群组编码 |
| Telegram | `TG_BOT_TOKEN` | Telegram Bot Token |
| | `TG_CHAT_ID` | 接收通知的 Chat ID |
| Bark (iOS) | `BARK_KEY` | Bark 设备 key 或完整推送地址 |
| | `BARK_GROUP` | （可选）Bark 分组 |
| Discord | `DISCORD_WEBHOOK` | Discord Webhook 完整 URL |
| 邮箱 SMTP | `MAIL_HOST` | SMTP 服务器地址 |
| | `MAIL_PORT` | （可选，默认 `465`）SMTP 端口 |
| | `MAIL_USER` | SMTP 账号（发件邮箱） |
| | `MAIL_PASS` | SMTP 密码/授权码 |
| | `MAIL_TO` | 收件邮箱 |

**飞书机器人为例：**

1. 在飞书群 → 群设置 → 群机器人 → 添加「自定义机器人」。
2. 复制 Webhook 地址，`https://open.feishu.cn/open-apis/bot/v2/hook/<token>`，将 `<token>` 部分填入 Secret `FEISHU_BOT_KEY`。
3. 在仓库 `Settings -> Secrets and variables -> Actions` 中新建 Secret，Name 填 `FEISHU_BOT_KEY`，Value 填 token 即可。

> 旧版使用单一 `NOTIFY` 变量配置 PushPlus 的方式已被多渠道通知取代，可直接改用上表中的 `PUSHPLUS_TOKEN`。

### 4. 启用并运行 Action

1.  进入你的仓库，点击上方的 **`Actions`** 标签页。
2.  在左侧的工作流列表中，点击 **`WJKC Daily Check-in (Dev Branch)`**。
3.  点击右侧的 **`Run workflow`** 按钮，确保分支选择的是 `dev`，然后点击绿色的 `Run workflow` 按钮来手动触发一次，以测试配置是否正确。
4.  测试成功后，脚本将在预设的时间（默认为每天北京时间凌晨 2:00）自动运行。

---
## ☁️ Cloudflare Workers 部署

除 GitHub Actions 外，本项目还提供 `worker.js`，可直接部署到 Cloudflare Workers，功能与 Node 版一致（登录、签到、多渠道通知）。

1. 进入 [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages → **Create** → **Worker**。
2. 将 [worker.js](worker.js) 内容粘贴到编辑器并保存。
3. 配置 Cron 触发器（与 Actions 定时一致）：**Triggers → Cron Triggers → Add Cron Trigger**，表达式如 `0 18 * * *`（对应北京时间 02:00）。
4. 在 **Settings → Variables and Secrets** 中添加以下变量：

| 变量 | 说明 |
| --- | --- |
| `admin` | 管理面板登录密码（可选，配置后访问 Worker 域名可登录面板手动签到/测试推送） |
| `WJKC_CREDENTIALS` (必需) | 账号用 `;` 分隔，每账号 `邮箱,密码,别名`（与 Actions 格式一致，支持多账号。注意：Worker 的 Secret 变量**不支持换行**，故用 `;` 分隔） |
| `WECOM_BOT_KEY` | 企业微信机器人 key（可选） |
| `DINGTALK_BOT_KEY` / `DINGTALK_SECRET` | 钉钉机器人（可选，可加签） |
| `FEISHU_BOT_KEY` | 飞书机器人（可选） |
| `YUNHU_BOT_KEY` | 云湖机器人（可选） |
| `SERVERCHAN_SENDKEY` | Server酱（可选） |
| `PUSHPLUS_TOKEN` / `PUSHPLUS_TOPIC` | PushPlus（可选） |
| `TG_BOT_TOKEN` / `TG_CHAT_ID` | Telegram（可选） |
| `BARK_KEY` / `BARK_GROUP` | Bark（可选） |
| `DISCORD_WEBHOOK` | Discord（可选） |

> 便捷性：`WJKC_CREDENTIALS` 及通知变量均使用不含特殊字符的命名，可直接作为 Worker 变量绑定。
> 限制：Worker 运行时无法使用 SMTP，因此邮箱通知渠道在 `worker.js` 中不支持；其余渠道均可用。

---

## 🚀 开发与部署流程

本项目使用 `dev` 分支作为开发和测试分支，`main` 分支作为稳定的生产分支。

-   所有新的功能和改动都在 `dev` 分支上进行。
-   `dev` 分支的 Action 配置（`.github/workflows/checkin.yml`）只监听 `dev` 分支的事件。
-   当 `dev` 分支的功能测试稳定后，可以将其合并到 `main` 分支。

---
