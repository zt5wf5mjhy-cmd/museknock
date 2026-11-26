import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { build } from 'esbuild'

let runtime
before(async () => {
  const bundle = await build({
    stdin: { contents: `
      import { DeliveryQueue } from './src/store.ts';
      import { createCircuitBreaker } from './src/circuit-breaker.ts';
      import { DurableObject } from "cloudflare:workers";
      export class TestInbox extends DurableObject {
        async fetch(request) {
          const [, method, args] = await request.json()
          if (!this.queue) this.reopen()
          if (method === "claim" && args.length === 0) args.push(["vm-a"])
          if (method === "registerSideChat" && args.length === 2) args.push("vm-a")
          if (method === "setActiveSideChat" && typeof args[0] === "string") {
            args[0] = this.queue.getSideChat(args[0])
            if (!args[0]) return Response.json(null)
          }
          const target = ["age", "reopen"].includes(method) ? this : this.queue
          return Response.json(target[method](...args) ?? null)
        }
        reopen(route = "device-a", config) {
          this.queue = new DeliveryQueue(this.ctx.storage, route, createCircuitBreaker(this.ctx.storage, config))
        }
        age(milliseconds) {
          this.ctx.storage.sql.exec(
            "UPDATE events SET createdAt = createdAt - ?, startedAt = startedAt - ?",
            milliseconds, milliseconds
          )
          this.ctx.storage.sql.exec("UPDATE delivery_retries SET retryAt = retryAt - ?", milliseconds)
          this.ctx.storage.sql.exec("UPDATE lease_snapshots SET retryAt = retryAt - ?", milliseconds)
          this.ctx.storage.sql.exec("UPDATE authorizations SET startedAt = startedAt - ?", milliseconds)
          const hold = this.ctx.storage.kv.get("invalid-breaker-since")
          if (hold !== undefined) this.ctx.storage.kv.put("invalid-breaker-since", hold - milliseconds)
        }
      }
      export default {
        async fetch(request, env) {
          const [name] = await request.clone().json()
          const inbox = env.INBOX.getByName(name)
          return inbox.fetch(request)
        }
      }
    `, resolveDir: process.cwd() },
    bundle: true, format: 'esm', external: ['cloudflare:*'], write: false,
  })
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: '2025-09-01',
      durableObjects: { INBOX: { className: 'TestInbox', useSQLite: true } },
      script: bundle.outputFiles[0].text,
    }),
  )
})
after(async () => runtime?.dispose())

function inbox(name) {
  return async (method, ...args) => {
    const response = await runtime.dispatchFetch('http://localhost', {
      method: 'POST',
      body: JSON.stringify([name, method, args]),
    })
    const body = await response.text()
    assert.equal(response.status, 200, body)
    return JSON.parse(body)
  }
}

async function registeredInbox(name) {
  const call = inbox(name)
  await call('registerSideChat', 'ops', 'main-room', 'vm-a')
  return call
}

function event(key, source = 'monitor', type = 'alert') {
  return { source, key, type, text: '外部のメッセージ' }
}

test('one receipt per source and key, one authorization even with concurrent claims', async () => {
  const call = await registeredInbox('concurrency')
  const receipts = await Promise.all(Array.from({ length: 4 }, () => call('enqueue', event('job'))))
  const { id } = receipts[0]
  assert.equal(receipts.filter((r) => !r.duplicate).length, 1)
  assert.deepEqual([...new Set(receipts.map((r) => r.id))], [id])
  const other = await call('enqueue', event('job', 'second'))
  assert.notEqual(other.id, id)
  const claims = await Promise.all([call('claim'), call('claim')])
  const [claim] = claims.filter(Boolean)
  assert.equal(claims.filter(Boolean).length, 1)
  const { attempt, sessionId, vmId, ...payload } = claim
  assert.equal(vmId, 'vm-a')
  assert.equal(sessionId, 'main-room')
  assert.match(attempt, /^[a-f0-9-]{36}$/)
  assert.deepEqual(payload, { id, source: 'monitor', type: 'alert', text: '外部のメッセージ' })
  assert.equal(await call('finish', id, attempt, 'sent'), true)
  assert.equal(await call('finish', id, attempt, 'sent'), true)
  assert.equal(await call('finish', id, attempt, 'unknown'), false)
  const { createdAt, ...status } = await call('status', id)
  assert.equal(typeof createdAt, 'number')
  assert.deepEqual(status, { id, source: 'monitor', type: 'alert', state: 'sent' })
  assert.equal((await call('claim')).id, other.id)
})

test('pause and allowlist apply to the backlog and to new events', async () => {
  const call = await registeredInbox('rules')
  const beforePause = await call('enqueue', event('p'))
  assert.deepEqual(await call('setPaused', 'monitor', true), {
    source: 'monitor',
    paused: true,
    types: [],
  })
  assert.equal((await call('enqueue', event('paused'))).state, 'suppressed')
  await call('setPaused', 'monitor', false)
  assert.equal((await call('status', beforePause.id)).state, 'suppressed')
  const beforeFilter = await call('enqueue', event('f'))
  await call('setFilter', 'monitor', ['warning'])
  assert.equal((await call('enqueue', event('filtered'))).state, 'suppressed')
  assert.equal((await call('status', beforeFilter.id)).state, 'suppressed')
  assert.equal(await call('claim'), null)
  const allowed = await call('enqueue', event('ok', 'monitor', 'warning'))
  assert.equal((await call('claim')).id, allowed.id)
  assert.deepEqual(await call('sources'), [
    { source: 'monitor', paused: false, types: ['warning'] },
  ])
  await call('setFilter', 'monitor', [])
  assert.equal((await call('enqueue', event('all'))).state, 'queued')
})

test('sliding rate limits count distinct receipts per source and authorizations across sources', async () => {
  const call = await registeredInbox('limits')
  for (let i = 0; i < 10; i++)
    assert.equal((await call('enqueue', event(String(i)))).state, 'queued')
  assert.deepEqual(await call('enqueue', event('11')), { limited: true })
  assert.equal((await call('enqueue', event('1'))).duplicate, true)
  assert.equal((await call('enqueue', event('1', 'elsewhere'))).state, 'queued')
  for (let i = 0; i < 3; i++) {
    const claim = await call('claim')
    assert.equal(await call('finish', claim.id, claim.attempt, 'sent'), true)
  }
  assert.equal(await call('claim'), null)
  await call('age', 61_000)
  assert.equal((await call('enqueue', event('11'))).state, 'queued')
  assert.ok(await call('claim'))
})

test('lost acknowledgments never redeliver, stale queued events expire, and history ages out', async () => {
  const call = await registeredInbox('timeouts')
  const first = await call('enqueue', event('first'))
  const second = await call('enqueue', event('second'))
  const claim = await call('claim')
  assert.equal(claim.id, first.id)
  await call('age', 121_000)
  assert.equal((await call('claim')).id, second.id)
  assert.equal((await call('status', first.id)).state, 'unknown')
  assert.equal(await call('finish', first.id, claim.attempt, 'sent'), false)
  const third = await call('enqueue', event('third'))
  await call('age', 3_600_000)
  assert.equal(await call('claim'), null)
  assert.equal((await call('status', third.id)).state, 'expired')
  await call('age', 7 * 86_400_000)
  assert.equal(await call('status', first.id), null)
  const fresh = await call('enqueue', event('first'))
  assert.notEqual(fresh.id, first.id)
  assert.equal(fresh.duplicate, false)
})

test('definite non-delivery retains the payload, fences old reports, and counts every authorization', async () => {
  const call = await registeredInbox('retry')
  const { id } = await call('enqueue', event('retry'))
  const first = await call('claim')
  assert.equal(await call('finish', id, first.attempt, 'not_sent'), true)
  assert.equal(await call('finish', id, first.attempt, 'not_sent'), true)
  assert.equal(await call('finish', id, first.attempt, 'sent'), false)
  assert.equal((await call('status', id)).state, 'queued')
  for (let i = 0; i < 2; i++) {
    assert.equal(await call('claim'), null)
    await call('age', 61_000)
    const retry = await call('claim')
    assert.equal(retry.id, id)
    assert.equal(retry.text, first.text)
    assert.notEqual(retry.attempt, first.attempt)
    assert.equal(await call('finish', id, first.attempt, 'sent'), false)
    assert.equal(await call('finish', id, first.attempt, 'not_sent'), false)
    assert.equal(await call('finish', id, retry.attempt, 'not_sent'), true)
  }
  assert.equal(await call('claim'), null)
  await call('age', 61_000)
  const retry = await call('claim')
  assert.equal(await call('finish', id, retry.attempt, 'unknown'), true)
  assert.equal(await call('finish', id, retry.attempt, 'not_sent'), false)
  assert.equal(await call('claim'), null)
})

test('a failed attempt honors rule changes and expiry before retry', async () => {
  for (const mode of ['pause', 'filter', 'expire']) {
    const call = await registeredInbox('inflight-' + mode)
    const { id } = await call('enqueue', event('retry'))
    if (mode === 'expire') await call('age', 3_590_000)
    const { attempt } = await call('claim')
    if (mode === 'expire') await call('age', 15_000)
    if (mode === 'pause') await call('setPaused', 'monitor', true)
    if (mode === 'filter') await call('setFilter', 'monitor', ['other'])
    assert.equal(await call('finish', id, attempt, 'not_sent'), true)
    assert.equal((await call('status', id)).state, mode === 'expire' ? 'expired' : 'suppressed')
    assert.equal(await call('claim'), null)
  }
})

test('an alarm waits for the active attempt or the rolling limit, then stops on an empty queue', async () => {
  const call = await registeredInbox('alarms')
  assert.equal(await call('nextWakeAt'), null)
  for (const key of ['one', 'two', 'three', 'four']) await call('enqueue', event(key))
  for (let i = 0; i < 3; i++) {
    assert.ok((await call('nextWakeAt')) <= Date.now())
    const active = await call('claim')
    assert.ok((await call('nextWakeAt')) > Date.now() + 100_000)
    await call('finish', active.id, active.attempt, 'sent')
  }
  assert.ok((await call('nextWakeAt')) > Date.now() + 50_000)
  await call('age', 61_000)
  assert.ok((await call('nextWakeAt')) <= Date.now())
  await call('claim')
  await call('age', 121_000)
  assert.equal(await call('nextWakeAt'), null)
})

test('registers existing side chats and keeps the destination of each accepted notification', async () => {
  const call = inbox('registry-empty')
  assert.deepEqual(await call('listSideChats'), { active: null, chats: [] })
  assert.deepEqual(await call('enqueue', event('alert-1')), { noDestination: true })
  const first = { name: '障害対応', sessionId: 'room-one' }
  assert.deepEqual(await call('registerSideChat', first.name, first.sessionId), {
    active: first.name,
    chats: [first],
  })
  const receipt = await call('enqueue', event('alert-1'))
  assert.equal(receipt.duplicate, false)
  await call('registerSideChat', 'backup', 'room-two')
  assert.equal((await call('listSideChats')).active, first.name)
  assert.equal(await call('setActiveSideChat', 'missing'), null)
  assert.equal((await call('setActiveSideChat', 'backup')).active, 'backup')
  const second = await call('enqueue', event('alert-2'))
  await call('registerSideChat', 'backup', 'room-three')
  await call('reopen')
  assert.deepEqual(await call('listSideChats'), {
    active: 'backup',
    chats: [{ name: 'backup', sessionId: 'room-three' }, first],
  })
  assert.deepEqual(await call('enqueue', event('alert-1')), { ...receipt, duplicate: true })
  const one = await call('claim')
  assert.equal(one.id, receipt.id)
  assert.equal(one.sessionId, 'room-one')
  await call('finish', one.id, one.attempt, 'not_sent')
  const two = await call('claim')
  assert.equal(two.id, second.id)
  assert.equal(two.sessionId, 'room-two')
  await call('finish', two.id, two.attempt, 'sent')
  await call('age', 61_000)
  const retry = await call('claim')
  assert.equal(retry.sessionId, 'room-one')
  await call('finish', retry.id, retry.attempt, 'sent')
  await call('enqueue', event('alert-3'))
  assert.equal((await call('claim')).sessionId, 'room-three')
})

test('a delayed selection cannot overwrite a re-registration of the same session on another VM', async () => {
  const call = inbox('selection-race-empty')
  await call('registerSideChat', 'ops', 'room', 'vm-a')
  const verifying = await call('getSideChat', 'ops')
  await call('registerSideChat', 'ops', 'room', 'vm-b')
  assert.equal(await call('setActiveSideChat', verifying), null)
  const receipt = await call('enqueue', event('after-registration'))
  const claim = await call('claim', ['vm-a', 'vm-b'])
  assert.deepEqual([claim.id, claim.vmId], [receipt.id, 'vm-b'])
})

test('a missing device secret pauses intake and preserves the verified selection', async () => {
  const call = inbox('secrets-empty')
  await call('registerSideChat', 'ops', 'original-chat', 'vm-a')
  await call('reopen', null)
  assert.equal((await call('listSideChats')).active, null)
  assert.deepEqual(await call('enqueue', event('offline')), { noDestination: true })
  await call('reopen', 'device-a')
  assert.equal((await call('listSideChats')).active, 'ops')
  const receipt = await call('enqueue', event('restored'))
  assert.equal((await call('claim', ['vm-a'])).id, receipt.id)
})

test('a missing chat suppresses its backlog and leaves the same session on another VM available', async () => {
  const call = await registeredInbox('missing-chat')
  const first = await call('enqueue', event('first'))
  const sibling = await call('enqueue', event('sibling'))
  const missing = await call('claim')
  await call('registerSideChat', 'other', 'main-room', 'vm-b')
  await call('setActiveSideChat', 'other')
  const healthy = await call('enqueue', event('other'))
  await call('finish', first.id, missing.attempt, 'side_chat_missing')
  assert.equal((await call('status', sibling.id)).reason, 'side_chat_missing')
  assert.equal((await call('listSideChats')).active, 'other')
  const delivery = await call('claim', ['vm-b'])
  assert.equal(delivery.id, healthy.id)
  await call('finish', delivery.id, delivery.attempt, 'side_chat_missing')
  assert.equal((await call('listSideChats')).active, null)
  assert.deepEqual(await call('enqueue', event('unselected')), { noDestination: true })
})

test('queued notices survive a pairing change without crossing into the new destination', async () => {
  const call = await registeredInbox('switch-device')
  const receipt = await call('enqueue', event('private'))
  await call('reopen', 'device-b')
  assert.equal(await call('claim'), null)
  assert.equal(await call('nextWakeAt'), null)
  assert.equal((await call('status', receipt.id)).reason, 'destination_changed')
  assert.deepEqual(await call('listSideChats'), { active: null, chats: [] })
  await call('registerSideChat', 'ops', 'other-room')
  const fresh = await call('enqueue', event('new'))
  const sent = await call('claim')
  assert.deepEqual([sent.id, sent.sessionId], [fresh.id, 'other-room'])
  await call('finish', sent.id, sent.attempt, 'sent')
  await call('reopen', 'device-a')
  const original = await call('claim', ['vm-a'])
  assert.deepEqual([original.id, original.sessionId], [receipt.id, 'main-room'])
  await call('finish', original.id, original.attempt, 'not_sent')
  await call('age', 61_000)
  assert.equal(await call('claim', ['other-vm']), null)
  assert.equal((await call('claim', ['vm-a'])).id, original.id)
})

test('the VM verified during registration is also required for the first attempt', async () => {
  const call = inbox('verified-empty')
  await call('registerSideChat', 'verified', 'room', 'original-vm')
  const eventId = (await call('enqueue', event('one'))).id
  await call('reopen', 'replacement-device')
  assert.equal((await call('listSideChats')).active, null)
  assert.deepEqual(await call('enqueue', event('different-pairing')), { noDestination: true })
  await call('reopen', 'device-a')
  assert.equal(await call('claim', ['another-vm']), null)
  assert.equal((await call('claim', ['original-vm'])).id, eventId)
})

test('claims the oldest available destination even when VM leases or defaults change', async () => {
  const call = inbox('multiple-leases-empty')
  async function queueOn(vm) {
    await call('registerSideChat', vm, 'room-' + vm, vm)
    await call('setActiveSideChat', vm)
    return call('enqueue', event(vm))
  }
  const absent = await queueOn('absent')
  const first = await queueOn('first')
  const preferred = await queueOn('preferred')
  const oldest = await call('claim', ['preferred', 'first'])
  assert.deepEqual([oldest.id, oldest.vmId], [first.id, 'first'])
  await call('finish', oldest.id, oldest.attempt, 'sent')
  assert.equal((await call('status', absent.id)).state, 'queued')
  const next = await call('claim', ['preferred', 'first'])
  assert.deepEqual([next.id, next.vmId], [preferred.id, 'preferred'])
})

test('missing VM deadlines survive reopening the queue and expire without another lookup', async () => {
  const call = inbox('missing-lease-deadline')
  await call('registerSideChat', 'work', 'room', 'missing')
  await call('enqueue', event('first'))
  await call('recordLeases', ['healthy'])
  const deadline = await call('nextWakeAt')
  assert.ok(deadline > Date.now() + 50_000)
  await call('reopen')
  await call('enqueue', event('second'))
  assert.equal(await call('nextWakeAt'), deadline)
  await call('age', 61_000)
  assert.ok(await call('nextWakeAt') <= Date.now())
})

test('a retry waits for its chat while a healthy chat drains, even after the retry becomes due', async () => {
  const call = inbox('unreachable-vm-empty')
  const leased = ['vm-a', 'vm-b']
  await call('registerSideChat', 'broken', 'room', 'vm-a')
  const first = await call('enqueue', event('first'))
  const sibling = await call('enqueue', event('same-chat'))
  await call('registerSideChat', 'healthy', 'room', 'vm-b')
  await call('setActiveSideChat', 'healthy')
  const healthy = await call('enqueue', event('different-vm'))
  const attempt = await call('claim', leased)
  assert.equal(attempt.id, first.id)
  await call('finish', first.id, attempt.attempt, 'not_sent')
  await call('reopen')
  assert.ok(await call('nextWakeAt') <= Date.now())
  const next = await call('claim', leased)
  assert.equal(next.id, healthy.id)
  await call('finish', next.id, next.attempt, 'sent')
  assert.equal(await call('claim', leased), null)
  assert.ok(await call('nextWakeAt') > Date.now() + 50_000)
  const late = await call('enqueue', event('during-backoff'))
  assert.ok(await call('nextWakeAt') <= Date.now())
  await call('age', 61_000)
  const beforeRetry = await call('claim', leased)
  assert.equal(beforeRetry.id, late.id)
  await call('finish', beforeRetry.id, beforeRetry.attempt, 'sent')
  const recovered = await call('claim', leased)
  assert.equal(recovered.id, first.id)
  await call('finish', recovered.id, recovered.attempt, 'sent')
  assert.equal((await call('claim', leased)).id, sibling.id)
})

test('three retries cannot starve a healthy chat when the global minute limit resets', async () => {
  const call = inbox('retry-budget-empty')
  const ids = []
  const leased = ['first', 'second', 'third', 'healthy']
  for (const vm of leased) {
    await call('registerSideChat', vm, 'shared-room-id', vm)
    await call('setActiveSideChat', vm)
    ids.push((await call('enqueue', event(vm))).id)
  }
  for (const id of ids.slice(0, 3)) {
    const failed = await call('claim', leased)
    assert.equal(failed.id, id)
    await call('finish', id, failed.attempt, 'not_sent')
  }
  assert.equal(await call('claim', leased), null)
  assert.ok(await call('nextWakeAt') > Date.now() + 50_000)
  await call('age', 61_000)
  await call('recordLeases', ['elsewhere'])
  assert.ok(await call('nextWakeAt') > Date.now() + 50_000)
  await call('recordLeases', leased)
  assert.ok(await call('nextWakeAt') <= Date.now())
  assert.equal((await call('claim', leased)).id, ids[3])
})

test('the global cap survives restarts and destination changes across sources', async () => {
  const call = await registeredInbox('breaker-budget')
  assert.deepEqual(await call('breakerStatus'), { state: 'disabled' })
  await call('reopen', 'device-a', '{"maxAttempts":2}')
  assert.equal((await call('breakerStatus')).remaining, 2)
  const first = await call('enqueue', event('one', 'discord'))
  await call('registerSideChat', 'other', 'room-two')
  await call('setActiveSideChat', 'other')
  const github = await call('enqueue', event('two', 'github'))
  const backlog = await call('enqueue', event('three', 'line'))
  const attempts = await Promise.all([call('claim'), call('claim')])
  assert.equal(attempts.filter(Boolean).length, 1)
  const claim = attempts.find(Boolean)
  assert.equal(claim.id, first.id)
  await call('reopen', 'device-a', '{"maxAttempts":7}')
  assert.equal((await call('breakerStatus')).remaining, 1)
  await call('finish', claim.id, claim.attempt, 'not_sent')
  assert.equal((await call('status', first.id)).reason, 'source_open')
  const last = await call('claim')
  assert.equal(last.id, github.id)
  assert.equal((await call('status', backlog.id)).reason, 'circuit_open')
  assert.equal((await call('rearmBreaker', 1)).ok, false)
  assert.equal((await call('breakerStatus')).remaining, 0)
  assert.equal((await call('breakerStatus')).maxAttempts, 2)
  const discarded = await call('enqueue', event('test', 'museknock-test'))
  assert.equal(discarded.state, 'suppressed')
  assert.equal((await call('enqueue', event('test', 'museknock-test'))).duplicate, true)
  await call('finish', last.id, last.attempt, 'not_sent')
  assert.equal((await call('status', last.id)).reason, 'circuit_open')
  assert.equal((await call('breakerStatus')).suppressed, 4)
  assert.equal(await call('nextWakeAt'), null)
  await call('reopen', 'device-a', '{"enabled":false}')
  assert.equal((await call('breakerStatus')).state, 'disabled')
  await call('reopen', 'device-a', '{"maxAttempts":7}')
  assert.equal((await call('breakerStatus')).state, 'open')
  const recovered = await Promise.all([call('rearmBreaker', 1), call('rearmBreaker', 1)])
  assert.equal(recovered.filter(r => r.ok).length, 1)
  assert.equal((await call('breakerStatus')).remaining, 7)
  assert.equal((await call('breakerStatus')).generation, 2)
  assert.equal(await call('claim'), null)
  const fresh = await call('enqueue', event('fresh', 'github'))
  assert.equal((await call('claim')).id, fresh.id)
})

test('a configured return guard suppresses explicit known parents without spending an attempt', async () => {
  const call = await registeredInbox('breaker-returns')
  await call('reopen', 'device-a', '{}')
  const parent = await call('enqueue', event('known'))
  const sending = await call('claim')
  const returned = { ...event('return', 'elsewhere'), parentId: parent.id }
  const echo = await call('enqueue', returned)
  assert.equal(echo.state, 'suppressed')
  assert.equal((await call('status', echo.id)).reason, 'loop_return')
  assert.equal((await call('enqueue', returned)).duplicate, true)
  await call('finish', sending.id, sending.attempt, 'unknown')
  assert.equal((await call('enqueue', { ...returned, key: 'late' })).state, 'suppressed')
  assert.equal((await call('breakerStatus')).remaining, 99)
  assert.equal((await call('enqueue', { ...event('unrelated'), text: parent.id })).state, 'queued')
  assert.equal((await call('enqueue', { ...event('new-parent'), parentId: crypto.randomUUID() })).state, 'queued')
  await call('reopen', 'device-a', '{"suppressReturns":false}')
  assert.equal((await call('enqueue', { ...returned, key: 'allow' })).state, 'queued')
})

test('mounting accounts for an outstanding send once, and fails closed on invalid config', async () => {
  const call = await registeredInbox('breaker-migrate')
  await call('enqueue', event('existing'))
  const sending = await call('claim')
  await call('reopen', 'device-a', '{"maxAttempts":1}')
  assert.equal((await call('breakerStatus')).state, 'open')
  await call('reopen', 'device-a', '{"maxAttempts":1}')
  await call('finish', sending.id, sending.attempt, 'sent')
  const rearm = await call('rearmBreaker', 1)
  assert.equal(rearm.status.remaining, 1)
  const queued = await call('enqueue', event('old'))
  for (const raw of ['{}oops', '{"maxAttempts":0}', '{"maxAttemptsPerSource":0}', '{"unknown":true}', 'null']) {
    await call('reopen', 'device-a', raw)
    assert.deepEqual(await call('breakerStatus'), {state: 'invalid'})
    assert.equal(await call('claim'), null)
    assert.equal((await call('rearmBreaker', 2)).ok, false)
  }
  await call('age', 8 * 86_400_000)
  await call('reopen', 'device-a', 'null')
  assert.equal((await call('status', queued.id)).state, 'queued')
  assert.deepEqual(await call('enqueue', event('blocked')), { invalidBreaker: true })
  assert.equal(await call('nextWakeAt'), null)
  await call('reopen', 'device-a', '{}')
  assert.equal((await call('breakerStatus')).remaining, 1)
  const recovered = await call('claim')
  assert.equal(recovered.id, queued.id)
  assert.equal(recovered.text, event('old').text)
})

test('reattaching counts a new in-flight send from an unguarded deployment just once', async () => {
  const call = await registeredInbox('breaker-reattach')
  await call('reopen', 'device-a', '{"maxAttempts":3}')
  await call('enqueue', event('guarded'))
  const guarded = await call('claim')
  await call('finish', guarded.id, guarded.attempt, 'sent')
  await call('reopen')
  const queued = await call('enqueue', { ...event('unguarded'), parentId: guarded.id })
  assert.equal(queued.state, 'queued')
  const unguarded = await call('claim')
  for (let i = 0; i < 2; i++) {
    await call('reopen', 'device-a', '{"maxAttempts":3}')
    assert.equal((await call('breakerStatus')).remaining, 1)
  }
  await call('age', 121_000)
  assert.equal((await call('status', unguarded.id)).state, 'unknown')
  const final = await call('enqueue', event('fresh', 'github'))
  assert.equal((await call('claim')).id, final.id)
  await call('age', 121_000)
  assert.equal((await call('status', final.id)).state, 'unknown')
  assert.equal(await call('claim'), null)
  assert.equal((await call('rearmBreaker', 1)).ok, true)
})

test('return suppression ignores queued parents, and honors sent parents until their receipts expire', async () => {
  const call = await registeredInbox('breaker-lineage')
  await call('reopen', 'device-a', '{}')
  const parent = await call('enqueue', event('parent'))
  const child = { ...event('child'), parentId: parent.id }
  assert.equal((await call('enqueue', child)).state, 'queued')
  const claim = await call('claim')
  await call('finish', claim.id, claim.attempt, 'sent')
  assert.equal((await call('enqueue', { ...child, key: 'sent' })).state, 'suppressed')
  await call('age', 7 * 86_400_000)
  assert.equal((await call('enqueue', { ...child, key: 'expired' })).state, 'queued')
})

test('exhausting a source leaves another source deliverable until the operator rearms', async () => {
  const call = await registeredInbox('isolated-source')
  await call('reopen', 'device-a', '{"maxAttempts":4}')
  const first = await call('enqueue', event('first', 'discord'))
  const backlog = await call('enqueue', event('backlog', 'discord'))
  const alert = await call('enqueue', event('alert', 'github'))
  const attempt = await call('claim')
  assert.equal(attempt.id, first.id)
  await call('finish', attempt.id, attempt.attempt, 'not_sent')
  await call('age', 61_000)
  const retry = await call('claim')
  assert.equal(retry.id, first.id)
  assert.equal((await call('status', backlog.id)).reason, 'source_open')
  assert.equal((await call('rearmBreaker', 1)).ok, false)
  await call('finish', retry.id, retry.attempt, 'not_sent')
  assert.equal((await call('status', first.id)).reason, 'source_open')
  await call('reopen', 'device-a', '{"maxAttempts":10,"maxAttemptsPerSource":3}')
  assert.equal((await call('enqueue', event('new', 'discord'))).state, 'suppressed')
  const next = await call('claim')
  assert.equal(next.id, alert.id)
  await call('finish', next.id, next.attempt, 'sent')
  const status = await call('breakerStatus')
  assert.equal(status.remaining, 1)
  assert.equal(status.state, 'closed')
  assert.equal(status.maxAttemptsPerSource, 2)
  assert.deepEqual(status.sourceAttempts, { discord: 2, github: 1 })
  assert.equal((await call('rearmBreaker', 99)).ok, false)
  const recovered = await call('rearmBreaker', 1)
  assert.equal(recovered.ok, true)
  assert.equal(recovered.status.remaining, 10)
  assert.equal(recovered.status.maxAttemptsPerSource, 3)
  assert.deepEqual(recovered.status.sourceAttempts, {})
  assert.equal((await call('enqueue', event('recovered', 'discord'))).state, 'queued')
  assert.equal((await call('enqueue', event('backlog', 'discord'))).state, 'suppressed')
})

test('a retraction suppresses pending, retried and late messages from its source only', async () => {
  const call = await registeredInbox('retracted-messages')
  const message = (key, messageId, source = 'line') => ({ ...event(key, source, 'message'), messageId })
  const sending = await call('enqueue', message('one', '1'))
  const attempt = await call('claim')
  const pending = await call('enqueue', message('two', '2'))
  await call('retractMessages', 'line', ['1', '2', '3'])
  assert.equal((await call('status', pending.id)).reason, 'message_retracted')
  await call('finish', sending.id, attempt.attempt, 'not_sent')
  assert.equal((await call('status', sending.id)).state, 'suppressed')
  const late = await call('enqueue', message('late', '3'))
  assert.equal((await call('status', late.id)).reason, 'message_retracted')
  const other = await call('enqueue', message('unrelated', '1', 'elsewhere'))
  assert.equal((await call('claim')).id, other.id)
})

test('grouped provider callbacks share one delivery attempt through restart and expire with its receipt', async () => {
  const call = await registeredInbox('grouped-callbacks')
  await call('reopen', 'device-a', '{"maxAttempts":3,"maxAttemptsPerSource":3}')
  const original = { ...event('first', 'slack', 'message'), coalesceKey: 'post-1' }
  const mention = { ...event('second', 'slack', 'app_mention'), coalesceKey: 'post-1' }
  const receipt = await call('enqueue', original)
  const claim = await call('claim')
  await call('finish', receipt.id, claim.attempt, 'sent')
  await call('reopen', 'device-a', '{"maxAttempts":3,"maxAttemptsPerSource":3}')
  assert.deepEqual(await call('enqueue', mention), { id: receipt.id, state: 'sent', duplicate: true })
  assert.equal(await call('claim'), null)
  assert.equal((await call('breakerStatus')).remaining, 2)
  await call('age', 8 * 24 * 60 * 60_000)
  const next = await call('enqueue', mention)
  assert.equal(next.state, 'queued')
  assert.equal(next.duplicate, false)
  assert.notEqual(next.id, receipt.id)
})
