import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Response } from 'miniflare'
import { connect } from './mcp-client.ts'
import { openSettings } from './settings-client.ts'
import { startWorker } from './worker.ts'

test('switching pairings keeps each rotated token usable across Worker deployments', async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'museknock-pairings-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  const expected = new Map([['a', 'bootstrap-a'], ['b', 'bootstrap-b']])
  const refreshes: string[] = []
  const secret = '24'.repeat(32)
  for (const [pairing, seed, key] of [
    ['a', 'bootstrap-a', secret],
    ['b', 'bootstrap-b', '57'.repeat(32)],
    ['b', 'bootstrap-b', secret],
    ['a', 'hatch_refresh:bootstrap-a', secret],
  ]) {
    const worker = await startWorker((request) => {
      const url = new URL(request.url)
      if (url.pathname === '/device_token/refresh') {
        const refresh = request.headers.get('Authorization')?.replace('Bearer hatch_refresh:', '')
        refreshes.push(refresh ?? '')
        if (refresh !== expected.get(pairing)) return new Response(null, { status: 401 })
        const next = 'rotated-' + refreshes.length
        expected.set(pairing, next)
        return Response.json({ access_token: 'access-' + next, refresh_token: next })
      }
      // Expire the cached access token when the operator returns to A.
      if (url.pathname === '/fetch_vms' && refreshes.length === 2 && pairing === 'a')
        return new Response(null, { status: 401 })
      if (url.pathname === '/fetch_vms') return Response.json({
        vm_list: [{ vm_id: 'local-vm', vm_auth_token: 'test-token', vm_url: 'https://vm.example' }],
      })
      assert.equal(url.pathname, '/v1/noise')
      return new Response(null, { status: 503 })
    }, { MUSE_REFRESH_TOKEN: seed, CREDENTIAL_ENCRYPTION_KEY: key }, path)
    try {
      const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
      try {
        const status = await admin.callTool({ name: 'get_setup_status' })
        assert.deepEqual(status.structuredContent, {
          active: null, deviceConfigured: true, credentialStorageReady: key === secret, ready: false,
        })
        const settings = await openSettings(worker.url, admin)
        assert.equal((await settings.register('alerts', 'existing')).status, 422)
      } finally {
        await admin.close()
      }
    } finally {
      await worker.close()
    }
  }
  assert.deepEqual(refreshes, ['bootstrap-a', 'bootstrap-b', 'rotated-1'])
})

test('removing all three setup secrets preserves the chat, webhook ingress and rotated credentials', async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'museknock-handoff-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  const removed = { MUSE_NODE_ID: undefined, MUSE_SDK_TOKEN: undefined, MUSE_REFRESH_TOKEN: undefined }
  const refreshes: string[] = []
  const deployments: Record<string, string | undefined>[] = [{}, { MUSE_SDK_TOKEN: undefined }, removed]
  for (const [step, overrides] of deployments.entries()) {
    const worker = await startWorker(async (request) => {
      const endpoint = new URL(request.url).pathname
      if (endpoint === '/device_token/refresh') {
        assert.deepEqual(await request.json(), { device_id: 'test-123abc', sdk_token: 'mgst_' + 'A'.repeat(43) })
        refreshes.push(request.headers.get('Authorization')!)
        return Response.json({ access_token: 'access-' + step, refresh_token: 'rotated-' + step })
      }
      if (endpoint === '/fetch_vms') {
        if (step === 2 && request.headers.get('Authorization') === 'Bearer access-0') {
          return new Response(null, { status: 401 })
        }
        return Response.json({ vm_list: [{ vm_id: 'local-vm', vm_auth_token: 'vm-token', vm_url: 'https://vm.example' }] })
      }
      return new Response(null, { status: 503 })
    }, { TELEGRAM_WEBHOOK_SECRET: 'fixture-token', ...overrides }, path)
    try {
      if (step === 0) await worker.setFixtureChat('local-vm')
      const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
      try {
        const status = await admin.callTool({ name: 'get_setup_status' })
        assert.deepEqual(status.structuredContent, {
          deviceConfigured: step !== 1, credentialStorageReady: true,
          active: step === 1 ? null : 'Notifications', ready: step !== 1,
        })
        const settings = await openSettings(worker.url, admin)
        await settings.register('check', 'existing')
        if (step > 0) {
          for (const source of ['custom', 'telegram']) {
            assert.equal((await settings.pause(source, true)).status, 303)
          }
          const hook = await fetch(new URL('/v1/hooks/custom', worker.url), {
            method: 'POST', headers: { Authorization: 'Bearer HOOK_TOKEN-test' }, body: 'handoff',
          })
          assert.equal(hook.status, step === 1 ? 503 : 202)
          await hook.text()
          const telegram = await fetch(new URL('/v1/hooks/telegram', worker.url), {
            method: 'POST',
            headers: { 'X-Telegram-Bot-Api-Secret-Token': 'fixture-token' },
            body: JSON.stringify({ update_id: 42, message: { message_id: 12, chat: { id: -5 }, text: 'handoff' } }),
          })
          assert.equal(telegram.status, step === 1 ? 503 : 200)
          await telegram.text()
        }
      } finally { await admin.close() }
    } finally { await worker.close() }
  }
  assert.deepEqual(refreshes, ['Bearer hatch_refresh:test-initial-refresh', 'Bearer hatch_refresh:rotated-0'])
})

test('a corrected bootstrap SDK token uses the rotated refresh token and clears a previous rejection', async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'museknock-sdk-correction-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  const used: [string, string][] = []
  const first = 'mgst_' + 'A'.repeat(43)
  const corrected = 'mgst_' + 'B'.repeat(42) + 'A'
  for (const [step, sdkToken] of [first, first, first, corrected].entries()) {
    const worker = await startWorker(async request => {
      if (new URL(request.url).pathname === '/device_token/refresh') {
        const { sdk_token } = (await request.json()) as { sdk_token: string }
        used.push([sdk_token, request.headers.get('Authorization')!])
        if (step === 1) return new Response(null, { status: 401 })
        return Response.json({ access_token: 'access', refresh_token: 'rotated' })
      }
      if (new URL(request.url).pathname === '/fetch_vms' && step !== 1) return Response.json({
        vm_list: [{ vm_id: 'vm', vm_auth_token: 'vm-token', vm_url: 'https://vm.example' }],
      })
      return new Response(null, { status: 401 })
    }, { MUSE_SDK_TOKEN: sdkToken }, path)
    try {
      const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
      try {
        const before = await admin.callTool({ name: 'begin_muse_pairing' })
        assert.deepEqual(before.structuredContent, {
          state: 'configured', verification: ['unverified', 'verified', 'rejected', 'unverified'][step],
        })
        if (step === 2) {
          const hook = await fetch(new URL('/v1/hooks/custom', worker.url), {
            method: 'POST', headers: { Authorization: 'Bearer HOOK_TOKEN-test' }, body: 'waiting for repair',
          })
          assert.equal(hook.status, 503)
          assert.match(await hook.text(), /Configure the Muse device/)
          continue
        }
        const settings = await openSettings(worker.url, admin)
        await settings.register('check', 'existing')
        const result = await admin.callTool({name: 'begin_muse_pairing'})
        assert.deepEqual(result.structuredContent, {state:'configured', verification:step === 1 ? 'rejected' : 'verified'})
        const managed = await admin.callTool({ name: 'begin_muse_pairing', arguments: { replace: true } })
        assert.equal(managed.isError, true)
        assert.deepEqual(managed.structuredContent, { state: 'managed_by_secrets' })
      } finally { await admin.close() }
    } finally { await worker.close() }
  }
  assert.deepEqual(used, [[first, 'Bearer hatch_refresh:test-initial-refresh'],
    [first, 'Bearer hatch_refresh:rotated'], [corrected, 'Bearer hatch_refresh:rotated']])
})

test('a replacement waiting for Muse keeps accepting webhooks for the current chat', async (t) => {
  let markVerifying!: () => void
  const verifying = new Promise<void>(resolve => { markVerifying = resolve })
  let release!: () => void
  const continueVerification = new Promise<void>(resolve => { release = resolve })
  const worker = await startWorker(async (req) => {
    if (req.headers.get('Authorization') === 'Bearer hatch_refresh:replacement') {
      markVerifying()
      await continueVerification
      return new Response(null, { status: 401 })
    }
    if (new URL(req.url).pathname === '/device_token/refresh')
      return Response.json({ access_token: 'access', refresh_token: 'rotated' })
    return new Response(null, { status: 503 })
  }, { MUSE_NODE_ID: undefined, MUSE_SDK_TOKEN: undefined, MUSE_REFRESH_TOKEN: undefined })
  t.after(() => worker.close())
  const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
  t.after(() => admin.close())
  const begin = async (replace = false) =>
    (await admin.callTool({ name: 'begin_muse_pairing', arguments: { replace } })).structuredContent as Record<string, unknown>
  const { nodeId } = await begin()
  const post = (refreshToken: string, replaces?: unknown) => fetch(new URL('/v1/setup/pairing', worker.url), {
    method: 'POST', headers: { Authorization: 'Bearer MCP_ADMIN_TOKEN-test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId, sdkToken: 'mgst_' + 'A'.repeat(43), refreshToken, replaces }),
  })
  assert.equal((await post('first')).status, 204)
  await worker.setFixtureChat('vm')
  const settings = await openSettings(worker.url, admin)
  assert.equal((await settings.pause('custom', true)).status, 303)
  const replacement = post('replacement', (await begin(true)).replaces)
  await verifying
  try {
    const response = await fetch(new URL('/v1/hooks/custom', worker.url), {
      method: 'POST', headers: { Authorization: 'Bearer HOOK_TOKEN-test' }, body: 'during verification',
      signal: AbortSignal.timeout(2000),
    })
    assert.equal(response.status, 202)
    assert.equal((await response.json() as { state: string }).state, 'suppressed')
  } finally {
    release()
    assert.equal((await replacement).status, 422)
  }
})

test('a pairing retry saves the rotated credentials after a storage outage without rotating again', async (t) => {
  const used: string[] = []
  const worker = await startWorker((req) => {
    used.push(req.headers.get('Authorization')!)
    if (used.length > 1) return new Response(null, { status: 401 })
    return Response.json({ access_token: 'access', refresh_token: 'rotated' })
  }, { MUSE_NODE_ID: undefined, MUSE_SDK_TOKEN: undefined, MUSE_REFRESH_TOKEN: undefined })
  t.after(() => worker.close())
  const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
  t.after(() => admin.close())
  const begin = async () => (await admin.callTool({ name: 'begin_muse_pairing' })).structuredContent as Record<string, unknown>
  const { nodeId } = await begin()
  const post = () => fetch(new URL('/v1/setup/pairing', worker.url), {
    method: 'POST', headers: { Authorization: 'Bearer MCP_ADMIN_TOKEN-test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId, sdkToken: 'mgst_' + 'A'.repeat(43), refreshToken: 'first' }),
  })
  await worker.failCredentialWrites(2)
  assert.equal((await post()).status, 503)
  assert.equal((await post()).status, 204)
  assert.deepEqual(await begin(), { state: 'configured', verification: 'verified' })
  assert.deepEqual(used, ['Bearer hatch_refresh:first'])
})

test('lease discovery saves a rotated device again after a transient write failure', async (t) => {
  const requests: [string, string][] = []
  const worker = await startWorker((req) => {
    const path = new URL(req.url).pathname
    requests.push([path, req.headers.get('Authorization')!])
    if (path === '/device_token/refresh') return Response.json({ access_token: 'access', refresh_token: 'rotated' })
    return Response.json({ vm_list: [] })
  })
  t.after(() => worker.close())
  const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
  t.after(() => admin.close())
  await worker.failCredentialWrites(1)
  const settings = await openSettings(worker.url, admin)
  await settings.register('chat', 'session')
  assert.deepEqual(requests, [
    ['/device_token/refresh', 'Bearer hatch_refresh:test-initial-refresh'], ['/fetch_vms', 'Bearer access'],
  ])
  const pairing = (await admin.callTool({ name: 'begin_muse_pairing' })).structuredContent
  assert.deepEqual(pairing, { state: 'configured', verification: 'verified' })
})

test('an invalid breaker configuration reports why a configured Worker cannot accept webhooks', async (t) => {
  const worker = await startWorker(undefined, { CIRCUIT_BREAKER: 'bad' })
  t.after(() => worker.close())
  await worker.setFixtureChat('vm')
  const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
  t.after(() => admin.close())
  const result = await admin.callTool({ name: 'get_setup_status' })
  assert.deepEqual(result.structuredContent, {
    deviceConfigured: true, credentialStorageReady: true, active: 'Notifications', ready: false, reason: 'invalid_circuit_breaker',
  })
})
