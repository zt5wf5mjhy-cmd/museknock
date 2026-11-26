import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { museDeviceSchema } from '../src/muse-device.ts'
import { pairMac } from './mac-pairing.ts'
import { beginPairing, uploadPairing } from './worker-pairing.ts'

const host = '127.0.0.1'
const input = z.object({
  worker: z.string().trim().pipe(z.url()).transform(value => new URL(value)).refine(url =>
    url.protocol === 'https:' && !url.username && !url.password &&
    url.pathname === '/' && !url.search && !url.hash),
  admin: z.string().trim().regex(/^[\x21-\x7e]{1,1024}$/),
  sdkToken: z.string().trim().pipe(museDeviceSchema.shape.sdkToken),
  replace: z.boolean(),
})

async function readInput(request: IncomingMessage) {
  let body = ''
  for await (const chunk of request.setEncoding('utf8').iterator({ destroyOnReturn: false })) {
    body += chunk
    if (body.length > 4096) {
      request.resume()
      return null
    }
  }
  try {
    return input.safeParse(JSON.parse(body))
  } catch {
    return null
  }
}

export async function startPairingPage(replace = false) {
  const path = '/pair/' + randomBytes(18).toString('base64url')
  const nonce = randomBytes(18).toString('base64')
  const html = (await readFile(new URL('./pair-browser.html', import.meta.url), 'utf8'))
    .replace('SCRIPT_NONCE', nonce)
    .replace('REPLACE_CHECKED', replace ? 'checked' : '')
  const lifetime = new AbortController()
  let url: URL
  let busy = false

  async function serve(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store')
    if (request.headers.host !== url.host || request.url !== path)
      return response.writeHead(404).end()
    if (request.method === 'GET') {
      return response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'`,
        'Referrer-Policy': 'no-referrer',
      }).end(html)
    }
    if (request.method !== 'POST') return response.writeHead(405).end()
    if (request.headers.origin !== url.origin) return response.writeHead(403).end()
    if (request.headers['content-type'] !== 'application/json') return response.writeHead(415).end()
    if (busy) return response.writeHead(409).end()
    busy = true
    const cancelled = new AbortController()
    response.on('close', () => cancelled.abort())
    const signal = AbortSignal.any([cancelled.signal, lifetime.signal])
    try {
      const result = await readInput(request)
      if (!result?.success) return response.writeHead(400).end()
      const { worker, admin, sdkToken, replace } = result.data
      const connection = { worker, admin, signal }
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' })
      const report = (message: string) => response.write(JSON.stringify({ message }) + '\n')
      try {
        report('Checking your Worker…')
        const pairing = await beginPairing(connection, replace)
        if (pairing.state === 'configured') {
          if (pairing.verification === 'rejected')
            throw new Error('Muse rejected the saved credentials. Select Replace existing pairing and try again.')
          report('This Worker already has a pairing. Continue with side chat registration in Muse.')
        } else {
          report('Starting Bluetooth. Allow access if macOS asks.')
          await pairMac({ nodeId: pairing.nodeId, sdkToken }, (device, radio) =>
            uploadPairing(connection, device, pairing.replaces, radio), signal, report)
          report('Pairing saved in your Worker. Register the side chat through the Muse connector.')
        }
        response.once('finish', close)
        response.end(JSON.stringify({ done: true }) + '\n')
      } catch (error) {
        if (signal.aborted) return response.end()
        response.end(JSON.stringify({
          error: error instanceof Error && !(error instanceof z.ZodError)
            ? error.message : 'The pairing helper returned an unexpected response.',
        }) + '\n')
      }
    } finally {
      busy = false
    }
  }

  const server = createServer((request, response) => {
    void serve(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })
  await once(server.listen(0, host), 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not open the pairing page.')
  url = new URL(path, `http://${host}:${address.port}`)
  const timeout = setTimeout(close, 20 * 60_000).unref()
  function close() {
    clearTimeout(timeout)
    lifetime.abort()
    server.close()
  }
  return { url, close }
}
