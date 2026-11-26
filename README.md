<h1 align="center">MuseKnock</h1>
<p align="center"><strong>Bring webhooks into your Muse side chat</strong></p>

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/Code-Hex/MuseKnock"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"></a>
</p>

<p align="center"><strong>English</strong> · <a href="README.ja.md">日本語</a> · <a href="README.zh-CN.md">简体中文</a></p>

![Slack knocks on the door as X, LINE, and Telegram wait with envelopes. Muse opens the door.](assets/museknock-doorstep.webp)

MuseKnock delivers webhooks from Cloudflare Workers to an existing Muse side chat. Muse issues a temporary settings link so you can choose the destination in your browser. The Worker handles delivery while your computer is off.

[Quick start](#quick-start) · [Recipes](docs/recipes/README.md)

```mermaid
flowchart LR
    hooks["Slack · X · LINE · …"] -->|Webhook| inbox
    feeds["Discord · Bluesky"] -->|New events| inbox
    subgraph worker["Cloudflare Worker"]
        cron["Cron (every 5 min)"]
        setup["Setup and settings pages"]
        inbox["Notification queue<br/>(Durable Object)"]
    end
    cron -->|Poll| feeds
    admin["Muse MCP connector"] -->|Issue link| setup
    browser["Browser"] -->|Authorize device and set destination| setup
    setup -->|Save credentials and destination| inbox
    inbox -->|"Muse Link"| chat["Existing Muse side chat"]
```

## Quick start

If Muse is connected to Cloudflare, paste this request into the side chat where you want notifications.

> Set up https://github.com/Code-Hex/MuseKnock using my Cloudflare connector. Use this chat for notifications. Tell me which secrets to enter and which connector to register, then give me the browser setup link.

Muse can prepare the Worker up to the permissions granted to the connector. Complete the parts of steps 1 and 2 that Muse asks you to handle. Enter secrets in the designated Cloudflare or Muse fields. Open the link from step 3 on your own Worker URL and complete the identity check yourself.

If browser authorization fails, [pair the same Worker over Bluetooth using a Mac and the Muse iPhone app](docs/operations.md#authorize-a-device). Then follow step 4 to register the destination and check a test notification.

Prepare your Cloudflare and GitHub accounts, the Muse side chat where you want notifications, and your Muse Gadget SDK token (`MUSE_SDK_TOKEN`). The token is for personal, non-commercial use. [Issue an SDK token](https://gadgets.muse.ai/settings/sdk-tokens) · [SDK token terms](https://gadgets.muse.ai/sdk-terms)

**1. Deploy to Cloudflare.** Choose a Worker name and supply these three secrets. Generate the admin token and encryption key separately, keep them in your password manager, then copy the deployed Worker’s HTTPS URL.

| Worker secret | Value | When needed |
| --- | --- | --- |
| `MCP_ADMIN_TOKEN` | A long random token for the admin connector in Muse | Keep |
| `CREDENTIAL_ENCRYPTION_KEY` | A separate 32-byte key for encrypting stored credentials. In your password manager, generate 64 random hexadecimal characters (0–9, a–f) and keep a private backup. | Keep |
| `MUSE_SDK_TOKEN` | Your Gadget SDK token from [gadgets.muse.ai](https://gadgets.muse.ai/settings/sdk-tokens) | Browser authorization and later token refresh |

**2. Connect Muse.** In Muse **Settings → Connectors**, add one custom connector. Append `/mcp` to the deployed Worker URL, choose Bearer authentication, and enter `MCP_ADMIN_TOKEN` in the token field. [Muse connector guide](https://www.meta.com/en-gb/help/superintelligence/1687253048996149/)

**3. Ask Muse for a MuseKnock browser setup link in the side chat where you want notifications.** Muse passes that chat's session ID as the required `sessionId` argument to `create_browser_setup_link`. If Muse cannot obtain the ID, provide the side chat URL. On successful authorization, the Worker verifies and registers the chat, then sends a completion notification. The one-use URL is valid for ten minutes. Open it, enter your Muse email address or phone number, and complete the password and code prompts. The Worker mints Gadget credentials and stores the refresh token encrypted. If automatic chat registration fails, register the destination in step 4. To reauthorize a paired Worker, reset it using the procedure below, then request a new link.

<details>
<summary>Reauthorization only: reset a saved pairing</summary>

To clear the stored Gadget pairing and start setup again, run this locally. Enter the same `MCP_ADMIN_TOKEN` used by the Muse admin connector when prompted:

```sh
printf 'MCP_ADMIN_TOKEN: '
read -rs MUSEKNOCK_ADMIN_TOKEN
printf '\n'
if [ -z "$MUSEKNOCK_ADMIN_TOKEN" ]; then
  printf 'Admin token is empty.\n' >&2
else
curl --fail-with-body --silent --show-error \
  -X POST 'https://YOUR-WORKER.workers.dev/v1/setup/reset' \
  -H "Authorization: Bearer ${MUSEKNOCK_ADMIN_TOKEN}"
fi
unset MUSEKNOCK_ADMIN_TOKEN
```

A successful reset returns an empty `204` response and issues no link. Pending notifications stop and the previous destination is cleared. Ask Muse for a new setup link; the chat passed as `sessionId` is registered after authorization. Keep the admin token out of URLs and chats.

</details>

This browser flow uses Muse's private authentication API. If Muse changes it or requires additional account checks, use the [Bluetooth authorization procedure](docs/operations.md#authorize-a-device). The Worker sends your password and verification code to Muse over HTTPS and does not persist them. Anyone with the setup link can use it until it expires, so keep it private.

**4. Register and test the chat.** Ask Muse for a settings link, then make configuration changes in your browser.

1. “Check my MuseKnock configuration.” `get_setup_status` checks local settings. The test post below checks delivery.
2. If automatic registration failed, ask Muse to “Create a MuseKnock settings link.” Open the link and register `YOUR-EXISTING-SESSION-ID` as `builds`, then select it. The one-use link opens a browser session that expires after ten minutes. MuseKnock verifies the chat with Muse before saving it. Keep the link private. [Gadget SDK side chats](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/README.md)
3. “Send one test notification and check its receipt.” Muse calls `send_test_notification` with a fresh UUID as `requestId`, then `get_delivery_status` with the returned receipt ID. Look in the selected chat when the status is `sent`. Reuse the same request ID when retrying the same test.

**5. Connect your event source.** For Slack, LINE, Twilio, Telegram, WeCom, GitHub, or X, follow [Connect a service directly](#connect-a-service-directly). For Bluesky or Discord, see [Connect Bluesky](#connect-bluesky) or [Connect Discord](#connect-discord). For a sender that supports a custom Bearer header, use the generic webhook below.

For the custom webhook, first add a separate random Worker secret named `HOOK_TOKEN`. A read-only MCP connector uses another optional secret, `MCP_TOKEN`. Use a different token for each role.

In the sending service, configure `POST /v1/hooks/custom` on the same Worker, with `Authorization: Bearer YOUR_HOOK_TOKEN` and `Content-Type: application/json`. A body such as `{"message":"Build finished"}` returns a receipt ID. Ask Muse to check the receipt. To pause a source or filter event types, request a settings link and use its browser page.

## Connect a service directly

Open your Worker in Cloudflare, go to **Settings → Variables and Secrets**, add the secrets for the service you use, and deploy the changes. Append the path below to your public HTTPS Worker URL. Each endpoint uses the service's own authentication. Keep `HOOK_TOKEN` for `/v1/hooks/custom`.

| Service | Worker secrets | Register the URL and check delivery |
| --- | --- | --- |
| Slack Events API | `SLACK_SIGNING_SECRET` from **Basic Information → App Credentials** | Turn on **Event Subscriptions**, enter `/v1/hooks/slack` as the Request URL and wait for **Verified**. Subscribe to a bot event such as `app_mention`, approve the required scopes and install or reinstall the app. Invite it to a channel and mention it. Long messages are delivered as excerpts with the channel and message timestamp when available. Subscribe to the relevant message events to retract queued text when Slack reports a deletion. Message reactions include the target channel and timestamp. [Slack request URLs](https://docs.slack.dev/apis/events-api/using-http-request-urls/) |
| LINE Messaging API | `LINE_CHANNEL_SECRET` from the channel's **Basic settings** | Under **Messaging API**, set the Webhook URL to `/v1/hooks/line`, click **Verify** and enable **Use webhook**. Enable **Webhook redelivery** to retry failed requests. Send the official account a message. The signed verification request has an empty event list and creates no notification. If LINE retracts a message before delivery starts, the Worker removes its queued text. It remembers retractions for seven days, including cancellations received before the original message. [LINE webhook verification](https://developers.line.biz/en/docs/messaging-api/verify-webhook-url/) |
| Twilio incoming SMS/MMS | `TWILIO_AUTH_TOKEN`, the primary Auth Token of the account that owns the number | In **Active Numbers**, open the number's messaging configuration. Set **A message comes in → Webhook → HTTP POST** to the exact public URL ending in `/v1/hooks/twilio` and save. Send the number an SMS. The Worker returns empty TwiML, so the sender receives no automatic reply. [Twilio incoming messages](https://www.twilio.com/docs/messaging/guides/webhook-request) |
| WeCom (企业微信), internal app | `WECOM_CORP_ID` from **My Enterprise** and the app callback's `WECOM_TOKEN` and `WECOM_ENCODING_AES_KEY` | In **应用管理 → 自建 → 接收消息 → 设置 API 接收**, enter `/v1/hooks/wecom` and the matching Token and EncodingAESKey. If the console requires an organization-registered domain, use a matching custom domain for the Worker. Save to verify the encrypted URL challenge, then send a message to the app. [WeCom callbacks](https://developer.work.weixin.qq.com/document/path/90930) |

**Telegram Bot API.** Create a bot with @BotFather. Generate a separate random secret using letters, digits, underscores or hyphens (1–256 characters) and save it as `TELEGRAM_WEBHOOK_SECRET` in Cloudflare. In an HTTPS client, call `setWebhook` with the values shown below. In the shell example, set `BOT_TOKEN` to the BotFather token and `WORKER_URL` to the Worker origin without a trailing slash. The bot token is needed only when calling Telegram. Registering the URL replaces this bot's current webhook. [Telegram webhook setup](https://core.telegram.org/bots/api#setwebhook)

```sh
curl --fail-with-body -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WORKER_URL}/v1/hooks/telegram" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message","edited_message","channel_post","edited_channel_post"]'
curl --fail-with-body "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

Check that `getWebhookInfo` returns your URL, then open a private chat with the bot and send a message. MuseKnock forwards messages, channel posts and their edits, including text or captions when present. Check the selected Muse chat to confirm delivery. Anyone who can message the bot can trigger a notification.

### GitHub repository events

1. Generate a random secret and save it to the Worker as `GITHUB_WEBHOOK_SECRET`. In the repository, open **Settings → Webhooks → Add webhook**. Set the payload URL to `https://YOUR-WORKER/v1/hooks/github`, select `application/json`, enter the same secret, and keep SSL verification enabled.
2. Under **Let me select individual events**, choose from `push`, `issues`, `pull_request`, `release`, and `workflow_run`. Enable the hook. The Worker verifies GitHub’s SHA-256 signature and acknowledges the initial `ping` without posting to Muse. Trigger a selected event to see its summary in the chat. [Create a repository webhook](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks)
3. Check **Recent Deliveries** if an event is missing. GitHub does not automatically retry failures. The Worker accepts up to 512 KiB per request and 10 new events per source per minute. After a `429`, wait a minute and click **Redeliver**. Repeated deliveries of the same body count once within seven days. [Failed webhook deliveries](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/handling-failed-webhook-deliveries)

### X public posts

Prefer to forward the X notifications already on your iPhone? See the [iOS Shortcuts recipe](docs/recipes/x-notifications.md).

Use an approved X developer app with access to the X Activity API. Save its OAuth 2.0 **client secret** to the Worker as `X_OAUTH2_CLIENT_SECRET`. The Worker uses this secret for the registration challenge (CRC) and to verify signed deliveries. X bills for each delivered Post event, including deletions. [X Activity API](https://docs.x.com/x-api/activity/introduction)

Use the app-only Bearer Token for these two X API calls. Send JSON with `Authorization: Bearer YOUR_APP_BEARER_TOKEN` and `Content-Type: application/json`.

1. Send `POST https://api.x.com/2/webhooks` with `{"url":"https://YOUR-WORKER/v1/hooks/x"}`. After X verifies the URL, copy the webhook ID from the response. [Webhook registration](https://docs.x.com/x-api/webhooks/quickstart)
2. Send `POST https://api.x.com/2/activity/subscriptions` with `{"event_type":"post.create","filter":{"user_id":"NUMERIC_X_USER_ID"},"webhook_id":"WEBHOOK_ID"}`. To also receive deletions, create a second subscription with `post.delete`. [Activity subscriptions](https://docs.x.com/x-api/activity/quickstart)

Publish a post on the subscribed public account to check delivery. MuseKnock forwards the Post ID, URL, and up to 4,000 characters of text for new posts. MCP filters use `post_create` and `post_delete`. Repeated deliveries with the same X event ID count once within seven days. If the Worker receives a deletion while the original post is queued, it discards the queued text. It also remembers deletions for seven days if they arrive before the post.

## Connect Bluesky

After selecting a Muse chat, open the Worker's **Settings → Variables and Secrets**. Enable either or both sources below and deploy the changes. The Worker reads the official APIs every five minutes.

| What to receive | Worker settings | Source in Muse |
| --- | --- | --- |
| One account's new public posts and replies | Set `BLUESKY_DID` to its DID. To find it, replace `bsky.app` with the account's handle in the [profile lookup](https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=bsky.app) and copy `did`. No login is required. | `bluesky` |
| Notifications for your own Bluesky-hosted account, including mentions, likes and follows | Set `BLUESKY_IDENTIFIER` to your handle. Generate a dedicated app password with direct message access disabled and save it as the Worker secret `BLUESKY_APP_PASSWORD`. [Bluesky app passwords](https://bsky.app/settings/app-passwords) | `bluesky-notifications` |

The first successful poll for each account establishes where to start. To test delivery, wait for that poll, then publish a new post or have someone mention your account. Check the selected side chat after the next poll. Each source reads up to ten entries per poll and continues through a backlog on later runs. Reading notifications leaves their read status unchanged. [Author feed](https://github.com/bluesky-social/bsky/blob/main/lexicons/app/bsky/feed/getAuthorFeed.json) · [Account notifications](https://github.com/bluesky-social/bsky/blob/main/lexicons/app/bsky/notification/listNotifications.json)

## Connect Discord

The Worker checks one Discord server text channel every five minutes. It starts at the latest message on the first successful check. Subsequent checks read up to ten new messages per run in chronological order. Normal messages and replies appear in Muse with their author, the first 2,000 characters of text, and attachment names, sizes and media types. For forwarded messages, the notification also includes the original text and attachment metadata.

1. In the Discord Developer Portal, create an application. Open **Bot**, enable **Message Content Intent**, and copy the bot token. Verified apps need approval for this intent. Save the token to the Worker as the secret `DISCORD_BOT_TOKEN`. [Discord message content access](https://docs.discord.com/developers/events/gateway#message-content-intent)
2. Under **Installation**, configure **Guild Install** with the `bot` scope. Open the installation link to add the bot to your server. In the chosen channel’s permissions, grant the bot **View Channel** and **Read Message History**. Everyone whose messages the bot reads there can trigger a notification in the selected Muse chat. [Discord installation guide](https://docs.discord.com/developers/resources/application#installation-context) · [Channel history permissions](https://docs.discord.com/developers/resources/message#get-channel-messages)
3. In Discord, enable **User Settings → Advanced → Developer Mode**. Right-click the channel and choose **Copy Channel ID**. Set `DISCORD_CHANNEL_ID` to the copied ID in the Worker, deploy the changes, and wait for the first scheduled check. Send a message and check Muse after the next run. The MCP source is `discord` and the event type is `message`. Changing the channel ID starts a new baseline.

## Optional delivery circuit breaker

To bound automatic posts across all webhooks, pollers and MCP test sends, add a **Text** variable named `CIRCUIT_BREAKER` in the Worker's settings. For example:

```json
{"enabled":true,"maxAttempts":100,"maxAttemptsPerSource":50,"suppressReturns":true}
```

- `maxAttemptsPerSource` limits how many attempts one source can use between resets. The default is half of `maxAttempts`, rounded down, with a minimum of 1. In the example, once Discord starts its 50th attempt, the Worker suppresses pending and new Discord notifications. Other sources can still use the remaining global budget. Choose a positive integer below the global limit to leave capacity for other sources. An equal limit lets one source use the entire budget.
- `maxAttempts` limits attempts across all sources (default 100). Each attempt, including a retry, counts toward both limits. Once the last global attempt starts, the Worker suppresses pending and new notifications for every source. Changes to either limit take effect at the next reset.
- With `suppressReturns` enabled (default), a relay can pass the original MuseKnock receipt ID in the `X-MuseKnock-Parent` header on `/v1/hooks/custom`. A recognized return is suppressed without spending an attempt. Sources that omit the header still share the total budget.
- Omit the variable or use `{"enabled":false}` to detach the middleware. Reattaching it resumes its saved budget. Invalid settings pause delivery and polling, preserve queued notifications, and return HTTP 503 for incoming notifications until the settings are corrected. Use the read-only MCP tool `get_delivery_breaker` to read the remaining global budget (`remaining`) and the number of attempts used by each source (`sourceAttempts`).

When either limit is reached, fix the source of the loop before resetting the budgets. Use a separate operator-controlled MCP client connected to `/mcp` with the optional Worker secret `MCP_RECOVERY_TOKEN`. Generate a distinct token and keep it outside Muse. Read the current generation with `get_delivery_breaker`, then call `rearm_delivery_breaker` with that number as `expectedGeneration`. Recovery resets the global budget and every source budget after any in-flight attempt finishes. Previously suppressed notifications stay suppressed.

## Change the destination

Ask the admin connector to create a settings link. Open it, register another name and session ID, then select that chat as the active destination. The first registration becomes active if there is no destination yet. Switching affects newly accepted notifications. Queued deliveries and retries keep the destination they had when accepted.

A connector configured with `MCP_TOKEN` can list registered chats and check receipts. The admin connector can issue temporary settings links; configuration changes happen on the browser page. For optional CLI setup, webhook formats, and troubleshooting, see the [operations guide](docs/operations.md).
