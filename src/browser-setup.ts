import { blake2b } from 'blakejs'
import nacl from 'tweetnacl-sealed-box'
import { museDeviceSchema, type MuseDevice } from './muse-device.ts'

const webBase = 'https://muse.ai'
const hatchBase = 'https://hatch-api.meta.ai'
const gadgetAppId = 1503079994796347
const timeoutMs = 15_000
const maxResponseBytes = 64 * 1024

type Json = Record<string, unknown>
type Request = (url: string, init: RequestInit) => Promise<Response>

export type BrowserSetupSession = {
  expiresAt: number
  nodeId: string
  sideChatId?: string
  notice?: 'delivery_pending' | 'chat_registration_failed' | 'delivery_failed'
  waterfallId: string
  csrf?: string
  keyId?: number
  publicKey?: string
  cookies?: Record<string, string>
  methods?: { id: string; type: string }[]
  selectedMethod?: string
  passwordAvailable?: boolean
  stage: 'contact' | 'otp' | 'password' | 'two_factor' | 'done' | 'error'
  error?: BrowserSetupIssue
}

export type BrowserSetupIssue =
  | { kind: 'upstream'; status: number; type?: string }
  | { kind: 'manual_check' | 'invalid_step' | 'generic' }

class AuthError extends Error {
  constructor(readonly status: number, readonly problem: Json) {
    super('Muse authentication failed')
  }
}

function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Muse response')
  return value as Json
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

async function jsonResponse(response: Response): Promise<Json> {
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength > maxResponseBytes) throw new Error('Muse response too large')
  if (response.ok && bytes.byteLength === 0) return {}
  let data: Json
  try { data = object(JSON.parse(new TextDecoder().decode(bytes))) }
  catch { throw new Error('Invalid Muse response') }
  if (!response.ok) throw new AuthError(response.status, data)
  return data
}

async function postHatch(path: string, body: Json, bearer: string, request: Request): Promise<Json> {
  return jsonResponse(await request(hatchBase + path, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8',
      'X-API-Version': '1.0.0', Authorization: 'Bearer ' + bearer },
    body: JSON.stringify(body),
  }))
}

async function postWeb(session: BrowserSetupSession, path: string, body: Json, request: Request): Promise<Json> {
  const response = await request(webBase + path, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Accept: 'application/json, text/html;q=0.9, */*;q=0.8',
      'Content-Type': 'application/json',
      Origin: webBase, Referer: webBase + '/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
      'X-Hatch-Waterfall-Id': session.waterfallId,
      ...(session.csrf ? { 'X-Hatch-CSRF-Token': session.csrf } : {}),
      ...(session.cookies && Object.keys(session.cookies).length ? {
        Cookie: Object.entries(session.cookies).map(([name, value]) => name + '=' + value).join('; '),
      } : {}),
    },
    body: JSON.stringify(body),
  })
  for (const header of response.headers.getSetCookie()) {
    const cookie = /^([^=;]+)=([^;]*)/.exec(header)
    if (cookie) (session.cookies ??= {})[cookie[1]] = cookie[2]
  }
  try {
    const data = await jsonResponse(response)
    const csrf = string(data.csrf_token)
    if (csrf) session.csrf = csrf
    return data
  } catch (error) {
    if (error instanceof AuthError) {
      const csrf = string(error.problem.csrf_token)
      if (csrf) session.csrf = csrf
    }
    throw error
  }
}

function publicKeyBytes(value: string): Uint8Array {
  if (/^[0-9a-f]{64}$/i.test(value))
    return Uint8Array.from(value.match(/../g)!, byte => parseInt(byte, 16))
  const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0))
  if (bytes.length !== 32) throw new Error('Invalid Muse password key')
  return bytes
}

export async function encryptWebPassword(password: string, keyId: number, publicKey: string, now = Date.now()): Promise<string> {
  if (!Number.isInteger(keyId) || keyId < 0 || keyId > 255) throw new Error('Invalid Muse password key')
  const recipient = publicKeyBytes(publicKey)
  const stamp = String(Math.floor(now / 1000))
  const aesKey = crypto.getRandomValues(new Uint8Array(32))
  const plain = new TextEncoder().encode(password)
  try {
    const aes = await crypto.subtle.importKey('raw', aesKey, 'AES-GCM', false, ['encrypt'])
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12),
      additionalData: new TextEncoder().encode(stamp) }, aes, plain))
    const ephemeral = nacl.box.keyPair()
    const nonce = blake2b(new Uint8Array([...ephemeral.publicKey, ...recipient]), undefined, 24)
    const boxed = nacl.box(aesKey, nonce, recipient, ephemeral.secretKey)
    ephemeral.secretKey.fill(0)
    const sealed = new Uint8Array([...ephemeral.publicKey, ...boxed])
    const envelope = new Uint8Array(4 + sealed.length + encrypted.length)
    envelope[0] = 1
    envelope[1] = keyId
    new DataView(envelope.buffer).setUint16(2, sealed.length, true)
    envelope.set(sealed, 4)
    envelope.set(encrypted.subarray(encrypted.length - 16), 4 + sealed.length)
    envelope.set(encrypted.subarray(0, encrypted.length - 16), 4 + sealed.length + 16)
    return '#PWD_BROWSER:5:' + stamp + ':' + btoa(String.fromCharCode(...envelope))
  } finally {
    aesKey.fill(0)
    plain.fill(0)
  }
}

async function acceptCredentials(session: BrowserSetupSession, data: Json, sdkToken: string, request: Request) {
  if (data.checkpoint_required || data.checkpoint_url || data.reactivation_required || data.account_selection_required) {
    session.stage = 'error'
    session.error = { kind: 'manual_check' }
    return { session }
  }
  if (data.two_factor_required) {
    const methods = Array.isArray(data.two_factor_methods) ? data.two_factor_methods.flatMap(entry => {
      if (!entry || typeof entry !== 'object') return []
      const item = entry as Json
      const id = string(item.method_id)
      const type = string(item.method_type)
      return id && type ? [{ id, type }] : []
    }) : []
    if (!methods.length) throw new Error('Unsupported two-factor challenge')
    session.methods = methods
    session.selectedMethod = (methods.find(method => method.type.toUpperCase() === 'SMS') ?? methods[0]).id
    session.stage = 'two_factor'
    if (methods.some(method => method.id === session.selectedMethod && method.type.toUpperCase() === 'SMS'))
      await postWeb(session, '/api/auth/native/two-factor-send-code', { method_id: session.selectedMethod }, request)
    return { session }
  }
  const meta = data.auth_meta_session ? object(data.auth_meta_session) : null
  const frl = meta && string(meta.frl_access_token)
  if (!frl) throw new Error('Muse login did not return a session')
  const exchanged = await postHatch('/hatch/login', { frl_access_token: frl }, frl, request)
  const access = string(exchanged.access_token)
  if (!access || !string(exchanged.abra_user_id)) throw new Error('Muse did not return a Hatch session')
  const minted = await postHatch('/hatch/device_token/mint', {
    device_id: session.nodeId, sdk_token: sdkToken, abra_device_app_fbid: gadgetAppId,
  }, access, request)
  const payload = object(minted.payload ?? minted)
  const device = museDeviceSchema.safeParse({
    nodeId: session.nodeId, sdkToken, refreshToken: payload.refresh_token,
  })
  if (!string(payload.access_token) || !device.success) throw new Error('Muse did not return complete gadget credentials')
  return { session, device: device.data }
}

export async function beginWebLogin(session: BrowserSetupSession, contact: string, region: string,
  request: Request = fetch): Promise<BrowserSetupSession> {
  const restarted = await postWeb(session, '/api/auth/native/restart', {}, request)
  if (!string(restarted.csrf_token)) {
    session.csrf = undefined
    throw new Error('Muse did not provide CSRF token')
  }
  let started = restarted
  if (restarted.flow_state === 'new') started = await postWeb(session, '/api/auth/native/start', {}, request)
  if (started.flow_state !== 'started') throw new Error('Unsupported Muse login flow')
  const encryption = object(started.password_encryption)
  if (typeof encryption.key_id !== 'number' || !string(encryption.public_key)) throw new Error('Muse did not provide password key')
  session.keyId = encryption.key_id
  session.publicKey = string(encryption.public_key)
  const fields: Json = { contact_point: contact }
  if (region) fields.region = region.toUpperCase()
  const sent = await postWeb(session, '/api/auth/native/send-otp', fields, request)
  if (sent.registration_state === 'password_required' ||
      (sent.registration_state === 'otp_sent' && sent.password_login_available !== false)) {
    session.passwordAvailable = true
    session.stage = 'password'
  } else if (sent.registration_state === 'otp_sent') {
    session.stage = 'otp'
  } else {
    throw new Error('Unsupported Muse login state')
  }
  session.error = undefined
  return session
}

export async function advanceWebLogin(session: BrowserSetupSession, action: string, value: string,
  sdkToken: string, request: Request = fetch): Promise<{ session: BrowserSetupSession; device?: MuseDevice }> {
  let response: Json
  if (action === 'password' && session.stage === 'password' && session.passwordAvailable &&
      session.keyId !== undefined && session.publicKey) {
    const password = await encryptWebPassword(value, session.keyId, session.publicKey)
    response = await postWeb(session, '/api/auth/native/confirm-password', {
      password, remember_device: false, supports_muse_link_transparency: true,
      security_key_related_origins: true,
    }, request)
  } else if (action === 'otp' && session.stage === 'otp') {
    response = await postWeb(session, '/api/auth/native/confirm-otp', { otp_code: value, return_to: '/' }, request)
  } else if (action === 'two_factor' && session.stage === 'two_factor' && session.selectedMethod) {
    response = await postWeb(session, '/api/auth/native/two-factor', {
      code: value, method_id: session.selectedMethod, remember_device: false,
      security_key_related_origins: true,
    }, request)
  } else if (action === 'send_code' && session.stage === 'two_factor' && session.selectedMethod &&
      session.methods?.some(method => method.id === session.selectedMethod && method.type.toUpperCase() === 'SMS')) {
    await postWeb(session, '/api/auth/native/two-factor-send-code', { method_id: session.selectedMethod }, request)
    session.error = undefined
    return { session }
  } else {
    throw new Error('Invalid login step')
  }
  session.error = undefined
  return acceptCredentials(session, response, sdkToken, request)
}

export function browserSetupError(error: unknown): BrowserSetupIssue {
  if (error instanceof AuthError) {
    const type = string(error.problem.type)
    return { kind: 'upstream', status: error.status,
      ...(type && /^[A-Za-z0-9_./-]{1,100}$/.test(type) ? { type } : {}) }
  }
  return error instanceof Error && error.message === 'Invalid login step'
    ? { kind: 'invalid_step' }
    : { kind: 'generic' }
}
