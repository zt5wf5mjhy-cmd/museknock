import { HTTPException } from 'hono/http-exception'
import { timingSafeEqual } from 'hono/utils/buffer'
import { z } from 'zod'
import { parseJson, type ProviderDelivery } from '../provider.ts'
import type { WorkerEnv } from '../webhook.ts'

const updateSchema = z.looseObject({ update_id: z.number().int().nonnegative() })
const messageTypes = ['message', 'edited_message', 'channel_post', 'edited_channel_post'] as const
const messageSchema = z.object({
  message_id: z.number().int(),
  chat: z.object({ id: z.number().int() }),
  from: z.object({ id: z.number().int() }).optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
})

export async function telegram(
  request: Request,
  env: WorkerEnv['Bindings'],
): Promise<ProviderDelivery> {
  const secret = env.TELEGRAM_WEBHOOK_SECRET
  if (!secret || !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    throw new HTTPException(503, { message: 'Configure TELEGRAM_WEBHOOK_SECRET' })
  }
  const token = request.headers.get('X-Telegram-Bot-Api-Secret-Token')
  if (!token || !(await timingSafeEqual(token, secret))) throw new HTTPException(401)
  const update = updateSchema.safeParse(parseJson(await request.arrayBuffer()))
  if (!update.success) throw new HTTPException(400, { message: 'Invalid Telegram update' })
  const type = messageTypes.find((name) => name in update.data)
  const response = new Response(null)
  if (!type) return { response }
  const message = messageSchema.safeParse(update.data[type])
  if (!message.success) throw new HTTPException(400, { message: 'Invalid Telegram message' })
  return {
    events: [{ key: String(update.data.update_id), type, text: JSON.stringify(message.data) }],
    response,
  }
}
