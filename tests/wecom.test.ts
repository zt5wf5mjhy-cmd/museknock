import assert from 'node:assert/strict'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { connect } from './mcp-client.ts'
import { startConfiguredWorker, startWorker } from './worker.ts'

const aesKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index))
const settings = {
  WECOM_TOKEN: 'test-callback-token',
  WECOM_ENCODING_AES_KEY: aesKey.toString('base64').slice(0, -1),
  WECOM_CORP_ID: 'ww-test-corp',
}

function encrypted(message: string, recipient = settings.WECOM_CORP_ID, damagePadding = false) {
  const size = Buffer.alloc(4)
  size.writeUInt32BE(Buffer.byteLength(message))
  const frame = Buffer.concat([randomBytes(16), size, Buffer.from(message), Buffer.from(recipient)])
  const count = 32 - (frame.length % 32)
  const padding = Buffer.alloc(count, count)
  if (damagePadding) padding[0] = 0
  const cipher = createCipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16))
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(Buffer.concat([frame, padding])), cipher.final()]).toString(
    'base64',
  )
}

function signed(url: URL, ciphertext: string, ageSeconds = 0) {
  const result = new URL('/v1/hooks/wecom', url)
  const timestamp = String(Math.floor(Date.now() / 1000) - ageSeconds)
  const nonce = '185606411'
  const signature = createHash('sha1')
    .update([settings.WECOM_TOKEN, timestamp, nonce, ciphertext].sort().join(''))
    .digest('hex')
  result.search = new URLSearchParams({ timestamp, nonce, msg_signature: signature }).toString()
  return result
}

const msg =
  '<xml><ToUserName>ww-test-corp</ToUserName><FromUserName>User-T</FromUserName>' +
  '<CreateTime>1700000000</CreateTime><MsgType>text</MsgType><Content><![CDATA[会議 & <notes>]]></Content>' +
  '<MsgId>9223372036854775807</MsgId><AgentID>1000002</AgentID></xml>'
const envelope = (ciphertext: string) =>
  '<xml><Encrypt><![CDATA[' + ciphertext + ']]></Encrypt></xml>'

test('WeCom checks signatures, decrypts both padding ranges and verifies challenge recipients before setup', async (t) => {
  const worker = await startWorker(undefined, { ...settings, MUSE_REFRESH_TOKEN: '' })
  t.after(() => worker.close())
  function challenge(ciphertext: string, age = 0) {
    const url = signed(worker.url, ciphertext, age)
    url.searchParams.set('echostr', ciphertext)
    return url
  }
  for (const value of ['123', '0123456789abcdef', '0123456789abcdef0123456789abcdef']) {
    const response = await fetch(challenge(encrypted(value)))
    assert.equal(response.status, 200)
    assert.equal(await response.text(), value)
  }
  const forged = challenge(encrypted('123'))
  forged.searchParams.set('msg_signature', '0'.repeat(40))
  for (const url of [
    forged,
    challenge(encrypted('123', 'wrong')),
    challenge(encrypted('123'), 3600),
  ]) {
    assert.equal((await fetch(url)).status, 401)
  }
  for (const url of [
    challenge(encrypted('123', settings.WECOM_CORP_ID, true)),
    challenge(encrypted(msg)),
  ]) {
    assert.equal((await fetch(url)).status, 400)
  }
})

test('WeCom acknowledges authenticated XML callbacks, rejects invalid XML and keeps verification out of the inbox', async (t) => {
  const worker = await startConfiguredWorker(undefined, settings)
  t.after(() => worker.close())
  const reader = await connect(new URL('/mcp', worker.url), 'MCP_TOKEN-test')
  t.after(() => reader.close())
  const sources = async () => (await reader.callTool({ name: 'list_sources' })).structuredContent
  const post = (url: URL, body: string) => fetch(url, { method: 'POST', body })
  const ciphertext = encrypted(msg)
  const url = signed(worker.url, ciphertext)
  const forged = new URL(url)
  forged.searchParams.set('nonce', 'different')
  assert.equal((await post(forged, envelope(ciphertext))).status, 401)
  assert.equal((await post(url, '<xml><Encrypt>' + ciphertext + '</Encrypt>')).status, 400)
  assert.equal(
    (await post(url, '<!DOCTYPE xml [<!ENTITY x "bad">]>' + envelope(ciphertext))).status,
    400,
  )
  assert.equal(
    (await post(url, '<xml><Encrypt>' + ciphertext + '</Encrypt><Encrypt>x</Encrypt></xml>'))
      .status,
    400,
  )
  assert.deepEqual(await sources(), { sources: [] })
  const click = '<xml><MsgType>event</MsgType><Event>CLICK</Event><EventKey>button</EventKey></xml>'
  // Fill the ten distinct arrivals allowed per minute. Both retries use fresh encrypted frames.
  const more = Array.from({ length: 8 }, (_, n) =>
    msg.replace('9223372036854775807', String(n + 1)),
  )
  for (const body of [msg, msg, click, click, ...more]) {
    const cipher = encrypted(body)
    const received = await post(signed(worker.url, cipher), envelope(cipher))
    assert.equal(received.status, 200)
    assert.equal(await received.text(), '')
  }
  const next = encrypted(msg.replace('9223372036854775807', '9'))
  assert.equal((await post(signed(worker.url, next), envelope(next))).status, 429)
  assert.deepEqual(await sources(), { sources: [{ source: 'wecom', paused: false, types: [] }] })
})
