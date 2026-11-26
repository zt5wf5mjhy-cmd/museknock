import { z } from 'zod'
import type { BatchResult, Delivery } from './delivery.ts'

type Marker = { key: string | null; indexedAt: number }
export type BlueskyCheckpoint = {
  identity: string
  head: Marker
  scan?: { cursor: string; head?: Marker }
}
type Event = Pick<Delivery, 'type' | 'text'> & { key: string }
export type BlueskyItem = Event & { indexedAt: number }
export type BlueskyEnqueue = (events: Event[]) => Promise<BatchResult>
type Page = { items: BlueskyItem[]; cursor?: string } | { restart: true }

export async function blueskyKey(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function pollBlueskyFeed(
  identity: string,
  saved: BlueskyCheckpoint | undefined,
  enqueue: BlueskyEnqueue,
  read: (cursor?: string) => Promise<Page>,
): Promise<BlueskyCheckpoint> {
  const previous = saved?.identity === identity ? saved : undefined
  const started = Date.now()
  const page = await read(previous?.scan?.cursor)
  if ('restart' in page) {
    if (!previous?.scan) throw new Error('Bluesky rejected the initial feed request')
    return { identity, head: previous.head }
  }
  const { items, cursor } = page
  const first = items[0]
  const head = first && { key: first.key, indexedAt: first.indexedAt }
  if (!previous) return { identity, head: head ?? { key: null, indexedAt: started } }

  const boundary = items.findIndex((item) => item.key === previous.head.key)
  const candidates = boundary < 0 ? items : items.slice(0, boundary)
  // A deleted post cannot mark the boundary. Its server indexing time still excludes history.
  const fresh = candidates.filter((item) => item.indexedAt >= previous.head.indexedAt)
  if (fresh.length) {
    const result = await enqueue(fresh.map(({ key, type, text }) => ({ key, type, text })))
    if (result !== 'accepted') return previous
  }
  const newest =
    previous.scan?.head ??
    (fresh.length ? { key: fresh[0].key, indexedAt: fresh[0].indexedAt } : undefined)
  const reachedHistory =
    boundary >= 0 || (items.at(-1)?.indexedAt ?? Infinity) < previous.head.indexedAt
  if (!reachedHistory && cursor) {
    if (cursor === previous.scan?.cursor) return { identity, head: previous.head }
    return { ...previous, scan: { cursor, head: newest } }
  }
  return { identity, head: newest ?? previous.head }
}

const feed = z.object({
  cursor: z.string().max(4096).optional(),
  feed: z
    .array(
      z.object({
        reason: z.unknown().optional(),
        post: z.object({
          uri: z.string(),
          indexedAt: z.iso.datetime({ offset: true }),
          author: z.object({ did: z.string() }),
          record: z.object({
            $type: z.literal('app.bsky.feed.post'),
            text: z.string().max(3000),
            reply: z.unknown().optional(),
          }),
        }),
      }),
    )
    .max(10),
})

export async function pollBluesky(
  did: string,
  saved: BlueskyCheckpoint | undefined,
  enqueue: BlueskyEnqueue,
  fetchPage: (url: URL, init: RequestInit) => Promise<Response> = fetch,
): Promise<BlueskyCheckpoint> {
  if (!/^did:(?:plc:[a-z2-7]{24}|web:[a-zA-Z0-9.-]+)$/.test(did) || did.length > 2048) {
    throw new Error('Expected a Bluesky account DID')
  }
  return pollBlueskyFeed(did, saved, enqueue, async (cursor) => {
    const url = new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed')
    url.search = new URLSearchParams({
      actor: did,
      filter: 'posts_and_replies_only',
      includePins: 'false',
      limit: '10',
    }).toString()
    if (cursor) url.searchParams.set('cursor', cursor)
    const response = await fetchPage(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
    if (cursor && response.status === 400) return { restart: true }
    if (!response.ok) throw new Error('Bluesky author feed returned HTTP ' + response.status)
    const page = feed.parse(await response.json())
    const items: BlueskyItem[] = []
    const prefix = 'at://' + did + '/app.bsky.feed.post/'
    for (const { post, reason } of page.feed) {
      if (reason || post.author.did !== did || !post.uri.startsWith(prefix)) continue
      const rkey = post.uri.slice(prefix.length)
      if (!/^[a-zA-Z0-9._:~-]{1,512}$/.test(rkey) || rkey === '.' || rkey === '..') continue
      items.push({
        key: await blueskyKey(post.uri),
        type: post.record.reply ? 'reply' : 'post',
        indexedAt: Date.parse(post.indexedAt),
        text: JSON.stringify({
          text: post.record.text,
          url: 'https://bsky.app/profile/' + did + '/post/' + rkey,
        }),
      })
    }
    return { items, cursor: page.cursor }
  })
}
