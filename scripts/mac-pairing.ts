import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { museDeviceSchema, type MuseDevice } from '../src/muse-device.ts'

const event = z.union([
  z.object({
    advertising: z.string().regex(/^MuseGadget[A-F0-9]{6}$/),
    proof: z.string().regex(/^[a-f0-9]{16}$/),
    service: z.uuid(),
    characteristic: z.uuid(),
  }),
  z.object({ verified: z.literal(true) }),
  z.object({ progress: z.enum(['subscribed', 'identity', 'scan', 'handshake', 'reconnect', 'network']) }),
  z.object({ refreshToken: museDeviceSchema.shape.refreshToken }),
])

export async function pairMac(
  { nodeId, sdkToken }: Pick<MuseDevice, 'nodeId' | 'sdkToken'>,
  save: (device: MuseDevice, lifetime: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  report: (message: string) => void = console.log,
) {
  const path = fileURLToPath(new URL('./pair-mac.py', import.meta.url))
  const child = spawn('uv', ['run', '--script', path], { stdio: ['pipe', 'pipe', 'inherit'], signal })
  const lifetime = new AbortController()
  child.once('close', () => lifetime.abort())
  const exited = once(child, 'close')
  // The subprocess can fail to start before the line iterator finishes.
  void exited.catch(() => {})
  child.stdin.on('error', () => {}) // A child that exits early also closes its pipe.
  const lines = createInterface({ input: child.stdout })
  let saved = false
  try {
    child.stdin.write(JSON.stringify({ nodeId, sdkToken }) + '\n')
    for await (const line of lines) {
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        throw new Error('The Mac pairing helper returned an unreadable response.')
      }
      const message = event.parse(raw)
      if ('advertising' in message) {
        report('Open a Bluetooth LE reader on your iPhone (such as nRF Connect). Connect to ' + message.advertising + '.')
        report('Open service ' + message.service + ', then write to the MuseKnock verification characteristic ' + message.characteristic + '.')
        report('Choose Write with response. Enter this one-time value as hex bytes or as UTF-8 text: ' + message.proof.toUpperCase())
      } else if ('verified' in message) {
        report('Phone verified. Disconnect the Bluetooth reader, then open Muse → Settings → Devices → Allow community devices → Add Device → Muse Gadget. Select the same gadget. At the Wi-Fi list, select “Use current connection”.')
      } else if ('progress' in message) {
        report('Bluetooth: ' + message.progress)
      } else {
        if (saved) throw new Error('The Mac received a second pairing.')
        await save({ nodeId, sdkToken, refreshToken: message.refreshToken }, lifetime.signal)
        saved = true
        child.stdin.end('saved\n')
      }
    }
    const [code] = await exited
    if (!saved || code !== 0) throw new Error(saved
      ? 'Worker pairing was saved. The phone did not acknowledge completion.'
      : 'Bluetooth pairing did not complete. See the Mac message above.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('Install uv on this Mac to run Bluetooth pairing.')
    throw error
  } finally {
    lines.close()
    child.kill()
  }
}
