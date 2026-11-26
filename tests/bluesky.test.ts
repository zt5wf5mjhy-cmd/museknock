import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pollBluesky, type BlueskyCheckpoint } from '../src/bluesky.ts'

const did = 'did:plc:z72i7hdynmk6r22z27h6tvur'
const other = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const uri = (id: number, actor = did) => 'at://' + actor + '/app.bsky.feed.post/' + id
const item = (id: number, actor = did, reply = false) => ({
  post: {
    uri: uri(id, actor),
    indexedAt: new Date(1700000000000 + id * 1000).toISOString(),
    author: { did: actor },
    record: {
      $type: 'app.bsky.feed.post',
      text: 'post ' + id,
      ...(reply && { reply: { parent: { uri: uri(1) } } }),
    },
  },
})
function page(feed: unknown[], cursor?: string, expectedCursor?: string, actor = did) {
  return async (url: URL, init: RequestInit) => {
    assert.equal(
      url.origin + url.pathname,
      'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed',
    )
    assert.equal(url.searchParams.get('actor'), actor)
    assert.equal(url.searchParams.get('filter'), 'posts_and_replies_only')
    assert.equal(url.searchParams.get('includePins'), 'false')
    assert.equal(url.searchParams.get('cursor'), expectedCursor ?? null)
    assert.equal(init.redirect, 'manual')
    assert.ok(init.signal)
    return Response.json({ feed, cursor })
  }
}
const noEvents = async (): Promise<'accepted'> => assert.fail('No notification expected')

test('baseline and actor change skip history; later polls accept only owned posts and replies', async () => {
  const base = await pollBluesky(did, undefined, noEvents, page([item(1)]))
  const events: string[] = []
  const completed = await pollBluesky(
    did,
    base,
    async (batch) => {
      for (const event of batch) {
        assert.ok(/^[0-9a-f]{64}$/.test(event.key))
        events.push(event.type + ':' + JSON.parse(event.text).text)
      }
      return 'accepted'
    },
    page([
      { ...item(9), reason: { $type: 'app.bsky.feed.defs#reasonPin' } },
      { ...item(8), reason: { $type: 'app.bsky.feed.defs#reasonRepost' } },
      item(7, other),
      item(3, did, true),
      item(2),
      item(1),
    ]),
  )
  assert.deepEqual(events, ['reply:post 3', 'post:post 2'])
  await pollBluesky(did, completed, noEvents, page([item(3, did, true), item(2), item(1)]))
  await pollBluesky(other, completed, noEvents, page([item(9, other)], undefined, undefined, other))
})

test('one persisted page per poll, failed enqueue and API failure keep a resumable boundary', async () => {
  const base = await pollBluesky(did, undefined, noEvents, page([item(1)]))
  let state: BlueskyCheckpoint = base
  const urls: string[] = []
  const accept: Parameters<typeof pollBluesky>[2] = async (events) => {
    urls.push(...events.map((event) => JSON.parse(event.text).url))
    return 'accepted'
  }
  state = await pollBluesky(did, state, accept, page([item(4)], 'older'))
  const waiting = await pollBluesky(
    did,
    state,
    async () => 'limited',
    page([item(3), item(2)], 'end', 'older'),
  )
  assert.deepEqual(waiting, state)
  await assert.rejects(
    pollBluesky(did, state, accept, async () => new Response(null, { status: 503 })),
  )
  state = await pollBluesky(did, waiting, accept, page([item(3), item(2)], 'end', 'older'))
  state = await pollBluesky(did, state, noEvents, page([item(1)], undefined, 'end'))
  await pollBluesky(did, state, noEvents, page([item(4)]))
  assert.deepEqual(
    urls,
    [4, 3, 2].map((id) => 'https://bsky.app/profile/' + did + '/post/' + id),
  )
})

test('deleting the boundary or starting with an empty profile does not replay historic posts', async () => {
  const base = await pollBluesky(did, undefined, noEvents, page([item(9), item(7)]))
  await pollBluesky(did, base, noEvents, page([item(4)]))
  const empty = await pollBluesky(did, undefined, noEvents, page([]))
  await pollBluesky(did, empty, noEvents, page([item(4)]))
  await assert.rejects(
    pollBluesky('https://wrong.test/', undefined, noEvents, async () =>
      assert.fail('unexpected fetch'),
    ),
    /DID/,
  )
})

test('an invalid or nonadvancing cursor restarts the scan without advancing its boundary', async () => {
  const base = await pollBluesky(did, undefined, noEvents, page([item(1)]))
  const accept = async () => 'accepted' as const
  const scan = await pollBluesky(did, base, accept, page([item(3)], 'old-page'))
  const invalid = async () => new Response(null, { status: 400 })
  assert.deepEqual(await pollBluesky(did, scan, accept, invalid), base)
  assert.deepEqual(
    await pollBluesky(did, scan, accept, page([item(2)], 'old-page', 'old-page')),
    base,
  )
  await assert.rejects(pollBluesky(did, base, accept, invalid))
})

test('an empty filtered page does not hide the newest post on the following page', async () => {
  const base = await pollBluesky(did, undefined, noEvents, page([item(1)]))
  const empty = await pollBluesky(did, base, noEvents, page([], 'older'))
  const finish = await pollBluesky(
    did,
    empty,
    async () => 'accepted',
    page([item(2), item(1)], undefined, 'older'),
  )
  await pollBluesky(did, finish, noEvents, page([item(2)]))
})
