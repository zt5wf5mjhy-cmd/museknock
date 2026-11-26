import { execFile } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { parseArgs, promisify } from 'node:util'
import { z } from 'zod'
import { museDeviceSchema } from '../src/muse-device.ts'
import { beginPairing, uploadPairing } from './worker-pairing.ts'
import { pairMac } from './mac-pairing.ts'
import { startPairingPage } from './pair-browser.ts'

async function pair() {
  const { values: { replace, browser } } = parseArgs({
    options: { replace: { type: 'boolean', default: false }, browser: { type: 'boolean' } },
  })
  if (process.platform !== 'darwin') throw new Error('Run npm run pair on a Bluetooth-enabled Mac.')
  if (browser) {
    const page = await startPairingPage(replace)
    console.log('Open ' + page.url.href + ' to pair. Keep this window open until pairing finishes.')
    try {
      await promisify(execFile)('/usr/bin/open', [page.url.href])
    } catch {
      console.error('Open the address above in your browser.')
    }
    return
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Open a private interactive terminal to authorize MuseKnock.')
  let hidden = false
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!hidden) process.stdout.write(chunk)
      done()
    },
  })
  const terminal = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 })
  const cancelled = new AbortController()
  terminal.on('SIGINT', () => terminal.close())
  terminal.on('close', () => cancelled.abort())

  async function prompt(label: string, secret = false) {
    const signal = cancelled.signal
    signal.throwIfAborted()
    hidden = secret
    if (secret) process.stdout.write(label)
    try {
      const input = (await terminal.question(secret ? '' : label, { signal })).trim()
      if (!input) throw new Error('A response is required.')
      return input
    } finally {
      if (hidden) process.stdout.write('\n')
      hidden = false
    }
  }

  try {
    const worker = new URL(await prompt('Your deployed MuseKnock Worker URL: '))
    if (worker.protocol !== 'https:' || worker.username || worker.password || worker.pathname !== '/' || worker.search || worker.hash)
      throw new Error('Enter the HTTPS origin of your own Worker.')
    const admin = await prompt('MCP_ADMIN_TOKEN for ' + worker.host + ': ', true)
    const connection = { worker, admin, signal: cancelled.signal }
    const pairing = await beginPairing(connection, replace)
    if (pairing.state === 'configured') {
      if (pairing.verification === 'rejected')
        throw new Error('Muse rejected the saved credentials. Correct the dashboard secrets or run npm run pair -- --replace for a stored pairing.')
      console.log(pairing.verification === 'verified'
        ? 'The Worker has previously refreshed this pairing. Continue with side chat registration in Muse.'
        : 'The Worker has saved credentials. Register an existing side chat in Muse to verify them.')
      return
    }

    const sdkToken = await prompt('Muse Gadget SDK token: ', true)
    if (!museDeviceSchema.shape.sdkToken.safeParse(sdkToken).success) throw new Error('Invalid SDK token format.')
    await pairMac({ nodeId: pairing.nodeId, sdkToken }, (device, lifetime) =>
      uploadPairing(connection, device, pairing.replaces, lifetime), cancelled.signal)
    console.log('Pairing saved in your Worker. Register your existing side chat through the Muse MCP connector.')
  } finally {
    terminal.close()
  }
}
pair().catch(error => {
  console.error(error instanceof z.ZodError ? 'The server returned an unexpected authentication response.' :
    error instanceof Error ? error.message : 'Authorization failed.')
  process.exitCode = 1
})
