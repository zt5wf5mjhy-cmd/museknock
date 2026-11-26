import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { identifier } from '../identifiers.ts'
import { maxEventBytes, parseJson, verifyHmac, type ProviderDelivery } from '../provider.ts'
import type { WorkerEnv } from '../webhook.ts'

const envelope = z.object({ type: z.string().min(1) })
const creationSubtypes = new Set([undefined, 'file_share', 'me_message', 'thread_broadcast', 'bot_message'])
const verification = z.object({ challenge: z.string().min(1) })
const entity = z.union([z.string(), z.object({ id: z.string(), name: z.string().optional() })])
const eventCallback = z.object({
  event_id: z.string().regex(/^[!-~]{1,128}$/),
  team_id: z.string().optional(),
  event: z.object({
    type: z.string().regex(identifier),
    subtype: z.string().optional(),
    channel: entity.optional().catch(undefined),
    user: entity.optional().catch(undefined),
    text: z.string().optional(),
    ts: z.string().optional(),
    deleted_ts: z.string().optional(),
    reaction: z.string().optional(),
    item: z.object({ type: z.literal('message'), channel: z.string(), ts: z.string() }).optional().catch(undefined),
    message: z
      .object({ text: z.string().optional(), ts: z.string().optional() })
      .optional()
      .catch(undefined),
  }),
})

function summarize({ team_id, event }: z.infer<typeof eventCallback>): string {
  const fields = { team_id, ...event }
  const encoder = new TextEncoder()
  let json = JSON.stringify(fields)
  for (
    let limit = 4_000;
    encoder.encode(json).byteLength > maxEventBytes;
    limit = Math.floor(limit / 2)
  ) {
    json = JSON.stringify({ ...fields, truncated: true }, (_key, value: unknown) =>
      typeof value === 'string' && value.length > limit
        ? Array.from(value).slice(0, limit).join('')
        : value,
    )
  }
  return json
}

export async function slack(
  request: Request,
  env: WorkerEnv['Bindings'],
): Promise<ProviderDelivery> {
  const secret = env.SLACK_SIGNING_SECRET
  if (!secret) throw new HTTPException(503, { message: 'Configure SLACK_SIGNING_SECRET first' })
  const timestamp = request.headers.get('X-Slack-Request-Timestamp') ?? ''
  const signature = /^v0=([0-9a-f]{64})$/.exec(request.headers.get('X-Slack-Signature') ?? '')
  if (
    !signature ||
    !/^\d{1,12}$/.test(timestamp) ||
    Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300
  ) {
    throw new HTTPException(401, { message: 'Invalid Slack signature or timestamp' })
  }

  const body = await request.arrayBuffer()
  const prefix = new TextEncoder().encode('v0:' + timestamp + ':')
  const signed = new Uint8Array(prefix.length + body.byteLength)
  signed.set(prefix)
  signed.set(new Uint8Array(body), prefix.length)
  const digest = Uint8Array.from({ length: 32 }, (_, i) =>
    Number.parseInt(signature[1].slice(2 * i, 2 * i + 2), 16),
  )
  if (!(await verifyHmac('SHA-256', secret, signed, digest))) {
    throw new HTTPException(401, { message: 'Invalid Slack signature' })
  }

  const json = parseJson(body)
  const outer = envelope.safeParse(json)
  if (!outer.success) throw new HTTPException(400, { message: 'Invalid Slack envelope' })
  if (outer.data.type === 'url_verification') {
    const check = verification.safeParse(json)
    if (!check.success) throw new HTTPException(400, { message: 'Missing Slack challenge' })
    return { response: new Response(check.data.challenge) }
  }
  const response = new Response(null)
  if (outer.data.type !== 'event_callback') return { response }
  const parsed = eventCallback.safeParse(json)
  if (!parsed.success) throw new HTTPException(400, { message: 'Invalid Slack event callback' })
  const { event_id, team_id, event } = parsed.data
  const channel = typeof event.channel === 'string' ? event.channel : event.channel?.id
  const deleted = event.type === 'message' && event.subtype === 'message_deleted'
  const ts = deleted ? event.deleted_ts : event.message?.ts ?? event.ts
  const messageKey = channel && ts && (event.type === 'message' || event.type === 'app_mention')
    ? JSON.stringify([team_id, channel, ts])
    : undefined
  const creation = event.type === 'app_mention' || (event.type === 'message' && creationSubtypes.has(event.subtype))
  return {
    retractedMessageIds: deleted && messageKey ? [messageKey] : undefined,
    events: [{
      key: event_id,
      coalesceKey: creation && team_id ? messageKey : undefined,
      messageId: deleted ? undefined : messageKey,
      type: event.type,
      text: summarize(parsed.data),
    }],
    response,
  }
}
