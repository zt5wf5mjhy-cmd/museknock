/// <reference types="node" />
import { Buffer } from 'node:buffer'
import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import { SaxesParser } from 'saxes'
import { identifier } from '../identifiers.ts'
import type { ProviderDelivery } from '../provider.ts'
import type { WorkerEnv } from '../webhook.ts'

const badCallback = () => new HTTPException(400, { message: 'Invalid WeCom callback' })
const unauthorized = () => new HTTPException(401, { message: 'Invalid WeCom authentication' })
const messageFields = [
  'MsgType',
  'Event',
  'EventKey',
  'MsgId',
  'FromUserName',
  'CreateTime',
  'AgentID',
  'Content',
  'Title',
  'Description',
  'Recognition',
  'Label',
]

function fields(xml: string, names: string[]): Map<string, string> {
  const result = new Map<string, string>()
  const parser = new SaxesParser()
  let depth = 0
  let field: string | undefined
  parser.on('error', () => {
    throw badCallback()
  })
  parser.on('doctype', () => {
    throw badCallback()
  })
  parser.on('opentag', ({ name }) => {
    depth++
    if (depth > 32 || (depth === 1 && name !== 'xml') || field) throw badCallback()
    if (depth === 2 && names.includes(name)) {
      if (result.has(name)) throw badCallback()
      field = name
      result.set(name, '')
    }
  })
  function append(text: string) {
    if (field) result.set(field, (result.get(field) ?? '') + text)
  }
  parser.on('text', append)
  parser.on('cdata', append)
  parser.on('closetag', () => {
    if (depth === 2) field = undefined
    depth--
  })
  parser.write(xml).close()
  return result
}

function decrypt(ciphertext: string, key: Buffer, recipient: string): string {
  const bytes = Buffer.from(ciphertext, 'base64')
  if (!bytes.length || bytes.length % 32 !== 0 || bytes.toString('base64') !== ciphertext)
    throw badCallback()
  const cipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  // WeCom pads the frame to 32 bytes, twice AES's native block size.
  cipher.setAutoPadding(false)
  const padded = Buffer.concat([cipher.update(bytes), cipher.final()])
  const padding = padded[padded.length - 1]
  if (
    padding < 1 ||
    padding > 32 ||
    !padded.subarray(-padding).every((byte: number) => byte === padding)
  ) {
    throw badCallback()
  }
  const frame = padded.subarray(0, padded.length - padding)
  if (frame.length < 20) throw badCallback()
  const end = 20 + frame.readUInt32BE(16)
  if (end > frame.length) throw badCallback()
  if (!frame.subarray(end).equals(Buffer.from(recipient))) throw unauthorized()
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(20, end))
  } catch {
    throw badCallback()
  }
}

export async function wecom(
  request: Request,
  env: WorkerEnv['Bindings'],
): Promise<ProviderDelivery> {
  const { WECOM_TOKEN: token, WECOM_ENCODING_AES_KEY: aesKey, WECOM_CORP_ID: corpId } = env
  if (!token || !aesKey || !/^[A-Za-z0-9+/]{43}$/.test(aesKey) || !corpId) {
    throw new HTTPException(503, { message: 'Configure WeCom callback credentials' })
  }
  const query = new URL(request.url).searchParams
  const timestamp = query.get('timestamp')
  const nonce = query.get('nonce')
  const signature = query.get('msg_signature')
  if (
    !timestamp ||
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
    !nonce ||
    !signature ||
    !/^[a-f0-9]{40}$/.test(signature)
  )
    throw unauthorized()

  const verifying = request.method === 'GET'
  const ciphertext = verifying
    ? query.get('echostr')
    : fields(await request.text(), ['Encrypt']).get('Encrypt')
  if (!ciphertext) throw badCallback()
  const expected = createHash('sha1')
    .update([token, timestamp, nonce, ciphertext].sort().join(''))
    .digest()
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw unauthorized()
  const message = decrypt(ciphertext, Buffer.from(aesKey, 'base64'), corpId)
  if (verifying) {
    if (!message || message.trimStart().startsWith('<')) throw badCallback()
    return { response: new Response(message, { headers: { 'Cache-Control': 'no-store' } }) }
  }

  const data = fields(message, messageFields)
  const msgType = data.get('MsgType')?.trim().toLowerCase()
  const type = msgType === 'event' ? data.get('Event')?.trim().toLowerCase() : msgType
  if (!type || !identifier.test(type)) throw badCallback()
  const msgId = data.get('MsgId')
  if (msgId && !/^\d{1,20}$/.test(msgId)) throw badCallback()
  const key = msgId || createHash('sha256').update(message).digest('hex')
  const text = JSON.stringify(Object.fromEntries(data))
  return { events: [{ key, type, text }], response: new Response(null) }
}
