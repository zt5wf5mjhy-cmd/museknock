import { z } from 'zod'
import {
  blueskyKey,
  pollBlueskyFeed,
  type BlueskyCheckpoint,
  type BlueskyEnqueue,
} from './bluesky.ts'
import type { CredentialStore } from './credential-store.ts'
import { identifier as eventType } from './identifiers.ts'

const origin = 'https://bsky.social/xrpc/'
const sessionKey = 'bluesky-notifications.session'
const checkpointKey = 'bluesky-notifications.checkpoint'
const token = z
  .string()
  .min(1)
  .regex(/^[!-~]+$/)
const credentials = z.object({
  did: z.string().startsWith('did:'),
  accessJwt: token,
  refreshJwt: token,
})
export type BlueskySession = z.infer<typeof credentials>
type CheckpointStore = {
  get<T>(key: typeof checkpointKey): Promise<T | undefined>
  put(key: typeof checkpointKey, value: BlueskyCheckpoint): Promise<void>
}
type Transport = (url: URL, init: RequestInit) => Promise<Response>

const postText = z.object({ text: z.string().max(3000) })
const listing = z.object({
  cursor: z.string().max(4096).optional(),
  notifications: z
    .array(
      z.object({
        uri: z.string().startsWith('at://'),
        author: z.object({ did: z.string().startsWith('did:'), handle: z.string() }),
        reason: z.string().min(1),
        reasonSubject: z.string().optional(),
        record: z.unknown(),
        indexedAt: z.iso.datetime({ offset: true }),
      }),
    )
    .max(10),
})

function request(transport: Transport, url: URL, init: RequestInit) {
  return transport(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(10_000) })
}

async function invalidToken(response: Response) {
  if (response.status !== 400 && response.status !== 401) return false
  const data = (await response.json().catch(() => null)) as { error?: unknown } | null
  return data?.error === 'ExpiredToken' || data?.error === 'InvalidToken'
}

export async function pollBlueskyNotifications(
  identifier: string,
  password: string,
  storage: CheckpointStore,
  credentialsStore: CredentialStore,
  enqueue: BlueskyEnqueue,
  transport: Transport = fetch,
) {
  const fingerprint = await blueskyKey(JSON.stringify([identifier, password]))
  const stored = await credentialsStore.get(sessionKey)
  async function save(response: Response): Promise<BlueskySession> {
    if (!response.ok)
      throw new Error('Bluesky authentication failed (HTTP ' + response.status + ')')
    const session = credentials.parse(await response.json())
    await credentialsStore.put(sessionKey, { fingerprint, session })
    return session
  }
  async function login() {
    const response = await request(
      transport,
      new URL(origin + 'com.atproto.server.createSession'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      },
    )
    return save(response)
  }
  let session = stored?.fingerprint === fingerprint ? stored.session : await login()
  const owner = session.did
  const saved = await storage.get<BlueskyCheckpoint>(checkpointKey)
  const next = await pollBlueskyFeed(owner, saved, enqueue, async (cursor) => {
    const url = new URL(origin + 'app.bsky.notification.listNotifications')
    url.searchParams.set('limit', '10')
    if (cursor) url.searchParams.set('cursor', cursor)
    const read = () =>
      request(transport, url, { headers: { Authorization: 'Bearer ' + session.accessJwt } })
    let response = await read()
    let needsAuth = await invalidToken(response)
    if (needsAuth) {
      const rotated = await request(
        transport,
        new URL(origin + 'com.atproto.server.refreshSession'),
        {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + session.refreshJwt },
        },
      )
      session = (await invalidToken(rotated)) ? await login() : await save(rotated)
      if (session.did !== owner) throw new Error('Bluesky account changed during polling')
      response = await read()
      needsAuth = await invalidToken(response)
    }
    if (cursor && response.status === 400 && !needsAuth) return { restart: true as const }
    if (!response.ok)
      throw new Error('Bluesky notification lookup failed (HTTP ' + response.status + ')')
    const page = listing.parse(await response.json())
    const items = await Promise.all(
      page.notifications.map(async ({ uri, author, reason, reasonSubject, record, indexedAt }) => {
        const post = postText.safeParse(record)
        return {
          key: await blueskyKey(JSON.stringify([owner, uri, author.did, reason, reasonSubject])),
          type: eventType.test(reason) ? reason : 'notification',
          text: JSON.stringify({
            uri,
            author,
            reason,
            reasonSubject,
            text: post.success ? post.data.text : undefined,
          }),
          indexedAt: Date.parse(indexedAt),
        }
      }),
    )
    return { items, cursor: page.cursor }
  })
  await storage.put(checkpointKey, next)
}
