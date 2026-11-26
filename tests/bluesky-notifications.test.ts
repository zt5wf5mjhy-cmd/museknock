import assert from 'node:assert/strict'
import { test } from 'node:test'
import { serialize } from 'node:v8'
import { Response as WorkerResponse } from 'miniflare'
import { startConfiguredWorker } from './worker.ts'
import { connect } from './mcp-client.ts'
import { CredentialStore } from '../src/credential-store.ts'
import { pollBlueskyNotifications } from '../src/bluesky-notifications.ts'
import type { BlueskyEnqueue } from '../src/bluesky.ts'

const account = 'alice.bsky.social'
const password = 'app-password-test'
const did = 'did:plc:test-owner'
const create = 'com.atproto.server.createSession'
const refresh = 'com.atproto.server.refreshSession'
const list = 'app.bsky.notification.listNotifications'

function store() {
  const saved = new Map<string, unknown>()
  return {
    saved,
    async get<T>(key: string) {
      return saved.get(key) as T | undefined
    },
    async list<T>({ prefix, limit }: { prefix: string; limit: number }) {
      return new Map([...saved].filter(([key]) => key.startsWith(prefix)).slice(0, limit)) as Map<string, T>
    },
    async put<T>(key: string, value: T) {
      saved.set(key, structuredClone(value))
    },
  }
}

function session(n: number, owner = did) {
  return Response.json({ did: owner, accessJwt: 'access-' + n, refreshJwt: 'refresh-' + n })
}
function event(id: number, reason = 'mention') {
  return {
    uri: 'at://did:plc:sender/app.bsky.feed.post/' + id,
    author: { did: 'did:plc:sender', handle: 'sender.bsky.social', description: 'extra' },
    record: { text: 'post ' + id, embed: { key: 'not for chat' } },
    indexedAt: new Date(1700000000000 + id * 1000).toISOString(),
    reason,
    reasonSubject: 'at://did:plc:subject/app.bsky.feed.post/initial',
    isRead: false,
  }
}

function server(...calls: [string, string | null, Response][]) {
  let next = 0
  return {
    complete() {
      assert.equal(next, calls.length)
    },
    async request(url: URL, options: RequestInit) {
      const [method, token, response] = calls[next++]
      assert.equal(url.origin + url.pathname, 'https://bsky.social/xrpc/' + method)
      assert.equal(options.redirect, 'manual')
      assert.ok(options.signal)
      assert.equal(new Headers(options.headers).get('Authorization'), token && 'Bearer ' + token)
      if (method === create) assert.ok(JSON.parse(String(options.body)).password)
      if (method === list) {
        assert.equal(url.searchParams.get('limit'), '10')
        assert.equal(url.searchParams.has('seenAt'), false)
      }
      return response
    },
  }
}
const page = (...notifications: ReturnType<typeof event>[]) => Response.json({ notifications })
const expired = () => Response.json({ error: 'ExpiredToken' }, { status: 400 })
const none: BlueskyEnqueue = async () => assert.fail('unexpected notification')

test('Bluesky reads personal notifications with a reusable session and keeps read state untouched', async () => {
  const storage = store()
  const credentialsStore = new CredentialStore(storage, 'ad'.repeat(32))
  const first = server([create, null, session(1)], [list, 'access-1', page(event(1))])
  await pollBlueskyNotifications(account, password, storage, credentialsStore, none, first.request)
  first.complete()
  const second = server([list, 'access-1', page(event(2), event(1))])
  let texts: string[] = []
  await pollBlueskyNotifications(
    account,
    password,
    storage,
    credentialsStore,
    async (events) => {
      texts = events.map((event) => event.text)
      assert.equal(events[0].type, 'mention')
      assert.match(events[0].key, /^[a-f0-9]{64}$/)
      return 'accepted'
    },
    second.request,
  )
  assert.equal(texts.length, 1)
  assert.match(texts[0], /post 2/)
  assert.doesNotMatch(texts[0], /extra|not for chat|app-password-test|access-1|refresh-1/)
  const third = server([list, 'access-1', page(event(2), event(1))])
  await pollBlueskyNotifications(account, password, storage, credentialsStore, none, third.request)
  assert.doesNotMatch(
    serialize(storage.saved).toString('latin1'),
    /app-password-test|access-1|refresh-1/,
  )
})

test('Bluesky refreshes expired tokens, saves rotations and signs in again only for invalid refresh credentials', async () => {
  const storage = store()
  const credentialsStore = new CredentialStore(storage, 'ad'.repeat(32))
  const run = async (...calls: Parameters<typeof server>) => {
    const api = server(...calls)
    await pollBlueskyNotifications(account, password, storage, credentialsStore, none, api.request)
    api.complete()
  }
  await run([create, null, session(1)], [list, 'access-1', page(event(1))])
  await run(
    [list, 'access-1', expired()],
    [refresh, 'refresh-1', session(2)],
    [list, 'access-2', page(event(1))],
  )
  assert.doesNotMatch(serialize(storage.saved).toString('latin1'), /access-2|refresh-2/)
  await assert.rejects(
    run([list, 'access-2', expired()], [refresh, 'refresh-2', new Response(null, { status: 503 })]),
    /503/,
  )
  await assert.rejects(run([list, 'access-2', Response.redirect('https://other.example')]), /302/)
  await assert.rejects(run([list, 'access-2', new Response(null, { status: 429 })]), /429/)
  await run(
    [list, 'access-2', expired()],
    [refresh, 'refresh-2', expired()],
    [create, null, session(3)],
    [list, 'access-3', page(event(1))],
  )
  const rotated = server(
    [create, null, session(4, 'did:plc:other-owner')],
    [list, 'access-4', page(event(5))],
  )
  await pollBlueskyNotifications(
    'other.bsky.social',
    'new-app-password',
    storage,
    credentialsStore,
    none,
    rotated.request,
  )
  rotated.complete()
})

test('the scheduled Worker polls the account notification endpoint and queues only new activity', async (t) => {
  let reads = 0
  let logins = 0
  const worker = await startConfiguredWorker(
    async (req) => {
      const url = new URL(req.url)
      if (url.origin !== 'https://bsky.social') return new WorkerResponse(null, { status: 503 })
      if (url.pathname.endsWith(create)) {
        logins++
        assert.deepEqual(await req.json(), { identifier: account, password })
        return WorkerResponse.json({ did, accessJwt: 'access-1', refreshJwt: 'refresh-1' })
      }
      assert.equal(url.pathname, '/xrpc/' + list)
      assert.equal(req.headers.get('authorization'), 'Bearer access-1')
      return WorkerResponse.json({
        notifications: ++reads === 1 ? [event(1)] : [event(2), event(1)],
      })
    },
    { BLUESKY_IDENTIFIER: account, BLUESKY_APP_PASSWORD: password },
  )
  t.after(() => worker.close())
  const reader = await connect(new URL('/mcp', worker.url), 'MCP_TOKEN-test')
  t.after(() => reader.close())
  const tick = async () => {
    const response = await fetch(new URL('/cdn-cgi/local/scheduled?format=json', worker.url))
    assert.equal(response.status, 200, await response.text())
  }
  const sources = async () => (await reader.callTool({ name: 'list_sources' })).structuredContent
  await tick()
  assert.deepEqual(await sources(), { sources: [] })
  await tick()
  assert.deepEqual(await sources(), {
    sources: [{ source: 'bluesky-notifications', paused: false, types: [] }],
  })
  assert.equal(reads, 2)
  assert.equal(logins, 1)
})
