import assert from 'node:assert/strict'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

export async function openSettings(worker: URL, admin: Client) {
  const issued = await admin.callTool({ name: 'create_settings_link' })
  const url = new URL(String((issued.structuredContent as { url: string }).url))
  const opened = await fetch(url, {
    method: 'POST', redirect: 'manual',
    headers: { Origin: worker.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(),
  })
  assert.equal(opened.status, 303)
  const cookie = opened.headers.get('Set-Cookie')?.split(';')[0]
  assert.ok(cookie)
  const endpoint = new URL('/v1/setup/settings', worker)
  const post = (fields: Record<string, string>) => fetch(endpoint, {
    method: 'POST', redirect: 'manual',
    headers: { Origin: worker.origin, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  })
  return {
    post,
    register: (name: string, sessionId: string) => post({ action: 'register_chat', name, sessionId }),
    select: (name: string) => post({ action: 'select_chat', name }),
    pause: (source: string, paused: boolean) => post({ action: 'pause_source', source, paused: String(paused) }),
    filter: (source: string, types: string[]) => post({ action: 'filter_source', source, mode: types.length ? 'selected' : 'all', otherTypes: types.join(', ') }),
  }
}
