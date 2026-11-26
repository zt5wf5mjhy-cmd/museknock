import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CredentialStore } from '../src/credential-store.ts'

const key = 'ab'.repeat(32)
const pairing = 'device:test-a'
const tokens = { nodeId: 'test-123abc', sdkToken: 'mgst_' + 'A'.repeat(43), refreshToken: 'example-refresh', access: { token: 'example-access', savedAt: 10 } }

function storage() {
  const records = new Map<string, unknown>()
  return {
    records,
    async get<T>(name: string) {
      return structuredClone(records.get(name)) as T | undefined
    },
    async put<T>(name: string, value: T) {
      records.set(name, structuredClone(value))
    },
    async list<T>({ prefix, limit }: { prefix: string; limit: number }) {
      return new Map([...records].filter(([name]) => name.startsWith(prefix)).slice(0, limit)) as Map<string, T>
    },
  }
}

test('stores one encrypted record per pairing and uses a fresh nonce on every write', async () => {
  const data = storage()
  const store = new CredentialStore(data, key)
  await store.initialize(null)
  await store.put(pairing, tokens)
  const slot = 'credentials:' + pairing
  const first = await data.get<ArrayBuffer>(slot)
  assert.ok(first instanceof ArrayBuffer)
  assert.equal(Buffer.from(first).includes(Buffer.from(tokens.refreshToken)), false)
  for (const value of [tokens.nodeId, tokens.sdkToken, tokens.access.token]) {
    assert.equal(Buffer.from(first).includes(Buffer.from(value)), false)
  }
  await store.put(pairing, tokens)
  const second = await data.get<ArrayBuffer>(slot)
  assert.ok(second instanceof ArrayBuffer)
  assert.notDeepEqual(second.slice(0, 12), first.slice(0, 12))
  assert.equal(data.records.size, 1)
  const reopened = new CredentialStore(data, key)
  await reopened.initialize(null)
  assert.deepEqual(await reopened.get(pairing), tokens)
})

test('missing or malformed keys prevent initialization and credential access', async () => {
  for (const invalid of [undefined, '', 'A'.repeat(63), key + '\n', 'z'.repeat(64)]) {
    const data = storage()
    const store = new CredentialStore(data, invalid)
    for (const call of [() => store.initialize(null), () => store.put(pairing, tokens), () => store.get(pairing)]) {
      await assert.rejects(call, /CREDENTIAL_ENCRYPTION_KEY/)
    }
    assert.equal(data.records.size, 0)
  }
})

test('initialization checks the active pairing even when another credential is readable', async () => {
  const data = storage()
  const store = new CredentialStore(data, key)
  await store.put('bluesky-notifications.session', {
    fingerprint: 'test', session: { did: 'did:plc:test', accessJwt: 'access', refreshJwt: 'refresh' },
  })
  await store.put(pairing, tokens)
  const saved = (await data.get<ArrayBuffer>('credentials:' + pairing))!
  const damaged = saved.slice(0)
  new Uint8Array(damaged)[12] ^= 1
  await data.put('credentials:' + pairing, damaged)
  await assert.rejects(store.initialize('test-a'), /Cannot open credentials/)
  await data.put('credentials:' + pairing, saved)
  await store.initialize('test-a')
  assert.deepEqual(await store.get(pairing), tokens)
})

test('rejects a wrong key, damaged ciphertext, plaintext, and credentials copied between slots', async () => {
  const data = storage()
  const store = new CredentialStore(data, key)
  await store.put(pairing, tokens)
  const sealed = (await data.get<ArrayBuffer>('credentials:' + pairing))!
  await assert.rejects(new CredentialStore(data, 'cd'.repeat(32)).initialize(null), /Cannot open credentials/)
  const corrupt = sealed.slice(0)
  new Uint8Array(corrupt)[12] ^= 1
  for (const invalid of [corrupt, tokens, null]) {
    await data.put('credentials:' + pairing, invalid)
    await assert.rejects(store.get(pairing), /Cannot open credentials/)
    await assert.rejects(store.initialize(null), /Cannot open credentials/)
    assert.deepEqual(await data.get('credentials:' + pairing), invalid)
  }
  for (const name of ['device:test-b', 'bluesky-notifications.session'] as const) {
    await data.put('credentials:' + name, sealed)
    await assert.rejects(store.get(name), /Cannot open credentials/)
  }
})
