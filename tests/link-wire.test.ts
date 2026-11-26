import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ControlMessages, requestEnvelope, ResponseFrames } from '../src/link/wire.ts'

// Encoded independently with the Muse Gadget SDK's envelope.py and framing.py.
const responseParts = [
  '08b6e9c4efbbd1d9c1da01180222090a1c08021a1808ca01',
  '08b6e9c4efbbd1d9c1da011001180222151a117b226163636570746564223a747275657d2001',
].map((hex) => Uint8Array.from(Buffer.from(hex, 'hex')))

test('opens the SDK control stream with the published request envelope', () => {
  assert.equal(
    Buffer.from(requestEnvelope(1, '/link-control', [])).toString('hex'),
    '1219080112150a04504f5354120d2f6c696e6b2d636f6e74726f6c',
  )
})

test('reassembles a Python SDK response with a signed 64-bit fragment ID', () => {
  const frames = new ResponseFrames()
  assert.equal(frames.push(responseParts[1]), undefined)
  assert.deepEqual(frames.push(responseParts[0]), {
    stream: 2,
    status: 202,
    body: new TextEncoder().encode('{"accepted":true}'),
    ended: true,
  })
})

test('rejects a duplicate fragment', () => {
  const frames = new ResponseFrames()
  frames.push(responseParts[0])
  assert.throws(() => frames.push(responseParts[0]))
})

test('accepts control messages split across length prefixes and bodies', () => {
  const decoder = new ControlMessages()
  const data = Uint8Array.of(
    7,
    0,
    0,
    0,
    123,
    34,
    97,
    34,
    58,
    49,
    125,
    7,
    0,
    0,
    0,
    123,
    34,
    98,
    34,
    58,
    50,
    125,
  )
  assert.deepEqual(decoder.push(data.subarray(0, 2)), [])
  assert.deepEqual(decoder.push(data.subarray(2, 12)), [{ a: 1 }])
  assert.deepEqual(decoder.push(data.subarray(12)), [{ b: 2 }])
})

test('ignores a fragmented zero-length control keepalive', () => {
  const decoder = new ControlMessages()
  assert.deepEqual(decoder.push(Uint8Array.of(0, 0)), [])
  assert.deepEqual(decoder.push(Uint8Array.of(0, 0, 2, 0, 0, 0, 123, 125)), [{}])
})
