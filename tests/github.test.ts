import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { startConfiguredWorker, startWorker } from './worker.ts'

const secret = 'github-webhook-test-secret'
const repository = { full_name: 'example/project' }
const issue = { number: 1, title: '桜', html_url: 'https://github.com/example/project/issues/1' }

function post(origin: URL, event: string, body: string, signed = body) {
  return fetch(new URL('/v1/hooks/github', origin), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': randomUUID(),
      'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', secret).update(signed).digest('hex'),
    },
    body,
  })
}

test('GitHub authenticates the exact payload before acknowledging a ping or parsing events', async (t) => {
  const worker = await startWorker(undefined, {
    GITHUB_WEBHOOK_SECRET: secret,
  })
  t.after(() => worker.close())
  const ping = JSON.stringify({ zen: 'Keep it logically awesome.', hook_id: 123, hook: {} })
  assert.equal((await post(worker.url, 'ping', ping)).status, 200)
  assert.equal((await post(worker.url, 'ping', ping, ping + ' ')).status, 401)
  assert.equal((await post(worker.url, 'issues', '{')).status, 400)
  assert.equal(
    (
      await fetch(new URL('/v1/hooks/github', worker.url), {
        method: 'POST',
        headers: { Authorization: 'Bearer HOOK_TOKEN-test' },
        body: ping,
      })
    ).status,
    401,
  )
  const issues = JSON.stringify({ repository, action: 'opened', issue })
  assert.equal((await post(worker.url, 'issues', issues)).status, 503)
  assert.equal((await post(worker.url, 'pull_request', issues)).status, 400)
  assert.equal(
    (await post(worker.url, 'star', JSON.stringify({ action: 'created', repository }))).status,
    200,
  )
})

test('GitHub queues supported repository events with bounded summaries and deduplicates signed bodies', async (t) => {
  const worker = await startConfiguredWorker(undefined, { GITHUB_WEBHOOK_SECRET: secret })
  t.after(() => worker.close())
  const details = 'private content '.repeat(4000)
  const events = [
    [
      'push',
      {
        repository,
        ref: 'refs/heads/main',
        before: 'a'.repeat(40),
        after: 'b'.repeat(40),
        commits: [{ message: details }],
      },
    ],
    ['issues', { repository, action: 'opened', issue: { ...issue, body: details } }],
    ['pull_request', { repository, action: 'opened', pull_request: { ...issue, body: details } }],
    [
      'release',
      {
        repository,
        action: 'published',
        release: {
          tag_name: 'v1',
          name: null,
          html_url: 'https://github.com/example/project/releases/tag/v1',
          body: details,
        },
      },
    ],
    [
      'workflow_run',
      {
        repository,
        action: 'completed',
        workflow_run: {
          name: 'Build',
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/example/project/actions/runs/1',
        },
      },
    ],
  ] as const
  for (const [event, payload] of events) {
    assert.equal((await post(worker.url, event, JSON.stringify(payload))).status, 200, event)
  }
  const nextIssue = (n: number) =>
    JSON.stringify({ repository, action: 'opened', issue: { ...issue, number: n } })
  for (let n = 2; n <= 6; n++)
    assert.equal((await post(worker.url, 'issues', nextIssue(n))).status, 200)
  assert.equal((await post(worker.url, 'issues', nextIssue(6))).status, 200)
  assert.equal((await post(worker.url, 'issues', nextIssue(7))).status, 429)
})

test('GitHub requires a configured webhook secret', async (t) => {
  const worker = await startConfiguredWorker()
  t.after(() => worker.close())
  assert.equal((await post(worker.url, 'ping', '{}')).status, 503)
})
