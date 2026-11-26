import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Response } from 'miniflare'
import { startConfiguredWorker } from './worker.ts'
import { connect } from './mcp-client.ts'

const cron = '/cdn-cgi/local/scheduled?format=json'

test('a scheduled run skips Bluesky when it is unconfigured', async (t) => {
  const calls: string[] = []
  const worker = await startConfiguredWorker((req) => {
    calls.push(req.url)
    return new Response(null, { status: 500 })
  })
  t.after(() => worker.close())
  assert.equal((await fetch(new URL(cron, worker.url))).status, 200)
  assert.deepEqual(calls, [])
})

test('the schedule establishes a baseline then queues a new public post in the personal inbox', async (t) => {
  const did = 'did:plc:abcdefghijklmnopqrstuvwx'
  let feedCalls = 0
  const item = (n: number) => ({
    post: {
      uri: 'at://' + did + '/app.bsky.feed.post/3mbbcdabc2' + n,
      cid: 'example-cid-' + n,
      author: { did, handle: 'test.bsky.social' },
      record: {
        $type: 'app.bsky.feed.post',
        text: 'Post ' + n,
        createdAt: '2026-11-20T00:00:0' + n + '.000Z',
      },
      indexedAt: '2026-11-20T00:00:0' + n + '.000Z',
    },
  })
  const worker = await startConfiguredWorker(
    (req) => {
      const url = new URL(req.url)
      if (url.origin !== 'https://public.api.bsky.app') return new Response(null, { status: 503 })
      assert.equal(url.searchParams.get('actor'), did)
      assert.equal(req.headers.get('authorization'), null)
      feedCalls++
      return Response.json({ feed: feedCalls === 1 ? [item(1)] : [item(2), item(1)] })
    },
    { BLUESKY_DID: did },
  )
  t.after(() => worker.close())
  const reader = await connect(new URL('/mcp', worker.url), 'MCP_TOKEN-test')
  t.after(() => reader.close())
  const tick = async () => {
    const res = await fetch(new URL(cron, worker.url))
    assert.equal(res.status, 200, await res.text())
  }
  const sources = async () => (await reader.callTool({ name: 'list_sources' })).structuredContent
  await tick()
  assert.deepEqual(await sources(), { sources: [] })
  await tick()
  assert.deepEqual(await sources(), { sources: [{ source: 'bluesky', paused: false, types: [] }] })
  assert.equal(feedCalls, 2)
})
