import type { BlueskySession } from './bluesky-notifications.ts'
import type { BrowserSetupSession } from './browser-setup.ts'
import { museDeviceSchema, type MuseDevice } from './muse-device.ts'

type Storage = {
  get<T>(name: string): Promise<T | undefined>
  put<T>(name: string, value: T): Promise<void>
  delete?(name: string): Promise<boolean>
  list<T>(options: { prefix: string; limit: number }): Promise<Map<string, T>>
}

type Records = {
  [pairing: `device:${string}`]: MuseDevice
  [setup: `browser:${string}`]: BrowserSetupSession
  'bluesky-notifications.session': { fingerprint: string; session: BlueskySession }
}

const prefix = 'credentials:'
const ivSize = 12
const encoder = new TextEncoder()

export class CredentialStoreError extends Error {}

export class CredentialStore {
  private key?: Promise<CryptoKey>
  constructor(
    private readonly storage: Storage,
    private readonly secret: string | undefined,
  ) {}

  private encryptionKey() {
    if (this.secret?.length !== 64 || !/^[0-9a-f]{64}$/i.test(this.secret)) {
      throw new CredentialStoreError('Set CREDENTIAL_ENCRYPTION_KEY to 64 hexadecimal characters')
    }
    this.key ??= crypto.subtle.importKey(
      'raw',
      Uint8Array.from(this.secret.match(/../g)!, (pair) => parseInt(pair, 16)),
      'AES-GCM',
      false,
      ['encrypt', 'decrypt'],
    )
    return this.key
  }

  private async decrypt(slot: string, record: unknown, key: CryptoKey) {
    try {
      if (!(record instanceof ArrayBuffer)) throw new Error()
      const bytes = new Uint8Array(record)
      return await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes.subarray(0, ivSize), additionalData: encoder.encode(slot) },
        key,
        bytes.subarray(ivSize),
      )
    } catch {
      throw new CredentialStoreError('Cannot open credentials. Check CREDENTIAL_ENCRYPTION_KEY and storage integrity.')
    }
  }

  async initialize(activePairing: string | null) {
    const key = await this.encryptionKey()
    if (activePairing !== null) {
      const device = await this.get(`device:${activePairing}`)
      if (device !== undefined) {
        const parsed = museDeviceSchema.safeParse(device)
        if (!parsed.success) throw new CredentialStoreError('Invalid saved Muse pairing')
        return parsed.data
      }
    }
    // A new pairing has no saved record yet. Check the key against an existing credential.
    const sample = await this.storage.list({ prefix, limit: 1 })
    for (const [slot, record] of sample) await this.decrypt(slot, record, key)
  }

  async get<K extends keyof Records>(name: K): Promise<Records[K] | undefined> {
    const key = await this.encryptionKey()
    const slot = prefix + name
    const record = await this.storage.get(slot)
    if (record === undefined) return undefined
    const plaintext = await this.decrypt(slot, record, key)
    return JSON.parse(new TextDecoder().decode(plaintext))
  }

  async put<K extends keyof Records>(name: K, value: Records[K]) {
    const key = await this.encryptionKey()
    const slot = prefix + name
    const iv = crypto.getRandomValues(new Uint8Array(ivSize))
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(slot) },
      key,
      encoder.encode(JSON.stringify(value)),
    )
    const record = new Uint8Array(ivSize + ciphertext.byteLength)
    record.set(iv)
    record.set(new Uint8Array(ciphertext), ivSize)
    await this.storage.put(slot, record.buffer)
  }

  async delete<K extends keyof Records>(name: K) {
    if (!this.storage.delete) throw new CredentialStoreError('Credential deletion unavailable')
    await this.storage.delete(prefix + name)
  }
}
