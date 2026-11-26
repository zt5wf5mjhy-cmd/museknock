import { z } from 'zod'
import type { BatchResult, Delivery } from './delivery.ts'

export type DiscordCheckpoint = { channelId: string; lastId?: string; retryAt?: number }
type Enqueue = (
  events: (Pick<Delivery, 'type' | 'text'> & { key: string })[],
) => Promise<BatchResult>
type Transport = (url: URL, init: RequestInit) => Promise<Response>
const snowflake = z.string().regex(/^[1-9]\d{0,19}$/)
const messageBody = z.object({
  content: z.string(),
  attachments: z.array(
    z.object({
      filename: z.string(),
      size: z.number().int().nonnegative(),
      content_type: z.string().optional(),
    }),
  ),
})
const message = messageBody.extend({
  id: snowflake,
  channel_id: snowflake,
  type: z.number().int(),
  author: z.object({ id: snowflake, username: z.string().max(80) }),
  message_reference: z.object({ type: z.number().int().optional() }).optional(),
  message_snapshots: z.array(z.object({ message: messageBody })).optional(),
})

type MessageBody = z.infer<typeof messageBody>

function summarizeBody(body: MessageBody, companion?: MessageBody) {
  // A forward shares one notification's excerpt budget with the forwarding message.
  const chars = Math.max(1000, 2000 - (companion?.content.length ?? 0))
  const attachments = Math.max(5, 10 - (companion?.attachments.length ?? 0))
  return {
    content: Array.from(body.content).slice(0, chars).join(''),
    attachments: body.attachments.slice(0, attachments).map((attachment) => ({
      filename: Array.from(attachment.filename).slice(0, 150).join(''),
      size: attachment.size,
      content_type: attachment.content_type?.slice(0, 128),
    })),
  }
}

const channel = z.object({ id: snowflake, type: z.literal(0) })
class DiscordBackoff extends Error {
  constructor(readonly seconds: number) {
    super('Discord rate limited')
  }
}

export async function pollDiscord(
  channelId: string,
  botToken: string,
  saved: DiscordCheckpoint | undefined,
  enqueue: Enqueue,
  fetchPage: Transport = fetch,
): Promise<DiscordCheckpoint> {
  if (!snowflake.safeParse(channelId).success || !botToken || /\s/.test(botToken)) {
    throw new Error('Invalid Discord channel or bot token')
  }
  const state = saved?.channelId === channelId ? saved : { channelId }
  if (state.retryAt && Date.now() < state.retryAt) return state
  const path = 'https://discord.com/api/v10/channels/' + channelId
  async function read(url: URL): Promise<unknown> {
    const response = await fetchPage(url, {
      headers: { Authorization: 'Bot ' + botToken },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 429) {
      const body = z
        .object({ retry_after: z.number().nonnegative() })
        .safeParse(await response.json().catch(() => null))
      const header = Number(response.headers.get('Retry-After'))
      const seconds = body.success
        ? body.data.retry_after
        : Number.isFinite(header) && header > 0
          ? header
          : 60
      throw new DiscordBackoff(seconds)
    }
    if (!response.ok) throw new Error('Discord API returned HTTP ' + response.status)
    return response.json()
  }
  try {
    const url = new URL(path + '/messages')
    if (!state.lastId) {
      const current = channel.safeParse(await read(new URL(path)))
      if (!current.success || current.data.id !== channelId)
        throw new Error('Expected a Discord guild text channel')
      url.searchParams.set('limit', '1')
      const started = Date.now()
      const [latest] = z
        .array(z.object({ id: snowflake, channel_id: z.literal(channelId) }))
        .max(1)
        .parse(await read(url))
      // An empty history also occurs when the bot lacks Read Message History.
      const startSnowflake = (BigInt(started - 1420070400000) << 22n).toString()
      return { channelId, lastId: latest?.id ?? startSnowflake }
    }
    url.search = new URLSearchParams({ after: state.lastId, limit: '10' }).toString()
    const history = z
      .array(message)
      .max(10)
      .parse(await read(url))
    if (history.some((m) => m.channel_id !== channelId))
      throw new Error('Unexpected Discord channel')
    const boundary = BigInt(state.lastId)
    // Discord returns each page newest first; advance only after enqueueing it in order.
    const fresh = history.reverse().filter((m) => BigInt(m.id) > boundary)
    const events = fresh
      .filter((m) => m.type === 0 || m.type === 19)
      .map((m) => {
        const forward = m.message_reference?.type === 1 ? m.message_snapshots?.[0]?.message : undefined
        return {
          key: m.id,
          type: 'message',
          text: JSON.stringify({
            channel_id: channelId,
            id: m.id,
            author: m.author,
            ...summarizeBody(m, forward),
            forwarded: forward && summarizeBody(forward, m),
          }),
        }
      })
    if (events.length && (await enqueue(events)) !== 'accepted') return state
    return { channelId, lastId: fresh.at(-1)?.id ?? state.lastId }
  } catch (error) {
    if (error instanceof DiscordBackoff)
      return { ...state, retryAt: Date.now() + error.seconds * 1000 }
    throw error
  }
}
