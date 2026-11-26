import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { connect } from './mcp-client.ts'
import { openSettings } from './settings-client.ts'
import { startConfiguredWorker, startWorker } from './worker.ts'

const secrets = {
  SLACK_SIGNING_SECRET: 'slack-signing-key',
  LINE_CHANNEL_SECRET: 'line-channel-key',
}

function slackHeaders(body: string, offset = 0) {
  const timestamp = String(Math.floor(Date.now() / 1000) + offset)
  const digest = createHmac('sha256', secrets.SLACK_SIGNING_SECRET)
    .update('v0:' + timestamp + ':' + body)
    .digest('hex')
  return { 'X-Slack-Request-Timestamp': timestamp, 'X-Slack-Signature': 'v0=' + digest }
}

function lineHeaders(body: string) {
  const digest = createHmac('sha256', secrets.LINE_CHANNEL_SECRET).update(body).digest('base64')
  return { 'X-Line-Signature': digest }
}

function post(url: URL, service: string, body: string, headers: Record<string, string>) {
  return fetch(new URL('/v1/hooks/' + service, url), {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

test('Slack and LINE verify signed connection checks before device and destination setup', async (t) => {
  const worker = await startWorker(undefined, {
    ...secrets,
    MUSE_REFRESH_TOKEN: '',
  })
  t.after(() => worker.close())
  const challenge = '{ "type": "url_verification", "challenge": "桜" }'
  const confirmation = await post(worker.url, 'slack', challenge, slackHeaders(challenge))
  assert.equal(confirmation.status, 200)
  assert.equal(await confirmation.text(), '桜')
  const emptyBatch = '{ "destination":"Utest", "events": [] }'
  assert.equal((await post(worker.url, 'line', emptyBatch, lineHeaders(emptyBatch))).status, 200)

  const slack = JSON.stringify({
    type: 'event_callback',
    event_id: 'Ev1',
    event: { type: 'app_mention', text: 'Hi' },
  })
  const line = JSON.stringify({ events: [{ type: 'follow', webhookEventId: 'ID1' }] })
  assert.equal((await post(worker.url, 'slack', slack, slackHeaders(slack))).status, 503)
  assert.equal((await post(worker.url, 'line', line, lineHeaders(line))).status, 503)
})

test('Slack and LINE require provider credentials and authenticate exact bytes before parsing', async (t) => {
  const worker = await startConfiguredWorker(undefined, secrets)
  t.after(() => worker.close())
  const disabled = await startConfiguredWorker()
  t.after(() => disabled.close())
  const malformed = '{'
  for (const [service, sign] of [
    ['slack', slackHeaders],
    ['line', lineHeaders],
  ] as const) {
    assert.equal((await post(disabled.url, service, malformed, sign(malformed))).status, 503)
    assert.equal(
      (await post(worker.url, service, malformed, { Authorization: 'Bearer HOOK_TOKEN-test' }))
        .status,
      401,
    )
    assert.equal((await post(worker.url, service, malformed, sign(malformed + ' '))).status, 401)
    assert.equal((await post(worker.url, service, malformed, sign(malformed))).status, 400)
  }
  for (const offset of [-360, 360]) {
    assert.equal(
      (await post(worker.url, 'slack', malformed, slackHeaders(malformed, offset))).status,
      401,
    )
  }
  assert.equal((await post(worker.url, 'line', malformed, { 'X-Line-Signature': '@' })).status, 401)
})

test('Slack and LINE queue callbacks under their own source and accept retries with the same event IDs', async (t) => {
  const worker = await startConfiguredWorker(undefined, secrets)
  t.after(() => worker.close())
  const client = await connect(new URL('/mcp', worker.url), 'MCP_TOKEN-test')
  t.after(() => client.close())
  const slack = JSON.stringify({
    type: 'event_callback',
    team_id: 'T1',
    event_id: 'Ev1',
    event: { type: 'message', text: 'Hi' },
  })
  const events = Array.from({ length: 10 }, (_, n) => ({
    type: 'message',
    webhookEventId: 'ID' + n,
    message: { type: 'text', id: String(n), text: '桜' },
  }))
  for (let attempt = 0; attempt < 2; ++attempt) {
    assert.equal((await post(worker.url, 'slack', slack, slackHeaders(slack))).status, 200)
    const line = JSON.stringify({
      events: events.map((e) => ({ ...e, deliveryContext: { isRedelivery: !!attempt } })),
    })
    assert.equal((await post(worker.url, 'line', line, lineHeaders(line))).status, 200)
  }
  const line = JSON.stringify({ events: [{ ...events[0], webhookEventId: 'extra' }] })
  assert.equal((await post(worker.url, 'line', line, lineHeaders(line))).status, 429)
  assert.deepEqual((await client.callTool({ name: 'list_sources' })).structuredContent, {
    sources: [
      { source: 'line', paused: false, types: [] },
      { source: 'slack', paused: false, types: [] },
    ],
  })
})

test('LINE retains message text and omits provider credentials and reply capabilities', async (t) => {
  const worker = await startConfiguredWorker(undefined, secrets)
  t.after(() => worker.close())
  // A field above the notification limit makes its inclusion observable at the HTTP boundary.
  const long = 'x'.repeat(32 * 1024)
  for (const text of ['Hi', long]) {
    const expected = text === long ? 413 : 200
    const line = JSON.stringify({
      events: [
        {
          type: 'message',
          webhookEventId: 'ID' + expected,
          replyToken: long,
          message: { type: 'text', id: 'm1', text, quoteToken: long },
        },
      ],
    })
    assert.equal((await post(worker.url, 'line', line, lineHeaders(line))).status, expected)
  }
})

test('Slack queues UTF-8 previews with channel and message timestamps for long posts and edits', async (t) => {
  const worker = await startConfiguredWorker(undefined, secrets)
  t.after(() => worker.close())
  const longText = '文🌱'.repeat(6000)
  const escapedText = String.fromCharCode(2).repeat(12_000)
  const ts = '1234567890.123456'
  const shortTs = '1234567889.123456'
  const editTs = '1234567891.123456'
  for (const [key, event] of Object.entries({
    short: { text: 'Hello', ts: shortTs },
    long: { text: longText, ts },
    edit: { subtype: 'message_changed', ts: editTs, text: longText, message: { text: escapedText, ts } },
  })) {
    const body = JSON.stringify({
      type: 'event_callback',
      event_id: key,
      token: 'callback-secret',
      event: { type: 'message', channel: 'C123', response_url: 'private-url', ...event },
    })
    assert.equal((await post(worker.url, 'slack', body, slackHeaders(body))).status, 200)
  }
  const rows = await worker.storedEvents()
  assert.equal(rows.length, 3)
  for (const { key, text } of rows) {
    assert.ok(Buffer.byteLength(text) <= 32 * 1024)
    assert.doesNotMatch(text, /callback-secret|private-url/)
    const summary = JSON.parse(text)
    assert.equal(summary.channel, 'C123')
    assert.equal(summary.ts, { short: shortTs, edit: editTs, long: ts }[key])
    if (key === 'short') {
      assert.equal(summary.text, 'Hello')
    } else {
      const excerpt = key === 'edit' ? summary.message.text : summary.text
      const original = key === 'edit' ? escapedText : longText
      assert.ok(excerpt.length > 0 && excerpt.length < original.length)
      assert.ok(original.startsWith(excerpt))
      assert.equal(excerpt.isWellFormed(), true)
      assert.equal(summary.truncated, true)
      if (key === 'edit') {
        assert.equal(summary.message.ts, ts)
        assert.ok(summary.text.length > 0 && longText.startsWith(summary.text))
      }
    }
  }
})

test('Slack retracts queued messages and edits in either arrival order and identifies reactions', async (t) => {
  const worker = await startConfiguredWorker(undefined, secrets)
  t.after(() => worker.close())
  const ts = '1234567890.123456'
  const channel = 'C1'
  const item = { type: 'message', channel, ts }
  for (const [event_id, event] of Object.entries({
    original: { type: 'message', channel, ts, text: 'original' },
    mention: { type: 'app_mention', channel, ts, text: 'mention' },
    edit: { type: 'message', subtype: 'message_changed', channel, ts: '2', message: { ts, text: 'edited' } },
    other: { type: 'message', channel: 'C2', ts, text: 'keep' },
    deletion: { type: 'message', subtype: 'message_deleted', channel, deleted_ts: ts, ts: '3' },
    before: { type: 'message', subtype: 'message_deleted', channel, deleted_ts: '4', ts: '5' },
    late: { type: 'message', channel, ts: '4', text: 'late' },
    reaction: { type: 'reaction_added', item, reaction: 'eyes' },
  })) {
    const body = JSON.stringify({ type: 'event_callback', team_id: 'T1', event_id, event })
    assert.equal((await post(worker.url, 'slack', body, slackHeaders(body))).status, 200)
  }
  const rows = await worker.storedEvents()
  const states = Object.fromEntries(rows.map(({ key, state }) => [key, state]))
  assert.deepEqual(states, {
    original: 'suppressed', edit: 'suppressed', other: 'queued',
    deletion: 'queued', before: 'queued', late: 'suppressed', reaction: 'queued',
  })
  for (const row of rows.filter(row => row.state === 'suppressed')) assert.equal(row.text, '')
  assert.deepEqual(JSON.parse(rows.find(row => row.key === 'reaction')!.text).item, item)
})

test('Slack overlapping subscriptions queue one creation under either callback order and type filter', async (t) => {
  for (const allowed of [[], ['message'], ['app_mention']]) {
    const worker = await startConfiguredWorker(undefined, secrets)
    t.after(() => worker.close())
    const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
    t.after(() => admin.close())
    const settings = await openSettings(worker.url, admin)
    assert.equal((await settings.filter('slack', allowed)).status, 303)
    const pairs = [['app_mention', 'message'], ['message', 'app_mention']]
    for (const [i, pair] of pairs.entries()) {
      for (const type of pair) {
        const body = JSON.stringify({
          type: 'event_callback', event_id: type + i, team_id: 'T1',
          event: { type, text: 'hello', channel: 'C1', ts: '1234.00000' + i },
        })
        for (let attempt = 0; attempt < 2; attempt++)
          assert.equal((await post(worker.url, 'slack', body, slackHeaders(body))).status, 200)
      }
    }
    const queued = (await worker.storedEvents()).filter(row => row.state === 'queued')
    assert.deepEqual(queued.map(row => row.type), pairs.map(pair => allowed[0] ?? pair[0]))
    assert.deepEqual(queued.map(row => JSON.parse(row.text).ts), ['1234.000000', '1234.000001'])
  }
})
