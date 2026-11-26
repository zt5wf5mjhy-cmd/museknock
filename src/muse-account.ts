import { z } from 'zod'
import { museDeviceSchema, type MuseDevice } from './muse-device.ts'

const api = 'https://api.muse.ai'
const noiseHost = 'hatch.metaaivm.com'
const refreshAfterMs = 3 * 60 * 60 * 1000

const token = z.string().regex(/^[\x21-\x7e]+$/)
const { refreshToken } = museDeviceSchema.shape
const rotated = z.object({ access_token: token, refresh_token: refreshToken })
const listing = z.object({
  vm_list: z.array(z.unknown()),
  error_title: z.unknown().optional(),
  backend_error_code: z.unknown().optional(),
})
const lease = z.object({
  vm_id: z.string().nullish(),
  vm_name: z.string().nullish(),
  vm_auth_token: token,
  vm_ws_url: z.string().nullish(),
  vm_url: z.string().nullish(),
  default: z.boolean().optional(),
})

type AccountRequest = (url: string, options: RequestInit) => Promise<Response>

function accountRequest(request: AccountRequest, path: string, options: RequestInit) {
  return request(api + path, {
    ...options,
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  })
}

export class MuseCredentialRejected extends Error {}

export async function refreshMuseDevice(
  config: MuseDevice,
  request: AccountRequest = fetch,
) {
  const raw = config.refreshToken.replace(/^hatch_refresh:/, '')
  const response = await accountRequest(request, '/device_token/refresh', {
    method: 'POST',
    headers: { Authorization: 'Bearer hatch_refresh:' + raw, 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: config.nodeId, sdk_token: config.sdkToken }),
  })
  if (response.status === 401 || response.status === 403)
    throw new MuseCredentialRejected('Muse rejected the device credentials')
  if (!response.ok) throw new Error('Muse device refresh failed (HTTP ' + response.status + ')')

  const data: unknown = await response.json().catch(() => null)
  const tokens = rotated.safeParse(
    data && typeof data === 'object' && 'payload' in data ? data.payload : data,
  )
  if (!tokens.success) throw new Error('Invalid Muse device refresh response')
  return {
    ...config,
    access: { token: tokens.data.access_token, savedAt: Date.now() },
    refreshToken: tokens.data.refresh_token,
  }
}

function fetchLeases(accessToken: string, request: AccountRequest) {
  return accountRequest(request, '/fetch_vms', {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + accessToken, 'X-API-Version': '1.0.0' },
  })
}

export async function getMuseVms(
  config: MuseDevice,
  vmId: string | undefined,
  rotateAccess: () => Promise<NonNullable<MuseDevice['access']>>,
  request: AccountRequest = fetch,
) {
  if (!museDeviceSchema.safeParse(config).success) throw new Error('Invalid Muse device configuration')
  const age = config.access ? Date.now() - config.access.savedAt : -1
  const cached = age >= 0 && age < refreshAfterMs ? config.access : undefined
  const access = cached ?? await rotateAccess()
  let response = await fetchLeases(access.token, request)
  if (response.status === 401 && cached) {
    await response.body?.cancel()
    response = await fetchLeases((await rotateAccess()).token, request)
  }
  if (!response.ok) throw new Error('Muse VM lookup failed (HTTP ' + response.status + ')')
  const result = listing.safeParse(await response.json().catch(() => null))
  if (!result.success || result.data.error_title || result.data.backend_error_code) {
    throw new Error('Invalid Muse VM lookup response')
  }

  const available = result.data.vm_list.flatMap((entry) => {
    const item = lease.safeParse(entry)
    if (!item.success || !(item.data.vm_ws_url || item.data.vm_url)) return []
    const id = item.data.vm_id || item.data.vm_name
    if (!id || (vmId && id !== vmId)) return []
    return [{ vmId: id, vmToken: item.data.vm_auth_token, isDefault: item.data.default === true }]
  })
  if (!available.length)
    throw new Error(vmId ? 'No lease for the requested VM' : 'No leased Muse VM')
  return available
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
    .map(({ vmId, vmToken }) => ({ noiseHost, vmId, vmToken }))
}
