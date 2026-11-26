import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { test, type TestContext } from 'node:test'
import type { MuseDevice } from '../src/muse-device.ts'
import { getMuseVms, refreshMuseDevice } from '../src/muse-account.ts'

const device = {
  nodeId: 'homelink-abc123',
  sdkToken: 'mgst_' + 'A'.repeat(43),
  refreshToken: 'hatch_refresh:bootstrap',
}
const first = { vm_id: 'first', vm_auth_token: 'vm-token-1', vm_ws_url: 'wss://unused.invalid' }
const preferred = {
  vm_id: 'second',
  vm_auth_token: 'vm-token-2',
  vm_url: 'https://unused.invalid',
  default: true,
}
const current = {
  ...device,
  refreshToken: 'hatch_refresh:rotated',
  access: { token: 'current', savedAt: Date.now() },
}

async function endpoint(
  t: TestContext,
  handle: (req: IncomingMessage, res: ServerResponse) => void,
) {
  const server = createServer(handle).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return (url: string, init: RequestInit) => {
    const target = new URL(url)
    assert.equal(target.origin, 'https://api.muse.ai')
    assert.equal(init.redirect, 'manual')
    return fetch(new URL(target.pathname, 'http://127.0.0.1:' + address.port), init)
  }
}

test('rotates the device secret before VM lookup and selects the default leased VM', async (t) => {
  const paths: string[] = []
  let saved: MuseDevice | undefined
  const http = await endpoint(t, async (req, res) => {
    paths.push(req.url!)
    if (req.method === 'POST') {
      assert.equal(req.headers.authorization, 'Bearer hatch_refresh:bootstrap')
      let body = ''
      for await (const part of req) body += part
      assert.deepEqual(JSON.parse(body), { device_id: device.nodeId, sdk_token: device.sdkToken })
      res.end(JSON.stringify({ payload: { access_token: 'access', refresh_token: 'next' } }))
    } else {
      assert.equal(saved?.refreshToken, 'next')
      assert.equal(req.headers.authorization, 'Bearer access')
      assert.equal(req.headers['x-api-version'], '1.0.0')
      res.end(JSON.stringify({ vm_list: [null, first, preferred] }))
    }
  })
  const vms = await getMuseVms(
    device,
    undefined,
    async () => {
      const next = await refreshMuseDevice(device, http)
      saved = next
      return next.access
    },
    http,
  )
  assert.deepEqual(paths, ['/device_token/refresh', '/fetch_vms'])
  assert.deepEqual(vms, [
    { noiseHost: 'hatch.metaaivm.com', vmId: 'second', vmToken: 'vm-token-2' },
    { noiseHost: 'hatch.metaaivm.com', vmId: 'first', vmToken: 'vm-token-1' },
  ])
})

test('a requested VM must match exactly; a fresh access token needs no rotation', async (t) => {
  const http = await endpoint(t, (req, res) => {
    assert.equal(req.method, 'GET')
    assert.equal(req.headers.authorization, 'Bearer current')
    res.end(JSON.stringify({ vm_list: [first, preferred] }))
  })
  const persist = async () => assert.fail('should use saved access token')
  assert.deepEqual(
    (await getMuseVms(current, 'first', persist, http)).map((vm) => vm.vmId),
    ['first'],
  )
  await assert.rejects(
    getMuseVms(current, 'other', persist, http),
    /requested VM/,
  )
})

test('refreshes a rejected cached access token once, with the latest refresh secret', async (t) => {
  const methods: string[] = []
  const http = await endpoint(t, (req, res) => {
    methods.push(req.method!)
    if (req.method === 'POST') {
      assert.equal(req.headers.authorization, 'Bearer hatch_refresh:rotated')
      res.end(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh' }))
    } else {
      res.writeHead(401).end('private diagnostic')
    }
  })
  const persisted: MuseDevice[] = []
  await assert.rejects(
    getMuseVms(
      current,
      undefined,
      async () => {
        const next = await refreshMuseDevice(current, http)
        persisted.push(next)
        return next.access
      },
      http,
    ),
    { message: 'Muse VM lookup failed (HTTP 401)' },
  )
  assert.deepEqual(methods, ['GET', 'POST', 'GET'])
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].refreshToken, 'new-refresh')
})

test('keeps credentials out of errors and stops before lookup if persisting a rotated pair fails', async (t) => {
  const methods: string[] = []
  const http = await endpoint(t, (req, res) => {
    methods.push(req.method!)
    res.end(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh' }))
  })
  await assert.rejects(
    getMuseVms(
      device,
      undefined,
      async () => {
        await refreshMuseDevice(device, http)
        throw new Error('storage unavailable')
      },
      http,
    ),
    /storage unavailable/,
  )
  assert.deepEqual(methods, ['POST'])
  await assert.rejects(
    getMuseVms({ ...device, nodeId: 'other\r\nhost' }, undefined, async () => assert.fail(), http),
    /device/,
  )
  assert.deepEqual(methods, ['POST'])
})

test('an expired access token rotates before discovery, and a refused redirect never receives a credential', async (t) => {
  const paths: string[] = []
  const http = await endpoint(t, (req, res) => {
    paths.push(req.url!)
    if (req.url === '/device_token/refresh') {
      assert.equal(req.headers.authorization, 'Bearer hatch_refresh:rotated')
      res.writeHead(307, { Location: '/private' }).end()
    } else {
      res.end(JSON.stringify({ access_token: 'unsafe', refresh_token: 'unsafe' }))
    }
  })
  const expired = { ...current, access: { ...current.access, savedAt: 0 } }
  const rotate = async () => (await refreshMuseDevice(expired, http)).access
  await assert.rejects(getMuseVms(expired, undefined, rotate, http))
  assert.deepEqual(paths, ['/device_token/refresh'])
})
