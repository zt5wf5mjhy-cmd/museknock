import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Response, WebSocketPair } from 'miniflare'
import { setTimeout as delay } from 'node:timers/promises'
import { connect } from './mcp-client.ts'
import { openSettings } from './settings-client.ts'
import { startConfiguredWorker, startWorker, waitForAssertion } from './worker.ts'

test('new webhooks and MCP verification respect the pairing retry time across deployments', async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'museknock-lease-retry-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  const refreshes: string[] = []
  async function exercise(seed: string, expectedRefreshes: string[], existingAlarm?: number) {
    const worker = await startConfiguredWorker(request => {
      assert.equal(new URL(request.url).pathname, '/device_token/refresh')
      refreshes.push(request.headers.get('Authorization')?.replace('Bearer hatch_refresh:', '') ?? '')
      return new Response(null, { status: 503 })
    }, { MUSE_REFRESH_TOKEN: seed }, path)
    try {
      const post = async () => {
        const key = crypto.randomUUID()
        const response = await fetch(new URL('/v1/hooks/custom', worker.url), {
          method: 'POST', headers: { Authorization: 'Bearer HOOK_TOKEN-test', 'Idempotency-Key': key }, body: key,
        })
        assert.equal(response.status, 202)
      }
      await post()
      await waitForAssertion(async () => {
        assert.deepEqual(refreshes, expectedRefreshes)
        const alarm = await worker.scheduledAlarm()
        assert.ok(alarm && alarm > Date.now() + 50_000 && alarm <= Date.now() + 60_000)
        if (existingAlarm !== undefined) assert.equal(alarm, existingAlarm)
      })
      const retryAt = (await worker.scheduledAlarm())!
      await post()
      const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
      try {
        const settings = await openSettings(worker.url, admin)
        assert.equal((await settings.register('alerts', 'existing')).status, 422)
      } finally {
        await admin.close()
      }
      assert.equal(await worker.scheduledAlarm(), retryAt)
      assert.deepEqual(refreshes, expectedRefreshes)
      return retryAt
    } finally {
      await worker.close()
    }
  }
  const firstAlarm = await exercise('first-pair', ['first-pair'])
  await exercise('first-pair', ['first-pair'], firstAlarm)
  await exercise('second-pair', ['first-pair', 'second-pair'])
})

test('an absent VM keeps its lookup deadline across arrivals and restarts while a leased VM wakes immediately', async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'museknock-missing-lease-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  let lookups = 0
  const attempts: string[] = []
  const open = () => startWorker(request => {
    const url = new URL(request.url)
    if (url.pathname === '/device_token/refresh')
      return Response.json({ access_token: 'access', refresh_token: 'refreshed' })
    if (url.pathname === '/fetch_vms') {
      lookups++
      return Response.json({ vm_list: [
        { vm_id: 'healthy', vm_auth_token: 'vm-token', vm_url: 'https://vm.example' },
      ] })
    }
    assert.equal(url.pathname, '/v1/noise')
    attempts.push(url.searchParams.get('vm_id')!)
    return new Response(null, { status: 503 })
  }, {}, path)
  const post = async (worker: Awaited<ReturnType<typeof open>>) => {
    const response = await fetch(new URL('/v1/hooks/custom', worker.url), {
      method: 'POST', headers: { Authorization: 'Bearer HOOK_TOKEN-test' }, body: 'notice',
    })
    assert.equal(response.status, 202)
  }
  const first = await open()
  let deadline: number
  try {
    await first.setFixtureChat('absent')
    await post(first)
    await waitForAssertion(async () => {
      assert.equal(lookups, 1)
      const alarm = await first.scheduledAlarm()
      assert.ok(alarm && alarm > Date.now() + 50_000 && alarm <= Date.now() + 60_000)
    })
    deadline = (await first.scheduledAlarm())!
  } finally {
    await first.close()
  }
  const second = await open()
  try {
    await post(second)
    assert.equal(await second.scheduledAlarm(), deadline)
    assert.equal(lookups, 1)
    await second.setFixtureChat('healthy')
    await post(second)
    await waitForAssertion(() => assert.deepEqual(attempts, ['healthy']))
    assert.equal(lookups, 2)
  } finally {
    await second.close()
  }
})

test('switching the registered VM wakes a new delivery while the previous VM awaits a retry', async (t) => {
  const attempts: string[] = []
  const worker = await startWorker((request) => {
    const url = new URL(request.url)
    if (url.pathname === '/device_token/refresh') {
      return Response.json({ access_token: 'test-access', refresh_token: 'test-refresh' })
    }
    if (url.pathname === '/fetch_vms') {
      return Response.json({ vm_list: ['vm-a', 'vm-b'].map(vm => ({
        vm_id: vm, vm_auth_token: 'test-token', vm_url: 'https://vm.example',
      })) })
    }
    assert.equal(url.pathname, '/v1/noise')
    const [client, server] = Object.values(new WebSocketPair())
    server.accept()
    server.addEventListener('message', () => {
      attempts.push(url.searchParams.get('vm_id')!)
      server.close(1000)
    }, { once: true })
    return new Response(null, { status: 101, webSocket: client })
  })
  t.after(() => worker.close())
  const post = (key: string) => fetch(new URL('/v1/hooks/custom', worker.url), {
    method: 'POST', headers: { Authorization: 'Bearer HOOK_TOKEN-test', 'Idempotency-Key': key }, body: key,
  })
  await worker.setFixtureChat('vm-a')
  const first = await (await post('first')).json()
  const until = Date.now() + 5_000
  do {
    await delay(25)
    if (attempts.length && (await (await post('first')).json()).state === 'queued') break
  } while (Date.now() < until)
  assert.deepEqual(attempts, ['vm-a'])
  assert.deepEqual(await (await post('first')).json(), { id: first.id, state: 'queued', duplicate: true })
  await worker.setFixtureChat('vm-b')
  assert.equal((await post('second')).status, 202)
  const deadline = Date.now() + 5_000
  while (attempts.length < 2 && Date.now() < deadline) await delay(25)
  assert.deepEqual(attempts, ['vm-a', 'vm-b'])
})

test('a webhook wakes the Worker and starts device authorization without a bridge client', async (t) => {
  const calls: string[] = []
  const worker = await startConfiguredWorker((request) => {
    calls.push(new URL(request.url).pathname)
    return new Response('{}', { status: 503 })
  })
  t.after(() => worker.close())
  const post = () =>
    fetch(new URL('/v1/hooks/custom', worker.url), {
      method: 'POST',
      headers: { Authorization: 'Bearer HOOK_TOKEN-test', 'Idempotency-Key': 'first-knock' },
      body: 'A test notification',
    })
  const receipt = await (await post()).json()
  assert.equal(receipt.state, 'queued')
  const until = Date.now() + 6_000
  while (!calls.length && Date.now() < until) await delay(50)
  assert.deepEqual(calls, ['/device_token/refresh'])
  let state
  do {
    state = (await (await post()).json()).state
    if (state !== 'sending') break
    await delay(20)
  } while (Date.now() < until)
  assert.equal(state, 'queued')
})
