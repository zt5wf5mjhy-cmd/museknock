import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { fetch as localFetch, Response } from 'miniflare'
import { z } from 'zod'
import { sendOverLink } from '../src/link/chat.ts'
import { connect } from './mcp-client.ts'
import { openSettings } from './settings-client.ts'
import { startWorker } from './worker.ts'

test(
  'posts to the original side chat using the upstream Python SDK responder',
  {
    skip: process.env.MUSE_SDK_TESTS
      ? false
      : 'set MUSE_SDK_TESTS to the upstream linux/tests directory',
    timeout: 30_000,
  },
  async (t) => {
    const peer = spawn(
      process.env.MUSE_PYTHON ?? 'python3',
      [fileURLToPath(new URL('./link-peer.py', import.meta.url))],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    )
    const exited = once(peer, 'exit')
    t.after(() => {
      peer.kill()
    })
    const output = createInterface({ input: peer.stdout })
    const [port] = await Promise.race([
      once(output, 'line'),
      exited.then(() => {
        throw Error('SDK peer did not start')
      }),
    ])
    for (const size of [65_400, 75_000]) {
      const socket = new WebSocket('ws://127.0.0.1:' + port + '/incomplete-post')
      await once(socket, 'open')
      const aborted = new AbortController()
      const send = socket.send.bind(socket)
      socket.send = (packet) => {
        send(packet)
        // Disconnect after the first large packet reaches the socket, before the JSON body is complete.
        if (ArrayBuffer.isView(packet) && packet.byteLength > 16_000) aborted.abort()
      }
      try {
        const outcome = await sendOverLink(socket, 'test-123abc', 'same-chat', 'a'.repeat(size),
          AbortSignal.any([aborted.signal, AbortSignal.timeout(8_000)]))
        assert.ok(aborted.signal.aborted)
        assert.equal(outcome, 'not_sent', 'incomplete post of ' + size + ' characters')
      } finally {
        socket.close()
      }
    }
    for (const [path, outcome] of [
      ['late-lookup-reset', 'sent'],
      ['deleted', 'side_chat_missing'],
      ['lookup-busy', 'not_sent'],
      ['lookup-reset', 'not_sent'],
      ['reject-registration', 'not_sent'],
      ['post-rate-limited', 'not_sent'],
      ['post-unavailable', 'unknown'],
      ['lost-ack', 'unknown'],
      ['post-reset', 'unknown'],
      ['malformed-ack', 'unknown'],
      ['empty-ack', 'unknown'],
      ['array-ack', 'unknown'],
    ]) {
      const socket = new WebSocket('ws://127.0.0.1:' + port + '/' + path)
      await once(socket, 'open')
      try {
        assert.equal(
          await sendOverLink(
            socket,
            'test-123abc',
            'same-chat',
            'event'.repeat(15_000),
            AbortSignal.timeout(8_000),
          ),
          outcome,
          path,
        )
      } finally {
        if (socket.readyState < WebSocket.CLOSING) socket.close()
      }
    }
    const accountRequests: string[] = []
    let defaultChanged = false
    let originalLeased = true
    const outbound: Parameters<typeof startWorker>[0] = async (req) => {
      const url = new URL(req.url)
      if (url.origin === 'https://hatch.metaaivm.com') {
        assert.equal(req.headers.get('upgrade'), 'websocket')
        return localFetch('http://127.0.0.1:' + port + url.pathname + url.search, {
          headers: {
            Upgrade: 'websocket',
            Authorization: req.headers.get('authorization') ?? '',
          },
          redirect: 'manual',
        })
      }
      assert.equal(url.origin, 'https://api.muse.ai')
      accountRequests.push(url.pathname)
      if (req.method === 'POST' && url.pathname === '/device_token/refresh') {
        assert.equal(
          req.headers.get('authorization'),
          'Bearer hatch_refresh:test-initial-refresh',
        )
        assert.deepEqual(await req.json(), {
          device_id: 'test-123abc',
          sdk_token: 'mgst_' + 'A'.repeat(43),
        })
        return Response.json({ access_token: 'local-access', refresh_token: 'local-refresh' })
      }
      assert.equal(req.method, 'GET')
      assert.equal(url.pathname, '/fetch_vms')
      assert.equal(req.headers.get('authorization'), 'Bearer local-access')
      return Response.json({
        vm_list: [
          { vm_id: 'local-vm', vm_auth_token: 'local-vm-token', vm_url: 'https://vm.example', default: !defaultChanged },
          { vm_id: 'other-vm', vm_auth_token: 'other-token', vm_url: 'https://other.example', default: defaultChanged },
        ].filter(vm => originalLeased || vm.vm_id !== 'local-vm'),
      })
    }
    const worker = await startWorker(
      outbound,
      { TELEGRAM_WEBHOOK_SECRET: 'interop-test', LINE_CHANNEL_SECRET: 'line-test' },
    )
    t.after(() => worker.close())
    const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
    t.after(() => admin.close())
    const settings = await openSettings(worker.url, admin)
    assert.equal((await settings.register('My existing chat', 'same-chat')).status, 303)
    const selected = (await admin.callTool({ name: 'list_side_chats' })).structuredContent
    assert.deepEqual(selected, {
      active: 'My existing chat',
      chats: [{ name: 'My existing chat', sessionId: 'same-chat' }],
    })
    const register = settings.register
    const activate = settings.select
    const missing = await register('My existing chat', 'missing-chat')
    assert.equal(missing.status, 422)
    assert.match(await missing.text(), /not found/i)
    const unavailable = await register('My existing chat', 'busy-chat')
    assert.equal(unavailable.status, 422)
    assert.match(await unavailable.text(), /could not verify/i)
    assert.deepEqual((await admin.callTool({ name: 'list_side_chats' })).structuredContent, selected)
    assert.equal((await register('Other', 'other-chat')).status, 303)
    assert.equal((await activate('Other')).status, 303)
    assert.deepEqual((await admin.callTool({ name: 'list_side_chats' })).structuredContent, {
      active: 'Other', chats: [{ name: 'My existing chat', sessionId: 'same-chat' }, { name: 'Other', sessionId: 'other-chat' }],
    })
    defaultChanged = true
    originalLeased = false
    assert.equal((await activate('My existing chat')).status, 422)
    const unchanged = await admin.callTool({ name: 'list_side_chats' })
    assert.equal(z.object({ active: z.string() }).parse(unchanged.structuredContent).active, 'Other')
    originalLeased = true
    assert.equal((await activate('My existing chat')).status, 303)
    const disappeared = await activate('Other')
    assert.equal(disappeared.status, 422)
    assert.match(await disappeared.text(), /not found/i)
    async function postAndWait(url: URL, key: string, body: string, contentType = 'text/plain') {
      const post = () => fetch(new URL('/v1/hooks/custom', url), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer HOOK_TOKEN-test',
          'Content-Type': contentType,
          'Idempotency-Key': key,
        },
        body,
      })
      const first = await post()
      assert.equal(first.status, 202)
      const { id } = z.object({ id: z.uuid() }).parse(await first.json())
      const deadline = Date.now() + 8_000
      let repeated
      do {
        await delay(50)
        const duplicate = await post()
        assert.equal(duplicate.status, 200)
        repeated = z.object({ id: z.uuid(), duplicate: z.boolean(), state: z.string() }).parse(await duplicate.json())
      } while (['queued', 'sending'].includes(repeated.state) && Date.now() < deadline)
      assert.deepEqual(repeated, { id, duplicate: true, state: 'sent' })
      return id
    }
    await postAndWait(worker.url, 'interop', '{\n  "id": 9007199254740993\n}\n', 'application/json')
    const testPost = await admin.callTool({
      name: 'send_test_notification',
      arguments: { requestId: crypto.randomUUID() },
    })
    const testReceipt = testPost.structuredContent
    assert.ok(testReceipt && typeof testReceipt === 'object' && 'id' in testReceipt)
    const until = Date.now() + 10_000
    let state: unknown
    do {
      await delay(50)
      const lookup = await admin.callTool({
        name: 'get_delivery_status', arguments: { id: testReceipt.id },
      })
      const status = lookup.structuredContent
      assert.ok(status && typeof status === 'object' && 'state' in status)
      state = status.state
    } while ((state === 'queued' || state === 'sending') && Date.now() < until)
    assert.equal(state, 'sent')
    assert.equal((await settings.filter('line', ['message'])).status, 303)
    const batch = JSON.stringify({ events: [
      { type: 'message', webhookEventId: 'L1', message: { type: 'text', id: 'msg1', text: 'withdrawn' } },
      { type: 'unsend', webhookEventId: 'L2', unsend: { messageId: 'msg1' } },
    ] })
    const line = await fetch(new URL('/v1/hooks/line', worker.url), {
      method: 'POST',
      headers: { 'X-Line-Signature': createHmac('sha256', 'line-test').update(batch).digest('base64') },
      body: batch,
    })
    assert.equal(line.status, 200)
    const telegram = await fetch(new URL('/v1/hooks/telegram', worker.url), {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'interop-test', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        update_id: 101,
        edited_channel_post: { message_id: 3, chat: { id: -7 }, caption: 'Release ready' },
      }),
    })
    assert.equal(telegram.status, 200)
    // A separate installation has its own delivery budget and device token cache.
    const deletedWorker = await startWorker(outbound, { MUSE_VM_ID: 'local-vm' })
    t.after(() => deletedWorker.close())
    const deletedAdmin = await connect(new URL('/mcp', deletedWorker.url), 'MCP_ADMIN_TOKEN-test')
    t.after(() => deletedAdmin.close())
    const deletedSettings = await openSettings(deletedWorker.url, deletedAdmin)
    assert.equal((await deletedSettings.register('Deleted', 'deleted-after-registration')).status, 303)
    assert.deepEqual((await deletedAdmin.callTool({ name: 'list_side_chats' })).structuredContent, {
      active: 'Deleted', chats: [{ name: 'Deleted', sessionId: 'deleted-after-registration' }],
    })
    const queued = await deletedAdmin.callTool({
      name: 'send_test_notification', arguments: { requestId: crypto.randomUUID() },
    })
    const { id } = z.object({ state: z.literal('queued'), id: z.uuid() }).parse(queued.structuredContent)
    const timeout = Date.now() + 8_000
    let final
    do {
      const status = await deletedAdmin.callTool({ name: 'get_delivery_status', arguments: { id } })
      final = z.object({ state: z.string(), reason: z.string().optional() }).parse(status.structuredContent)
      if (final.state === 'suppressed') break
      await delay(25)
    } while (Date.now() < timeout)
    assert.equal(final.reason, 'side_chat_missing')
    const setup = await deletedAdmin.callTool({ name: 'get_setup_status' })
    assert.deepEqual(setup.structuredContent, { deviceConfigured: true, credentialStorageReady: true, active: null, ready: false })
    assert.equal(accountRequests.filter(path => path === '/device_token/refresh').length, 2)
    assert.equal(accountRequests.filter(path => path === '/fetch_vms').length, 13)

    await t.test('delivers both webhooks to the same side chat across a Worker restart', async (t) => {
      const storage = await mkdtemp(join(tmpdir(), 'museknock-restart-'))
      t.after(() => rm(storage, { recursive: true, force: true }))
      const receipts = new Set<string>()
      for (const [index, text] of ['Before restart', 'After restart'].entries()) {
        const instance = await startWorker(outbound, { MUSE_VM_ID: 'local-vm' }, storage)
        try {
          if (index === 0) {
            const client = await connect(new URL('/mcp', instance.url), 'MCP_ADMIN_TOKEN-test')
            try {
              const setup = await openSettings(instance.url, client)
              assert.equal((await setup.register('Notifications', 'same-chat')).status, 303)
              assert.deepEqual((await client.callTool({ name: 'list_side_chats' })).structuredContent, {
                active: 'Notifications',
                chats: [{ name: 'Notifications', sessionId: 'same-chat' }],
              })
            } finally {
              await client.close()
            }
          }
          receipts.add(await postAndWait(instance.url, 'restart-' + index, text))
        } finally {
          await instance.close()
        }
      }
      assert.equal(receipts.size, 2)
    })
    assert.equal((await exited)[0], 0)
  },
)
