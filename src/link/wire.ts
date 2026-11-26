import { BinaryReader, BinaryWriter, WireType } from '@bufbuild/protobuf/wire'

const empty = new Uint8Array()
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const chunkBytes = 65_489
const maxMessage = 1_048_576

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

function fields(bytes: Uint8Array) {
  const values = new Map<number, Uint8Array | bigint>()
  const reader = new BinaryReader(bytes)
  while (reader.pos < reader.len) {
    const [field, type] = reader.tag()
    if (field <= 5 && type === WireType.LengthDelimited) values.set(field, reader.bytes())
    else if (field <= 5 && type === WireType.Varint) values.set(field, BigInt(reader.uint64()))
    else reader.skip(type, field)
  }
  return {
    has: (field: number) => values.has(field),
    data(field: number) {
      const value = values.get(field) ?? empty
      if (!(value instanceof Uint8Array)) throw new Error('Invalid Link byte field')
      return value
    },
    integer(field: number, fallback = 0n) {
      const value = values.get(field) ?? fallback
      if (typeof value !== 'bigint') throw new Error('Invalid Link integer field')
      return value
    },
  }
}

function envelope(stream: number, kind: number, payload: Uint8Array) {
  const frame = new BinaryWriter()
    .tag(1, WireType.Varint)
    .uint64(stream)
    .tag(kind, WireType.LengthDelimited)
    .bytes(payload)
    .finish()
  return new BinaryWriter().tag(2, WireType.LengthDelimited).bytes(frame).finish()
}

export function requestEnvelope(
  stream: number,
  path: string,
  headers: [string, string][],
  body?: Uint8Array,
) {
  const request = new BinaryWriter()
    .tag(1, WireType.LengthDelimited)
    .string('POST')
    .tag(2, WireType.LengthDelimited)
    .string(path)
  for (const [key, value] of headers) {
    request
      .tag(3, WireType.LengthDelimited)
      .fork()
      .tag(1, WireType.LengthDelimited)
      .string(key)
      .tag(2, WireType.LengthDelimited)
      .string(value)
      .join()
  }
  if (body) request.tag(4, WireType.LengthDelimited).bytes(body).tag(5, WireType.Varint).bool(true)
  return envelope(stream, 2, request.finish())
}

export function bodyEnvelope(stream: number, data: Uint8Array, ended = false) {
  const body = new BinaryWriter().tag(1, WireType.LengthDelimited).bytes(data)
  if (ended) body.tag(2, WireType.Varint).bool(true)
  return envelope(stream, 4, body.finish())
}

export function cancelEnvelope(stream: number) {
  const cancelled = 1
  return envelope(stream, 5, new BinaryWriter().tag(1, WireType.Varint).int32(cancelled).finish())
}

export function* fragments(payload: Uint8Array) {
  const id = crypto.getRandomValues(new Uint32Array(1))[0]
  const count = Math.ceil(payload.length / chunkBytes)
  for (let index = 0; index < count; index++) {
    const writer = new BinaryWriter().tag(1, WireType.Varint).uint64(id)
    if (index) writer.tag(2, WireType.Varint).uint32(index)
    yield writer
      .tag(3, WireType.Varint)
      .uint32(count)
      .tag(4, WireType.LengthDelimited)
      .bytes(payload.subarray(index * chunkBytes, (index + 1) * chunkBytes))
      .finish()
  }
}

export class ResponseFrames {
  private readonly pending = new Map<bigint, { parts: Uint8Array[]; received: number }>()
  private buffered = 0

  push(plaintext: Uint8Array) {
    const fragment = fields(plaintext)
    const id = fragment.integer(1)
    const index = Number(fragment.integer(2))
    const count = Number(fragment.integer(3, 1n))
    const part = fragment.data(4)
    if (count < 1 || count > 256 || index >= count || part.length > chunkBytes) {
      throw new Error('Invalid Link fragment')
    }
    let payload = part
    if (count > 1 || this.pending.has(id)) {
      let assembly = this.pending.get(id)
      if (!assembly) {
        if (this.pending.size >= 16) throw new Error('Too many partial Link frames')
        assembly = { parts: new Array(count), received: 0 }
        this.pending.set(id, assembly)
      }
      if (assembly.parts.length !== count || assembly.parts[index])
        throw new Error('Inconsistent Link fragments')
      this.buffered += part.length
      if (this.buffered > maxMessage) throw new Error('Link message too large')
      assembly.parts[index] = part
      if (++assembly.received < count) return
      payload = concat(assembly.parts)
      this.pending.delete(id)
      this.buffered -= payload.length
    }

    const frame = fields(fields(payload).data(1))
    const stream = Number(frame.integer(1))
    if (frame.has(5)) return { stream, reset: true as const }
    if (frame.has(3)) {
      const response = fields(frame.data(3))
      return {
        stream,
        status: Number(response.integer(1)),
        body: response.data(3),
        ended: response.integer(4) !== 0n,
      }
    }
    if (!frame.has(4)) throw new Error('Unexpected Link service frame')
    const chunk = fields(frame.data(4))
    return { stream, status: undefined, body: chunk.data(1), ended: chunk.integer(2) !== 0n }
  }
}

export function controlMessage(obj: object) {
  const json = encoder.encode(JSON.stringify(obj))
  const bytes = new Uint8Array(4 + json.length)
  new DataView(bytes.buffer).setUint32(0, json.length, true)
  bytes.set(json, 4)
  return bytes
}

export class ControlMessages {
  private remainder = empty

  push(data: Uint8Array): Record<string, unknown>[] {
    let input = concat([this.remainder, data])
    const messages: Record<string, unknown>[] = []
    while (input.length >= 4) {
      const length = new DataView(input.buffer, input.byteOffset).getUint32(0, true)
      if (length > maxMessage) throw new Error('Link control message too large')
      if (input.length < length + 4) break
      const data = input.subarray(4, length + 4)
      input = input.subarray(length + 4)
      if (length === 0) continue
      const message: unknown = JSON.parse(decoder.decode(data))
      if (!message || typeof message !== 'object' || Array.isArray(message))
        throw new Error('Invalid Link message')
      messages.push(message as Record<string, unknown>)
    }
    this.remainder = input
    return messages
  }
}
