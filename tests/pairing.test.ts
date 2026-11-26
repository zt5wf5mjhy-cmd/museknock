import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Response as WorkerResponse } from 'miniflare'
import { startPairingPage } from '../scripts/pair-browser.ts'
import { beginPairing, uploadPairing } from '../scripts/worker-pairing.ts'
import { startWorker } from './worker.ts'
import { connect } from './mcp-client.ts'

const sdkToken = 'mgst_' + 'A'.repeat(43)
const blank = { MUSE_NODE_ID: undefined, MUSE_SDK_TOKEN: undefined, MUSE_REFRESH_TOKEN: undefined }

test('the pairing page accepts credentials only from its local origin', async (t) => {
  const page = await startPairingPage()
  t.after(page.close)
  const screen = await fetch(page.url)
  assert.equal(screen.status, 200)
  assert.equal(screen.headers.get('Cache-Control'), 'no-store')
  assert.match(await screen.text(), /Start pairing/)
  const submit = (origin: string) => fetch(page.url, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ worker: 'http://example.com', admin: 'test', sdkToken, replace: false }),
  })
  assert.equal((await submit('https://example.com')).status, 403)
  assert.equal((await submit(page.url.origin)).status, 400)
})

test('a lost upload acknowledgement is resolved against the exact pairing after Bluetooth exits', async t => {
  const worker = await startWorker(() => WorkerResponse.json({ access_token: 'access', refresh_token: 'rotated' }), blank)
  t.after(() => worker.close())
  const options = { worker: worker.url, admin: 'MCP_ADMIN_TOKEN-test', signal: new AbortController().signal }
  const pending = await beginPairing(options)
  assert.equal(pending.state, 'awaiting_authorization')
  const device = { nodeId: pending.nodeId, sdkToken, refreshToken: 'first-pair' }
  let posts = 0
  const lifetime = new AbortController()
  const lostResponse: typeof fetch = async (url, init) => {
    if (new URL(String(url)).pathname === '/v1/setup/pairing') {
      posts++
      const response = await fetch(url, init)
      assert.equal(response.status, 204)
      lifetime.abort()
      throw new Error('Lost acknowledgement')
    }
    return fetch(url, init)
  }
  await uploadPairing({ ...options, transport: lostResponse }, device, undefined, lifetime.signal)
  assert.equal(posts, 1)

  const interrupted = new AbortController()
  const neverUploaded: typeof fetch = async (url, init) => {
    if (new URL(String(url)).pathname === '/v1/setup/pairing') {
      posts++
      interrupted.abort()
      throw new Error('Connection closed')
    }
    return fetch(url, init)
  }
  await assert.rejects(uploadPairing({ ...options, transport: neverUploaded }, {
    ...device, refreshToken: 'different-proposal',
  }, undefined, interrupted.signal), /could not confirm this pairing/i)
  assert.equal(posts, 2)
})

test('only the admin can provision a fresh Worker and an existing pairing survives retries and restarts', async t => {
  const path = await mkdtemp(join(tmpdir(), 'museknock-import-'))
  t.after(() => rm(path, { force: true, recursive: true }))
  const pair = { nodeId: 'homelink-123abc', sdkToken, refreshToken: 'device-refresh' }
  const begin = { name: 'begin_muse_pairing' }
  const refreshes: string[] = []
  const outbound: Parameters<typeof startWorker>[0] = req => {
    if (new URL(req.url).pathname === '/fetch_vms') return WorkerResponse.json({ vm_list: [] })
    assert.equal(new URL(req.url).pathname, '/device_token/refresh')
    const bearer = req.headers.get('Authorization') ?? ''
    refreshes.push(bearer)
    if (bearer.endsWith(':bad')) return new WorkerResponse(null, { status: 401 })
    if (bearer.endsWith(':down')) return new WorkerResponse(null, { status: 503 })
    return WorkerResponse.json({ access_token: 'verified-access', refresh_token: 'verified-' + refreshes.length })
  }
  for (const stage of ['begin', 'finish', 'restart']) {
    const worker = await startWorker(outbound, { ...blank, MCP_RECOVERY_TOKEN: 'MCP_RECOVERY_TOKEN-test' }, path)
    const endpoint = new URL('/v1/setup/pairing', worker.url)
    const post = (token: string, body: unknown) => fetch(endpoint, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const admin = 'MCP_ADMIN_TOKEN-test'
    const client = await connect(new URL('/mcp', worker.url), admin)
    try {
      const result = await client.callTool(begin)
      const details = result.structuredContent as Record<string, unknown>
      assert.ok(details)
      if (stage === 'begin') {
        const node = details.nodeId
        assert.equal(details.state, 'awaiting_authorization')
        assert.match(String(details.instructions), /npm run pair\./)
        assert.equal(typeof node, 'string')
        assert.match(String(node), /^homelink-[a-f0-9]{6}$/)
        pair.nodeId = String(node)
        for (const token of ['MCP_TOKEN-test', 'MCP_RECOVERY_TOKEN-test']) {
          const limited = await connect(new URL('/mcp', worker.url), token)
          try { assert.equal((await limited.callTool(begin)).isError, true) } finally { await limited.close() }
        }
        continue
      }
      if (stage === 'finish') {
        assert.equal(details.nodeId, pair.nodeId)
        assert.equal((await post(admin, { ...pair, refreshToken: 'bad' })).status, 422)
        assert.equal((await post(admin, { ...pair, refreshToken: 'down' })).status, 503)
        assert.equal(((await client.callTool(begin)).structuredContent as Record<string, unknown>).state, 'awaiting_authorization')
        const wrong = pair.nodeId.endsWith('0') ? '1' : '0'
        assert.equal((await post(admin, { ...pair, nodeId: pair.nodeId.slice(0, -1) + wrong })).status, 409)
      } else {
        assert.deepEqual(result.structuredContent, { state: 'configured', verification: 'verified' })
      }
      for (const other of ['MCP_TOKEN-test', 'HOOK_TOKEN-test']) assert.equal((await post(other, pair)).status, 401)
      assert.equal((await post(admin, { ...pair, session: 'must-never-save-account-session' })).status, 400)
      assert.equal((await post(admin, pair)).status, 204)
      assert.equal((await post(admin, { ...pair, refreshToken: 'another-refresh' })).status, 409)
      if (stage === 'restart') {
        await worker.setFixtureChat('old-account-VM')
        const repair = (await client.callTool({ ...begin, arguments: { replace: true } })).structuredContent as Record<string, unknown>
        assert.equal(repair.nodeId, pair.nodeId)
        assert.match(String(repair.instructions), /npm run pair -- --replace\./)
        assert.equal(typeof repair.replaces, 'string')
        const candidate = { ...pair, refreshToken: 'replacement', replaces: repair.replaces }
        assert.equal((await post(admin, { ...candidate, refreshToken: 'bad' })).status, 422)
        const oldChat = (await client.callTool({ name: 'list_side_chats' })).structuredContent as Record<string, unknown>
        assert.equal(oldChat.active, 'Notifications')
        const queued = await fetch(new URL('/v1/hooks/custom', worker.url), {
          method: 'POST', headers: { Authorization: 'Bearer HOOK_TOKEN-test' }, body: 'For the old chat only',
        })
        assert.equal(queued.status, 202)
        const receipt = await queued.json() as { id: string }
        const concurrent = await Promise.all([post(admin, candidate), post(admin, candidate)])
        assert.deepEqual(concurrent.map(response => response.status), [204, 204])
        const previous = await client.callTool({ name: 'get_delivery_status', arguments: { id: receipt.id } })
        assert.equal((previous.structuredContent as Record<string, unknown>).reason, 'destination_changed')
        assert.equal((await post(admin, { ...candidate, refreshToken: 'late' })).status, 409)
      }
      const status = await client.callTool({ name: 'get_setup_status' })
      assert.deepEqual(status.structuredContent, { deviceConfigured: true, active: null, ready: false, credentialStorageReady: true })
    } finally {
      await client.close()
      await worker.close()
    }
  }
  assert.deepEqual(refreshes, ['bad', 'down', 'device-refresh', 'bad', 'replacement'].map(v => 'Bearer hatch_refresh:' + v))
})
