import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Response as WorkerResponse } from 'miniflare'
import { blake2b } from 'blakejs'
import nacl from 'tweetnacl-sealed-box'
import { encryptWebPassword } from '../src/browser-setup.ts'
import { connect } from './mcp-client.ts'
import { startWorker } from './worker.ts'

test('browser password envelope decrypts with the advertised public key', async () => {
  const recipient = nacl.box.keyPair()
  const publicKey = Array.from(recipient.publicKey, byte => byte.toString(16).padStart(2, '0')).join('')
  const result = await encryptWebPassword('test password', 7, publicKey, 1_700_000_000_000)
  assert.match(result, /^#PWD_BROWSER:5:1700000000:/)
  const envelope = Uint8Array.from(atob(result.split(':')[3]), char => char.charCodeAt(0))
  assert.equal(envelope[0], 1)
  assert.equal(envelope[1], 7)
  const sealedLength = new DataView(envelope.buffer).getUint16(2, true)
  const ephemeral = envelope.subarray(4, 36)
  const boxed = envelope.subarray(36, 4 + sealedLength)
  const nonce = blake2b(new Uint8Array([...ephemeral, ...recipient.publicKey]), undefined, 24)
  const aesKey = nacl.box.open(boxed, nonce, ephemeral, recipient.secretKey)
  assert.ok(aesKey)
  const tag = envelope.subarray(4 + sealedLength, 4 + sealedLength + 16)
  const cipher = envelope.subarray(4 + sealedLength + 16)
  const aes = await crypto.subtle.importKey('raw', new Uint8Array(aesKey), 'AES-GCM', false, ['decrypt'])
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(12),
    additionalData: new TextEncoder().encode('1700000000') }, aes, new Uint8Array([...cipher, ...tag]))
  assert.equal(new TextDecoder().decode(plain), 'test password')
})

test('a one-use browser link completes password, SMS and gadget mint without exposing tokens', async t => {
  const calls: string[] = []
  const csrfHeaders: (string | null)[] = []
  const worker = await startWorker(async request => {
    const path = new URL(request.url).pathname
    calls.push(path)
    if (path.startsWith('/api/auth/native/') && path !== '/api/auth/native/restart') {
      csrfHeaders.push(request.headers.get('x-hatch-csrf-token'))
    }
    const body = request.method === 'POST' ? await request.json() as Record<string, unknown> : {}
    if (path === '/api/auth/native/restart') return WorkerResponse.json({
      csrf_token: 'csrf', flow_state: 'new',
    }, { status: 201 })
    if (path === '/api/auth/native/start') return WorkerResponse.json({
      csrf_token: 'csrf-start', flow_state: 'started',
      password_encryption: { key_id: 1, public_key: 'A'.repeat(64) },
    }, { status: 201 })
    if (path === '/api/auth/native/send-otp') {
      assert.equal(body.region, 'JP')
      return WorkerResponse.json({ csrf_token: 'csrf-otp', registration_state: 'password_required', password_login_available: true }, { status: 201 })
    }
    if (path === '/api/auth/native/confirm-password') {
      assert.match(String(body.password), /^#PWD_BROWSER:5:\d+:/)
      assert.doesNotMatch(String(body.password), /private-password/)
      return WorkerResponse.json({ csrf_token: 'csrf-password', registration_state: 'two_factor_required', two_factor_required: true,
        two_factor_methods: [{ method_id: 'sms', method_type: 'SMS' }] })
    }
    if (path === '/api/auth/native/two-factor-send-code') {
      assert.deepEqual(body, { method_id: 'sms' })
      return WorkerResponse.json(calls.filter(call => call === path).length === 1 ? { csrf_token: 'csrf-sms' } : {})
    }
    if (path === '/api/auth/native/two-factor') {
      if (body.code === '000000') {
        return WorkerResponse.json({ csrf_token: 'csrf-retry', type: 'invalid_code' }, { status: 400 })
      }
      assert.equal(body.code, '123456')
      return WorkerResponse.json({ auth_meta_session: { frl_access_token: 'frl' } })
    }
    if (path === '/hatch/login') {
      assert.equal(body.frl_access_token, 'frl')
      return WorkerResponse.json({ access_token: 'user-session', abra_user_id: 'user' })
    }
    if (path === '/hatch/device_token/mint') {
      assert.equal(new URL(request.url).host, 'hatch-api.meta.ai')
      assert.equal(request.headers.get('Authorization'), 'Bearer user-session')
      assert.equal(body.sdk_token, 'mgst_' + 'A'.repeat(43))
      assert.equal(body.abra_device_app_fbid, 1503079994796347)
      assert.match(String(body.device_id), /^homelink-[0-9a-f]{6}$/)
      return WorkerResponse.json({ access_token: 'device-access', refresh_token: 'device-refresh' })
    }
    if (path === '/device_token/refresh') return WorkerResponse.json({ access_token: 'verified-access', refresh_token: 'verified-refresh' })
    return new WorkerResponse(null, { status: 404 })
  }, { MUSE_NODE_ID: undefined, MUSE_REFRESH_TOKEN: undefined })
  t.after(() => worker.close())
  const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
  t.after(() => admin.close())
  const linkTool = (await admin.listTools()).tools.find(tool => tool.name === 'create_browser_setup_link')
  assert.deepEqual(Object.keys(linkTool?.inputSchema.properties ?? {}), ['sessionId'])
  assert.deepEqual(linkTool?.inputSchema.required, ['sessionId'])
  const issued = await admin.callTool({ name: 'create_browser_setup_link', arguments: { sessionId: 'same-chat' } })
  assert.ok(issued.structuredContent, JSON.stringify(issued))
  assert.equal((issued.structuredContent as Record<string, unknown>).sessionId, 'same-chat')
  const url = new URL(String((issued.structuredContent as Record<string, unknown>).url))
  assert.equal(url.origin, worker.url.origin)
  const chinesePage = await fetch(url, { headers: { 'Accept-Language': 'zh-CN, en;q=0.8' } })
  assert.match(await chinesePage.text(), /<html lang="zh-CN"/)
  url.searchParams.set('lang', 'ja')
  const page = await fetch(url)
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('Cache-Control'), 'no-store')
  assert.equal(page.headers.get('Referrer-Policy'), 'same-origin')
  assert.match(await page.text(), /Muse/)
  const submit = (target: URL, body: URLSearchParams, cookie?: string) => fetch(target, {
    method: 'POST', redirect: 'manual',
    headers: { Origin: worker.url.origin, 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
    body,
  })
  assert.equal((await fetch(url, {
    method: 'POST', redirect: 'manual',
    headers: { Origin: 'https://other.example', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ contact: 'person@example.com', region: 'JP' }),
  })).status, 403)
  const started = await submit(url, new URLSearchParams({ contact: 'person@example.com', region: 'JP' }))
  assert.equal(started.status, 303)
  assert.equal(new URL(started.headers.get('Location')!, worker.url).searchParams.get('lang'), 'ja')
  const cookie = started.headers.get('Set-Cookie')!.split(';')[0]
  assert.equal((await submit(url, new URLSearchParams({ contact: 'another@example.com' }))).status, 410)
  const form = new URL('/v1/setup/browser?lang=ja', worker.url)
  assert.match(await (await fetch(form, { headers: { Cookie: cookie } })).text(), /パスワード/)
  const password = await submit(form, new URLSearchParams({ action: 'password', password: 'private-password' }), cookie)
  assert.equal(password.status, 303)
  assert.equal(calls.filter(path => path === '/api/auth/native/two-factor-send-code').length, 1)
  const resend = await submit(form, new URLSearchParams({ action: 'send_code' }), cookie)
  assert.equal(resend.status, 303)
  assert.equal(calls.filter(path => path === '/api/auth/native/two-factor-send-code').length, 2)
  const rejectedCode = await submit(form, new URLSearchParams({ action: 'two_factor', code: '000000' }), cookie)
  assert.equal(rejectedCode.status, 303)
  assert.match(await (await fetch(form, { headers: { Cookie: cookie } })).text(), /HTTP 400, invalid_code/)
  const code = await submit(form, new URLSearchParams({ action: 'two_factor', code: '123456' }), cookie)
  assert.equal(code.status, 303)
  assert.deepEqual(csrfHeaders, ['csrf', 'csrf-start', 'csrf-otp', 'csrf-password', 'csrf-sms', 'csrf-sms', 'csrf-retry'])
  const done = await fetch(form, { headers: { Cookie: cookie } })
  assert.equal(done.status, 200)
  const html = await done.text()
  assert.match(html, /完了|Complete/)
  assert.match(html, /通知先の自動登録/)
  assert.doesNotMatch(html, /private-password|user-session|device-refresh|verified-refresh/)
  assert.ok(calls.includes('/hatch/device_token/mint'))
  assert.ok(calls.includes('/hatch/login'))
  assert.equal(((await admin.callTool({ name: 'get_setup_status' })).structuredContent as Record<string, unknown>).deviceConfigured, true)
  assert.equal(((await admin.callTool({ name: 'get_setup_status' })).structuredContent as Record<string, unknown>).ready, false)
})

test('admin reset clears pairing without issuing a link', async t => {
  const worker = await startWorker(request => {
    if (new URL(request.url).pathname === '/device_token/refresh')
      return WorkerResponse.json({ access_token: 'verified-access', refresh_token: 'verified-refresh' })
    return new WorkerResponse(null, { status: 404 })
  }, { MUSE_NODE_ID: undefined, MUSE_REFRESH_TOKEN: undefined })
  t.after(() => worker.close())
  const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
  t.after(() => admin.close())
  const initial = (await admin.callTool({ name: 'begin_muse_pairing' })).structuredContent as { nodeId: string }
  const paired = await fetch(new URL('/v1/setup/pairing', worker.url), {
    method: 'POST', headers: { Authorization: 'Bearer MCP_ADMIN_TOKEN-test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId: initial.nodeId, sdkToken: 'mgst_' + 'A'.repeat(43), refreshToken: 'first-refresh' }),
  })
  assert.equal(paired.status, 204)
  const alreadyPaired = await admin.callTool({ name: 'create_browser_setup_link', arguments: { sessionId: 'same-chat' } })
  assert.equal(alreadyPaired.isError, true)
  assert.match(JSON.stringify(alreadyPaired.content), /reset/i)
  await worker.setFixtureChat('old-vm')
  const queued = await fetch(new URL('/v1/hooks/custom', worker.url), {
    method: 'POST', headers: { Authorization: 'Bearer HOOK_TOKEN-test' }, body: 'old message',
  })
  assert.equal(queued.status, 202)
  const receipt = await queued.json() as { id: string }
  const endpoint = new URL('/v1/setup/reset', worker.url)
  const reset = (token: string) => fetch(endpoint, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token },
  })
  assert.equal((await reset('MCP_TOKEN-test')).status, 401)
  assert.equal((await fetch(endpoint, {
    method: 'POST', headers: { Authorization: 'Bearer MCP_ADMIN_TOKEN-test', Origin: 'https://other.example' },
  })).status, 403)
  const response = await reset('MCP_ADMIN_TOKEN-test')
  assert.equal(response.status, 204)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(await response.text(), '')
  assert.equal(((await admin.callTool({ name: 'get_setup_status' })).structuredContent as { deviceConfigured: boolean }).deviceConfigured, false)
  const delivery = (await admin.callTool({ name: 'get_delivery_status', arguments: { id: receipt.id } })).structuredContent as { state: string; reason: string }
  assert.deepEqual({ state: delivery.state, reason: delivery.reason }, { state: 'suppressed', reason: 'destination_changed' })
  assert.equal((await admin.callTool({ name: 'create_browser_setup_link' })).isError, true)
  const link = (await admin.callTool({ name: 'create_browser_setup_link', arguments: { sessionId: 'same-chat' } })).structuredContent as { url: string }
  assert.equal((await fetch(link.url)).status, 200)
  assert.equal((await reset('MCP_ADMIN_TOKEN-test')).status, 204)
  assert.equal((await fetch(link.url)).status, 410)
})
