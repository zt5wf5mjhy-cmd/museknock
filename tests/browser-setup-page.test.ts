import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserSetupPage, setupLanguage } from '../src/browser-setup-page.ts'

const view = { stage: 'contact' as const, nodeId: 'homelink-123abc', expiresAt: 1_700_000_000_000 }

test('setup language follows the explicit choice, then browser preferences', () => {
  assert.equal(setupLanguage(new Request('https://example.com/setup?lang=ja', { headers: { 'Accept-Language': 'en-US' } })), 'ja')
  assert.equal(setupLanguage(new Request('https://example.com/setup', { headers: { 'Accept-Language': 'fr, zh-TW;q=0.8, ja;q=0.9' } })), 'ja')
  assert.equal(setupLanguage(new Request('https://example.com/setup', { headers: { 'Accept-Language': 'zh-CN, en;q=0.8' } })), 'zh-CN')
  assert.equal(setupLanguage(new Request('https://example.com/setup')), 'en')
})

test('setup renders all three languages with local forms and no external assets', () => {
  const expected = [
    ['en', 'Connect to Muse', 'Email address or phone number', 'Continue with Muse', 'This is not an official Meta sign-in page.'],
    ['ja', 'Muse に接続', 'メールアドレスまたは電話番号', 'Muse で続ける', 'このページは Meta の公式ログインページではありません。'],
    ['zh-CN', '连接 Muse', '电子邮箱或手机号码', '继续使用 Muse', '这不是 Meta 官方登录页面。'],
  ] as const
  for (const [lang, title, label, button, disclosureLead] of expected) {
    const html = browserSetupPage(view, true, lang)
    assert.match(html, new RegExp(`<html lang="${lang}"`))
    assert.ok(html.includes(`<h1>${title}</h1>`))
    assert.ok(html.includes(label))
    assert.ok(html.includes(button))
    assert.ok(html.includes(`${disclosureLead}<br>`))
    assert.doesNotMatch(html, /ノックして|A little knock|轻敲一下|class="progress"|class="eyebrow"/)
    assert.ok(html.includes(`action="?lang=${lang}"`))
    assert.ok(html.includes('name="contact"'))
    assert.doesNotMatch(html, /<script|<link|<img|@import|url\(/i)
    assert.ok(new TextEncoder().encode(html).length < 18_000)
  }
})

test('setup translates stages, errors and notices without exposing markup', () => {
  const html = browserSetupPage({ ...view, stage: 'done', error: { kind: 'upstream', status: 400, type: 'bad_request' }, notice: 'delivery_pending', nodeId: '<script>' }, false, 'zh-CN')
  assert.ok(html.includes('设置完成'))
  assert.ok(html.includes('HTTP 400'))
  assert.ok(html.includes('bad_request'))
  assert.ok(html.includes('&lt;script&gt;'))
  assert.doesNotMatch(html, /<script>/)
  assert.ok(html.includes('href="?lang=ja"'))
  const japanese = browserSetupPage({ ...view, stage: 'two_factor', methods: [{ id: 'sms', type: 'SMS' }], selectedMethod: 'sms' }, false, 'ja')
  assert.ok(japanese.includes('SMS で届いたコード'))
  assert.ok(japanese.includes('SMS を送信・再送'))
  assert.ok(japanese.includes('action="/v1/setup/browser?lang=ja"'))
  const english = browserSetupPage({ ...view, stage: 'password', passwordAvailable: true }, false, 'en')
  assert.ok(english.includes('Muse password'))
  assert.ok(english.includes('Continue with password'))
})
