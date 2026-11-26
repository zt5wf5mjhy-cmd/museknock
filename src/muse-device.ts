import { createHash } from 'node:crypto'
import { z } from 'zod'

export const sideChatId = /^[a-zA-Z0-9-]{1,64}$/
export const museDeviceSchema = z.object({
  nodeId: z.string().regex(/^[a-z]+-[0-9a-f]{6}$/),
  sdkToken: z.string().regex(/^mgst_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
  refreshToken: z.string().regex(/^(?:hatch_refresh:)?[A-Za-z0-9._~+/=-]+$/),
  access: z.object({ token: z.string().regex(/^[\x21-\x7e]+$/), savedAt: z.number().finite() }).optional(),
})
export type MuseDevice = z.infer<typeof museDeviceSchema>

export type MuseDeviceBindings = {
  MUSE_NODE_ID?: string
  MUSE_SDK_TOKEN?: string
  MUSE_REFRESH_TOKEN?: string
  MUSE_VM_ID?: string
}

export function bootstrapDevice(env: MuseDeviceBindings) {
  if (!env.MUSE_NODE_ID && !env.MUSE_SDK_TOKEN && !env.MUSE_REFRESH_TOKEN) return undefined
  if (!env.MUSE_NODE_ID && env.MUSE_SDK_TOKEN && !env.MUSE_REFRESH_TOKEN) return undefined
  const device = museDeviceSchema.safeParse({
    nodeId: env.MUSE_NODE_ID,
    sdkToken: env.MUSE_SDK_TOKEN,
    refreshToken: env.MUSE_REFRESH_TOKEN,
  })
  return device.success ? device.data : null
}

export function pairingFingerprint(device: MuseDevice) {
  return createHash('sha256')
    .update(JSON.stringify([device.nodeId, device.refreshToken.replace(/^hatch_refresh:/, '')]))
    .digest('hex')
}
