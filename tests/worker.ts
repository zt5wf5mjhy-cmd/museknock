import { AssertionError } from 'node:assert'
import { setTimeout as delay } from 'node:timers/promises'
import { build, type Plugin } from 'esbuild'
import { Miniflare, Response, convertV4MiniflareOptions, type V4ServiceDesignator } from 'miniflare'

export async function startWorker(
  outbound: V4ServiceDesignator = () => new Response(null, { status: 503 }),
  overrides: Record<string, string | undefined> = {},
  resourcePersistencePath?: string,
  plugins: Plugin[] = [],
) {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        export { default } from './src/index.ts'
        import { Inbox as ProductionInbox } from './src/inbox.ts'
        export class Inbox extends ProductionInbox {
          async fetch(request) {
            if (new URL(request.url).pathname === '/fail-credential-writes') {
              const put = this.credentials.put.bind(this.credentials)
              let failures = Number(await request.text())
              this.credentials.put = async (...args) => {
                if (failures-- > 0) throw new Error('Fixture credential write failed')
                return put(...args)
              }
              return new Response(null, { status: 204 })
            }
            if (new URL(request.url).pathname === '/alarm') return Response.json(await this.ctx.storage.getAlarm())
            if (request.method === 'GET') {
              return Response.json(this.ctx.storage.sql.exec('SELECT key, type, state, text FROM events ORDER BY rowid').toArray())
            }
            this.queue.registerSideChat('Notifications', 'same-chat', await request.text())
            return new Response(null, { status: 204 })
          }
        }
      `,
    },
    bundle: true,
    plugins,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker'],
    external: ['cloudflare:*', 'node:*'],
    write: false,
  })
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      script: bundle.outputFiles[0].text,
      modules: true,
      compatibilityDate: '2026-11-19',
      host: '127.0.0.1',
      port: 0,
      resourcePersistencePath,
      unsafeTriggerHandlers: true,
      cf: false,
      durableObjects: { INBOX: { className: 'Inbox', useSQLite: true } },
      outboundService: outbound,
      bindings: Object.fromEntries(Object.entries({
        CREDENTIAL_ENCRYPTION_KEY: '12'.repeat(32),
        HOOK_TOKEN: 'HOOK_TOKEN-test',
        MUSE_NODE_ID: 'test-123abc',
        MUSE_SDK_TOKEN: 'mgst_' + 'A'.repeat(43),
        MUSE_REFRESH_TOKEN: 'test-initial-refresh',
        MCP_ADMIN_TOKEN: 'MCP_ADMIN_TOKEN-test',
        MCP_TOKEN: 'MCP_TOKEN-test',
        ...overrides,
      }).filter((binding): binding is [string, string] => binding[1] !== undefined)),
    }),
  )
  try {
    const namespace = await runtime.getDurableObjectNamespace('INBOX')
    const stub = namespace.get(namespace.idFromName('personal'))
    return {
      url: await runtime.ready,
      close: () => runtime.dispose(),
      async storedEvents() {
        const result = await stub.fetch('http://fixture.test')
        if (!result.ok) throw new Error(await result.text())
        return await result.json() as { key: string; type: string; state: string; text: string }[]
      },
      async failCredentialWrites(count: number) {
        const result = await stub.fetch('http://fixture.test/fail-credential-writes', { method: 'POST', body: String(count) })
        if (!result.ok) throw new Error(await result.text())
      },
      async scheduledAlarm() {
        const result = await stub.fetch('http://fixture.test/alarm')
        return await result.json() as number | null
      },
      async setFixtureChat(vmId: string) {
        const result = await stub.fetch('http://fixture.test', { method: 'POST', body: vmId })
        if (!result.ok) throw new Error(await result.text())
      },
    }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

export async function startConfiguredWorker(...args: Parameters<typeof startWorker>) {
  const worker = await startWorker(...args)
  try {
    await worker.setFixtureChat('local-vm')
    return worker
  } catch (error) {
    await worker.close()
    throw error
  }
}

export async function waitForAssertion(check: () => void | Promise<void>) {
  const deadline = Date.now() + 5_000
  while (true) {
    try {
      return await check()
    } catch (error) {
      if (!(error instanceof AssertionError) || Date.now() >= deadline) throw error
      await delay(25)
    }
  }
}
