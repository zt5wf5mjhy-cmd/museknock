import { HTTPException } from 'hono/http-exception'
import { verifyHmac, type ProviderDelivery } from '../provider.ts'
import type { WorkerEnv } from '../webhook.ts'

function signedForm(url: string, form: URLSearchParams): string {
  // Twilio signs all fields, including new fields, with distinct values sorted for each name.
  form.sort()
  const valuesByName = new Map<string, Set<string>>()
  for (const [name, value] of form) {
    const values = valuesByName.get(name)
    if (values) values.add(value)
    else valuesByName.set(name, new Set([value]))
  }
  let message = url
  for (const [name, values] of valuesByName) {
    for (const value of [...values].sort()) message += name + value
  }
  return message
}

function singleValue(form: URLSearchParams, name: string): string | undefined {
  const values = form.getAll(name)
  return values.length === 1 ? values[0] : undefined
}

export async function twilio(
  request: Request,
  env: WorkerEnv['Bindings'],
): Promise<ProviderDelivery> {
  const secret = env.TWILIO_AUTH_TOKEN
  if (!secret) throw new HTTPException(503, { message: 'Configure TWILIO_AUTH_TOKEN first' })
  const signature = request.headers.get('X-Twilio-Signature') ?? ''
  if (!/^[A-Za-z0-9+/]{27}=$/.test(signature)) {
    throw new HTTPException(401, { message: 'Invalid Twilio signature' })
  }
  const media = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  if (media !== 'application/x-www-form-urlencoded') {
    throw new HTTPException(400, { message: 'Expected a URL-encoded Twilio form' })
  }
  const form = new URLSearchParams(await request.text())
  const message = new TextEncoder().encode(signedForm(request.url, form))
  const digest = Uint8Array.from(atob(signature), (char) => char.charCodeAt(0))
  if (!(await verifyHmac('SHA-1', secret, message, digest))) {
    throw new HTTPException(401, { message: 'Invalid Twilio signature' })
  }

  const key = singleValue(form, 'MessageSid')
  const from = singleValue(form, 'From')
  const to = singleValue(form, 'To')
  const body = singleValue(form, 'Body')
  const count = singleValue(form, 'NumMedia')
  const numMedia = Number(count)
  const statuses = [...form.getAll('SmsStatus'), ...form.getAll('MessageStatus')]
  if (
    !key ||
    !/^(?:SM|MM)[0-9a-f]{32}$/i.test(key) ||
    !from ||
    !to ||
    body === undefined ||
    !count ||
    !/^\d+$/.test(count) ||
    !Number.isSafeInteger(numMedia) ||
    (!body && numMedia === 0) ||
    statuses.some((status) => status !== 'received')
  ) {
    throw new HTTPException(400, { message: 'Expected an incoming Twilio SMS or MMS' })
  }

  return {
    events: [
      { key, type: numMedia ? 'mms' : 'sms', text: JSON.stringify({ from, to, body, numMedia }) },
    ],
    response: new Response('<Response/>', {
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    }),
  }
}
