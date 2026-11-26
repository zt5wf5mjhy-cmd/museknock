<h1 align="center">MuseKnock</h1>
<p align="center"><strong>Webhook 通知を Muse のサイドチャットへ</strong></p>

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/Code-Hex/MuseKnock"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"></a>
</p>

<p align="center"><a href="README.md">English</a> · <strong>日本語</strong> · <a href="README.zh-CN.md">简体中文</a></p>

![封筒を持った X、LINE、Telegram が並ぶ前で Slack が扉をノックし、Muse が顔を出す。](assets/museknock-doorstep.webp)

MuseKnock は Cloudflare Workers で Webhook を受け取り、既存の Muse サイドチャットに通知を届けます。Muse に一時的な設定リンクを発行してもらい、ブラウザで投稿先を選びます。パソコンの電源を切っても Worker が配信を続けます。

[クイックスタート](#クイックスタート) · [レシピ集](docs/recipes/README.ja.md)

```mermaid
flowchart LR
    hooks["Slack · X · LINE · …"] -->|Webhook| inbox
    feeds["Discord · Bluesky"] -->|新着| inbox
    subgraph worker["Cloudflare Worker"]
        cron["Cron（5分ごと）"]
        setup["セットアップ・設定ページ"]
        inbox["通知キュー<br/>(Durable Object)"]
    end
    cron -->|取得| feeds
    admin["Muse の MCP コネクタ"] -->|リンクを発行| setup
    browser["ブラウザ"] -->|端末認証・投稿先設定| setup
    setup -->|認証情報・投稿先を保存| inbox
    inbox -->|"Muse Link"| chat["既存の Muse サイドチャット"]
```

## クイックスタート

Cloudflare コネクタを接続済みの Muse では、通知を受け取りたいサイドチャットに次の依頼を貼り付けます。

> https://github.com/Code-Hex/MuseKnock を Cloudflare コネクタでセットアップして。このチャットを通知先にしたいです。私が入力する Secret と登録が必要なコネクタを案内し、準備ができたらブラウザセットアップリンクを発行して。

Muse はコネクタの権限で可能な範囲まで Worker の準備を進めます。手順 1・2 は、Muse から入力や操作を求められた箇所だけ行ってください。Secret は Cloudflare や Muse の指定欄に入力します。手順 3 のリンクを自分の Worker の URL で開き、本人確認を完了してください。

ブラウザで Gadget 認証を完了できないときは、同じ Worker を [Mac と iPhone の Muse アプリで Bluetooth ペアリング](docs/operations.ja.md#初回の端末認証)できます。認証後は手順 4 で通知先を登録し、テスト通知を確認します。

Cloudflare と GitHub のアカウント、通知を受け取る Muse サイドチャット、Muse Gadget SDK トークン（`MUSE_SDK_TOKEN`）を用意します。トークンは個人・非商用利用向けです。[SDK トークンを発行する](https://gadgets.muse.ai/settings/sdk-tokens) · [利用条件](https://gadgets.muse.ai/sdk-terms)

**1. Cloudflare にデプロイします。** Worker 名を選び、次の3つを Secret として入力します。管理用トークンと暗号鍵は別々に生成し、パスワードマネージャーに保管します。デプロイ先の HTTPS URL を控えます。

| シークレット | 設定する値 | 必要な期間 |
| --- | --- | --- |
| `MCP_ADMIN_TOKEN` | Muse の管理用コネクタで使う、十分に長いランダムなトークン | 常時 |
| `CREDENTIAL_ENCRYPTION_KEY` | 保存する認証情報を暗号化する32バイトの専用鍵。パスワードマネージャーで16進数（0〜9、a〜f）のランダムな64文字を生成し、控えを安全に保管します。 | 常時 |
| `MUSE_SDK_TOKEN` | [gadgets.muse.ai](https://gadgets.muse.ai/settings/sdk-tokens) で発行した Gadget SDK トークン | ブラウザでの端末認証と、その後のトークン更新 |

**2. Muse にコネクタを追加します。** Muse の **Settings → Connectors** でカスタムコネクタを1つ追加します。デプロイ先の URL の末尾に `/mcp` を付け、認証方式に Bearer を選び、トークン欄に `MCP_ADMIN_TOKEN` を入力します。[Muse コネクタの設定手順](https://www.meta.com/en-gb/help/superintelligence/1687253048996149/)

**3. 通知を受け取りたい Muse サイドチャットで「このチャットを通知先にして、MuseKnock のブラウザセットアップリンクを発行して」と頼みます。** Muse はそのチャットのセッション ID を `create_browser_setup_link` の `sessionId` 引数で Worker に送ります。Muse が ID を取得できない場合は、サイドチャットの URL を伝えてください。Worker は認証完了時にチャットを確認して通知先に登録し、完了通知を送ります。リンクは10分間有効な1回限りの URL です。開いたページに Muse のメールアドレスまたは電話番号を入力し、案内されたパスワード、SMS コードなどを入力します。Worker は Gadget のトークンを発行して暗号化保存します。チャットの自動登録に失敗した場合は手順4で登録します。再設定する場合は、下のリセット手順を実行してから新しいリンクを発行します。

<details>
<summary>再設定時のみ：保存済みのペアリングをリセットする</summary>

保存済みの Gadget 認証を消して最初から設定し直す場合は、手元のターミナルで次を実行します。Muse の管理コネクタに登録した `MCP_ADMIN_TOKEN` を、表示されない入力欄に入れます。トークンは URL やチャットに貼らず、`Authorization` ヘッダーで送ります。

```sh
printf 'MCP_ADMIN_TOKEN: '
read -rs MUSEKNOCK_ADMIN_TOKEN
printf '\n'
if [ -z "$MUSEKNOCK_ADMIN_TOKEN" ]; then
  printf '管理トークンが空です。\n' >&2
else
curl --fail-with-body --silent --show-error \
  -X POST 'https://YOUR-WORKER.workers.dev/v1/setup/reset' \
  -H "Authorization: Bearer ${MUSEKNOCK_ADMIN_TOKEN}"
fi
unset MUSEKNOCK_ADMIN_TOKEN
```

成功時は本文なしの `204` が返ります。リンクは発行されません。未配信通知は停止し、以前の投稿先も消えます。続けて Muse に新しいセットアップリンクを依頼すると、渡した `sessionId` のチャットが認証完了時に登録されます。

</details>

このブラウザ方式は Muse の非公開認証 API を利用します。Muse の変更や追加の本人確認によって完了できない場合は、[Bluetooth を使う認証手順](docs/operations.ja.md#初回の端末認証)を使ってください。入力したパスワードと確認コードは Worker から Muse に HTTPS で送られ、Worker の保存領域には残しません。セットアップ URL は開いた人が利用できるため、他人に共有しないでください。

**4. 投稿先を登録してテストします。** 設定変更はブラウザで行います。

1. 「MuseKnock の設定を確認して」。`get_setup_status` は Worker 内の設定を確認します。実際に届くかはテスト投稿で確かめます。
2. 通知先の自動登録に失敗した場合は、Muse に「MuseKnock の設定リンクを発行して」と頼みます。リンクを開き、`既存のセッションID` を『ビルド通知』として登録して通知先に選びます。リンクは一度使うと無効になり、ブラウザの設定セッションは10分で期限切れになります。他人に共有しないでください。MuseKnock は保存前にチャットの存在を確認します。[Gadget SDK のサイドチャット](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/README.md)
3. 「テスト通知を1件送り、配信状態を確認して」。Muse は新しい UUID を `requestId` として `send_test_notification` を呼び、返った受付 ID を `get_delivery_status` に渡します。`sent` になったら選んだチャットを開きます。同じテストを再試行するときは同じリクエスト ID を使います。

**5. 送信元サービスを接続します。** Slack、LINE、Twilio、Telegram、企業微信、GitHub、X には[サービス別の設定手順](#サービスを直接接続する)を使います。Bluesky と Discord の設定は [Bluesky を接続する](#bluesky-を接続する)と [Discord を接続する](#discord-を接続する)を参照してください。Bearer ヘッダーを指定できる送信元には、次の汎用 Webhook が使えます。

汎用 Webhook を使う場合は、別途ランダムな `HOOK_TOKEN` を Worker の Secret に追加してください。閲覧専用の MCP コネクタを使う場合は `MCP_TOKEN` も追加します。用途ごとに別の値を使います。

送信元の Webhook 設定で、同じ Worker の `/v1/hooks/custom` に `POST` を指定します。ヘッダーを `Authorization: Bearer YOUR_HOOK_TOKEN`、`Content-Type: application/json` とし、例えば `{"message":"ビルドが完了しました"}` を送ると受付 ID が返ります。配信状態は Muse で確認できます。通知元の停止やイベント種別の絞り込みには、設定リンクのブラウザ画面を使います。

## サービスを直接接続する

Cloudflare で対象の Worker を開き、**Settings → Variables and Secrets** に利用するサービスの値を Secret として追加し、変更をデプロイします。登録する URL は、Worker の公開 HTTPS URL の末尾に下表のパスを付けたものです。各サービスは独自の方式で認証するため、`HOOK_TOKEN` は `/v1/hooks/custom` 用に保管します。

| サービス | Worker に登録する Secret | URL の登録と動作確認 |
| --- | --- | --- |
| Slack Events API | **Basic Information → App Credentials** の Signing Secret を `SLACK_SIGNING_SECRET` に設定 | **Event Subscriptions** を有効にし、Request URL に `/v1/hooks/slack` を登録します。**Verified** と表示されたら `app_mention` などの Bot Event を購読し、必要な権限を承認してアプリをインストールまたは再インストールします。チャンネルに招待してメンションを送ります。長文は抜粋して届けます。イベントに含まれていれば、チャンネルとメッセージのタイムスタンプも残します。対象チャンネルのメッセージイベントも購読すると、削除通知を受けた時点で配信待ちの本文を破棄します。メッセージへのリアクションには対象チャンネルと投稿時刻が付きます。 [Slack の URL 設定](https://docs.slack.dev/apis/events-api/using-http-request-urls/) |
| LINE Messaging API | チャネルの **チャネル基本設定** にあるチャネルシークレットを `LINE_CHANNEL_SECRET` に設定 | **Messaging API 設定** の Webhook URL に `/v1/hooks/line` を登録し、**検証** を押して **Webhook の利用** を有効にします。受信エラー時の再送は **Webhook の再送** で有効にできます。公式アカウントにメッセージを送ります。検証時に届く署名付きの空イベントは投稿されません。LINE の送信取消が配信開始前に届くと、待機中の本文を消去します。元のメッセージより先に届いた取消も7日間記憶します。 [LINE の接続確認](https://developers.line.biz/ja/docs/messaging-api/verify-webhook-url/) |
| Twilio の SMS・MMS 着信 | 番号を所有するアカウントの Primary Auth Token を `TWILIO_AUTH_TOKEN` に設定 | **Active Numbers** で対象番号を開き、Messaging の **A message comes in → Webhook → HTTP POST** に `/v1/hooks/twilio` で終わる公開 URL を正確に入力して保存します。その番号に SMS を送って確認します。Worker は空の TwiML を返すため、自動返信は送信されません。[Twilio の着信 Webhook](https://www.twilio.com/docs/messaging/guides/webhook-request) |
| 企業微信（WeCom）の自建アプリ | **我的企业** の企業 ID を `WECOM_CORP_ID` に、コールバックの Token と EncodingAESKey を `WECOM_TOKEN` と `WECOM_ENCODING_AES_KEY` に設定 | **应用管理 → 自建 → 接收消息 → 设置 API 接收** で `/v1/hooks/wecom` と同じ Token、EncodingAESKey を入力します。管理画面で企業名義の登録済みドメインを求められた場合は、その条件を満たすカスタムドメインを Worker に設定します。保存時に暗号化されたチャレンジで接続を確認します。その後、アプリにメッセージを送ります。[企業微信のコールバック](https://developer.work.weixin.qq.com/document/path/90930) |

**Telegram Bot API** は @BotFather で Bot を作成します。英数字、アンダースコア、ハイフンからなるランダムな値（1〜256 文字）を別途生成し、Cloudflare の `TELEGRAM_WEBHOOK_SECRET` に保存します。HTTPS クライアントから次の値で `setWebhook` を呼びます。シェルで実行する場合、`BOT_TOKEN` は BotFather のトークン、`WORKER_URL` は末尾のスラッシュを除いた Worker の URL です。Bot トークンは Telegram API の呼び出しにだけ使います。登録すると、その Bot の既存の Webhook URL は置き換わります。[Telegram の Webhook 設定](https://core.telegram.org/bots/api#setwebhook)

```sh
curl --fail-with-body -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WORKER_URL}/v1/hooks/telegram" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message","edited_message","channel_post","edited_channel_post"]'
curl --fail-with-body "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

`getWebhookInfo` で登録した URL が返ったら、Bot との個人チャットにメッセージを送ります。通常のメッセージ、チャンネル投稿、これらの編集を受け付け、テキストやキャプションがあれば転送します。選択した Muse サイドチャットに届けば、配信まで確認できています。この Bot にメッセージを送れる人は誰でも通知を発生させられます。

### GitHub のリポジトリイベント

1. ランダムなシークレットを生成し、Worker の `GITHUB_WEBHOOK_SECRET` に保存します。対象リポジトリで **Settings → Webhooks → Add webhook** を開き、Payload URL に `https://YOUR-WORKER/v1/hooks/github`、Content type に `application/json`、Secret に同じ値を設定します。SSL 検証は有効にします。
2. **Let me select individual events** で `push`、`issues`、`pull_request`、`release`、`workflow_run` から必要なイベントを選び、有効化します。Worker は GitHub の SHA-256 署名を検証します。登録時の `ping` は接続確認のみで、選択したイベントが発生するとチャットに概要が届きます。[GitHub の Webhook 作成手順](https://docs.github.com/ja/webhooks/using-webhooks/creating-webhooks)
3. 届かない場合は **Recent Deliveries** を開きます。GitHub は失敗した配信を自動再送しません。Worker の上限はリクエスト本文が 512 KiB、送信元ごとの新規イベントが毎分 10 件です。`429` の場合は 1 分待ち、**Redeliver** を押します。7 日以内に同じ本文を再送しても、通知は重複しません。[失敗した配信の処理](https://docs.github.com/ja/webhooks/testing-and-troubleshooting-webhooks/handling-failed-webhook-deliveries)

### X の公開投稿

iPhone に届く X の通知を活用する方法は、[ショートカットのレシピ](docs/recipes/x-notifications.ja.md)を参照してください。

X Activity API を利用できる承認済みの開発者アプリを用意します。OAuth 2.0 の **Client Secret** を Worker の `X_OAUTH2_CLIENT_SECRET` に保存します。Worker はこの値で登録時のチャレンジ（CRC）に応答し、配信の署名を検証します。X は削除を含む投稿イベントの配信ごとに課金します。[X Activity API](https://docs.x.com/x-api/activity/introduction)

次の 2 回の X API 呼び出しにはアプリ専用 Bearer Token を使います。ヘッダーを `Authorization: Bearer YOUR_APP_BEARER_TOKEN` と `Content-Type: application/json` にして JSON を送信します。

1. `POST https://api.x.com/2/webhooks` に `{"url":"https://YOUR-WORKER/v1/hooks/x"}` を送ります。X が接続を確認したら、応答から Webhook ID を控えます。[Webhook の登録](https://docs.x.com/x-api/webhooks/quickstart)
2. `POST https://api.x.com/2/activity/subscriptions` に `{"event_type":"post.create","filter":{"user_id":"NUMERIC_X_USER_ID"},"webhook_id":"WEBHOOK_ID"}` を送ります。削除通知も必要なら、`post.delete` でもう一件登録します。[イベント購読の設定](https://docs.x.com/x-api/activity/quickstart)

対象の公開アカウントで投稿し、サイドチャットへの配信を確認します。新しい投稿は投稿 ID、URL、本文の先頭 4,000 文字までを転送します。MCP の絞り込みには `post_create` と `post_delete` を使います。同じ X イベント ID の再送は 7 日間重複排除されます。削除通知を受け取ると、配信待ちの元投稿の本文を破棄します。削除が先に届いた場合も、7 日間は後から届く元投稿を抑止します。

## Bluesky を接続する

Muse の投稿先を選んだら、Worker の **Settings → Variables and Secrets** を開きます。以下の片方または両方を設定してデプロイすると、Worker が5分おきに公式 API を読み取ります。

| 受け取る内容 | Worker に設定する値 | Muse での送信元名 |
| --- | --- | --- |
| 指定アカウントの新しい公開投稿と返信 | `BLUESKY_DID` に対象の DID を設定します。[プロフィール照会](https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=bsky.app) の URL 末尾の `bsky.app` を対象のハンドルに置き換え、結果から `did` をコピーできます。ログインは不要です。 | `bluesky` |
| Bluesky がホストする自分のアカウントへのメンション、いいね、フォローなど | `BLUESKY_IDENTIFIER` に自分のハンドルを設定します。DM へのアクセスを無効にした専用のアプリパスワードを作成し、Worker の Secret `BLUESKY_APP_PASSWORD` に保存します。[アプリパスワードの作成](https://bsky.app/settings/app-passwords) | `bluesky-notifications` |

各アカウントの初回取得で開始位置を記録します。動作確認はその後に、新しく公開投稿するか、別のアカウントからメンションを送ってください。次の取得後に選択したサイドチャットで確認できます。1回に取得するのは各送信元につき最大10件で、続きは次回以降に取得します。通知を取得しても Bluesky 上の既読状態は変わりません。[公開投稿の API](https://github.com/bluesky-social/bsky/blob/main/lexicons/app/bsky/feed/getAuthorFeed.json) · [アカウント通知の API](https://github.com/bluesky-social/bsky/blob/main/lexicons/app/bsky/notification/listNotifications.json)

## Discord を接続する

Worker が Discord サーバーのテキストチャンネルを 1 つ、5 分ごとに確認します。初回はその時点の最新メッセージを記録し、次回から新着を毎回最大 10 件、古い順に読み取ります。通常のメッセージと返信について、投稿者、本文の先頭 2,000 文字、添付ファイルの名前・サイズ・種類が Muse に届きます。 転送メッセージには転送元の本文と添付ファイルの情報も含まれます。

1. Discord Developer Portal でアプリを作成し、**Bot** で **Message Content Intent** を有効にします。認証済みアプリにはこの権限の承認が必要です。Bot トークンをコピーし、Worker の Secret `DISCORD_BOT_TOKEN` に保存します。[メッセージ本文へのアクセス](https://docs.discord.com/developers/events/gateway#message-content-intent)
2. **Installation** の **Guild Install** に `bot` スコープを設定し、インストールリンクから Bot をサーバーに追加します。対象チャンネルで Bot に **チャンネルを見る** と **メッセージ履歴を読む** 権限を付与します。そのチャンネルに投稿できる人の発言が、選択した Muse チャットに届きます。[Discord アプリのインストール](https://docs.discord.com/developers/resources/application#installation-context)・[チャンネル履歴の権限](https://docs.discord.com/developers/resources/message#get-channel-messages)
3. Discord の **ユーザー設定 → 詳細設定 → 開発者モード** を有効にします。対象チャンネルを右クリックし、**チャンネル ID をコピー** します。Worker の `DISCORD_CHANNEL_ID` にその ID を設定してデプロイします。初回の定期確認が終わってからメッセージを送り、次の確認後に Muse を開きます。MCP の送信元名は `discord`、イベント種別は `message` です。対象チャンネルを変更すると、新しいチャンネルの最新位置から開始します。

## 配信サーキットブレーカー（任意）

Webhook、定期取得、MCP のテスト送信を合わせた送信試行回数に上限を設けられます。Worker の設定に **Text 型**の変数 `CIRCUIT_BREAKER` を追加します。

```json
{"enabled":true,"maxAttempts":100,"maxAttemptsPerSource":50,"suppressReturns":true}
```

- `maxAttemptsPerSource` は、手動で復旧するまでに各送信元が使える試行回数です。既定値は `maxAttempts` の半分を切り捨てた値で、最小は1回です。上の例で Discord が50回目の試行を開始すると、Worker は待機中と新着の Discord 通知を抑止します。他の送信元は全体枠の残りを使えます。他の送信元にも枠を残すには、全体の上限より小さい正の整数を指定します。両方を同じ値にすると、1つの送信元が全体枠を使い切れます。
- `maxAttempts` は全送信元を合わせた上限です（既定100回）。再試行を含め、送信を試みるたびに送信元別の枠と全体枠を1回ずつ使います。全体枠の最後の試行を開始すると、全送信元の待機中と新着の通知を抑止します。どちらの上限も、設定変更は次の復旧時に適用されます。
- `suppressReturns` が有効（既定）の場合、中継側は元の受付 ID を `/v1/hooks/custom` の `X-MuseKnock-Parent` ヘッダーで返せます。識別できた折り返しは枠を使わずに抑止します。ヘッダーがない経路にも共通上限が効きます。
- 変数を省略するか `{"enabled":false}` を設定するとミドルウェアが外れます。再装着時は保存済みの枠から再開します。設定が不正な間は配信と定期取得を停止し、待機中の通知を保持します。新しい通知には HTTP 503 を返し、設定を直すと再開します。閲覧用 MCP ツール `get_delivery_breaker` で、全体枠の残り（`remaining`）と送信元ごとの試行回数（`sourceAttempts`）を確認できます。

いずれかの上限に達したら、循環の原因を直してから、運用者専用の MCP クライアントで `/mcp` に接続します。この接続には、他のトークンと異なる Worker シークレット `MCP_RECOVERY_TOKEN` を設定し、Muse には渡さずに保管します。`get_delivery_breaker` で現在の世代を確認し、その数値を `expectedGeneration` に指定して `rearm_delivery_breaker` を呼びます。送信中の試行が終わると、復旧操作で全体枠とすべての送信元の枠をリセットできます。抑止済みの通知は再送されません。

## 投稿先を切り替える

管理用コネクタに設定リンクを発行してもらい、ブラウザで別の登録名とセッション ID を入力して通知先に選びます。投稿先が未設定なら最初の登録が自動で選ばれます。切り替えは次に受け付ける通知から有効です。配信待ちや再送の通知には、受付時の投稿先を使います。

`MCP_TOKEN` を使う閲覧用コネクタでは、登録済みチャットや配信状態を確認できます。管理用コネクタは一時的な設定リンクを発行し、設定変更はブラウザ画面で行います。CLI でのセットアップ、Webhook の形式、配信の調査については[運用ガイド](docs/operations.ja.md)を参照してください。
