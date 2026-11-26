import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startConfiguredWorker, startWorker } from './worker.ts'

test('a webhook is authenticated, validated and deduplicated', async (t) => {
  const worker = await startConfiguredWorker()
  t.after(() => worker.close())
  const post = (path: string, token: string, body?: string, headers?: Record<string, string>) =>
    fetch(new URL(path, worker.url), {
      method: 'POST',
      body,
      headers: { Authorization: 'Bearer ' + token, ...headers },
    })
  const hook = '/v1/hooks/custom'
  const hookToken = 'HOOK_TOKEN-test'
  const body = '{"temperature":35, "sensor_id":9007199254740993}'
  const headers = {
    'Content-Type': 'application/json',
    'X-Event-Type': 'sensor',
    'Idempotency-Key': 'sensor-1',
  }
  assert.equal((await post(hook, 'wrong-role', body, headers)).status, 401)
  assert.equal((await post('/hooks/custom', hookToken)).status, 404)
  assert.equal((await post('/hooks/slack', hookToken)).status, 404)
  assert.equal((await post('/bridge/claim', hookToken)).status, 404)
  assert.equal((await post('/v1/hooks/unknown', hookToken, body, headers)).status, 404)
  assert.equal((await post(hook, hookToken, '{', headers)).status, 400)
  assert.equal((await post(hook, hookToken, 'x'.repeat(33 * 1024))).status, 413)
  assert.equal((await post('/v1/hooks/default', hookToken, body, headers)).status, 404)
  const received = await post(hook, hookToken, body, headers)
  assert.equal(received.status, 202)
  const receipt = await received.json()
  assert.equal(receipt.state, 'queued')
  assert.deepEqual(await (await post(hook, hookToken, body, headers)).json(), {
    ...receipt,
    duplicate: true,
  })
  assert.equal(
    (
      await post(hook, hookToken, 'temp=30&temp=40', {
        'Content-Type': 'application/x-www-form-urlencoded',
      })
    ).status,
    202,
  )
  assert.equal((await post(hook, hookToken, 'plain text')).status, 202)
})

test('incomplete device configuration rejects a webhook before queuing it', async (t) => {
  const worker = await startWorker(undefined, { MUSE_REFRESH_TOKEN: '' })
  t.after(() => worker.close())
  const response = await fetch(new URL('/v1/hooks/custom', worker.url), {
    method: 'POST',
    headers: { Authorization: 'Bearer HOOK_TOKEN-test' },
    body: 'event',
  })
  assert.equal(response.status, 503)
})

test('a deployment without an initial chat rejects new webhooks until a chat is registered', async (t) => {
  const worker = await startWorker()
  t.after(() => worker.close())
  const response = await fetch(new URL('/v1/hooks/custom', worker.url), {
    method: 'POST',
    headers: { Authorization: 'Bearer HOOK_TOKEN-test' },
    body: 'event',
  })
  assert.equal(response.status, 503)
  assert.match(await response.text(), /register.*side chat/i)
})

test('the Worker has no browser setup routes', async (t) => {
  const worker = await startConfiguredWorker()
  t.after(() => worker.close())
  for (const path of ['/', '/setup', '/setup/', '/setup/setup.js']) {
    const response = await fetch(new URL(path, worker.url), { redirect: 'manual' })
    assert.equal(response.status, 404, path)
  }
})
