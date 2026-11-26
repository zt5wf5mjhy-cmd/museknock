import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Response } from 'miniflare'
import { connect } from './mcp-client.ts'
import { openSettings } from './settings-client.ts'
import { startConfiguredWorker, startWorker } from './worker.ts'

test('a temporary settings link moves source changes out of MCP', async t => {
  const worker = await startConfiguredWorker()
  t.after(() => worker.close())
  const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
  const reader = await connect(new URL('/mcp', worker.url), 'MCP_TOKEN-test')
  t.after(() => Promise.all([admin.close(), reader.close()]))

  const tools = (await admin.listTools()).tools.map(tool => tool.name)
  assert.ok(tools.includes('create_settings_link'))
  for (const name of ['set_source_paused', 'set_event_filter', 'register_side_chat', 'set_active_side_chat']) {
    assert.ok(!tools.includes(name))
  }
  assert.equal((await reader.callTool({ name: 'create_settings_link' })).isError, true)
  const issued = (await admin.callTool({ name: 'create_settings_link' })).structuredContent as { url: string }
  const link = new URL(issued.url)
  assert.equal(link.origin, worker.url.origin)
  const landing = await fetch(link)
  assert.equal(landing.status, 200)
  assert.equal(landing.headers.get('Referrer-Policy'), 'no-referrer')
  assert.match(landing.headers.get('Content-Security-Policy')!, /form-action 'self'/)
  assert.doesNotMatch(await landing.text(), /MCP_ADMIN_TOKEN-test/)

  const post = (url: URL, body: URLSearchParams, cookie?: string, origin = worker.url.origin, fetchSite?: string) => fetch(url, {
    method: 'POST', redirect: 'manual',
    headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded', ...(fetchSite ? { 'Sec-Fetch-Site': fetchSite } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body,
  })
  assert.equal((await post(link, new URLSearchParams(), undefined, 'https://other.example')).status, 403)
  assert.equal((await post(link, new URLSearchParams(), undefined, 'null', 'cross-site')).status, 403)
  assert.equal((await post(link, new URLSearchParams(), undefined, 'null')).status, 403)
  const opened = await post(link, new URLSearchParams(), undefined, 'null', 'same-origin')
  assert.equal(opened.status, 303)
  const cookie = opened.headers.get('Set-Cookie')!.split(';')[0]
  assert.match(cookie, /^__Host-museknock-settings=[0-9a-f]{64}$/)
  assert.equal((await post(link, new URLSearchParams())).status, 410)
  const page = new URL('/v1/setup/settings', worker.url)
  assert.equal((await fetch(page)).status, 410)
  assert.equal((await post(page, new URLSearchParams({ action: 'pause_source', source: 'custom', paused: 'true' }))).status, 410)
  const initialPage = await fetch(page, { headers: { Cookie: cookie } })
  assert.equal(initialPage.status, 200)
  const initialHtml = await initialPage.text()
  assert.match(initialHtml, /Custom webhook/)
  assert.match(initialHtml, /GitHub/)
  assert.match(initialHtml, /Notify on receipt/)
  assert.match(initialHtml, /Pause notifications/)
  assert.match(initialHtml, /name="type" value="push"/)
  assert.match(initialHtml, /Save selected events/)
  assert.match(initialHtml, /Allow all events/)
  assert.ok(initialHtml.includes(new URL('/v1/hooks/github', worker.url).href))
  assert.match(initialHtml, /README\.md#github-repository-events/)
  assert.equal((await post(page, new URLSearchParams({ action: 'pause_source', source: 'custom', paused: 'true' }), cookie, 'https://other.example')).status, 403)
  assert.equal((await post(page, new URLSearchParams({ action: 'pause_source', source: 'custom', paused: 'true' }), cookie, 'null', 'cross-site')).status, 403)

  const changed = await post(page, new URLSearchParams({ action: 'pause_source', source: 'custom', paused: 'true' }), cookie, 'null', 'same-origin')
  assert.equal(changed.status, 303)
  assert.deepEqual((await reader.callTool({ name: 'list_sources' })).structuredContent, {
    sources: [{ source: 'custom', paused: true, types: [] }],
  })
  assert.equal((await post(page, new URLSearchParams({ action: 'filter_source', source: 'custom', mode: 'selected', otherTypes: 'broken value' }), cookie)).status, 400)
  const noEvents = await post(page, new URLSearchParams({ action: 'filter_source', source: 'custom', mode: 'selected', otherTypes: '' }), cookie)
  assert.equal(noEvents.status, 400)
  assert.match(await noEvents.text(), /Select at least one event/)
  assert.equal((await post(page, new URLSearchParams([['action', 'pause_source'], ['action', 'filter_source'], ['source', 'custom'], ['paused', 'false']]), cookie)).status, 400)
  const filtered = await post(page, new URLSearchParams({ action: 'filter_source', source: 'custom', mode: 'selected', otherTypes: 'push, release' }), cookie)
  assert.equal(filtered.status, 303)
  const updatedHtml = await (await fetch(new URL(filtered.headers.get('Location')!, worker.url), { headers: { Cookie: cookie } })).text()
  assert.match(updatedHtml, /<details[^>]*open[^>]*>.*?Custom webhook/s)
  assert.match(updatedHtml, /Resume notifications/)
  assert.match(updatedHtml, /value="push, release"/)
  assert.deepEqual((await reader.callTool({ name: 'list_sources' })).structuredContent, {
    sources: [{ source: 'custom', paused: true, types: ['push', 'release'] }],
  })
  assert.equal((await post(page, new URLSearchParams({ action: 'filter_source', source: 'custom', mode: 'all' }), cookie)).status, 303)
  assert.deepEqual((await reader.callTool({ name: 'list_sources' })).structuredContent, {
    sources: [{ source: 'custom', paused: true, types: [] }],
  })
  assert.equal((await post(page, new URLSearchParams([
    ['action', 'filter_source'], ['source', 'github'], ['mode', 'selected'],
    ['type', 'push'], ['type', 'release'], ['otherTypes', ''],
  ]), cookie)).status, 303)
  assert.deepEqual((await reader.callTool({ name: 'list_sources' })).structuredContent, {
    sources: [
      { source: 'custom', paused: true, types: [] },
      { source: 'github', paused: false, types: ['push', 'release'] },
    ],
  })
})

test('registration checks later VM leases, but selection stays on the registered VM', async t => {
  const lookups: { vm: string | null; session: string | null }[] = []
  const sessionId = 'target-chat'
  let vmWithChat: string | null = 'later-vm'
  let unavailableVm: string | null = 'preferred-vm'
  const worker = await startWorker(request => {
    const url = new URL(request.url)
    if (url.pathname === '/device_token/refresh') {
      return Response.json({ access_token: 'test-access', refresh_token: 'test-refresh' })
    }
    if (url.pathname === '/fetch_vms') {
      return Response.json({ vm_list: [
        { vm_id: 'later-vm', vm_auth_token: 'later-token', vm_url: 'https://vm.test' },
        { vm_id: 'preferred-vm', vm_auth_token: 'preferred-token', vm_url: 'https://vm.test', default: true },
      ] })
    }
    assert.equal(url.origin + url.pathname, 'https://vm.test/side-chat')
    const vm = url.searchParams.get('vm')
    const session = url.searchParams.get('session')
    lookups.push({ vm, session })
    if (vm === unavailableVm) return new Response('private upstream error', { status: 503 })
    return new Response(null, { status: vm === vmWithChat && session === sessionId ? 200 : 404 })
  }, {}, undefined, [{
    name: 'mock-side-chat-lookup',
    setup(build) {
      build.onResolve({ filter: /^\.\/link\/chat\.ts$/, namespace: 'file' }, args => ({
        path: args.resolveDir, namespace: 'mock-side-chat-lookup',
      }))
      build.onLoad({ filter: /.*/, namespace: 'mock-side-chat-lookup' }, args => ({
        resolveDir: args.path,
        contents: `
          export { sendSideChat } from './link/chat.ts'
          export async function sideChatExists(vm, session) {
            const url = new URL('https://vm.test/side-chat')
            url.search = new URLSearchParams({ vm: vm.vmId, session })
            const response = await fetch(url)
            if (response.status === 404) return false
            if (!response.ok) throw new Error(await response.text())
            return true
          }
        `,
      }))
    },
  }])
  t.after(() => worker.close())
  const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
  t.after(() => admin.close())
  const settings = await openSettings(worker.url, admin)

  const registered = await settings.register('Builds', sessionId)
  assert.deepEqual(lookups.splice(0), [
    { vm: 'preferred-vm', session: sessionId }, { vm: 'later-vm', session: sessionId },
  ])
  assert.equal(registered.status, 303)
  const chats = { active: 'Builds', chats: [{ name: 'Builds', sessionId }] }
  assert.deepEqual((await admin.callTool({ name: 'list_side_chats' })).structuredContent, chats)

  vmWithChat = 'preferred-vm'
  unavailableVm = null
  assert.equal((await settings.select('Builds')).status, 422)
  assert.deepEqual(lookups.splice(0), [{ vm: 'later-vm', session: sessionId }])
  assert.deepEqual((await admin.callTool({ name: 'list_side_chats' })).structuredContent, chats)

  vmWithChat = null
  const missing = await settings.register('Missing', sessionId)
  assert.equal(missing.status, 422)
  assert.match(await missing.text(), /Side chat not found on any leased Muse VM/)

  unavailableVm = 'preferred-vm'
  const unavailable = await settings.register('Missing', sessionId)
  assert.equal(unavailable.status, 422)
  const html = await unavailable.text()
  assert.match(html, /Could not verify the side chat with Muse/)
  assert.doesNotMatch(html, /private upstream error/)
  assert.deepEqual((await admin.callTool({ name: 'list_side_chats' })).structuredContent, chats)
})

test('a new link replaces an unused ticket and reset ends an open settings session', async t => {
  const worker = await startWorker(undefined, { MUSE_NODE_ID: undefined, MUSE_REFRESH_TOKEN: undefined })
  t.after(() => worker.close())
  const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
  t.after(() => admin.close())
  const issue = async () => new URL(String(((await admin.callTool({ name: 'create_settings_link' })).structuredContent as { url: string }).url))
  const old = await issue()
  const current = await issue()
  assert.equal((await fetch(old)).status, 410)
  assert.equal((await fetch(current)).status, 200)
  const opened = await fetch(current, { method: 'POST', redirect: 'manual',
    headers: { Origin: worker.url.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(),
  })
  const cookie = opened.headers.get('Set-Cookie')!.split(';')[0]
  const page = new URL('/v1/setup/settings', worker.url)
  assert.equal((await fetch(page, { headers: { Cookie: cookie } })).status, 200)
  const reset = await fetch(new URL('/v1/setup/reset', worker.url), {
    method: 'POST', headers: { Authorization: 'Bearer MCP_ADMIN_TOKEN-test' },
  })
  assert.equal(reset.status, 204)
  assert.equal((await fetch(page, { headers: { Cookie: cookie } })).status, 410)
})
