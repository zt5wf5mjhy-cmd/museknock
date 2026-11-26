import assert from 'node:assert/strict'
import test from 'node:test'
import { startNoise } from '../src/link/noise.ts'

// Generated with the Muse Python SDK's NoiseXXResponder, responder payload "server",
// and X25519 private keys filled with bytes 1 (local e), 2 (remote e), 3 (remote s), 4 (local s).
const transcript = {
  ephemeral: 'a4e09292b651c278b9772c569f5fa9bb13d906b46ab68c9df9dc2b4409f8a209',
  static: 'ac01b2209e86354fb853237b5de0f4fab13c7fcbf433a61c019369617fecf10b',
  message2:
    'ce8d3ad1ccb633ec7b70c17814a5c76ecd029685050d344745ba05870e587d59fd776e5ac83278eaa8282906d9c8c8f268eac01a9ef277646e51a8e2afdb1370944d8d377df19dff797000440cafed45703982b3a3563e445bf1359058ffd51169ab936a71ff',
  message3:
    '98b08948a4c0638806d85dee2d9aff0ccdee594e210d474dae3dfda2ae4a71f8f0fc0c76e09e920884828be1d72e9cf0b2bd36f6a6fa136956073cde8e6be77b',
}

function initiate() {
  const keys = [
    { privateByte: 1, publicHex: transcript.ephemeral },
    { privateByte: 4, publicHex: transcript.static },
  ]
  return startNoise(async () => {
    const { privateByte, publicHex } = keys.shift()!
    const raw = Buffer.from(publicHex, 'hex')
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      {
        kty: 'OKP',
        crv: 'X25519',
        x: raw.toString('base64url'),
        d: Buffer.alloc(32, privateByte).toString('base64url'),
      },
      'X25519',
      false,
      ['deriveBits'],
    )
    const publicKey = await crypto.subtle.importKey('raw', raw, 'X25519', true, [])
    return { publicKey, privateKey }
  })
}

test('Noise initiator matches the SDK handshake and both transport streams', async () => {
  const initiator = await initiate()
  assert.equal(Buffer.from(initiator.message1).toString('hex'), transcript.ephemeral)
  const channel = await initiator.finish(Buffer.from(transcript.message2, 'hex'))
  assert.equal(Buffer.from(channel.message3).toString('hex'), transcript.message3)
  for (const expected of [
    '99d19c16d10b8a96f99d084083f82b8c7e7d887f',
    'eeab102aaf8981e2f3db47930b7bcfa75128526c',
  ]) {
    assert.equal(Buffer.from(await channel.encrypt(Buffer.from('test'))).toString('hex'), expected)
  }
  for (const encrypted of [
    'a7b06f6cbb82fa78cf6aa8e7095c9138ee698e8a1c40180e',
    'b7962460396d9e553f2b7dd28f1ea5ead787cc74d925828e',
  ]) {
    assert.equal(
      Buffer.from(await channel.decrypt(Buffer.from(encrypted, 'hex'))).toString(),
      'incoming',
    )
  }
  await assert.rejects(initiator.finish(Buffer.from(transcript.message2, 'hex')))
})

test('Noise rejects tampered handshake and transport ciphertext', async () => {
  const init = await initiate()
  const corrupted = Buffer.from(transcript.message2, 'hex')
  corrupted[corrupted.length - 1] ^= 1
  await assert.rejects(init.finish(corrupted))
  await assert.rejects(init.finish(Buffer.from(transcript.message2, 'hex')))
  const channel = await (await initiate()).finish(Buffer.from(transcript.message2, 'hex'))
  await assert.rejects(channel.decrypt(new Uint8Array(16)))
  await assert.rejects(
    channel.decrypt(Buffer.from('b7962460396d9e553f2b7dd28f1ea5ead787cc74d925828e', 'hex')),
  )
})
