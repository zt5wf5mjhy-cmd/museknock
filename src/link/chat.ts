import type { Outcome } from '../delivery.ts'
import { sideChatId } from '../muse-device.ts'
import { startNoise } from './noise.ts'
import {
  bodyEnvelope,
  cancelEnvelope,
  ControlMessages,
  controlMessage,
  fragments,
  requestEnvelope,
  ResponseFrames,
} from './wire.ts'

export type Vm = { noiseHost: string; vmId: string; vmToken: string }

const controlStream = 1
const lookupStream = 2
const postStream = 3

function readPackets(socket: WebSocket, signal: AbortSignal) {
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>(
    {
      start(controller) {
        let stopped = false
        function stop() {
          if (stopped) return
          stopped = true
          controller.error(new Error('Muse Link connection ended'))
        }
        socket.addEventListener('message', ({ data }) => {
          if (stopped) return
          if (
            !(data instanceof ArrayBuffer) ||
            data.byteLength < 16 ||
            data.byteLength > 65_535 ||
            (controller.desiredSize ?? 0) <= 0
          ) {
            stop()
            return
          }
          controller.enqueue(new Uint8Array(data))
        })
        socket.addEventListener('close', () => {
          if (stopped) return
          stopped = true
          controller.close()
        })
        socket.addEventListener('error', stop)
        signal.addEventListener('abort', stop, { once: true })
        if (signal.aborted) stop()
      },
    },
    { highWaterMark: 32 },
  )
  const reader = stream.getReader()
  return async () => {
    const { value, done } = await reader.read()
    if (done) throw new Error('Muse Link connection closed')
    return value
  }
}

async function openChannel(socket: WebSocket, signal: AbortSignal) {
  socket.binaryType = 'arraybuffer'
  const receive = readPackets(socket, signal)
  function send(data: Uint8Array<ArrayBuffer>) {
    signal.throwIfAborted()
    if (socket.readyState !== WebSocket.OPEN) throw new Error('Muse Link connection closed')
    socket.send(data)
  }
  const handshake = await startNoise()
  send(handshake.message1)
  const keys = await handshake.finish(await receive())
  send(keys.message3)
  const frames = new ResponseFrames()
  return {
    async write(envelope: Uint8Array) {
      for (const part of fragments(envelope)) {
        send(await keys.encrypt(part))
      }
    },
    async read() {
      while (true) {
        const frame = frames.push(await keys.decrypt(await receive()))
        if (frame) return frame
      }
    },
  }
}

function subscribeRequest(stream: number, sessionId: string) {
  return requestEnvelope(
    stream,
    '/chat/subscribe',
    [
      ['Content-Type', 'application/json'],
      ['Accept', 'application/x-ndjson'],
      ['x-request-id', crypto.randomUUID()],
      ['x-app-id', 'musegadget'],
    ],
    new TextEncoder().encode(JSON.stringify({ session_id: sessionId })),
  )
}

function chatExists(status: number | undefined) {
  if (status === 404) return false
  if (status !== undefined && status >= 200 && status < 300) return true
  throw new Error('Side chat lookup failed')
}

export async function sendOverLink(
  socket: WebSocket,
  nodeId: string,
  sessionId: string,
  message: string,
  signal: AbortSignal,
): Promise<Outcome> {
  let failure: Outcome = 'not_sent'
  try {
    const { write, read } = await openChannel(socket, signal)
    const registration = crypto.randomUUID()
    await write(requestEnvelope(controlStream, '/link-control', []))
    await write(
      bodyEnvelope(
        controlStream,
        controlMessage({
          type: 'req',
          id: registration,
          method: 'link.register',
          params: {
            node_id: nodeId,
            display_name: 'MuseKnock',
            platform: 'linux',
            version: '0.1.0',
            device_family: 'gadget',
            model_id: 'museknock',
            metadata: { model_name: 'MuseKnock' },
            is_wakeup_supported: false,
            commands_v2: {},
          },
        }),
      ),
    )

    const messages = new ControlMessages()
    let awaitingStream = controlStream
    let chatStatus: number | undefined
    let chatBytes = 0
    let acknowledgement = ''
    const decoder = new TextDecoder('utf-8', { fatal: true })
    while (true) {
      const frame = await read()
      if (frame.stream !== controlStream && frame.stream !== awaitingStream) continue
      if (frame.reset) throw new Error('Muse reset an active Link stream')
      if (frame.stream === controlStream) {
        if (
          frame.ended ||
          (frame.status !== undefined && (frame.status < 200 || frame.status >= 300))
        ) {
          throw new Error('Muse closed the control stream')
        }
        for (const reply of messages.push(frame.body)) {
          if (reply.event === 'link.unpaired' || reply.event === 'node.unpaired')
            throw new Error('Device unpaired')
          if (awaitingStream !== controlStream || reply.id !== registration || reply.method !== undefined) continue
          if (reply.error || reply.ok === false)
            throw new Error('Muse rejected gadget registration')
          awaitingStream = lookupStream
          await write(subscribeRequest(lookupStream, sessionId))
        }
      } else if (frame.stream === lookupStream) {
        if (!chatExists(frame.status)) return 'side_chat_missing'
        if (!frame.ended) await write(cancelEnvelope(lookupStream))
        awaitingStream = postStream
        const headers: [string, string][] = [
          ['Content-Type', 'application/json'],
          ['x-request-id', crypto.randomUUID()],
          ['x-app-id', 'musegadget'],
        ]
        const body = new TextEncoder().encode(
          JSON.stringify({
            message,
            output_modality: 'text',
            device_id: nodeId,
            session_id: sessionId,
          }),
        )
        if (body.length <= 64 * 1024) {
          await write(requestEnvelope(postStream, '/chat/stream', headers, body))
        } else {
          await write(requestEnvelope(postStream, '/chat/stream', headers))
          for (let start = 0; start < body.length; start += 16 * 1024) {
            const end = Math.min(start + 16 * 1024, body.length)
            await write(bodyEnvelope(postStream, body.subarray(start, end), end === body.length))
          }
        }
        // The socket now has the complete request. Retrying after a lost acknowledgement could post twice.
        failure = 'unknown'
      } else {
        if (frame.status !== undefined) {
          if (chatStatus !== undefined || frame.status < 100 || frame.status > 599)
            throw new Error('Invalid Muse response status')
          if (frame.status === 429) return 'not_sent'
          chatStatus = frame.status
        }
        chatBytes += frame.body.length
        if (chatStatus === undefined || chatBytes > 1024 * 1024)
          throw new Error('Invalid Muse response body')
        acknowledgement += decoder.decode(frame.body, { stream: !frame.ended })
        if (frame.ended) {
          if (chatStatus < 200 || chatStatus >= 300) return 'unknown'
          const reply: unknown = JSON.parse(acknowledgement)
          return reply !== null && typeof reply === 'object' && !Array.isArray(reply)
            ? 'sent'
            : 'unknown'
        }
      }
    }
  } catch {
    return failure
  }
}

async function withLink<T>(
  vm: Vm,
  timeout: number,
  run: (socket: WebSocket, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  let socket: (WebSocket & { accept(): void }) | undefined
  try {
    const url = new URL('https://' + vm.noiseHost + '/v1/noise')
    url.searchParams.set('vm_id', vm.vmId)
    const response = await fetch(url, {
      headers: { Upgrade: 'websocket', Authorization: 'Bearer ' + vm.vmToken },
      redirect: 'manual',
      signal: controller.signal,
    })
    socket = (response as Response & { webSocket?: typeof socket }).webSocket
    if (response.status !== 101 || !socket) {
      await response.body?.cancel()
      throw new Error('Muse Link upgrade failed')
    }
    socket.accept()
    return await run(socket, controller.signal)
  } finally {
    clearTimeout(timer)
    controller.abort()
    try {
      if (socket && socket.readyState < 2) socket.close(1000)
    } catch {
      // The peer may have closed while this Worker was finishing the receipt.
    }
  }
}

export async function sendSideChat(
  vm: Vm,
  nodeId: string,
  sessionId: string,
  message: string,
): Promise<Outcome> {
  if (!nodeId || !sideChatId.test(sessionId)) return 'not_sent'
  try {
    return await withLink(vm, 75_000, (socket, signal) =>
      sendOverLink(socket, nodeId, sessionId, message, signal),
    )
  } catch {
    return 'not_sent'
  }
}

export function sideChatExists(vm: Vm, sessionId: string): Promise<boolean> {
  return withLink(vm, 15_000, async (socket, signal) => {
    const { write, read } = await openChannel(socket, signal)
    await write(subscribeRequest(1, sessionId))
    const frame = await read()
    if (frame.stream !== 1 || frame.reset) throw new Error('Invalid side chat lookup response')
    return chatExists(frame.status)
  })
}
