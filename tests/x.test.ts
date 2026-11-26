import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { connect } from './mcp-client.ts'
import { startConfiguredWorker, startWorker } from './worker.ts'

const secret = 'x-test-client-secret'
const signature = (message: string) =>
  'sha256=' + createHmac('sha256', secret).update(message).digest('base64')
function post(url: URL, body: string, digest = signature(body)) {
  return fetch(new URL('/v1/hooks/x', url), {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json', 'X-Twitter-Webhooks-Signature-OAuth2': digest },
  })
}
function activity(type: string, id = '2080761390344937796') {
  return {
    data: {
      event_uuid: id,
      event_type: type,
      filter: { user_id: '1111111111111111111' },
      payload: { id: '2080761390344937796', author_id: '1111111111111111111', text: '新しい投稿' },
    },
  }
}

test('X signs CRC challenges before Muse setup and requires a configured client secret', async (t) => {
  const worker = await startWorker(undefined, {
    X_OAUTH2_CLIENT_SECRET: secret,
  })
  t.after(() => worker.close())
  const url = new URL('/v1/hooks/x', worker.url)
  assert.equal((await fetch(url)).status, 400)
  const token = 'challenge_x-2'
  url.searchParams.set('crc_token', token)
  const crc = await fetch(url)
  assert.equal(crc.status, 200)
  assert.deepEqual(await crc.json(), { response_token: signature(token) })
  url.searchParams.set('crc_token', 'invalid token')
  assert.equal((await fetch(url)).status, 400)
  const body = JSON.stringify(activity('post.create'))
  assert.equal((await post(worker.url, body)).status, 503)
  const disabled = await startConfiguredWorker()
  t.after(() => disabled.close())
  assert.equal((await post(disabled.url, body)).status, 503)
})

test('X authenticates exact bytes, ignores unrelated activities and deduplicates public Post events', async (t) => {
  const worker = await startConfiguredWorker(undefined, { X_OAUTH2_CLIENT_SECRET: secret })
  t.after(() => worker.close())
  const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
  t.after(() => admin.close())
  const list = () => admin.callTool({ name: 'list_sources' })
  const event = activity('post.create')
  const body = JSON.stringify(event)
  assert.equal((await post(worker.url, body + ' ', signature(body))).status, 401)
  assert.equal((await post(worker.url, '{')).status, 400)
  assert.equal(
    (await post(worker.url, JSON.stringify({ data: { event_type: 'post.create' } }))).status,
    400,
  )
  assert.equal((await post(worker.url, JSON.stringify(activity('dm.received')))).status, 200)
  assert.deepEqual((await list()).structuredContent, { sources: [] })
  const posts = Array.from({ length: 9 }, (_, n) =>
    JSON.stringify(activity('post.create', String(n + 1))),
  )
  const deleted = JSON.stringify({
    data: {
      event_type: 'post.delete',
      event_uuid: '-2781149976877970683',
      payload: { id: '203012655', author_id: '111' },
    },
  })
  for (const message of [...posts, deleted, ...posts, deleted]) {
    assert.equal((await post(worker.url, message)).status, 200)
  }
  assert.equal((await post(worker.url, body)).status, 429)
  assert.deepEqual((await list()).structuredContent, {
    sources: [{ source: 'x', types: [], paused: false }],
  })
})

test('X deletion clears queued text and suppresses a late creation for the same post', async (t) => {
  const worker = await startConfiguredWorker(undefined, { X_OAUTH2_CLIENT_SECRET: secret })
  t.after(() => worker.close())
  const events = [
    ['post.create', 'create-1', '101'],
    ['post.delete', 'delete-1', '101'],
    ['post.delete', 'delete-2', '102'],
    ['post.create', 'create-2', '102'],
    ['post.create', 'unrelated', '103'],
  ]
  for (const [type, key, id] of events) {
    const notification = activity(type, key)
    notification.data.payload.id = id
    assert.equal((await post(worker.url, JSON.stringify(notification))).status, 200)
  }
  const rows = await worker.storedEvents()
  assert.deepEqual(rows.map(({ key, state }) => [key, state]), [
    ['create-1', 'suppressed'],
    ['delete-1', 'queued'],
    ['delete-2', 'queued'],
    ['create-2', 'suppressed'],
    ['unrelated', 'queued'],
  ])
  assert.deepEqual(rows.filter(r => r.state === 'suppressed').map(r => r.text), ['', ''])
  assert.equal(JSON.parse(rows[4].text).text, '新しい投稿')
  for (const row of rows.filter(r => r.type === 'post_delete')) {
    assert.equal(JSON.parse(row.text).text, undefined)
  }
})
