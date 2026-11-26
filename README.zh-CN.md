<h1 align="center">MuseKnock</h1>
<p align="center"><strong>将 Webhook 通知送到你的 Muse 侧边对话</strong></p>

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/Code-Hex/MuseKnock"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"></a>
</p>

<p align="center"><a href="README.md">English</a> · <a href="README.ja.md">日本語</a> · <strong>简体中文</strong></p>

![Slack 敲响房门，X、LINE 和 Telegram 拿着信封排在门外，Muse 探出头来。](assets/museknock-doorstep.webp)

MuseKnock 通过 Cloudflare Workers 把 Webhook 通知发送到已有的 Muse 侧边对话。请 Muse 生成临时设置链接，再在浏览器中选择目标对话。关闭电脑后，Worker 会继续投递通知。

[快速开始](#快速开始) · [使用案例](docs/recipes/README.zh-CN.md)

```mermaid
flowchart LR
    hooks["Slack · X · LINE · …"] -->|Webhook| inbox
    feeds["Discord · Bluesky"] -->|新事件| inbox
    subgraph worker["Cloudflare Worker"]
        cron["Cron（每 5 分钟）"]
        setup["设置与管理页面"]
        inbox["通知队列<br/>(Durable Object)"]
    end
    cron -->|读取| feeds
    admin["Muse MCP 连接器"] -->|生成链接| setup
    browser["浏览器"] -->|设备授权与目标设置| setup
    setup -->|保存凭据与目标| inbox
    inbox -->|"Muse Link"| chat["已有的 Muse 侧边对话"]
```

## 快速开始

如果 Muse 已连接 Cloudflare，请在要接收通知的侧边对话中发送以下请求。

> 请用我的 Cloudflare 连接器设置 https://github.com/Code-Hex/MuseKnock ，将此对话设为通知目标。请告诉我需要填写哪些密钥、注册哪个连接器，准备好后给我浏览器设置链接。

Muse 会在连接器的权限范围内准备 Worker。按 Muse 的提示完成步骤 1 和 2 中需要本人操作的部分，在 Cloudflare 或 Muse 指定的字段中填写密钥。打开步骤 3 的链接，确认是自己的 Worker 地址，再完成身份验证。

如果浏览器授权失败，可以[使用 Mac 和 iPhone 上的 Muse 应用通过蓝牙配对同一个 Worker](docs/operations.zh-CN.md#首次授权设备)。配对后按步骤 4 注册目标对话并确认收到测试通知。

请准备 Cloudflare 和 GitHub 账户、要接收通知的 Muse 侧边对话，以及 Muse Gadget SDK 令牌（`MUSE_SDK_TOKEN`）。该令牌仅供个人非商业用途。[申请 SDK 令牌](https://gadgets.muse.ai/settings/sdk-tokens) · [使用条款](https://gadgets.muse.ai/sdk-terms)

**1. 部署到 Cloudflare。** 选择 Worker 名称并填写以下三项 Secret。管理令牌和加密密钥分别生成，保存在密码管理器中，并记下部署后的 HTTPS 地址。

| Worker 密钥 | 值 | 使用时间 |
| --- | --- | --- |
| `MCP_ADMIN_TOKEN` | 用于 Muse 管理连接器的长随机令牌 | 长期保留 |
| `CREDENTIAL_ENCRYPTION_KEY` | 用于加密凭据的独立 32 字节密钥。在密码管理器中随机生成 64 个十六进制字符（0–9、a–f），并妥善备份。 | 长期保留 |
| `MUSE_SDK_TOKEN` | 在 [gadgets.muse.ai](https://gadgets.muse.ai/settings/sdk-tokens) 申请的 Gadget SDK 令牌 | 浏览器授权及后续令牌更新 |

**2. 连接 Muse。** 在 Muse 的 **Settings → Connectors** 中添加一个自定义连接器。在已部署 Worker 的 URL 后加上 `/mcp`，选择 Bearer 身份验证，将 `MCP_ADMIN_TOKEN` 填入令牌栏。[Muse 连接器指南](https://www.meta.com/en-gb/help/superintelligence/1687253048996149/)

**3. 在接收通知的 Muse 侧边对话中请求 MuseKnock 浏览器设置链接。** Muse 将该对话的会话 ID 作为必填的 `sessionId` 参数传给 `create_browser_setup_link`。若 Muse 无法取得 ID，请提供侧边对话的网址。认证成功后，Worker 会验证并注册该对话，然后发送完成通知。链接有效期十分钟且只能使用一次。打开后输入 Muse 邮箱或电话号码，并完成密码和验证码步骤。Worker 申请 Gadget 凭据并加密保存刷新令牌。若对话自动注册失败，请在第 4 步手动注册。若要重新认证已配对的 Worker，请先按下方步骤重置，再申请新链接。

<details>
<summary>仅重新授权时使用：重置已保存的配对</summary>

要清除已保存的 Gadget 配对并重新设置，请在本地终端运行以下命令，并在提示时输入 Muse 管理连接器使用的同一个 `MCP_ADMIN_TOKEN`：

```sh
printf 'MCP_ADMIN_TOKEN: '
read -rs MUSEKNOCK_ADMIN_TOKEN
printf '\n'
if [ -z "$MUSEKNOCK_ADMIN_TOKEN" ]; then
  printf '管理令牌为空。\n' >&2
else
curl --fail-with-body --silent --show-error \
  -X POST 'https://YOUR-WORKER.workers.dev/v1/setup/reset' \
  -H "Authorization: Bearer ${MUSEKNOCK_ADMIN_TOKEN}"
fi
unset MUSEKNOCK_ADMIN_TOKEN
```

成功时返回无正文的 `204`，不会生成链接。待发送通知会停止，原通知目标也会清除。请 Muse 生成新链接；认证成功后会注册通过 `sessionId` 提供的对话。不要把管理令牌放进 URL 或聊天。

</details>

此浏览器流程使用 Muse 的非公开认证 API。如果 Muse 更改接口或要求额外的账户验证，请使用[蓝牙授权步骤](docs/operations.zh-CN.md#首次授权设备)。Worker 通过 HTTPS 将密码和验证码发送给 Muse，但不持久保存。拿到设置链接的人在有效期内可以使用它，请勿分享。

**4. 注册对话并测试投递。** 在浏览器中更改配置。

1. “检查我的 MuseKnock 配置。” `get_setup_status` 检查 Worker 中的配置。下面的测试消息用于验证实际投递。
2. 若自动注册失败，请让 Muse “生成 MuseKnock 设置链接”。打开链接，将 `已有会话ID` 注册为“构建通知”并选为目标。链接只能使用一次，浏览器设置会话在十分钟后过期。请勿分享链接。MuseKnock 会先确认对话存在，再保存目标。[Gadget SDK 侧边对话说明](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/README.md)
3. “发送一条测试通知并检查回执。”Muse 使用新的 UUID 作为 `requestId` 调用 `send_test_notification`，然后用返回的回执 ID 调用 `get_delivery_status`。当状态为 `sent` 时，打开所选对话查看消息。重试同一次测试时，请使用相同的请求 ID。

**5. 连接事件来源。** 如需接入 Slack、LINE、Twilio、Telegram、企业微信、GitHub 或 X，请参阅[直接连接服务](#直接连接服务)。Bluesky 和 Discord 的设置见[连接 Bluesky](#连接-bluesky)和[连接 Discord](#连接-discord)。支持自定义 Bearer 请求头的服务可以使用下面的通用 Webhook。

如需使用通用 Webhook，请先在 Worker 的 Secret 中添加独立的随机令牌 `HOOK_TOKEN`。如需只读 MCP 连接器，再添加 `MCP_TOKEN`。每种用途应使用不同的令牌。

在发送服务的 Webhook 设置中，将请求设为发往同一 Worker 的 `/v1/hooks/custom` 的 `POST`，添加 `Authorization: Bearer YOUR_HOOK_TOKEN` 和 `Content-Type: application/json`。发送 `{"message":"构建完成"}` 等正文后会收到回执 ID。可在 Muse 中查看投递状态；暂停来源或筛选事件类型请使用设置链接打开浏览器页面。

## 直接连接服务

在 Cloudflare 中打开 Worker，进入 **Settings → Variables and Secrets**，按需将下表中的值添加为 Secret 并部署更改。将相应路径附加到 Worker 的公开 HTTPS 地址，得到要注册的完整 URL。各服务使用自身的认证机制，`HOOK_TOKEN` 仅供 `/v1/hooks/custom` 使用。

| 服务 | Worker Secret | 注册 URL 并验证投递 |
| --- | --- | --- |
| Slack Events API | 将 **Basic Information → App Credentials** 中的 Signing Secret 保存为 `SLACK_SIGNING_SECRET` | 启用 **Event Subscriptions**，将 `/v1/hooks/slack` 注册为 Request URL。显示 **Verified** 后，订阅 `app_mention` 等机器人事件，授权所需权限并安装或重新安装应用。将机器人邀请到频道并 @ 它。长消息会以摘录形式投递，并保留事件中提供的频道和消息时间戳。订阅对应频道的消息事件后，Worker 收到删除通知就会清除待投递的原文。消息表情回应会保留目标频道和消息时间戳。 [Slack URL 设置](https://docs.slack.dev/apis/events-api/using-http-request-urls/) |
| LINE Messaging API | 将频道 **Basic settings** 中的 Channel secret 保存为 `LINE_CHANNEL_SECRET` | 在 **Messaging API** 中将 Webhook URL 设为 `/v1/hooks/line`，点击 **Verify**，启用 **Use webhook**，并按需开启 **Webhook redelivery** 以便在接收失败时重试，然后向官方账号发送消息。验证请求带有签名和空事件列表，不会生成通知。如果 LINE 在投递开始前撤回消息，Worker 会清除队列中的正文。撤回记录保留七天，即使撤回事件先于原消息到达也能生效。 [LINE 连接验证](https://developers.line.biz/en/docs/messaging-api/verify-webhook-url/) |
| Twilio 入站短信和彩信 | 将号码所属账号的 Primary Auth Token 保存为 `TWILIO_AUTH_TOKEN` | 在 **Active Numbers** 中打开该号码的消息设置。在 **A message comes in → Webhook → HTTP POST** 中准确填写以 `/v1/hooks/twilio` 结尾的公开 URL 并保存。向号码发送短信进行验证。Worker 返回空的 TwiML，不会自动回复短信。[Twilio 入站 Webhook](https://www.twilio.com/docs/messaging/guides/webhook-request) |
| 企业微信自建应用 | 将 **我的企业** 中的企业 ID 保存为 `WECOM_CORP_ID`，将回调的 Token、EncodingAESKey 分别保存为 `WECOM_TOKEN`、`WECOM_ENCODING_AES_KEY` | 在 **应用管理 → 自建 → 接收消息 → 设置 API 接收** 中填入 `/v1/hooks/wecom` 和相同的 Token、EncodingAESKey。如果后台要求主体相关的备案域名，请为 Worker 配置相应的自定义域名。保存时会自动验证加密回调 URL，然后给应用发送消息。[企业微信回调配置](https://developer.work.weixin.qq.com/document/path/90930) |

**Telegram Bot API**。通过 @BotFather 创建机器人，另行生成由字母、数字、下划线或连字符组成的随机值（1 至 256 个字符），并将其保存为 Cloudflare 的 `TELEGRAM_WEBHOOK_SECRET`。使用 HTTPS 客户端按下例调用 `setWebhook`。在 shell 示例中，`BOT_TOKEN` 是 BotFather 提供的令牌，`WORKER_URL` 是末尾不带斜杠的 Worker 地址。机器人令牌仅用于访问 Telegram API。注册后会替换该机器人现有的 Webhook URL。[Telegram Webhook 设置](https://core.telegram.org/bots/api#setwebhook)

```sh
curl --fail-with-body -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WORKER_URL}/v1/hooks/telegram" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message","edited_message","channel_post","edited_channel_post"]'
curl --fail-with-body "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

通过 `getWebhookInfo` 确认返回的 URL，然后在与机器人的私聊中发送消息。MuseKnock 接收消息、频道帖子及其编辑，并转发其中的文本或媒体说明。消息出现在选定的 Muse 侧边对话中即表示投递成功。任何能给该机器人发消息的人都能触发通知。

### GitHub 仓库事件

1. 生成随机密钥，保存到 Worker 的 `GITHUB_WEBHOOK_SECRET`。在目标仓库打开 **Settings → Webhooks → Add webhook**，将 Payload URL 设为 `https://YOUR-WORKER/v1/hooks/github`，Content type 选 `application/json`，在 Secret 中填入相同密钥，并启用 SSL 验证。
2. 在 **Let me select individual events** 中按需选择 `push`、`issues`、`pull_request`、`release` 和 `workflow_run`，然后启用 Webhook。Worker 验证 GitHub 的 SHA-256 签名。首次 `ping` 仅用于确认连接，触发所选事件后即可在对话中看到摘要。[创建仓库 Webhook](https://docs.github.com/zh/webhooks/using-webhooks/creating-webhooks)
3. 如果通知未送达，请检查 **Recent Deliveries**。GitHub 不会自动重试失败的投递。Worker 每次最多接收 512 KiB，每个来源每分钟最多接收 10 个新事件。遇到 `429` 时，等待一分钟后点击 **Redeliver**。七天内重复投递相同正文只会产生一条通知。[处理失败的投递](https://docs.github.com/zh/webhooks/testing-and-troubleshooting-webhooks/handling-failed-webhook-deliveries)

### X 公开帖子

要转发 iPhone 上收到的 X 通知，请参阅[快捷指令使用案例](docs/recipes/x-notifications.zh-CN.md)。

准备一个已获批准且可以使用 X Activity API 的开发者应用，将其 OAuth 2.0 **Client Secret** 保存为 Worker 的 `X_OAUTH2_CLIENT_SECRET`。Worker 用它响应注册时的验证请求（CRC）并验证投递签名。X 按实际投递的帖子事件收费，包括删除事件。[X Activity API](https://docs.x.com/x-api/activity/introduction)

使用应用级 Bearer Token 调用以下两个 X API。请求头使用 `Authorization: Bearer YOUR_APP_BEARER_TOKEN` 和 `Content-Type: application/json`。

1. 向 `POST https://api.x.com/2/webhooks` 发送 `{"url":"https://YOUR-WORKER/v1/hooks/x"}`。X 验证 URL 后，从响应中复制 Webhook ID。[注册 Webhook](https://docs.x.com/x-api/webhooks/quickstart)
2. 向 `POST https://api.x.com/2/activity/subscriptions` 发送 `{"event_type":"post.create","filter":{"user_id":"NUMERIC_X_USER_ID"},"webhook_id":"WEBHOOK_ID"}`。如需接收删除通知，再用 `post.delete` 创建一条订阅。[订阅事件](https://docs.x.com/x-api/activity/quickstart)

在订阅的公开账号发布帖子，确认消息已送达侧边对话。对于新帖子，MuseKnock 转发帖子 ID、URL 和正文的前 4,000 个字符。MCP 的筛选类型为 `post_create` 和 `post_delete`。七天内重复投递同一 X 事件 ID 只会产生一条通知。Worker 收到删除事件时会丢弃仍在排队的原帖正文。如果删除事件先到，Worker 会保留该记录七天，以阻止之后到达的原帖进入投递流程。

## 连接 Bluesky

选好 Muse 目标对话后，打开 Worker 的 **Settings → Variables and Secrets**。按需启用下列一种或两种来源并部署更改。Worker 每五分钟读取一次官方 API。

| 接收内容 | Worker 设置 | Muse 中的来源名称 |
| --- | --- | --- |
| 指定账号的新公开帖子和回复 | 将该账号的 DID 填入 `BLUESKY_DID`。在[查询个人资料](https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=bsky.app)的 URL 中将末尾的 `bsky.app` 替换为目标账号的用户名，复制结果中的 `did`。无需登录。 | `bluesky` |
| 自己在 Bluesky 托管的账号收到的提及、点赞、关注等通知 | 将自己的用户名填入 `BLUESKY_IDENTIFIER`。生成一个不允许访问私信的专用应用密码，并保存为 Worker Secret `BLUESKY_APP_PASSWORD`。[创建应用密码](https://bsky.app/settings/app-passwords) | `bluesky-notifications` |

每个账号首次成功获取数据时只记录起点。此后发布新帖或让其他账号提及你，下一次轮询后在所选 Muse 侧边对话中确认。每次轮询每个来源最多读取十条，积压的内容会在后续轮询中继续读取。读取通知不会修改其在 Bluesky 的已读状态。[公开帖子 API](https://github.com/bluesky-social/bsky/blob/main/lexicons/app/bsky/feed/getAuthorFeed.json) · [账号通知 API](https://github.com/bluesky-social/bsky/blob/main/lexicons/app/bsky/notification/listNotifications.json)

## 连接 Discord

Worker 每五分钟检查一个 Discord 服务器文字频道。首次检查仅记录最新消息的位置，之后每次按时间顺序读取最多十条新消息。普通消息和回复会被转发到 Muse，内容包括作者、正文前 2,000 个字符，以及附件名称、大小和文件类型。 对于转发的消息，通知还包含转发原文和附件信息。

1. 在 Discord Developer Portal 创建应用，打开 **Bot**，启用 **Message Content Intent**。已验证的应用需要申请该权限。复制机器人令牌，在 Worker 中将其保存为 Secret `DISCORD_BOT_TOKEN`。[访问消息内容](https://docs.discord.com/developers/events/gateway#message-content-intent)
2. 在 **Installation → Guild Install** 中选择 `bot` 权限范围，通过安装链接将机器人添加到服务器。在目标频道为机器人授予 **查看频道** 和 **读取消息历史记录** 权限。成员在该频道发布的消息将转发到所选 Muse 对话。[安装 Discord 应用](https://docs.discord.com/developers/resources/application#installation-context) · [频道消息权限](https://docs.discord.com/developers/resources/message#get-channel-messages)
3. 在 Discord 的 **用户设置 → 高级 → 开发者模式** 中启用开发者模式。右键点击目标频道并选择 **复制频道 ID**，将该值保存为 Worker 的 `DISCORD_CHANNEL_ID` 并部署。首次定时检查完成后，在频道中发送一条消息，下一次检查后打开 Muse 确认投递。MCP 的来源名称为 `discord`，事件类型为 `message`。切换频道后，Worker 会从新频道的最新消息开始。

## 可选的投递熔断器

要限制所有 Webhook、轮询和 MCP 测试消息的发送尝试总数，在 Worker 设置中添加 **Text 类型**的变量 `CIRCUIT_BREAKER`。

```json
{"enabled":true,"maxAttempts":100,"maxAttemptsPerSource":50,"suppressReturns":true}
```

- `maxAttemptsPerSource` 限制每个来源在两次人工恢复之间的发送尝试次数。默认值为 `maxAttempts` 的一半，向下取整，最少为 1 次。在上例中，Discord 开始第 50 次尝试后，Worker 会停止投递排队中和新到达的 Discord 通知。其他来源仍可使用剩余的全局额度。要给其他来源留下额度，请设置小于全局上限的正整数。两个上限相等时，单个来源就能用尽全局额度。
- `maxAttempts` 限制所有来源的尝试总数，默认为 100 次。每次尝试（包括重试）都会消耗一次来源额度和一次全局额度。最后一次全局尝试开始时，Worker 会停止投递所有来源排队中和新到达的通知。两项上限的修改都在下次恢复时生效。
- 启用 `suppressReturns`（默认）时，中继可以通过 `/v1/hooks/custom` 的 `X-MuseKnock-Parent` 请求头传回原始回执 ID。识别出的回传不会消耗额度。没有该请求头的来源仍受总额度限制。
- 省略此变量或设置 `{"enabled":false}` 即可卸载中间件。重新启用时沿用已保存的额度。配置无效时，Worker 暂停投递和轮询，保留队列中的通知，并对新通知返回 HTTP 503。修正配置后恢复投递。通过只读 MCP 工具 `get_delivery_breaker` 可查看剩余的全局额度（`remaining`）以及各来源已使用的次数（`sourceAttempts`）。

任一额度用尽后，先修复循环来源，再用独立的运维 MCP 客户端连接 `/mcp`。为该连接配置单独的 Worker Secret `MCP_RECOVERY_TOKEN`，请勿将它交给 Muse。通过 `get_delivery_breaker` 读取当前代次，然后以此数值作为 `expectedGeneration` 调用 `rearm_delivery_breaker`。待正在发送的请求结束后，恢复操作会重置全局额度和所有来源的额度。已抑制的通知不会重发。

## 切换目标对话

请管理连接器生成设置链接，在浏览器中输入新的名称和会话 ID，然后将该对话选为通知目标。如果尚未选择目标，首次注册的对话会自动成为默认目标。切换只影响接下来收到的通知。排队或重试中的通知仍按接收时确定的目标投递。

使用 `MCP_TOKEN` 的只读连接器可以列出已注册的对话、查看回执。管理连接器只生成短期设置链接；配置变更在浏览器页面中完成。可选的 CLI 安装方式、Webhook 格式及投递排查方法见[运维指南](docs/operations.zh-CN.md)。
