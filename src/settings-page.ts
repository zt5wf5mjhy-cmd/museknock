import type { SetupLanguage } from './browser-setup-page.ts'

type Source = { source: string; paused: boolean; types: string[] }
type Chats = { active: string | null; chats: { name: string; sessionId: string }[] }

const copy = {
  en: { title: 'MuseKnock settings', open: 'Open settings', openHint: 'This link grants temporary access to change this Worker. Open it only if you requested it.', expires: 'Expires', chats: 'Side chats', active: 'Active', none: 'None', name: 'Name', session: 'Session ID', register: 'Register chat', select: 'Select active chat', sources: 'Sources', sourceIntro: 'Choose a source to control which incoming events become notifications. Connect the service separately.', guide: 'Connection guide', webhookUrl: 'Webhook URL', workerSecret: 'Worker secret', allowed: 'Notify on receipt', paused: 'Paused', allEvents: 'All events', selectedEvents: 'Selected events', pause: 'Pause notifications', resume: 'Resume notifications', types: 'Event types to notify', otherTypes: 'Other event types', filterHint: 'Enter any other exact event names separated by commas.', saveSelected: 'Save selected events', allowAll: 'Allow all events', saved: 'Settings saved.', invalid: 'Check the entered values.', noEvents: 'Select at least one event, or choose Allow all events.', unavailable: 'The change could not be completed.', note: 'Only use this page on your own Worker URL. This is not a Meta login page.' },
  ja: { title: 'MuseKnock の設定', open: '設定を開く', openHint: 'このリンクから一時的に Worker の設定を変更できます。自分で依頼した場合のみ開いてください。', expires: '有効期限', chats: 'サイドチャット', active: '現在の通知先', none: '未設定', name: '名前', session: 'セッション ID', register: 'チャットを登録', select: '通知先を選択', sources: '通知元', sourceIntro: '通知元を選び、届いたイベントを通知するか設定します。サービスとの接続は別途必要です。', guide: '接続手順を見る', webhookUrl: 'Webhook URL', workerSecret: 'Worker の Secret', allowed: '受信時に通知', paused: '通知を停止中', allEvents: 'すべてのイベント', selectedEvents: '指定したイベント', pause: '通知を停止', resume: '通知を再開', types: '通知するイベント種別', otherTypes: 'その他のイベント種別', filterHint: '候補にない種別は、正確な名前をカンマで区切って入力してください。', saveSelected: '選んだイベントを保存', allowAll: 'すべて通知', saved: '設定を保存しました。', invalid: '入力内容を確認してください。', noEvents: 'イベントを1つ以上選ぶか、「すべて通知」を押してください。', unavailable: '変更を完了できませんでした。', note: '自分の Worker の URL でのみ操作してください。このページは Meta の公式ログインページではありません。' },
  'zh-CN': { title: 'MuseKnock 设置', open: '打开设置', openHint: '此链接可暂时更改这个 Worker 的设置。仅在您主动请求时打开。', expires: '有效期至', chats: '侧边对话', active: '当前目标', none: '未设置', name: '名称', session: '会话 ID', register: '注册对话', select: '选择目标对话', sources: '来源', sourceIntro: '选择来源，设置收到事件后是否发送通知。服务连接需另行配置。', guide: '查看连接步骤', webhookUrl: 'Webhook URL', workerSecret: 'Worker 密钥', allowed: '收到时通知', paused: '已暂停通知', allEvents: '所有事件', selectedEvents: '指定事件', pause: '暂停通知', resume: '恢复通知', types: '要通知的事件类型', otherTypes: '其他事件类型', filterHint: '未列出的类型请用逗号分隔准确名称。', saveSelected: '保存所选事件', allowAll: '允许所有事件', saved: '设置已保存。', invalid: '请检查输入值。', noEvents: '请至少选择一个事件，或选择允许所有事件。', unavailable: '无法完成更改。', note: '请仅在您自己的 Worker 地址操作。这不是 Meta 官方登录页面。' },
} as const

const sourceCatalog = [
  { source: 'custom', label: { en: 'Custom webhook', ja: '汎用 Webhook', 'zh-CN': '自定义 Webhook' }, examples: ['notification'] },
  { source: 'github', label: { en: 'GitHub', ja: 'GitHub', 'zh-CN': 'GitHub' }, examples: ['push', 'issues', 'pull_request', 'release', 'workflow_run'] },
  { source: 'slack', label: { en: 'Slack', ja: 'Slack', 'zh-CN': 'Slack' }, examples: ['app_mention', 'message', 'reaction_added'] },
  { source: 'line', label: { en: 'LINE', ja: 'LINE', 'zh-CN': 'LINE' }, examples: ['message', 'follow', 'unfollow'] },
  { source: 'telegram', label: { en: 'Telegram', ja: 'Telegram', 'zh-CN': 'Telegram' }, examples: ['message', 'edited_message', 'channel_post', 'edited_channel_post'] },
  { source: 'twilio', label: { en: 'Twilio', ja: 'Twilio', 'zh-CN': 'Twilio' }, examples: ['sms', 'mms'] },
  { source: 'wecom', label: { en: 'WeCom', ja: '企業微信', 'zh-CN': '企业微信' }, examples: ['text', 'image'] },
  { source: 'x', label: { en: 'X', ja: 'X', 'zh-CN': 'X' }, examples: ['post_create', 'post_delete'] },
  { source: 'bluesky', label: { en: 'Bluesky posts', ja: 'Bluesky の投稿', 'zh-CN': 'Bluesky 帖子' }, examples: ['post', 'reply'] },
  { source: 'bluesky-notifications', label: { en: 'Bluesky notifications', ja: 'Bluesky の通知', 'zh-CN': 'Bluesky 通知' }, examples: ['mention', 'reply', 'like', 'repost', 'follow'] },
  { source: 'discord', label: { en: 'Discord', ja: 'Discord', 'zh-CN': 'Discord' }, examples: ['message'] },
  { source: 'museknock-test', label: { en: 'Test notifications', ja: 'テスト通知', 'zh-CN': '测试通知' }, examples: ['test'] },
  { source: 'museknock-setup', label: { en: 'Setup completion', ja: 'セットアップ完了', 'zh-CN': '设置完成' }, examples: ['setup_complete'] },
] as const

const connections: Record<string, { hook?: string; secret?: string; guide: Record<SetupLanguage, string> }> = {
  custom: { hook: 'custom', secret: 'HOOK_TOKEN', guide: { en: 'quick-start', ja: 'クイックスタート', 'zh-CN': '快速开始' } },
  github: { hook: 'github', secret: 'GITHUB_WEBHOOK_SECRET', guide: { en: 'github-repository-events', ja: 'github-のリポジトリイベント', 'zh-CN': 'github-仓库事件' } },
  slack: { hook: 'slack', secret: 'SLACK_SIGNING_SECRET', guide: { en: 'connect-a-service-directly', ja: 'サービスを直接接続する', 'zh-CN': '直接连接服务' } },
  line: { hook: 'line', secret: 'LINE_CHANNEL_SECRET', guide: { en: 'connect-a-service-directly', ja: 'サービスを直接接続する', 'zh-CN': '直接连接服务' } },
  telegram: { hook: 'telegram', secret: 'TELEGRAM_WEBHOOK_SECRET', guide: { en: 'connect-a-service-directly', ja: 'サービスを直接接続する', 'zh-CN': '直接连接服务' } },
  twilio: { hook: 'twilio', secret: 'TWILIO_AUTH_TOKEN', guide: { en: 'connect-a-service-directly', ja: 'サービスを直接接続する', 'zh-CN': '直接连接服务' } },
  wecom: { hook: 'wecom', secret: 'WECOM_CORP_ID · WECOM_TOKEN · WECOM_ENCODING_AES_KEY', guide: { en: 'connect-a-service-directly', ja: 'サービスを直接接続する', 'zh-CN': '直接连接服务' } },
  x: { hook: 'x', secret: 'X_OAUTH2_CLIENT_SECRET', guide: { en: 'x-public-posts', ja: 'x-の公開投稿', 'zh-CN': 'x-公开帖子' } },
  bluesky: { secret: 'BLUESKY_DID', guide: { en: 'connect-bluesky', ja: 'bluesky-を接続する', 'zh-CN': '连接-bluesky' } },
  'bluesky-notifications': { secret: 'BLUESKY_IDENTIFIER · BLUESKY_APP_PASSWORD', guide: { en: 'connect-bluesky', ja: 'bluesky-を接続する', 'zh-CN': '连接-bluesky' } },
  discord: { secret: 'DISCORD_BOT_TOKEN · DISCORD_CHANNEL_ID', guide: { en: 'connect-discord', ja: 'discord-を接続する', 'zh-CN': '连接-discord' } },
}

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!)

const style = `<style>
:root{color-scheme:dark;font-family:Optimistic,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f7f7f7;background:#181819}
*{box-sizing:border-box}body{margin:0}.wrap{max-width:640px;margin:0 auto;padding:28px 18px 48px}.brand{font-size:18px;font-weight:600;margin-bottom:32px}
.card{background:#242426;border:1px solid #373739;border-radius:22px;padding:28px;margin:18px 0}h1,h2{font-weight:500;letter-spacing:-.025em}h1{text-align:center;font-size:30px;margin:0 0 20px}h2{font-size:21px;margin:0 0 16px}
p,li{line-height:1.55}.muted{color:#b8b8bc;font-size:13px}.notice{padding:12px 14px;border-radius:12px;background:#293a4d}.error{background:#46372c}
label{display:block;font-size:13px;font-weight:600;margin:14px 0}input,select{display:block;width:100%;margin-top:7px;padding:12px;border:1px solid #55555a;border-radius:12px;background:#38383a;color:#fff;font:inherit;font-size:16px}
select{appearance:none;padding-right:44px}.select-wrap{display:block;position:relative}.select-wrap::after{content:"";position:absolute;right:18px;top:50%;width:8px;height:8px;border-right:2px solid #fff;border-bottom:2px solid #fff;transform:translateY(-70%) rotate(45deg);pointer-events:none}
button{min-height:46px;padding:10px 18px;border:0;border-radius:999px;background:#4b93ff;color:#fff;font:inherit;cursor:pointer}button:hover{background:#3584f3}button:disabled{opacity:.55;cursor:default}
form{margin:16px 0 0}form+form{padding-top:16px;border-top:1px solid #3a3a3d}ul{padding-left:20px;overflow-wrap:anywhere}.langs{display:flex;gap:12px;justify-content:center;margin-top:24px}.langs a{color:#a9cbff}.foot{text-align:center}
.source-list{border-top:1px solid #3a3a3d;margin-top:20px}.source-row{border-bottom:1px solid #3a3a3d}.source-row summary{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:68px;list-style:none;cursor:pointer;padding:10px 28px 10px 0}.source-row summary::-webkit-details-marker{display:none}.source-row summary::after{content:"";width:8px;height:8px;flex:none;border-right:2px solid #b8b8bc;border-bottom:2px solid #b8b8bc;transform:rotate(45deg);margin-right:4px}.source-row[open] summary::after{transform:rotate(225deg)}.source-name{flex:1;min-width:0;font-weight:600}.source-name small{display:block;color:#b8b8bc;font-size:12px;font-weight:400}.source-status{color:#b8b8bc;font-size:12px;text-align:right}.source-body{padding:0 0 20px}.source-body form{margin-top:14px}.source-body p{margin:8px 0}.source-body a,.source-guide a{color:#a9cbff}.source-body input{margin-top:6px}
.event-options{border:0;padding:0;margin:12px 0 0}.event-options legend{font-size:13px;font-weight:600;margin-bottom:8px}.event-choice{display:flex;align-items:center;gap:10px;margin:8px 0;font-size:14px;font-weight:400}.event-choice input{width:18px;height:18px;margin:0;accent-color:#4b93ff}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}.actions button{font-size:14px}.actions .secondary{background:#38383a;border:1px solid #55555a}.actions .secondary:hover{background:#4b4b4e}
.connection{padding:12px 0 18px;border-bottom:1px solid #3a3a3d}.connection label{margin:8px 0}.connection input{font-size:13px}.connection p{margin:8px 0}
</style>`

function shell(lang: SetupLanguage, body: string) {
  const t = copy[lang]
  const links = ([['en', 'English'], ['zh-CN', '中文'], ['ja', '日本語']] as const)
    .map(([code, label]) => `<a href="?lang=${code}" lang="${code}">${label}</a>`).join('')
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t.title}</title>${style}</head><body><div class="wrap"><div class="brand">MuseKnock</div>${body}<nav class="langs" aria-label="Language">${links}</nav><p class="muted foot">${t.note}</p></div></body></html>`
}

export const settingsHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const

export function settingsLanding(expiresAt: number, lang: SetupLanguage) {
  const t = copy[lang]
  const expires = new Date(expiresAt).toLocaleString(lang, { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' })
  return shell(lang, `<main class="card"><h1>${t.title}</h1><p>${t.openHint}</p><p class="muted">${t.expires}: ${escape(expires)} JST</p><form method="post" action="?lang=${lang}"><button type="submit">${t.open}</button></form></main>`)
}

export function settingsPage(chats: Chats, sources: Source[], expiresAt: number, lang: SetupLanguage, origin: string, notice?: 'saved' | 'invalid' | 'noEvents' | 'unavailable', detail?: string, openSource?: string) {
  const t = copy[lang]
  const target = `/v1/setup/settings?lang=${lang}`
  const expires = new Date(expiresAt).toLocaleString(lang, { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' })
  const list = chats.chats.map(chat => `<li>${escape(chat.name)}: ${escape(chat.sessionId)}</li>`).join('')
  const options = chats.chats.map(chat => `<option value="${escape(chat.name)}"${chat.name === chats.active ? ' selected' : ''}>${escape(chat.name)}</option>`).join('')
  const known = new Set(sourceCatalog.map(item => item.source))
  const sourceOptions = [
    ...sourceCatalog.map(item => ({ source: item.source, label: item.label[lang], examples: [...item.examples] })),
    ...sources.filter(rule => !known.has(rule.source as typeof sourceCatalog[number]['source']))
      .map(rule => ({ source: rule.source, label: rule.source, examples: [] as string[] })),
  ]
  const current = new Map(sources.map(rule => [rule.source, rule]))
  const docs = lang === 'ja' ? 'README.ja.md' : lang === 'zh-CN' ? 'README.zh-CN.md' : 'README.md'
  const guide = `https://github.com/Code-Hex/MuseKnock/blob/main/${docs}`
  const sourceRows = sourceOptions.map(({ source, label, examples }) => {
    const rule = current.get(source) ?? { source, paused: false, types: [] }
    const status = `${rule.paused ? t.paused : t.allowed} · ${rule.types.length ? t.selectedEvents : t.allEvents}`
    const choices = examples.map(type => `<label class="event-choice"><input type="checkbox" name="type" value="${escape(type)}"${rule.types.includes(type) ? ' checked' : ''}>${escape(type)}</label>`).join('')
    const knownTypes = new Set(examples)
    const otherTypes = rule.types.filter(type => !knownTypes.has(type)).join(', ')
    const connection = connections[source]
    const connectionHtml = connection ? `<div class="connection">${connection.hook ? `<label>${t.webhookUrl}<input readonly value="${escape(`${origin}/v1/hooks/${connection.hook}`)}"></label>` : ''}${connection.secret ? `<p class="muted">${t.workerSecret}: <code>${escape(connection.secret)}</code></p>` : ''}<a href="${guide}#${encodeURIComponent(connection.guide[lang])}" target="_blank" rel="noopener noreferrer">${t.guide}</a></div>` : ''
    return `<details class="source-row" id="source-${escape(source)}"${openSource === source ? ' open' : ''}>
<summary><span class="source-name">${escape(label)}<small>${escape(source)}</small></span><span class="source-status">${status}</span></summary>
<div class="source-body">
${connectionHtml}
<form method="post" action="${target}"><input type="hidden" name="action" value="pause_source"><input type="hidden" name="source" value="${escape(source)}"><input type="hidden" name="paused" value="${!rule.paused}"><button type="submit">${rule.paused ? t.resume : t.pause}</button></form>
<form method="post" action="${target}"><input type="hidden" name="action" value="filter_source"><input type="hidden" name="source" value="${escape(source)}">${choices ? `<fieldset class="event-options"><legend>${t.types}</legend>${choices}</fieldset>` : ''}<label>${t.otherTypes}<input name="otherTypes" value="${escape(otherTypes)}" maxlength="4096"></label><p class="muted">${t.filterHint}</p><div class="actions"><button type="submit" name="mode" value="selected">${t.saveSelected}</button><button type="submit" name="mode" value="all" class="secondary">${t.allowAll}</button></div></form>
</div></details>`
  }).join('')
  const message = notice ? `<p class="notice${notice === 'saved' ? '' : ' error'}" role="status">${t[notice]}${detail ? ' ' + escape(detail) : ''}</p>` : ''
  return shell(lang, `<main><h1>${t.title}</h1><p class="muted">${t.expires}: ${escape(expires)} JST</p>${message}
<section class="card"><h2>${t.chats}</h2><p>${t.active}: ${escape(chats.active ?? t.none)}</p><ul>${list}</ul>
<form method="post" action="${target}"><input type="hidden" name="action" value="register_chat"><label>${t.name}<input name="name" required maxlength="64"></label><label>${t.session}<input name="sessionId" required maxlength="128"></label><button type="submit">${t.register}</button></form>
<form method="post" action="${target}"><input type="hidden" name="action" value="select_chat"><label>${t.name}<span class="select-wrap"><select name="name" required>${options}</select></span></label><button type="submit"${chats.chats.length ? '' : ' disabled'}>${t.select}</button></form></section>
<section class="card"><h2>${t.sources}</h2><p class="muted source-guide">${t.sourceIntro} <a href="${guide}" target="_blank" rel="noopener noreferrer">${t.guide}</a></p><div class="source-list">${sourceRows}</div></section></main>`)
}
