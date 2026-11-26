import { Buffer } from 'node:buffer'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { identifier } from '../identifiers.ts'
import { parseJson, verifyHmac, type ProviderDelivery } from '../provider.ts'
import type { WorkerEnv } from '../webhook.ts'

const repositoryEvent = z.object({
  repository: z.object({ full_name: z.string().min(1) }),
  sender: z.object({ login: z.string() }).nullish(),
})
const action = repositoryEvent.extend({ action: z.string().min(1) })
const item = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string(),
})
const summaries = new Map<string, z.ZodType>(
  Object.entries({
    push: repositoryEvent.extend({
      ref: z.string(),
      before: z.string(),
      after: z.string(),
      compare: z.string().optional(),
    }),
    issues: action.extend({ issue: item }),
    pull_request: action.extend({ pull_request: item.extend({ merged: z.boolean().optional() }) }),
    release: action.extend({
      release: z.object({ tag_name: z.string(), name: z.string().nullish(), html_url: z.string() }),
    }),
    workflow_run: action.extend({
      workflow_run: z.object({
        name: z.string().nullish(),
        status: z.string(),
        conclusion: z.string().nullable(),
        html_url: z.string(),
      }),
    }),
  }),
)
const ping = z.object({ zen: z.string() })

export async function github(
  request: Request,
  env: WorkerEnv['Bindings'],
): Promise<ProviderDelivery> {
  const secret = env.GITHUB_WEBHOOK_SECRET
  if (!secret) throw new HTTPException(503, { message: 'Configure GITHUB_WEBHOOK_SECRET first' })
  const signature = /^sha256=([a-f0-9]{64})$/.exec(request.headers.get('X-Hub-Signature-256') ?? '')
  if (!signature) throw new HTTPException(401, { message: 'Missing or invalid GitHub signature' })
  const body = await request.arrayBuffer()
  if (!(await verifyHmac('SHA-256', secret, body, Buffer.from(signature[1], 'hex')))) {
    throw new HTTPException(401, { message: 'Invalid GitHub signature' })
  }

  const type = request.headers.get('X-GitHub-Event') ?? ''
  if (!identifier.test(type)) throw new HTTPException(400, { message: 'Invalid GitHub event type' })
  const payload = parseJson(body)
  const response = new Response(null)
  if (type === 'ping') {
    if (!ping.safeParse(payload).success)
      throw new HTTPException(400, { message: 'Invalid GitHub ping' })
    return { response }
  }
  const schema = summaries.get(type)
  if (!schema) return { response }
  const summary = schema.safeParse(payload)
  if (!summary.success) throw new HTTPException(400, { message: 'Invalid GitHub event payload' })
  // GitHub signs only the body. Changing a delivery ID on a replay must not create another event.
  const key = Buffer.from(await crypto.subtle.digest('SHA-256', body)).toString('hex')
  return { events: [{ key, type, text: JSON.stringify(summary.data) }], response }
}
