import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { parseJson, verifyHmac, type ProviderDelivery } from '../provider.ts'
import type { WorkerEnv } from '../webhook.ts'

const envelope = z.object({ data: z.object({ event_type: z.string().min(1) }).passthrough() })
const post = z.object({
  event_uuid: z.string().regex(/^[!-~]{1,128}$/),
  payload: z.object({
    id: z.string().regex(/^\d{1,20}$/),
    author_id: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional(),
    text: z.string().optional(),
    note_tweet: z.object({ text: z.string() }).optional(),
  }),
})

async function challenge(request: Request, secret: string) {
  const tokens = new URL(request.url).searchParams.getAll('crc_token')
  // X uses the same key for CRC and delivery. Only sign opaque challenge tokens.
  if (tokens.length !== 1 || !/^[A-Za-z0-9_+/=-]{1,512}$/.test(tokens[0])) {
    throw new HTTPException(400, { message: 'Invalid X challenge' })
  }
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(tokens[0]))
  return Response.json(
    { response_token: 'sha256=' + btoa(String.fromCharCode(...new Uint8Array(digest))) },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function x(request: Request, env: WorkerEnv['Bindings']): Promise<ProviderDelivery> {
  const secret = env.X_OAUTH2_CLIENT_SECRET
  if (!secret) throw new HTTPException(503, { message: 'Configure X_OAUTH2_CLIENT_SECRET' })
  if (request.method === 'GET') return { response: await challenge(request, secret) }

  const signature = /^sha256=([A-Za-z0-9+/]{43}=)$/.exec(
    request.headers.get('X-Twitter-Webhooks-Signature-OAuth2') ?? '',
  )
  if (!signature) throw new HTTPException(401)
  const body = await request.arrayBuffer()
  const digest = Uint8Array.from(atob(signature[1]), (char) => char.charCodeAt(0))
  if (!(await verifyHmac('SHA-256', secret, body, digest))) throw new HTTPException(401)

  const parsed = envelope.safeParse(parseJson(body))
  if (!parsed.success) throw new HTTPException(400, { message: 'Invalid X Activity envelope' })
  const { data } = parsed.data
  const response = new Response(null)
  if (data.event_type !== 'post.create' && data.event_type !== 'post.delete') return { response }
  const event = post.safeParse(data)
  if (!event.success) throw new HTTPException(400, { message: 'Invalid X Post activity' })
  const { event_uuid, payload } = event.data
  const deleted = data.event_type === 'post.delete'
  const text = deleted ? undefined : (payload.note_tweet?.text ?? payload.text)
  return {
    retractedMessageIds: deleted ? [payload.id] : undefined,
    events: [
      {
        key: event_uuid,
        messageId: deleted ? undefined : payload.id,
        type: deleted ? 'post_delete' : 'post_create',
        text: JSON.stringify({
          id: payload.id,
          author_id: payload.author_id,
          url: 'https://x.com/i/web/status/' + payload.id,
          text: text === undefined ? undefined : Array.from(text).slice(0, 4_000).join(''),
        }),
      },
    ],
    response,
  }
}
