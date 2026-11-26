type Bytes = Uint8Array<ArrayBuffer>
const empty = new Uint8Array(0)

function join(left: Uint8Array, right: Uint8Array): Bytes {
  const result = new Uint8Array(left.length + right.length)
  result.set(left)
  result.set(right, left.length)
  return result
}

async function hash(bytes: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])
  if (!('privateKey' in pair)) throw new Error('X25519 key generation failed')
  return pair
}

async function publicBytes(pair: CryptoKeyPair): Promise<Bytes> {
  return new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
}

async function exchange(privateKey: CryptoKey, remote: Bytes): Promise<Bytes> {
  const publicKey = await crypto.subtle.importKey('raw', remote, 'X25519', false, [])
  const shared = await crypto.subtle.deriveBits(
    { name: 'X25519', public: publicKey },
    privateKey,
    256,
  )
  return new Uint8Array(shared)
}

async function deriveKeys(salt: Bytes, secret: Bytes): Promise<[Bytes, Bytes]> {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: empty },
    key,
    512,
  )
  const output = new Uint8Array(bits)
  return [output.subarray(0, 32), output.subarray(32)]
}

function aesKey(bytes: Bytes) {
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

async function cipher(
  operation: 'encrypt' | 'decrypt',
  key: CryptoKey,
  counter: number,
  data: Bytes,
  ad: Bytes,
): Promise<Bytes> {
  const iv = new Uint8Array(12)
  new DataView(iv.buffer).setBigUint64(4, BigInt(counter))
  return new Uint8Array(
    await crypto.subtle[operation]({ name: 'AES-GCM', iv, additionalData: ad }, key, data),
  )
}

function stream(operation: 'encrypt' | 'decrypt', key: CryptoKey) {
  let nonce = 0
  return async (data: Uint8Array): Promise<Bytes> => {
    if (nonce >= Number.MAX_SAFE_INTEGER) throw new Error('Noise cipher is closed')
    try {
      return await cipher(operation, key, nonce++, new Uint8Array(data), empty)
    } catch (error) {
      nonce = Number.MAX_SAFE_INTEGER
      throw error
    }
  }
}

export async function startNoise(newKeyPair = generateKeyPair) {
  const ephemeral = await newKeyPair()
  const message1 = await publicBytes(ephemeral)
  let consumed = false
  return {
    message1,
    async finish(response: Uint8Array) {
      if (consumed) throw new Error('Noise handshake already consumed')
      consumed = true
      if (response.length < 96 || response.length > 65535)
        throw new Error('Invalid Noise handshake length')
      const message2 = new Uint8Array(response)
      const protocol = new Uint8Array(32)
      protocol.set(new TextEncoder().encode('Noise_XX_25519_AESGCM_SHA256'))

      // The empty prologue and message 1's empty payload both enter the Noise transcript.
      const prologueHash = await hash(protocol)
      const afterMessage1 = await hash(await hash(join(prologueHash, message1)))
      const remoteEphemeral = message2.subarray(0, 32)
      let transcript = await hash(join(afterMessage1, remoteEphemeral))

      const [afterEE, ee] = await deriveKeys(
        protocol,
        await exchange(ephemeral.privateKey, remoteEphemeral),
      )
      const encryptedStatic = message2.subarray(32, 80)
      const remoteStatic = await cipher('decrypt', await aesKey(ee), 0, encryptedStatic, transcript)
      transcript = await hash(join(transcript, encryptedStatic))

      const [afterES, es] = await deriveKeys(
        afterEE,
        await exchange(ephemeral.privateKey, remoteStatic),
      )
      const esKey = await aesKey(es)
      const payload = message2.subarray(80)
      await cipher('decrypt', esKey, 0, payload, transcript)
      transcript = await hash(join(transcript, payload))

      const localStatic = await newKeyPair()
      const encryptedLocal = await cipher(
        'encrypt',
        esKey,
        1,
        await publicBytes(localStatic),
        transcript,
      )
      transcript = await hash(join(transcript, encryptedLocal))
      const [afterSE, se] = await deriveKeys(
        afterES,
        await exchange(localStatic.privateKey, remoteEphemeral),
      )
      const tag = await cipher('encrypt', await aesKey(se), 0, empty, transcript)
      const [outbound, inbound] = await deriveKeys(afterSE, empty)

      return {
        message3: join(encryptedLocal, tag),
        encrypt: stream('encrypt', await aesKey(outbound)),
        decrypt: stream('decrypt', await aesKey(inbound)),
      }
    },
  }
}
