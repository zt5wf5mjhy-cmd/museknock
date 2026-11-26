import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Response } from 'miniflare'
import { startConfiguredWorker } from './worker.ts'
import { connect } from './mcp-client.ts'

test('a scheduled Discord channel poll baselines existing messages and queues new messages', async (t) => {
  const channel = '123456789012345678'
  const base = '1420000000000000001'
  const next = '1420000000000000002'
  const lastSeen: (string | null)[] = []
  const worker = await startConfiguredWorker(
    (req) => {
      const url = new URL(req.url)
      if (url.origin !== 'https://discord.com') return new Response(null, { status: 503 })
      assert.equal(req.headers.get('Authorization'), 'Bot local-token')
      const path = '/api/v10/channels/' + channel
      if (url.pathname === path) return Response.json({ id: channel, type: 0 })
      assert.equal(url.pathname, path + '/messages')
      const after = url.searchParams.get('after')
      lastSeen.push(after)
      return Response.json([
        {
          id: after ? next : base,
          channel_id: channel,
          type: 0,
          author: { id: '123456789012345679', username: 'test' },
          content: 'Release ready',
          attachments: [],
        },
      ])
    },
    { DISCORD_BOT_TOKEN: 'local-token', DISCORD_CHANNEL_ID: channel },
  )
  t.after(() => worker.close())
  const reader = await connect(new URL('/mcp', worker.url), 'MCP_TOKEN-test')
  t.after(() => reader.close())
  for (const sources of [[], [{ source: 'discord', paused: false, types: [] }]]) {
    const tick = await fetch(new URL('/cdn-cgi/local/scheduled?format=json', worker.url))
    assert.equal(tick.status, 200, await tick.text())
    assert.deepEqual((await reader.callTool({ name: 'list_sources' })).structuredContent, {
      sources,
    })
  }
  assert.deepEqual(lastSeen, [null, base])
})
