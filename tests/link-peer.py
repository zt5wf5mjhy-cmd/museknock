"""Local interoperability peer. Run link-interop.test.ts with MUSE_SDK_TESTS and MUSE_PYTHON."""
import asyncio
import json
import os
import sys

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

sys.path.insert(0, os.environ["MUSE_SDK_TESTS"])
from test_link_client import FakeVm
from musegadget.noise.envelope import ApplicationResponse, BodyChunk, Reset, ResetCode, ServiceFrame


async def verify(socket, events, lookups):
    worker = socket.request.path.startswith("/v1/noise")
    other_vm = socket.request.path == "/v1/noise?vm_id=other-vm"
    if worker:
        assert other_vm or socket.request.path == "/v1/noise?vm_id=local-vm"
        token = "other-token" if other_vm else "local-vm-token"
        assert socket.request.headers["Authorization"] == "Bearer " + token
    vm = FakeVm(socket)
    await vm.handshake()
    control = await vm.next_frame()
    if control.value.path == "/chat/subscribe":
        assert worker and control.kind == "request" and control.value.verb == "POST"
        headers = {h.key.lower(): h.value for h in control.value.headers}
        assert headers["accept"] == "application/x-ndjson" and control.value.end_body
        payload = json.loads(control.value.body)
        assert set(payload) == {"session_id"}
        statuses = {"same-chat": 200, "missing-chat": 404, "other-chat": 200, "busy-chat": 503,
                    "deleted-after-registration": 200}
        session = payload["session_id"]
        if other_vm:
            assert session in {"busy-chat", "missing-chat"}
            status = 404
        else:
            lookups[session] = lookups.get(session, 0) + 1
            status = 404 if session == "other-chat" and lookups[session] == 3 else statuses[session]
        await vm.send_frame(ServiceFrame.response(control.stream_id, ApplicationResponse(status=status)))
        return
    assert not other_vm
    vm.stream_id = control.stream_id
    await vm.send_frame(ServiceFrame.response(control.stream_id, ApplicationResponse(status=200)))
    assert control.value.path == "/link-control"
    registration = await vm.next_message()
    assert registration["method"] == "link.register"
    assert registration["params"]["node_id"] == "test-123abc"
    assert registration["params"]["device_family"] == "gadget"
    assert registration["params"]["commands_v2"] == {}
    reject = socket.request.path == "/reject-registration"
    await vm.send_message({"type": "res", "id": registration["id"], "ok": not reject})
    if reject:
        return
    check = await vm.next_frame()
    assert check.kind == "request" and check.value.path == "/chat/subscribe"
    session = json.loads(check.value.body)["session_id"]
    status = 404 if session == "deleted-after-registration" or socket.request.path == "/deleted" else 200
    if socket.request.path == "/lookup-busy":
        status = 503
    if socket.request.path == "/lookup-reset":
        await vm.send_frame(ServiceFrame.reset(check.stream_id, Reset(code=ResetCode.TIMEOUT)))
        return
    ended_lookup = socket.request.path == "/empty-ack"
    await vm.send_frame(ServiceFrame.response(
        check.stream_id, ApplicationResponse(status=status, end_body=ended_lookup)
    ))
    if status != 200:
        try:
            await socket.recv()
        except ConnectionClosed:
            return
        raise AssertionError("received an outgoing frame after a failed side chat lookup")
    assert session == "same-chat"
    frame = await vm.next_frame()
    if not ended_lookup:
        assert frame.kind == "reset" and frame.stream_id == check.stream_id
        assert frame.value.code == ResetCode.CANCELLED
        frame = await vm.next_frame()
    assert (frame.kind, frame.value.verb, frame.value.path) == ("request", "POST", "/chat/stream")
    headers = {item.key.lower(): item.value for item in frame.value.headers}
    assert headers["x-app-id"] == "musegadget" and headers["content-type"] == "application/json"
    data = frame.value.body
    ended = frame.value.end_body
    while not ended:
        chunk = await vm.next_frame()
        assert chunk.kind == "body_chunk" and chunk.stream_id == frame.stream_id
        data += chunk.value.data
        ended = chunk.value.end_body
    payload = json.loads(data)
    assert socket.request.path != "/incomplete-post", "interrupted post arrived complete"
    message = payload.pop("message")
    if worker:
        _, event = message.split("\n", 1)
        notification = json.loads(event)
        assert notification.pop("id")
        assert notification == next(events)
    else:
        assert message == "event" * 15_000
    assert payload == {
        "session_id": "same-chat",
        "device_id": "test-123abc", "output_modality": "text",
    }
    if socket.request.path == "/lost-ack":
        return
    if socket.request.path in ("/post-rate-limited", "/post-unavailable"):
        status = 429 if socket.request.path == "/post-rate-limited" else 503
        await vm.send_frame(ServiceFrame.response(frame.stream_id, ApplicationResponse(status=status)))
        return
    if socket.request.path == "/post-reset":
        await vm.send_frame(ServiceFrame.response(frame.stream_id, ApplicationResponse(status=200, body=b"{}")))
        await vm.send_frame(ServiceFrame.reset(frame.stream_id, Reset(code=ResetCode.TIMEOUT)))
        return
    if socket.request.path == "/late-lookup-reset":
        await vm.send_frame(ServiceFrame.reset(check.stream_id, Reset(code=ResetCode.TIMEOUT)))
    body = {
        "/malformed-ack": b"not json",
        "/empty-ack": b"",
        "/array-ack": b"[]",
    }.get(socket.request.path, b'{"result":{"message_id":"local-id"}}')
    await vm.send_frame(ServiceFrame.response(frame.stream_id, ApplicationResponse(status=201, body=body[:8])))
    await vm.send_frame(ServiceFrame.body_chunk(frame.stream_id, BodyChunk(data=body[8:], end_body=True)))


async def main():
    finished = asyncio.Queue()
    lookups = {}
    events = iter([
        {
            "source": "custom", "type": "notification", "text": '{\n  "id": 9007199254740993\n}\n',
        },
        {"source": "museknock-test", "type": "test", "text": "MuseKnock test notification."},
        {"source": "telegram", "type": "edited_channel_post",
         "text": '{"message_id":3,"chat":{"id":-7},"caption":"Release ready"}'},
        {"source": "custom", "type": "notification", "text": "Before restart"},
        {"source": "custom", "type": "notification", "text": "After restart"},
    ])

    async def handle(socket):
        try:
            await asyncio.wait_for(verify(socket, events, lookups), 10)
            await finished.put(None)
        except ConnectionClosed as error:
            await finished.put(None if socket.request.path == "/incomplete-post" else error)
        except Exception as error:
            await finished.put(error)

    async with serve(handle, "127.0.0.1", 0, compression=None) as server:
        print(server.sockets[0].getsockname()[1], flush=True)
        for _ in range(31):
            error = await finished.get()
            if error:
                raise error


asyncio.run(main())
