import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { startConfiguredWorker } from './worker.ts'

const authToken = 'test-twilio-auth-token'
const messageSid = 'SM' + 'a'.repeat(32)

function sign(url: URL, sortedFields: string) {
  return createHmac('sha1', authToken)
    .update(url.href + sortedFields)
    .digest('base64')
}

test('Twilio authenticates the public URL, query and all form parameters before acknowledging an incoming message', async (t) => {
  const worker = await startConfiguredWorker(undefined, { TWILIO_AUTH_TOKEN: authToken })
  t.after(() => worker.close())
  const url = new URL('/v1/hooks/twilio?route=%2Fpersonal&v=2', worker.url)
  const form = new URLSearchParams([
    ['MessageSid', messageSid],
    ['FutureField', 'z'],
    ['To', '+15550000002'],
    ['Body', '  通知 + test  '],
    ['From', '+15550000001'],
    ['NumMedia', '0'],
    ['FutureField', 'a'],
    ['FutureField', 'z'],
  ])
  const signedFields =
    'Body  通知 + test  From+15550000001FutureFieldaFutureFieldzMessageSid' +
    messageSid +
    'NumMedia0To+15550000002'
  const signature = sign(url, signedFields)
  const post = (target: URL, body: URLSearchParams, headers: Record<string, string>) =>
    fetch(target, { method: 'POST', body, headers })

  const accepted = await post(url, form, { 'X-Twilio-Signature': signature })
  assert.equal(accepted.status, 200)
  assert.match(accepted.headers.get('content-type') ?? '', /xml/)
  assert.equal(await accepted.text(), '<Response/>')
  assert.equal((await post(url, form, { Authorization: 'Bearer HOOK_TOKEN-test' })).status, 401)
  assert.equal((await post(url, form, { 'X-Twilio-Signature': '***' })).status, 401)
  assert.equal(
    (await post(new URL('/v1/hooks/twilio', worker.url), form, { 'X-Twilio-Signature': signature }))
      .status,
    401,
  )
  const proxy = new URL(url)
  proxy.host = 'another.example'
  const forged = sign(proxy, signedFields)
  assert.equal(
    (await post(url, form, { 'X-Twilio-Signature': forged, 'X-Forwarded-Host': proxy.host }))
      .status,
    401,
  )
  form.append('Body', '  通知 + test  ')
  assert.equal((await post(url, form, { 'X-Twilio-Signature': signature })).status, 400)
  form.set('Body', '  通知 + test  ')
  form.append('Unrecognized', 'must also be signed')
  assert.equal((await post(url, form, { 'X-Twilio-Signature': signature })).status, 401)
})

test('Twilio accepts a media-only MMS and rejects signed status callbacks, voice calls and malformed forms', async (t) => {
  const worker = await startConfiguredWorker(undefined, { TWILIO_AUTH_TOKEN: authToken })
  t.after(() => worker.close())
  const url = new URL('/v1/hooks/twilio', worker.url)
  const post = (fields: Record<string, string>) => {
    const sortedFields = Object.keys(fields)
      .sort()
      .map((key) => key + fields[key])
      .join('')
    return fetch(url, {
      method: 'POST',
      body: new URLSearchParams(fields),
      headers: { 'X-Twilio-Signature': sign(url, sortedFields) },
    })
  }
  const fields = {
    MessageSid: 'MM' + 'b'.repeat(32),
    From: '+15550000001',
    To: '+15550000002',
    Body: '',
    NumMedia: '1',
    MediaContentType0: 'image/jpeg',
    MediaUrl0: 'https://api.twilio.com/media',
  }
  assert.equal((await post(fields)).status, 200)
  assert.equal((await post({ ...fields, NumMedia: '0' })).status, 400)
  assert.equal((await post({ ...fields, NumMedia: '-1' })).status, 400)
  assert.equal((await post({ ...fields, MessageSid: '' })).status, 400)
  assert.equal((await post({ MessageSid: messageSid, MessageStatus: 'delivered' })).status, 400)
  assert.equal((await post({ CallSid: 'CA' + 'c'.repeat(32), From: fields.From })).status, 400)
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json', 'X-Twilio-Signature': sign(url, '') },
      })
    ).status,
    400,
  )
})

test('Twilio stays disabled until its own auth token is configured', async (t) => {
  const worker = await startConfiguredWorker()
  t.after(() => worker.close())
  const response = await fetch(new URL('/v1/hooks/twilio', worker.url), {
    method: 'POST',
    body: new URLSearchParams({ Body: 'hello' }),
  })
  assert.equal(response.status, 503)
})
