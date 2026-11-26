import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Response } from 'miniflare'
import { connect } from './mcp-client.ts'
import { openSettings } from './settings-client.ts'
import { startConfiguredWorker, startWorker, waitForAssertion } from './worker.ts'

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value))
}

test('MCP readers inspect delivery rules; only administrators can change them', async (t) => {
  const worker = await startConfiguredWorker()
  t.after(() => worker.close())
  const url = new URL('/mcp', worker.url)
  const reader = await connect(url, 'MCP_TOKEN-test')
  const admin = await connect(url, 'MCP_ADMIN_TOKEN-test')
  t.after(() => Promise.all([reader.close(), admin.close()]))

  assert.deepEqual((await reader.listTools()).tools.map((tool) => tool.name).sort(), [
    'get_delivery_breaker',
    'get_delivery_status',
    'get_setup_status',
    'list_side_chats',
    'list_sources',
  ])
  assert.deepEqual((await admin.listTools()).tools.map((tool) => tool.name).sort(), [
    'begin_muse_pairing',
    'create_browser_setup_link',
    'create_settings_link',
    'get_delivery_breaker',
    'get_delivery_status',
    'get_setup_status',
    'list_side_chats',
    'list_sources',
    'send_test_notification',
  ])

  assert.deepEqual((await reader.callTool({ name: 'list_side_chats' })).structuredContent, {
    active: 'Notifications',
    chats: [{ name: 'Notifications', sessionId: 'same-chat' }],
  })

  assert.deepEqual((await reader.callTool({ name: 'get_delivery_breaker' })).structuredContent, {
    state: 'disabled',
  })

  const pause = { name: 'set_source_paused', arguments: { source: 'ci', paused: true } }
  assert.equal((await reader.callTool(pause)).isError, true)
  assert.equal((await admin.callTool(pause)).isError, true)
  const settings = await openSettings(worker.url, admin)
  assert.deepEqual((await reader.callTool({ name: 'list_sources' })).structuredContent, {
    sources: [],
  })
  assert.equal((await settings.pause('ci', true)).status, 303)
  assert.deepEqual(((await reader.callTool({ name: 'list_sources' })).structuredContent as { sources: unknown[] }).sources[0], {
    source: 'ci',
    paused: true,
    types: [],
  })
  assert.equal((await settings.filter('ci', ['failed'])).status, 303)
  assert.deepEqual((await reader.callTool({ name: 'list_sources' })).structuredContent, {
    sources: [{ source: 'ci', paused: true, types: ['failed'] }],
  })

  assert.equal((await settings.filter('ci', ['not an event type'])).status, 400)
  assert.equal(
    (
      await reader.callTool({
        name: 'get_delivery_status',
        arguments: { id: crypto.randomUUID() },
      })
    ).isError,
    true,
  )

  const hook = await fetch(new URL('/v1/hooks/custom', worker.url), {
    method: 'POST',
    headers: { Authorization: 'Bearer HOOK_TOKEN-test', 'X-Event-Type': 'opened' },
    body: 'sensitive event body',
  })
  assert.equal(hook.status, 202)
  const receipt = await hook.json()
  const status = (
    await reader.callTool({
      name: 'get_delivery_status',
      arguments: { id: receipt.id.toUpperCase() },
    })
  ).structuredContent
  assert.ok(status && typeof status === 'object' && 'createdAt' in status)
  assert.equal(typeof status.createdAt, 'number')
  assert.deepEqual(status, {
    id: receipt.id,
    source: 'custom',
    type: 'opened',
    state: 'queued',
    createdAt: status.createdAt,
  })

  const foreignOrigin = await fetch(url, {
    method: 'GET',
    headers: { Origin: 'https://other.example', Authorization: 'Bearer MCP_ADMIN_TOKEN-test' },
  })
  assert.equal(foreignOrigin.status, 403)
})

test('first setup preserves an empty registry when Muse cannot verify a destination', async (t) => {
  const worker = await startWorker()
  t.after(() => worker.close())
  const url = new URL('/mcp', worker.url)
  const reader = await connect(url, 'MCP_TOKEN-test')
  const admin = await connect(url, 'MCP_ADMIN_TOKEN-test')
  t.after(() => Promise.all([reader.close(), admin.close()]))
  const settings = await openSettings(worker.url, admin)

  const list = () => reader.callTool({ name: 'list_side_chats' })
  const post = () =>
    fetch(new URL('/v1/hooks/custom', worker.url), {
      method: 'POST',
      headers: { Authorization: 'Bearer HOOK_TOKEN-test' },
      body: 'browser setup complete',
    })

  const setup = () => reader.callTool({ name: 'get_setup_status' })
  assert.deepEqual((await setup()).structuredContent, {
    credentialStorageReady: true,
    deviceConfigured: true,
    active: null,
    ready: false,
  })
  const requestId = crypto.randomUUID()
  const sendTest = { name: 'send_test_notification', arguments: { requestId } }
  const missingDestination = await admin.callTool(sendTest)
  assert.equal(missingDestination.isError, true)
  assert.match(JSON.stringify(missingDestination.content), /register.*side chat/i)
  assert.deepEqual((await list()).structuredContent, { active: null, chats: [] })
  assert.equal((await post()).status, 503)
  assert.equal((await reader.callTool({ name: 'register_side_chat', arguments: { name: 'Builds', sessionId: 'room-1' } })).isError, true)
  assert.equal((await settings.register('bad\nname', 'room-1')).status, 400)
  assert.equal((await settings.register('untrusted', 'https://invalid.example')).status, 400)
  const unavailable = await settings.register('Builds', 'room-1')
  assert.equal(unavailable.status, 422)
  assert.match(await unavailable.text(), /could not verify/i)
  assert.equal((await settings.select('missing')).status, 422)
  assert.deepEqual((await list()).structuredContent, { active: null, chats: [] })
  assert.equal((await post()).status, 503)
})

test('MCP setup checks disclose no device secrets and never send an implicit test', async (t) => {
  const worker = await startWorker(undefined, { MUSE_REFRESH_TOKEN: '' })
  t.after(() => worker.close())
  const url = new URL('/mcp', worker.url)
  const admin = await connect(url, 'MCP_ADMIN_TOKEN-test')
  t.after(() => admin.close())
  assert.deepEqual((await admin.callTool({ name: 'get_setup_status' })).structuredContent, {
    credentialStorageReady: true,
    deviceConfigured: false,
    active: null,
    ready: false,
  })
  const missingDevice = await admin.callTool({
    name: 'send_test_notification',
    arguments: { requestId: crypto.randomUUID() },
  })
  assert.equal(missingDevice.isError, true)
  assert.match(JSON.stringify(missingDevice.content), /device.*(secrets|credentials)/i)
  assert.deepEqual((await admin.callTool({ name: 'list_sources' })).structuredContent, {
    sources: [],
  })
})

test('MCP test notifications respect the source pause and rate limits', async (t) => {
  const worker = await startConfiguredWorker()
  t.after(() => worker.close())
  const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
  t.after(() => admin.close())
  const settings = await openSettings(worker.url, admin)
  assert.equal((await settings.pause('museknock-test', true)).status, 303)
  const send = () =>
    admin.callTool({
      name: 'send_test_notification',
      arguments: { requestId: crypto.randomUUID() },
    })
  for (let i = 0; i < 10; i++) {
    const receipt = (await send()).structuredContent
    assertRecord(receipt)
    assert.equal(receipt.state, 'suppressed')
  }
  const limited = await send()
  assert.equal(limited.isError, true)
  assert.match(JSON.stringify(limited.content), /rate limit/i)
})

test('a shared webhook or read-only credential cannot authorize MCP administration', async (t) => {
  for (const reused of ['HOOK_TOKEN', 'MCP_TOKEN']) {
    const token = reused + '-test'
    const worker = await startConfiguredWorker(undefined, { MCP_ADMIN_TOKEN: token })
    t.after(() => worker.close())
    const response = await fetch(new URL('/mcp', worker.url), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
    })
    assert.equal(response.status, 503)
  }
})

test('credential storage must be available before accepting deliveries or refreshing tokens', async (t) => {
  const calls: string[] = []
  for (const key of ['', 'a'.repeat(64)]) {
    const worker = await startConfiguredWorker(
      (req) => {
        calls.push(req.url)
        throw new Error('Unexpected outbound request')
      },
      { CREDENTIAL_ENCRYPTION_KEY: key, HOOK_TOKEN: 'A'.repeat(64) },
    )
    t.after(() => worker.close())
    const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
    t.after(() => admin.close())
    const status = (await admin.callTool({ name: 'get_setup_status' })).structuredContent
    assert.deepEqual(status, {
      deviceConfigured: true,
      active: 'Notifications',
      credentialStorageReady: false,
      ready: false,
    })
    const test = await admin.callTool({
      name: 'send_test_notification',
      arguments: { requestId: crypto.randomUUID() },
    })
    assert.equal(test.isError, true)
    const response = await fetch(new URL('/v1/hooks/custom', worker.url), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + 'A'.repeat(64) },
      body: 'test',
    })
    assert.equal(response.status, 503)
  }
  assert.deepEqual(calls, [])
})

test('only the recovery connector can rearm the shared breaker after a delivery attempt', async (t) => {
  const worker = await startConfiguredWorker(
    (req) => {
      const path = new URL(req.url).pathname
      if (path === '/device_token/refresh') {
        return Response.json({ access_token: 'test-access', refresh_token: 'new-refresh' })
      }
      if (path === '/fetch_vms') {
        return Response.json({
          vm_list: [
            { vm_id: 'local-vm', vm_auth_token: 'test-vm-token', vm_ws_url: 'wss://example.test' },
          ],
        })
      }
      return new Response(null, { status: 503 })
    },
    { CIRCUIT_BREAKER: '{"maxAttempts":1}', MCP_RECOVERY_TOKEN: 'operator-only' },
  )
  t.after(() => worker.close())
  const url = new URL('/mcp', worker.url)
  const reader = await connect(url, 'MCP_TOKEN-test')
  const admin = await connect(url, 'MCP_ADMIN_TOKEN-test')
  const operator = await connect(url, 'operator-only')
  t.after(() => Promise.all([reader.close(), admin.close(), operator.close()]))
  const list = async (client: typeof reader) =>
    (await client.listTools()).tools.map((tool) => tool.name).sort()
  assert.deepEqual(await list(operator), [...(await list(reader)), 'rearm_delivery_breaker'].sort())
  const testPost = { name: 'send_test_notification', arguments: { requestId: crypto.randomUUID() } }
  assert.equal((await operator.callTool(testPost)).isError, true)
  const status = async () => {
    const data = (await reader.callTool({ name: 'get_delivery_breaker' })).structuredContent
    assertRecord(data)
    return data
  }
  const reset = { name: 'rearm_delivery_breaker', arguments: { expectedGeneration: 1 } }
  assert.equal((await status()).state, 'closed')
  assert.equal((await operator.callTool(reset)).isError, true)
  assert.equal(
    (await operator.callTool({ ...reset, arguments: { expectedGeneration: 0 } })).isError,
    true,
  )
  const receipt = (await admin.callTool(testPost)).structuredContent
  assertRecord(receipt)
  await waitForAssertion(async () => {
    const delivery = await reader.callTool({
      name: 'get_delivery_status',
      arguments: { id: receipt.id },
    })
    assertRecord(delivery.structuredContent)
    assert.equal(delivery.structuredContent.state, 'suppressed')
  })
  assert.equal((await status()).state, 'open')
  for (const client of [reader, admin]) assert.equal((await client.callTool(reset)).isError, true)
  assert.notEqual((await operator.callTool(reset)).isError, true)
  const after = await status()
  assert.equal(after.generation, 2)
  assert.equal(after.remaining, 1)
  assert.equal(after.state, 'closed')
  assert.equal((await operator.callTool(reset)).isError, true)
  assert.deepEqual(await status(), after)
})

test('a recovery credential shared with another bearer role disables bearer-protected routes', async (t) => {
  for (const conflictingRole of ['HOOK_TOKEN', 'MCP_TOKEN', 'MCP_ADMIN_TOKEN']) {
    const token = conflictingRole + '-test'
    const worker = await startConfiguredWorker(undefined, { MCP_RECOVERY_TOKEN: token })
    t.after(() => worker.close())
    for (const path of ['/mcp', '/v1/hooks/custom']) {
      const response = await fetch(new URL(path, worker.url), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
      })
      assert.equal(response.status, 503)
    }
  }
})

test('initial setup needs only the admin role before an optional event source is enabled', async (t) => {
  const worker = await startConfiguredWorker(undefined, { HOOK_TOKEN: '', MCP_TOKEN: '' })
  t.after(() => worker.close())
  const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
  t.after(() => admin.close())
  const status = await admin.callTool({ name: 'get_setup_status' })
  assertRecord(status.structuredContent)
  assert.equal(status.structuredContent.ready, true)
  const custom = await fetch(new URL('/v1/hooks/custom', worker.url), {
    method: 'POST', headers: { Authorization: 'Bearer MCP_ADMIN_TOKEN-test' }, body: 'event',
  })
  assert.equal(custom.status, 401)
})
