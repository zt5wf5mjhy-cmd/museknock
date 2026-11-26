# /// script
# requires-python = ">=3.13,<3.14"
# dependencies = [
#   "pyobjc-framework-CoreBluetooth==13.0",
#   "musegadget @ https://github.com/facebookincubator/muse-gadget-sdk/archive/e17081a45941415d483642dbe21c2a2e6ef85a13.tar.gz#subdirectory=linux&sha256=dcb48c9771a895f5a1f2d18e2d67795461a78138c897e5bddf112f4f9d212ad5",
# ]
# ///
"""One-shot macOS radio transport for the upstream Muse pairing controller."""
import json
import logging
import queue
import re
import secrets
import sys
import threading
import time

import CoreBluetooth as CB
import objc
from Foundation import NSDate, NSObject, NSRunLoop
from musegadget.ble_framing import ChunkAssembler
from musegadget.ble_setup import ProvisionFailed, SetupController
from musegadget.identity import Identity
from musegadget.network import is_online
from musegadget.pairing import PairingSession

SERVICE = "7fdd3d1c-38ea-46cf-8b46-314ecf5f240c"
RX = "4d593029-28a2-4a6e-a1f0-3c2d5e8f9b01"
TX = "d75dc4ca-7b2b-4e9c-8f0a-1d2e3f4a5b6c"
VERIFY = "85e19772-32cc-4ee7-a3a0-d42253ca20ec"


def emit(**fields):
    print(json.dumps(fields), flush=True)


class Network:
    def is_online(self):
        return is_online()

    def current_connection_entry(self):
        emit(progress="network")
        return {"ssid": "Use current connection", "rssi": -40, "secure": False}


class Radio(NSObject, protocols=[objc.protocolNamed("CBPeripheralManagerDelegate")]):
    @objc.python_method
    def configure(self, node, sdk):
        suffix = re.fullmatch(r"homelink-([a-f0-9]{6})", node)
        if not suffix:
            raise ValueError("Unsupported Worker node ID")
        identity = Identity("02:00:00:" + bytes.fromhex(suffix[1]).hex(":"))
        if identity.setup_node_id != node:
            raise ValueError("Worker identity mismatch")
        self.name = identity.ble_name
        self.central = None
        self.owner_id = None
        self.provisioning = threading.Event()
        self.stopped = None
        self.completed = threading.Event()
        self.proof = secrets.token_bytes(8)
        self.outbox = queue.Queue(maxsize=512)
        self.pending = None
        self.discovery = ChunkAssembler()
        self.packet_length = 20
        self.last_notification = b""
        self.controller = SetupController(
            pairing=PairingSession(node_id=node, device_id=identity.device_id,
                                   mac=identity.mac, firmware_version="1.0.0", sdk_token=sdk),
            identity=identity, version="1.0.0", transport=self, network=Network(),
            provision=self.provision, on_complete=self.completed.set,
        )

    @objc.python_method
    def provision(self, credentials, commit):
        def begin_upload():
            if self.central is None or self.stopped is not None:
                return False
            self.provisioning.set()
            return True

        if not commit(begin_upload):
            raise ProvisionFailed("error_pairing_decrypt")
        emit(refreshToken=credentials.refresh_token)
        if sys.stdin.readline().strip() != "saved":
            raise ProvisionFailed("error_auth_failed")

    @objc.python_method
    def send_packets(self, packets):
        for packet in packets:
            self.outbox.put(packet, timeout=2)

    @objc.python_method
    def mtu(self):
        return self.packet_length + 3

    @objc.python_method
    def disconnect(self, delay):
        self.stopped = "The phone disconnected or Muse rejected the encrypted pairing."

    def peripheralManagerDidUpdateState_(self, manager):
        state = manager.state()
        if state in (CB.CBManagerStateUnknown, CB.CBManagerStateResetting):
            return
        if state != CB.CBManagerStatePoweredOn:
            self.stopped = "Enable Bluetooth and allow Bluetooth access for your terminal in macOS System Settings."
            return
        uuid = CB.CBUUID.UUIDWithString_
        service = CB.CBMutableService.alloc().initWithType_primary_(uuid(SERVICE), True)
        self.rx = CB.CBMutableCharacteristic.alloc().initWithType_properties_value_permissions_(
            uuid(RX), CB.CBCharacteristicPropertyWrite | CB.CBCharacteristicPropertyWriteWithoutResponse,
            None, CB.CBAttributePermissionsWriteEncryptionRequired)
        self.tx = CB.CBMutableCharacteristic.alloc().initWithType_properties_value_permissions_(
            uuid(TX), CB.CBCharacteristicPropertyRead | CB.CBCharacteristicPropertyNotifyEncryptionRequired,
            None, CB.CBAttributePermissionsReadEncryptionRequired)
        self.verify_char = CB.CBMutableCharacteristic.alloc().initWithType_properties_value_permissions_(
            uuid(VERIFY), CB.CBCharacteristicPropertyWrite, None, CB.CBAttributePermissionsWriteEncryptionRequired)
        description = CB.CBMutableDescriptor.alloc().initWithType_value_(
            uuid(CB.CBUUIDCharacteristicUserDescriptionString), "MuseKnock verification")
        self.verify_char.setDescriptors_([description])
        service.setCharacteristics_([self.rx, self.tx, self.verify_char])
        manager.addService_(service)

    def peripheralManager_didAddService_error_(self, manager, service, error):
        if error:
            self.stopped = "macOS could not publish the Bluetooth service."
            return
        # The 128-bit service is discoverable after connection. Including it in
        # the advertisement can crowd out the name that Muse scans for.
        manager.startAdvertising_({CB.CBAdvertisementDataLocalNameKey: self.name})

    def peripheralManagerDidStartAdvertising_error_(self, manager, error):
        if error:
            self.stopped = "macOS could not advertise the pairing service."
        elif self.owner_id is None:
            emit(advertising=self.name, proof=self.proof.hex(), service=SERVICE, characteristic=VERIFY)

    def peripheralManager_central_didSubscribeToCharacteristic_(self, manager, central, characteristic):
        if self.stopped or characteristic.UUID() != self.tx.UUID():
            return
        peer_id = central.identifier()
        if self.owner_id != peer_id:
            return
        self.central = central
        self.packet_length = central.maximumUpdateValueLength()
        emit(progress="subscribed")

    def peripheralManager_central_didUnsubscribeFromCharacteristic_(self, manager, central, characteristic):
        if self.central is not None and self.central.identifier() == central.identifier():
            self.controller.on_disconnect()
            self.central = None
            self.discovery.reset()
            self.pending = None
            self.last_notification = b""
            while not self.outbox.empty():
                self.outbox.get_nowait()
            if self.provisioning.is_set():
                self.stopped = "The phone disconnected during credential verification."
            else:
                emit(progress="reconnect")
                if not manager.isAdvertising():
                    manager.startAdvertising_({CB.CBAdvertisementDataLocalNameKey: self.name})

    def peripheralManager_didReceiveReadRequest_(self, manager, req):
        if req.characteristic().UUID() != self.tx.UUID() or (
                self.central is None or req.central().identifier() != self.central.identifier()):
            result = CB.CBATTErrorReadNotPermitted
        elif req.offset() > len(self.last_notification):
            result = CB.CBATTErrorInvalidOffset
        else:
            req.setValue_(self.last_notification[req.offset():])
            result = CB.CBATTErrorSuccess
        manager.respondToRequest_withResult_(req, result)

    def peripheralManager_didReceiveWriteRequests_(self, manager, requests):
        first = requests[0]
        if first.characteristic().UUID() == self.verify_char.UUID():
            value = bytes(first.value() or b"")
            if re.fullmatch(rb"[0-9a-fA-F]{16}", value):
                value = bytes.fromhex(value.decode("ascii"))
            authorized = (
                len(requests) == 1 and first.offset() == 0 and self.stopped is None
                and self.proof is not None and secrets.compare_digest(self.proof, value)
            )
            if authorized:
                self.owner_id = first.central().identifier()
                self.proof = None
                emit(verified=True)
            result = CB.CBATTErrorSuccess if authorized else CB.CBATTErrorInsufficientAuthorization
            manager.respondToRequest_withResult_(first, result)
            return
        for req in requests:
            if (self.central is None or req.central().identifier() != self.central.identifier() or
                    req.characteristic().UUID() != self.rx.UUID() or req.offset() != 0 or self.stopped):
                manager.respondToRequest_withResult_(requests[0], CB.CBATTErrorInsufficientAuthorization)
                return
        for req in requests:
            packet = bytes(req.value() or b"")
            self.inspect_discovery(packet)
        manager.respondToRequest_withResult_(requests[0], CB.CBATTErrorSuccess)

    @objc.python_method
    def inspect_discovery(self, packet):
        raw = self.discovery.feed(packet)
        if raw is None or len(raw) > 8192:
            return
        try:
            message = json.loads(raw)
        except (ValueError, RecursionError):
            return
        if not isinstance(message, dict):
            return
        action = message.get("action")
        if action in ("get_device_info", "wifi_scan", "pairing_client_hello"):
            emit(progress={"get_device_info": "identity", "wifi_scan": "scan", "pairing_client_hello": "handshake"}[action])
        self.controller.handle_message(raw)

    @objc.python_method
    def flush(self):
        while self.central and not self.stopped:
            if self.pending is None:
                try:
                    self.pending = self.outbox.get_nowait()
                except queue.Empty:
                    return
            if not self.manager.updateValue_forCharacteristic_onSubscribedCentrals_(
                    self.pending, self.tx, [self.central]):
                return
            self.last_notification = self.pending
            self.pending = None


def run():
    logging.disable(logging.CRITICAL)  # Only the fixed IPC messages may leave this process.
    config = json.loads(sys.stdin.readline())
    radio = Radio.alloc().init()
    radio.configure(config["nodeId"], config["sdkToken"])
    radio.manager = CB.CBPeripheralManager.alloc().initWithDelegate_queue_(radio, None)
    deadline = time.monotonic() + 600
    done_at = None
    try:
        while time.monotonic() < deadline:
            with objc.autorelease_pool():
                NSRunLoop.currentRunLoop().runUntilDate_(NSDate.dateWithTimeIntervalSinceNow_(0.025))
                radio.flush()
                if radio.completed.is_set() and not radio.pending and radio.outbox.empty():
                    done_at = done_at or time.monotonic()
                    if time.monotonic() - done_at > 0.75 or radio.stopped:
                        return
                if radio.stopped:
                    raise RuntimeError(radio.stopped)
        raise RuntimeError("The ten-minute Bluetooth pairing window expired.")
    finally:
        radio.manager.stopAdvertising()
        radio.manager.removeAllServices()


if __name__ == "__main__":
    try:
        run()
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
