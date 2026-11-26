import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Response, WebSocketPair } from 'miniflare'
import { connect } from './mcp-client.ts'
import { startConfiguredWorker, startWorker, waitForAssertion } from './worker.ts'

async function post(url: URL, key: string, text = key, parent?: string) {
  const response = await fetch(new URL('/v1/hooks/custom', url), {
    method: 'POST',
    headers: {
      Authorization: 'Bearer HOOK_TOKEN-test',
      'Idempotency-Key': key,
      ...(parent && { 'X-MuseKnock-Parent': parent }),
    },
    body: text,
  })
  assert.ok(response.ok, await response.clone().text())
  return response.json() as Promise<{ id: string; state: string; duplicate: boolean }>
}

function museAccount(path: string) {
  switch (path) {
    case '/device_token/refresh':
      return Response.json({ access_token: 'local-access', refresh_token: 'local-refresh' })
    case '/fetch_vms':
      return Response.json({
        vm_list: [
          { vm_id: 'local-vm', vm_auth_token: 'local-token', vm_url: 'https://vm.example' },
        ],
      })
    default:
      throw new Error('Unexpected account API request ' + path)
  }
}

test('an explicit returning receipt is suppressed while the Muse link is in flight', async () => {
  let release!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  let linkAttempts = 0
  const worker = await startConfiguredWorker(
    async (request) => {
      const { hostname, pathname } = new URL(request.url)
      if (hostname === 'api.muse.ai') return museAccount(pathname)
      assert.equal(hostname, 'hatch.metaaivm.com')
      linkAttempts++
      await hold
      return new Response(null, { status: 503 })
    },
    { CIRCUIT_BREAKER: JSON.stringify({ maxAttempts: 4 }) },
  )
  let firstWasSent = false
  try {
    const reader = await connect(new URL('/mcp', worker.url), 'MCP_TOKEN-test')
    try {
      const first = await post(worker.url, 'initial')
      await waitForAssertion(() => assert.equal(linkAttempts, 1))
      firstWasSent = true
      const returned = await post(worker.url, 'new-provider-id', 'rewritten by relay', first.id)
      assert.equal(returned.state, 'suppressed')
      const details = await reader.callTool({
        name: 'get_delivery_status',
        arguments: { id: returned.id },
      })
      assert.equal((details.structuredContent as { reason?: string }).reason, 'loop_return')
      assert.equal(
        (await post(worker.url, 'ordinary', 'Related case: ' + first.id)).state,
        'queued',
      )
      assert.equal(
        (await post(worker.url, 'original-replay', 'new notification', crypto.randomUUID())).state,
        'queued',
      )
      assert.equal(linkAttempts, 1)
    } finally {
      await reader.close()
    }
  } finally {
    release()
    try {
      if (firstWasSent)
        await waitForAssertion(async () => {
          assert.notEqual((await post(worker.url, 'initial')).state, 'sending')
        })
    } finally {
      await worker.close()
    }
  }
})

test('a global breaker stays open across a disabled deployment and a changed limit', async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'museknock-breaker-'))
  t.after(() => rm(path, { force: true, recursive: true }))
  let attempts = 0
  const openWorker = (config: object) =>
    startConfiguredWorker(
      (request) => {
        const { hostname, pathname } = new URL(request.url)
        if (hostname === 'api.muse.ai') return museAccount(pathname)
        assert.equal(hostname, 'hatch.metaaivm.com')
        attempts++
        return new Response(null, { status: 503 })
      },
      {
        CIRCUIT_BREAKER: JSON.stringify(config),
        TELEGRAM_WEBHOOK_SECRET: 'telegram-test',
        MCP_RECOVERY_TOKEN: 'recovery-test',
      },
      path,
    )

  const first = await openWorker({ maxAttempts: 1 })
  try {
    const incoming = await fetch(new URL('/v1/hooks/telegram', first.url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'telegram-test',
      },
      body: JSON.stringify({
        update_id: 1,
        message: { message_id: 1, chat: { id: 5 }, text: 'event' },
      }),
    })
    assert.equal(incoming.status, 200)
    await waitForAssertion(() => assert.equal(attempts, 1))
    assert.equal((await post(first.url, 'original-blocked')).state, 'suppressed')
  } finally {
    await first.close()
  }

  const detached = await openWorker({ enabled: false })
  try {
    const queued = await post(detached.url, 'standalone')
    assert.equal(queued.state, 'queued')
    await waitForAssertion(() => assert.equal(attempts, 2))
    await waitForAssertion(async () =>
      assert.equal((await post(detached.url, 'standalone')).state, 'queued'),
    )
  } finally {
    await detached.close()
  }

  const attached = await openWorker({ maxAttempts: 4 })
  try {
    const oldRetry = await post(attached.url, 'standalone')
    assert.equal(oldRetry.duplicate, true)
    assert.equal(oldRetry.state, 'suppressed')
    const blocked = await post(attached.url, 'still-open')
    assert.equal(blocked.state, 'suppressed')
    const recovery = await connect(new URL('/mcp', attached.url), 'recovery-test')
    try {
      const rearm = { name: 'rearm_delivery_breaker', arguments: { expectedGeneration: 1 } }
      const result = await recovery.callTool(rearm)
      assert.notEqual(result.isError, true, JSON.stringify(result.content))
      const fresh = await recovery.callTool({ name: 'get_delivery_breaker' })
      assert.equal((fresh.structuredContent as { remaining: number }).remaining, 4)
      const duplicate = await post(attached.url, 'still-open')
      assert.equal(duplicate.id, blocked.id)
      assert.equal(duplicate.state, 'suppressed')
      assert.equal(duplicate.duplicate, true)
      assert.equal((await post(attached.url, 'after-recovery')).state, 'queued')
    } finally {
      await recovery.close()
    }
  } finally {
    await attached.close()
  }
})

test('MCP can start a delivery after the custom webhook reaches its limit', async (t) => {
  const worker = await startConfiguredWorker(
    async (request) => {
      await request.arrayBuffer()
      const { hostname, pathname } = new URL(request.url)
      if (hostname === 'api.muse.ai') return museAccount(pathname)
      assert.equal(hostname, 'hatch.metaaivm.com')
      const [client, peer] = Object.values(new WebSocketPair())
      peer.accept()
      peer.addEventListener('message', () => peer.close(1000))
      return new Response(null, { status: 101, webSocket: client })
    },
    { CIRCUIT_BREAKER: JSON.stringify({ maxAttempts: 3, maxAttemptsPerSource: 1 }) },
  )
  t.after(() => worker.close())
  const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
  try {
    const first = await post(worker.url, 'sensor-alert')
    await waitForAssertion(async () => {
      const receipt = await admin.callTool({ name: 'get_delivery_status', arguments: { id: first.id } })
      assert.equal((receipt.structuredContent as { reason?: string }).reason, 'source_open')
    })
    assert.equal((await post(worker.url, 'later-alert')).state, 'suppressed')
    const status = await admin.callTool({ name: 'get_delivery_breaker' })
    const budget = status.structuredContent as { remaining: number; sourceAttempts: Record<string, number> }
    assert.deepEqual(budget.sourceAttempts, { custom: 1 })
    assert.equal(budget.remaining, 2)
    const result = await admin.callTool({
      name: 'send_test_notification',
      arguments: { requestId: crypto.randomUUID() },
    })
    assert.equal((result.structuredContent as { state: string }).state, 'queued')
    await waitForAssertion(async () => {
      const next = await admin.callTool({ name: 'get_delivery_breaker' })
      const { remaining, sourceAttempts } = next.structuredContent as typeof budget
      assert.equal(remaining, 1)
      assert.deepEqual(sourceAttempts, { custom: 1, 'museknock-test': 1 })
    })
  } finally {
    await admin.close()
  }
})

test('invalid breaker settings reject ingress and leave scheduled sources unread', async (t) => {
  let outbound = 0
  const worker = await startConfiguredWorker(() => {
    outbound++
    return new Response(null, { status: 503 })
  }, {
    CIRCUIT_BREAKER: '{"maxAttempts":0}',
    DISCORD_CHANNEL_ID: '123456789012345678',
    DISCORD_BOT_TOKEN: 'local-token',
    TELEGRAM_WEBHOOK_SECRET: 'local-telegram',
  })
  t.after(() => worker.close())
  const custom = await fetch(new URL('/v1/hooks/custom', worker.url), {
    method: 'POST', body: 'try again later', headers: { Authorization: 'Bearer HOOK_TOKEN-test' },
  })
  assert.equal(custom.status, 503)
  const telegram = await fetch(new URL('/v1/hooks/telegram', worker.url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'local-telegram' },
    body: JSON.stringify({ update_id: 1, message: { message_id: 2, chat: { id: 3 }, text: 'notice' } }),
  })
  assert.equal(telegram.status, 503)
  const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
  try {
    const send = await admin.callTool({
      name: 'send_test_notification', arguments: { requestId: crypto.randomUUID() },
    })
    assert.equal(send.isError, true)
    const tick = await fetch(new URL('/cdn-cgi/local/scheduled?format=json', worker.url))
    assert.equal(tick.status, 200)
    assert.equal(outbound, 0)
    const sources = await admin.callTool({ name: 'list_sources' })
    assert.deepEqual(sources.structuredContent, { sources: [] })
  } finally {
    await admin.close()
  }
})

test('the scheduled worker restores the pending lease retry after fixing an invalid deployment', async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'museknock-held-'))
  t.after(() => rm(path, { force: true, recursive: true }))
  let accountRequests = 0
  const first = await startConfiguredWorker((request) => {
    const { pathname } = new URL(request.url)
    if (pathname === '/fetch_vms') {
      accountRequests++
      return Response.json({
        vm_list: [{ vm_id: 'other-vm', vm_auth_token: 'test-token', vm_url: 'https://vm.example' }],
      })
    }
    return museAccount(pathname)
  }, {}, path)
  let id: string
  let retryAt: number
  try {
    id = (await post(first.url, 'before-typo')).id
    await waitForAssertion(async () => {
      assert.equal(accountRequests, 1)
      const alarm = await first.scheduledAlarm()
      assert.ok(alarm && alarm > Date.now() + 50_000 && alarm <= Date.now() + 60_000)
    })
    retryAt = (await first.scheduledAlarm())!
  } finally {
    await first.close()
  }
  const invalid = await startWorker(undefined, { CIRCUIT_BREAKER: '{' }, path)
  try {
    const reader = await connect(new URL('/mcp', invalid.url), 'MCP_TOKEN-test')
    try {
      const receipt = await reader.callTool({ name: 'get_delivery_status', arguments: { id } })
      assert.equal((receipt.structuredContent as { state: string }).state, 'queued')
      assert.equal(await invalid.scheduledAlarm(), null)
    } finally {
      await reader.close()
    }
  } finally {
    await invalid.close()
  }
  const recovered = await startWorker(undefined, {}, path)
  try {
    const tick = await fetch(new URL('/cdn-cgi/local/scheduled?format=json', recovered.url))
    assert.equal(tick.status, 200)
    assert.equal(await recovered.scheduledAlarm(), retryAt)
  } finally {
    await recovered.close()
  }
})
