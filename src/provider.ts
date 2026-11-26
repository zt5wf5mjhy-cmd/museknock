import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { identifier } from './identifiers.ts'
import type { HookEvent } from './store.ts'
import { inbox, type WorkerEnv } from './webhook.ts'

export const maxEventBytes = 32 * 1024

export type ProviderDelivery = {
  events?: Omit<HookEvent, 'source'>[]
  retractedMessageIds?: string[]
  response: Response
}

export function parseJson(bytes: ArrayBuffer): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new HTTPException(400, { message: 'Invalid JSON' })
  }
}

export async function verifyHmac(
  hash: 'SHA-1' | 'SHA-256',
  secret: string,
  message: BufferSource,
  signature: Uint8Array<ArrayBuffer>,
) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash },
    false,
    ['verify'],
  )
  return crypto.subtle.verify('HMAC', key, signature, message)
}

export function registerProvider(
  app: Hono<WorkerEnv>,
  source: string,
  receive: (request: Request, env: WorkerEnv['Bindings']) => Promise<ProviderDelivery>,
  methods = ['POST'],
) {
  app.on(methods, '/v1/hooks/' + source, bodyLimit({ maxSize: 512 * 1024 }), async (c) => {
    const { events, retractedMessageIds, response } = await receive(c.req.raw, c.env)
    if (retractedMessageIds?.length) await inbox(c.env).retractMessages(source, retractedMessageIds)
    if (!events?.length) return response
    for (const { key, type, text } of events) {
      if (!identifier.test(type) || !/^[!-~]{1,128}$/.test(key) || !text.trim()) {
        return c.text('Invalid notification', 400)
      }
      if (new TextEncoder().encode(text).length > maxEventBytes) return c.text('Event too large', 413)
    }
    const result = await inbox(c.env).enqueueBatch(source, events)
    if (result === 'invalidBreaker') return c.text('Correct CIRCUIT_BREAKER and retry', 503)
    if (result === 'credentialStorageUnavailable')
      return c.text('Credential storage is unavailable', 503)
    if (result === 'missingDevice') return c.text('Configure the Muse device first', 503)
    if (result === 'noDestination') return c.text('Register a destination side chat first', 503)
    if (result === 'limited')
      return c.text('Source rate limit reached', 429, { 'Retry-After': '60' })
    return response
  })
}
