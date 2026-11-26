import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { parseJson, verifyHmac, type ProviderDelivery } from '../provider.ts'
import type { WorkerEnv } from '../webhook.ts'

const webhook = z.object({
  events: z.array(
    z.object({
      webhookEventId: z.string().regex(/^[!-~]{1,128}$/),
      type: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
      timestamp: z.number().optional(),
      source: z
        .object({
          type: z.string(),
          userId: z.string().optional(),
          groupId: z.string().optional(),
          roomId: z.string().optional(),
        })
        .optional(),
      message: z
        .object({ id: z.string(), type: z.string(), text: z.string().optional() })
        .optional(),
      postback: z.object({ data: z.string() }).optional(),
      unsend: z.object({ messageId: z.string().min(1).max(128) }).optional(),
    }),
  ),
})

export async function line(
  request: Request,
  env: WorkerEnv['Bindings'],
): Promise<ProviderDelivery> {
  const secret = env.LINE_CHANNEL_SECRET
  if (!secret) throw new HTTPException(503, { message: 'Configure LINE_CHANNEL_SECRET first' })
  const signature = request.headers.get('X-Line-Signature') ?? ''
  if (!/^[A-Za-z0-9+/]{43}=$/.test(signature)) {
    throw new HTTPException(401, { message: 'Invalid LINE signature' })
  }
  const body = await request.arrayBuffer()
  const digest = Uint8Array.from(atob(signature), (char) => char.charCodeAt(0))
  if (!(await verifyHmac('SHA-256', secret, body, digest))) {
    throw new HTTPException(401, { message: 'Invalid LINE signature' })
  }

  const parsed = webhook.safeParse(parseJson(body))
  if (!parsed.success) throw new HTTPException(400, { message: 'Invalid LINE event batch' })
  return {
    retractedMessageIds: parsed.data.events.flatMap((event) =>
      event.type === 'unsend' && event.unsend ? [event.unsend.messageId] : [],
    ),
    events: parsed.data.events.map(({ webhookEventId, ...event }) => ({
      key: webhookEventId,
      messageId: event.type === 'message' ? event.message?.id : undefined,
      type: event.type.toLowerCase(),
      text: JSON.stringify(event),
    })),
    response: new Response(null),
  }
}
