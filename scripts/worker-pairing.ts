import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { museDeviceSchema, pairingFingerprint, type MuseDevice } from '../src/muse-device.ts'
import { z } from 'zod'

type WorkerConnection = {
  worker: URL
  admin: string
  signal: AbortSignal
  transport?: typeof fetch
}

export async function beginPairing(
  { worker, admin, signal, transport: request = fetch }: WorkerConnection,
  replace = false,
) {
  const client = new Client({ name: 'museknock-pair', version: '0.1.0' })
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', worker), {
    requestInit: { headers: { Authorization: 'Bearer ' + admin } },
    fetch: (url, init) => {
      const signals = [signal, AbortSignal.timeout(30_000)]
      if (init?.signal) signals.push(init.signal)
      return request(url, { ...init, redirect: 'error', signal: AbortSignal.any(signals) })
    },
  })
  try {
    await client.connect(transport)
    const reply = await client.callTool({ name: 'begin_muse_pairing', arguments: { replace } })
    if (reply.isError) {
      if (z.object({ state: z.literal('managed_by_secrets') }).safeParse(reply.structuredContent).success)
        throw new Error('This pairing uses the three Muse secrets in Cloudflare. Follow the operations guide to update or replace it.')
      throw new Error('Check the Worker encryption key and Muse configuration, then retry.')
    }
    return z.discriminatedUnion('state', [
      z.object({ state: z.literal('configured'), verification: z.enum(['verified', 'unverified', 'rejected']) }),
      z.object({
        state: z.literal('awaiting_authorization'),
        nodeId: museDeviceSchema.shape.nodeId,
        replaces: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      }),
    ]).parse(reply.structuredContent)
  } finally {
    await client.close()
  }
}

export async function uploadPairing(
  connection: WorkerConnection,
  device: MuseDevice,
  replaces: string | undefined,
  lifetime: AbortSignal,
) {
  const { worker, admin, signal, transport = fetch } = connection
  const uploadSignal = AbortSignal.any([signal, lifetime])
  const endpoint = new URL('/v1/setup/pairing', worker)
  const body = JSON.stringify({ ...device, replaces })
  const fingerprint = pairingFingerprint(device)
  for (let attempt = 0; attempt < 2; attempt++) {
    uploadSignal.throwIfAborted()
    const response = await transport(endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.any([uploadSignal, AbortSignal.timeout(30_000)]),
      redirect: 'error',
    }).catch(() => undefined)
    if (response?.status === 204) return
    signal.throwIfAborted()
    if (response?.status === 409) throw new Error('The pairing changed. Check its status in Muse before starting authorization again.')
    if (response?.status === 422) throw new Error('Muse rejected these device credentials. Check your SDK token and start authorization again.')
    if (response && response.status < 500) throw new Error('Worker rejected pairing (HTTP ' + response.status + ').')

    // The Worker can commit after the radio disconnects or the HTTP acknowledgement is lost.
    const current = await beginPairing(connection, true).catch(() => undefined)
    signal.throwIfAborted()
    if (fingerprint !== replaces && current?.state === 'awaiting_authorization' && current.replaces === fingerprint) return
    if (uploadSignal.aborted) break
  }
  throw new Error('Could not confirm this pairing in the Worker. Check pairing status in Muse before starting authorization again.')
}
