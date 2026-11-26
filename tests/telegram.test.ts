import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startConfiguredWorker } from './worker.ts'

const secret = 'telegram_test-secret'
const update = { message: { message_id: 5, chat: { id: -12 }, text: 'Hello' } }
test('Telegram authenticates updates and deduplicates them by update_id before rate limiting', async (t) => {
  const worker = await startConfiguredWorker(undefined, { TELEGRAM_WEBHOOK_SECRET: secret, HOOK_TOKEN: '' })
  t.after(() => worker.close())
  const post = (body: unknown, token?: string) =>
    fetch(new URL('/v1/hooks/telegram', worker.url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token && { 'X-Telegram-Bot-Api-Secret-Token': token }),
      },
      body: JSON.stringify(body),
    })
  for (const token of [undefined, 'wrong']) assert.equal((await post(update, token)).status, 401)
  assert.equal((await post(update, secret)).status, 400)
  assert.equal((await post({ update_id: 100, message: null }, secret)).status, 400)
  for (let id = 1; id <= 10; id++) {
    assert.equal((await post({ update_id: id, ...update }, secret)).status, 200)
  }
  assert.equal((await post({ update_id: 1, ...update }, secret)).status, 200)
  assert.equal((await post({ update_id: 11, ...update }, secret)).status, 429)
})

test('Telegram requires a configured webhook secret', async (t) => {
  const worker = await startConfiguredWorker()
  t.after(() => worker.close())
  const response = await fetch(new URL('/v1/hooks/telegram', worker.url), { method: 'POST' })
  assert.equal(response.status, 503)
})

test('a Telegram secret shared with a webhook or MCP role disables bearer-protected routes', async () => {
  for (const role of ['HOOK_TOKEN', 'MCP_TOKEN', 'MCP_ADMIN_TOKEN', 'MCP_RECOVERY_TOKEN']) {
    const worker = await startConfiguredWorker(undefined, {
      [role]: secret,
      TELEGRAM_WEBHOOK_SECRET: secret,
    })
    try {
      for (const path of ['/v1/hooks/telegram', '/v1/hooks/custom', '/mcp', '/v1/setup/pairing']) {
        const response = await fetch(new URL(path, worker.url), {
          method: 'POST',
          headers: path === '/v1/hooks/telegram'
            ? { 'X-Telegram-Bot-Api-Secret-Token': secret }
            : { Authorization: 'Bearer ' + secret },
          body: JSON.stringify({ update_id: 1, ...update }),
        })
        assert.equal(response.status, 503, role + ' on ' + path)
      }
      assert.deepEqual(await worker.storedEvents(), [])
    } finally {
      await worker.close()
    }
  }
})
