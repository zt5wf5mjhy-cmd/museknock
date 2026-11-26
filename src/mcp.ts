import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { sideChatId } from './muse-device.ts'
import type { Inbox } from './inbox.ts'

export type McpRole = 'read' | 'admin' | 'recovery'

type DeliveryControls = Pick<
  DurableObjectStub<Inbox>,
  | 'status'
  | 'breakerStatus'
  | 'rearmBreaker'
  | 'sources'
  | 'listSideChats'
  | 'getSetupStatus'
  | 'beginPairing'
  | 'createBrowserSetupLink'
  | 'createSettingsLink'
  | 'sendTestNotification'
>

const readOnly = { readOnlyHint: true, openWorldHint: false }
const changeRule = { readOnlyHint: false, idempotentHint: true, openWorldHint: false }

function result(data: object): CallToolResult {
  return { structuredContent: { ...data }, content: [{ type: 'text', text: JSON.stringify(data) }] }
}

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] }
}

export async function handleMcp(
  request: Request,
  inbox: DeliveryControls,
  role: McpRole,
): Promise<Response> {
  const origin = request.headers.get('Origin')
  if (origin !== null && origin !== new URL(request.url).origin) {
    return new Response('Forbidden origin', { status: 403 })
  }
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  }

  const server = new McpServer({ name: 'museknock', version: '0.1.0' })
  server.registerTool(
    'get_setup_status',
    {
      description:
        'Check local webhook readiness, including device credentials, encrypted storage, the active destination and circuit breaker configuration. Use get_delivery_breaker to inspect remaining delivery attempts. This check makes no request to Muse.',
      annotations: readOnly,
    },
    async () => result(await inbox.getSetupStatus()),
  )

  server.registerTool(
    'list_sources',
    {
      description:
        'List webhook sources, their pause settings, and allowed event types. An empty list of types allows all types.',
      annotations: readOnly,
    },
    async () => result({ sources: await inbox.sources() }),
  )

  server.registerTool(
    'list_side_chats',
    {
      description:
        'List side chats registered with this Worker, their session IDs and the active webhook destination.',
      annotations: readOnly,
    },
    async () => result(await inbox.listSideChats()),
  )

  server.registerTool(
    'get_delivery_status',
    {
      description:
        'Look up a webhook delivery by its receipt ID. Sent means Muse acknowledged the chat post.',
      inputSchema: { id: z.uuid() },
      annotations: readOnly,
    },
    async ({ id }) => {
      const delivery = await inbox.status(id.toLowerCase())
      if (!delivery) return failure('No delivery found for this receipt ID.')
      return result(delivery)
    },
  )

  server.registerTool(
    'get_delivery_breaker',
    {
      description: 'Read the global delivery budget and the attempts used by each source.',
      annotations: readOnly,
    },
    async () => result(await inbox.breakerStatus()),
  )

  if (role === 'recovery') {
    server.registerTool(
      'rearm_delivery_breaker',
      {
        description:
          'When a source or the global budget reaches its limit, fix the loop and wait for in-flight sends to finish. Use the current generation to reset all delivery budgets.',
        inputSchema: { expectedGeneration: z.number().int().positive() },
        annotations: changeRule,
      },
      async ({ expectedGeneration }) => {
        const outcome = await inbox.rearmBreaker(expectedGeneration)
        return { ...result(outcome), isError: !outcome.ok }
      },
    )
  }

  if (role === 'admin') {
    server.registerTool(
      'create_settings_link',
      {
        description: 'Issue a ten-minute, one-use link to manage side chats, source pauses and event filters in a browser. Show the link only to the account owner. The user must open the link and submit changes on the page; this tool does not change settings.',
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      async () => {
        const issued = await inbox.createSettingsLink()
        return result({
          url: new URL('/v1/setup/settings/' + issued.token, request.url).toString(),
          expiresAt: new Date(issued.expiresAt).toISOString(),
        })
      },
    )

    server.registerTool(
      'create_browser_setup_link',
      {
        description: 'Issue a one-use, ten-minute browser link to authorize this Worker as a Muse Gadget. Pass the session ID of the side chat where the user requested setup. Muse does not send the chat ID in MCP request metadata; include it as sessionId. Successful setup registers that chat and sends a completion notification there. If the ID is unknown, ask the user for the side chat URL. The Worker must have MUSE_SDK_TOKEN configured. A paired Worker must be reset before another link can be issued. Show the link only to the account owner.',
        inputSchema: { sessionId: z.string().regex(sideChatId).describe('Session ID of the requesting Muse side chat.') },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      async ({ sessionId }) => {
        const issued = await inbox.createBrowserSetupLink(sessionId)
        if (issued.state !== 'issued') return failure(
          issued.state === 'missing_sdk_token' ? 'Set MUSE_SDK_TOKEN in the Worker secrets.' :
          issued.state === 'configured' ? 'This Worker is already paired. Reset the setup before requesting another browser link.' :
          'Browser setup is unavailable. Check the Worker credential encryption key and pairing settings.',
        )
        return result({
          url: new URL('/v1/setup/browser/' + issued.token, request.url).toString(),
          expiresAt: new Date(issued.expiresAt).toISOString(),
          nodeId: issued.nodeId,
          sessionId,
        })
      },
    )

    server.registerTool(
      'begin_muse_pairing',
      {
        description: 'Get setup instructions or the existing pairing and its last verification result. Set replace only when the operator requests reauthorization. Takes no credentials.',
        inputSchema: { replace: z.boolean().optional() },
        annotations: readOnly,
      },
      async ({ replace }) => {
        const pairing = await inbox.beginPairing(replace)
        if (pairing.state === 'managed_by_secrets') return {
          ...failure('Correct the three Muse bootstrap secrets in Cloudflare, or remove all three together before replacing this stored pairing.'),
          structuredContent: { state: pairing.state },
        }
        if (pairing.state === 'unavailable') return failure('Check the Worker encryption key and Muse credential configuration.')
        if (pairing.state === 'configured') return result(pairing)
        return result({
          ...pairing,
          instructions: [
            'On a Bluetooth-enabled Mac with Node.js and uv, open the MuseKnock repository in Finder and double-click Pair MuseKnock.command.',
            pairing.replaces ? 'Select Replace existing pairing on the local page.' : 'Select Start pairing on the local page after entering the credentials.',
            'For the terminal alternative, install dependencies with npm ci first.',
            pairing.replaces ? 'Run npm run pair -- --replace.' : 'Run npm run pair.',
            'Enter the Worker URL, admin token and Gadget SDK token in the local pairing interface.',
            'On your phone, use a Bluetooth LE tool to write the one-time code shown on the Mac.',
            'When the Mac confirms the phone, disconnect the tool and select the printed gadget name in the Muse app on that phone.',
            'Then ask Muse for a settings link and register your existing side chat in the browser.',
          ].join(' '),
        })
      },
    )

    server.registerTool(
      'send_test_notification',
      {
        description:
          'When the user asks for a test, queue a fixed test notification to the active side chat. Use get_delivery_status with the returned receipt ID to check delivery.',
        inputSchema: {
          requestId: z
            .uuid()
            .describe('Generate a UUID for each new test and reuse it when retrying that test.'),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ requestId }) => {
        const receipt = await inbox.sendTestNotification(requestId)
        if ('invalidBreaker' in receipt) return failure('Correct CIRCUIT_BREAKER and retry with the same request ID.')
        if ('credentialStorageUnavailable' in receipt)
          return failure('Check CREDENTIAL_ENCRYPTION_KEY and saved credentials in the Worker deployment.')
        if ('missingDevice' in receipt)
          return failure('Configure valid Muse device credentials in the Worker secrets first.')
        if ('noDestination' in receipt)
          return failure('Register a destination side chat on the settings page first, using an existing side chat ID.')
        if ('limited' in receipt)
          return failure(
            'Test notification rate limit reached. Retry in 60 seconds with the same request ID.',
          )
        return result(receipt)
      },
    )

  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    maxRequestBodySize: 32 * 1024,
  })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    await server.close()
  }
}
