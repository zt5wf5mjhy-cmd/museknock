import type { BrowserSetupIssue, BrowserSetupSession } from './browser-setup.ts'

export type BrowserSetupView = Pick<BrowserSetupSession,
  'stage' | 'error' | 'notice' | 'passwordAvailable' | 'methods' | 'selectedMethod' | 'nodeId' | 'expiresAt'>
export type SetupLanguage = 'en' | 'ja' | 'zh-CN'

const copy = {
  en: {
    contact: 'Connect to Muse', verify: 'Verify your account', done: 'Setup complete',
    doneHint: 'Your Worker is connected to Muse.',
    languageLabel: 'Language', contactLabel: 'Email address or phone number', regionLabel: 'Country code',
    contactButton: 'Continue with Muse', codeLabel: 'Verification code', codeButton: 'Verify code',
    passwordLabel: 'Muse password', passwordButton: 'Continue with password',
    smsHint: 'Enter the code sent by SMS.', twoFactorHint: 'Enter your Muse two-factor code.',
    twoFactorButton: 'Verify and connect', resend: 'Send or resend SMS',
    pending: 'A completion message is on its way to your side chat.',
    chatFailed: 'We could not add the side chat automatically. Register it in Muse.',
    deliveryFailed: 'The side chat is registered, but the completion message could not be queued.',
    manualChat: 'Return to MuseKnock and register your side chat.',
    retry: 'This link could not complete setup. Create a new link in MuseKnock.',
    manualCheck: 'Complete the additional identity check in Muse, then create a new link.',
    invalidStep: 'This action is unavailable at the current sign-in step.',
    genericError: 'Could not connect to Muse or complete sign-in. Please try again.',
    upstreamError: 'Muse declined the sign-in',
    device: 'Worker device ID', expires: 'Link expires',
    disclosureLead: 'This is not an official Meta sign-in page.',
    disclosureDetail: 'Your credentials are sent to Muse’s API by this Worker.',
  },
  ja: {
    contact: 'Muse に接続', verify: '本人確認', done: 'セットアップ完了',
    doneHint: 'Worker が Muse に接続されました。',
    languageLabel: '言語', contactLabel: 'メールアドレスまたは電話番号', regionLabel: '国コード',
    contactButton: 'Muse で続ける', codeLabel: '確認コード', codeButton: 'コードを確認',
    passwordLabel: 'Muse のパスワード', passwordButton: 'パスワードで続ける',
    smsHint: 'SMS で届いたコードを入力してください。', twoFactorHint: 'Muse の二段階認証コードを入力してください。',
    twoFactorButton: '認証して接続', resend: 'SMS を送信・再送',
    pending: 'サイドチャットへ完了通知を送信しています。',
    chatFailed: '通知先の自動登録ができませんでした。Muse でサイドチャットを登録してください。',
    deliveryFailed: '通知先の登録は完了しましたが、完了通知を送信できませんでした。',
    manualChat: 'MuseKnock に戻り、サイドチャットを登録してください。',
    retry: 'このリンクでセットアップを完了できませんでした。MuseKnock で新しいリンクを発行してください。',
    manualCheck: 'Muse 側で追加の本人確認を完了してから、リンクを作り直してください。',
    invalidStep: 'この操作は現在の認証段階では使えません。',
    genericError: 'Muse との接続または認証を完了できませんでした。再試行してください。',
    upstreamError: 'Muse が認証を拒否しました',
    device: 'Worker の端末 ID', expires: 'リンクの有効期限',
    disclosureLead: 'このページは Meta の公式ログインページではありません。',
    disclosureDetail: '入力した認証情報は、この Worker から Muse の API に送られます。',
  },
  'zh-CN': {
    contact: '连接 Muse', verify: '验证身份', done: '设置完成',
    doneHint: 'Worker 已连接到 Muse。',
    languageLabel: '语言', contactLabel: '电子邮箱或手机号码', regionLabel: '国家代码',
    contactButton: '继续使用 Muse', codeLabel: '验证码', codeButton: '验证代码',
    passwordLabel: 'Muse 密码', passwordButton: '使用密码继续',
    smsHint: '请输入短信收到的验证码。', twoFactorHint: '请输入 Muse 的双重验证码。',
    twoFactorButton: '验证并连接', resend: '发送或重发短信',
    pending: '完成通知正在发送到侧边聊天。',
    chatFailed: '无法自动添加侧边聊天。请在 Muse 中注册。',
    deliveryFailed: '侧边聊天已注册，但无法发送完成通知。',
    manualChat: '请返回 MuseKnock 注册侧边聊天。',
    retry: '无法通过此链接完成设置。请在 MuseKnock 中创建新链接。',
    manualCheck: '请先在 Muse 中完成额外身份验证，再创建新链接。',
    invalidStep: '当前登录步骤无法执行此操作。',
    genericError: '无法连接 Muse 或完成登录。请重试。',
    upstreamError: 'Muse 拒绝了登录',
    device: 'Worker 设备 ID', expires: '链接有效期至',
    disclosureLead: '这不是 Meta 官方登录页面。',
    disclosureDetail: '您输入的凭据由此 Worker 发送至 Muse API。',
  },
} as const

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!)

function language(value: string): SetupLanguage | undefined {
  const tag = value.toLowerCase()
  if (tag === 'ja' || tag.startsWith('ja-')) return 'ja'
  if (tag === 'zh' || tag.startsWith('zh-')) return 'zh-CN'
  if (tag === 'en' || tag.startsWith('en-')) return 'en'
}

export function setupLanguage(request: Request): SetupLanguage {
  const explicit = new URL(request.url).searchParams.get('lang')
  if (explicit) return language(explicit) ?? 'en'
  const preferences = (request.headers.get('Accept-Language') ?? '').split(',').map((part, index) => {
    const [tag, ...parameters] = part.trim().split(';')
    const quality = parameters.find(value => value.trim().startsWith('q='))?.trim().slice(2)
    return { tag, index, q: quality === undefined ? 1 : Number(quality) }
  }).filter(item => item.q > 0 && item.q <= 1).sort((a, b) => b.q - a.q || a.index - b.index)
  return preferences.map(item => language(item.tag)).find((item): item is SetupLanguage => !!item) ?? 'en'
}

const failures = {
  en: {
    origin: 'Forbidden origin.', link: 'Setup link expired or used.', session: 'Setup session expired.',
    form: 'Expected a form submission.', contact: 'Invalid contact or region.', step: 'Invalid login step.',
  },
  ja: {
    origin: '許可されていない送信元です。', link: 'セットアップリンクは期限切れ、または使用済みです。',
    session: 'セットアップセッションは期限切れです。', form: 'フォームから送信してください。',
    contact: 'メールアドレス、電話番号、または国コードを確認してください。', step: '無効なログイン操作です。',
  },
  'zh-CN': {
    origin: '不允许的来源。', link: '设置链接已过期或已使用。', session: '设置会话已过期。',
    form: '请通过表单提交。', contact: '电子邮箱、手机号码或国家代码无效。', step: '无效的登录步骤。',
  },
} as const

export function setupFailureText(lang: SetupLanguage, reason: keyof typeof failures.en): string {
  return failures[lang][reason]
}

function issueText(issue: BrowserSetupIssue | undefined, t: typeof copy[SetupLanguage]): string {
  if (!issue) return ''
  if (issue.kind === 'upstream') return `${t.upstreamError} (HTTP ${issue.status}${issue.type ? `, ${escape(issue.type)}` : ''}).`
  return issue.kind === 'manual_check' ? t.manualCheck : issue.kind === 'invalid_step' ? t.invalidStep : t.genericError
}

const styles = `<style>
:root{color-scheme:dark;font-family:optimisticAI,Optimistic,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f7f7f7;background:#181819}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#181819}
.wrap{max-width:560px;margin:auto;padding:28px 20px 42px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:38px}
.brand{font-size:18px;font-weight:600;letter-spacing:-.025em;color:#fff}
.langs{display:flex;gap:3px;padding:3px;border:1px solid #3e3e41;border-radius:999px;background:#28282a}.langs a{padding:6px 9px;border-radius:999px;color:#b8b8bc;text-decoration:none;font-size:12px;font-weight:500}.langs a[aria-current]{background:#4b93ff;color:#fff}
.card{background:#242426;border:1px solid #373739;border-radius:24px;overflow:hidden}.inner{padding:34px 34px 30px}
h1{font-size:clamp(26px,5vw,32px);font-weight:500;line-height:1.2;letter-spacing:-.025em;margin:0 0 28px;color:#fff;text-align:center}p{line-height:1.6}
form+form{margin-top:16px;padding-top:16px;border-top:1px solid #3a3a3d}label{display:block;font-size:13px;font-weight:500;margin:0 0 16px}input{display:block;width:100%;margin-top:8px;padding:12px 16px;min-height:48px;border:1px solid transparent;border-radius:16px;background:#38383a;color:#fff;font:inherit;font-size:16px}input:focus-visible,button:focus-visible,.langs a:focus-visible{outline:2px solid #7bb0ff;outline-offset:2px}button{width:100%;min-height:48px;border:0;border-radius:999px;background:#4b93ff;color:#fff;font:inherit;font-size:16px;font-weight:500;cursor:pointer}button:hover{background:#3584f3}form+form button{background:#39393c;color:#f7f7f7}form+form button:hover{background:#49494d}.hint{margin:0 0 18px;color:#b8b8bc;font-size:14px}.alert{padding:12px 14px;margin:0 0 20px;border-radius:12px;background:#46372c;color:#ffd6b0;font-size:13px}.result{padding:17px 18px;border-radius:14px;background:#293a4d;color:#e4efff;font-size:14px}.result p{margin:0}.result p+p{margin-top:7px}
.meta{display:grid;gap:8px;border-top:1px solid #39393c;padding:19px 34px 23px;color:#a6a6ab;font-size:11px}.meta div{display:flex;justify-content:space-between;gap:12px}.meta code{overflow-wrap:anywhere;color:#d5d5d8;font-size:11px;text-align:right}.disclosure{margin:22px 12px 0;color:#a6a6ab;font-size:11px;text-align:center;line-height:1.65}
@media(max-width:440px){.wrap{padding:20px 14px 28px}.top{margin-bottom:22px}.inner{padding:28px 22px 24px}.meta{padding:17px 22px 21px}.brand{font-size:16px}}
</style>`

export function browserSetupPage(view: BrowserSetupView, initial = false, lang: SetupLanguage = 'en') {
  const t = copy[lang]
  const title = view.stage === 'contact' ? t.contact : view.stage === 'done' ? t.done : t.verify
  const target = initial ? `?lang=${lang}` : `/v1/setup/browser?lang=${lang}`
  const error = view.error ? `<p class="alert" role="alert">${issueText(view.error, t)}</p>` : ''
  let content = ''
  if (view.stage === 'contact') {
    content = `<form method="post" action="${target}"><label for="contact">${t.contactLabel}<input id="contact" name="contact" autocomplete="username" required maxlength="256"></label><label for="region">${t.regionLabel}<input id="region" name="region" value="JP" maxlength="2" pattern="[A-Za-z]{2}" autocapitalize="characters"></label><button type="submit">${t.contactButton}</button></form>`
  } else if (view.stage === 'otp' || view.stage === 'password') {
    if (view.stage === 'otp') content += `<form method="post" action="${target}"><input type="hidden" name="action" value="otp"><label for="otp">${t.codeLabel}<input id="otp" name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="32"></label><button type="submit">${t.codeButton}</button></form>`
    if (view.passwordAvailable) content += `<form method="post" action="${target}"><input type="hidden" name="action" value="password"><label for="password">${t.passwordLabel}<input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024"></label><button type="submit">${t.passwordButton}</button></form>`
  } else if (view.stage === 'two_factor') {
    const method = view.methods?.find(item => item.id === view.selectedMethod) ?? view.methods?.[0]
    const sms = method?.type.toUpperCase() === 'SMS'
    content = `<p class="hint">${sms ? t.smsHint : t.twoFactorHint}</p><form method="post" action="${target}"><input type="hidden" name="action" value="two_factor"><label for="two-factor">${t.codeLabel}<input id="two-factor" name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="32"></label><button type="submit">${t.twoFactorButton}</button></form>`
    if (sms) content += `<form method="post" action="${target}"><input type="hidden" name="action" value="send_code"><button type="submit">${t.resend}</button></form>`
  } else if (view.stage === 'done') {
    const notice = view.notice === 'delivery_pending' ? t.pending : view.notice === 'chat_registration_failed' ? t.chatFailed : view.notice === 'delivery_failed' ? t.deliveryFailed : t.manualChat
    content = `<div class="result"><p>${t.doneHint}</p><p>${notice}</p></div>`
  } else content = `<p class="result">${t.retry}</p>`
  const expires = new Date(view.expiresAt).toLocaleString(lang, { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' })
  const languageLinks = ([['en', 'English'], ['zh-CN', '中文'], ['ja', '日本語']] as const).map(([code, name]) =>
    `<a href="?lang=${code}" lang="${code}"${code === lang ? ' aria-current="page"' : ''}>${name}</a>`).join('')
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · MuseKnock</title>${styles}</head><body><div class="wrap"><header class="top"><div class="brand">MuseKnock</div><nav class="langs" aria-label="${t.languageLabel}">${languageLinks}</nav></header><main class="card"><div class="inner"><h1>${title}</h1>${error}${content}</div><div class="meta"><div><span>${t.device}</span><code>${escape(view.nodeId)}</code></div><div><span>${t.expires}</span><span>${escape(expires)} JST</span></div></div></main><p class="disclosure">${t.disclosureLead}<br>${t.disclosureDetail}</p></div></body></html>`
}

export const browserSetupHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const
