"""macOS-only tests for the adapter between CoreBluetooth, the SDK and the Worker."""
import contextlib
import io
import json
import runpy
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

module = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/pair-mac.py"))
Radio, CB = module["Radio"], module["CB"]


def phone(name):
    return SimpleNamespace(identifier=lambda: name, maximumUpdateValueLength=lambda: 185)


class MacPairingTest(unittest.TestCase):
    def setUp(self):
        self.radio = Radio.alloc().init()
        self.radio.configure("homelink-000001", "fixture-sdk")
        self.radio.rx = SimpleNamespace(UUID=lambda: "rx")
        self.radio.tx = SimpleNamespace(UUID=lambda: "tx")
        self.radio.verify_char = SimpleNamespace(UUID=lambda: "verify")
        self.status = []
        self.manager = SimpleNamespace(isAdvertising=lambda: True, respondToRequest_withResult_=lambda _, s: self.status.append(s))
        self.phone = phone("selected phone")
        self.other = phone("other phone")

    def subscribe(self, central):
        self.radio.peripheralManager_central_didSubscribeToCharacteristic_(self.manager, central, self.radio.tx)

    def disconnect(self, central):
        self.radio.peripheralManager_central_didUnsubscribeFromCharacteristic_(self.manager, central, self.radio.tx)

    def test_advertisement_leaves_room_for_the_full_discovery_name(self):
        advertisements = []
        manager = SimpleNamespace(startAdvertising_=advertisements.append)
        self.radio.peripheralManager_didAddService_error_(manager, object(), None)
        self.assertEqual(advertisements, [{CB.CBAdvertisementDataLocalNameKey: self.radio.name}])

    def write(self, peer, characteristic, value):
        request = SimpleNamespace(central=lambda: peer, characteristic=lambda: characteristic,
                                  offset=lambda: 0, value=lambda: value)
        self.radio.peripheralManager_didReceiveWriteRequests_(self.manager, [request])
        return self.status[-1]

    def displayed_code(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.radio.peripheralManagerDidStartAdvertising_error_(self.manager, None)
        return json.loads(output.getvalue())["proof"]

    def test_unverified_subscriber_never_reserves_the_gadget(self):
        self.subscribe(self.other)
        self.assertIsNone(self.radio.central)
        self.assertEqual(self.write(self.other, self.radio.rx, b'{}'), CB.CBATTErrorInsufficientAuthorization)
        self.disconnect(self.other)
        self.assertEqual(self.write(self.phone, self.radio.verify_char, bytes.fromhex(self.displayed_code())),
                         CB.CBATTErrorSuccess)
        self.subscribe(self.phone)
        self.assertEqual(self.radio.central, self.phone)

    def test_wrong_verification_does_not_claim_the_gadget(self):
        self.assertEqual(self.write(self.other, self.radio.verify_char, b"invalid"), CB.CBATTErrorInsufficientAuthorization)
        self.assertIsNone(self.radio.owner_id)
        self.assertEqual(self.write(self.phone, self.radio.verify_char, self.displayed_code().upper().encode()),
                         CB.CBATTErrorSuccess)
        self.assertEqual(self.radio.owner_id, self.phone.identifier())

    def test_only_verified_phone_can_reconnect_and_send_protocol_messages(self):
        code = bytes.fromhex(self.displayed_code())
        self.assertEqual(self.write(self.phone, self.radio.verify_char, code), CB.CBATTErrorSuccess)
        self.assertEqual(self.write(self.other, self.radio.verify_char, code), CB.CBATTErrorInsufficientAuthorization)
        self.subscribe(self.other)
        self.assertIsNone(self.radio.central)
        self.subscribe(self.phone)
        self.disconnect(self.phone)
        self.subscribe(self.other)
        self.assertIsNone(self.radio.central)
        self.subscribe(self.phone)
        received = []
        self.radio.controller = SimpleNamespace(handle_message=received.append)
        self.assertEqual(self.write(self.other, self.radio.rx, b'{}'), CB.CBATTErrorInsufficientAuthorization)
        self.assertEqual(self.write(self.phone, self.radio.rx, b'{"action":"get_device_info"}'), CB.CBATTErrorSuccess)
        self.assertEqual(received, [b'{"action":"get_device_info"}'])

    def test_proof_characteristic_requires_an_encrypted_write_with_response(self):
        services = []
        self.radio.peripheralManagerDidUpdateState_(SimpleNamespace(state=lambda: CB.CBManagerStatePoweredOn,
                                                                    addService_=services.append))
        characteristic, = [item for item in services[0].characteristics()
                           if item.UUID().UUIDString().lower() == module["VERIFY"]]
        self.assertEqual(characteristic.properties(), CB.CBCharacteristicPropertyWrite)
        self.assertEqual(characteristic.permissions(), CB.CBAttributePermissionsWriteEncryptionRequired)
        self.assertEqual(characteristic.descriptors()[0].value(), "MuseKnock verification")

    def test_network_probe_observes_recovery(self):
        network = module["Network"]()
        with patch.dict(module["Network"].is_online.__globals__, is_online=iter([False, True]).__next__):
            self.assertFalse(network.is_online())
            self.assertTrue(network.is_online())

    def test_provision_releases_only_device_refresh_and_requires_worker_ack(self):
        creds = SimpleNamespace(refresh_token="fixture-refresh", access_token="fixture-access", username="fixture-user")
        self.write(self.phone, self.radio.verify_char, bytes.fromhex(self.displayed_code()))
        self.subscribe(self.phone)
        for reply in ("saved\n", ""):
            out = io.StringIO()
            with contextlib.redirect_stdout(out), patch.object(sys, "stdin", io.StringIO(reply)):
                if reply:
                    self.radio.provision(creds, lambda save: save())
                else:
                    with self.assertRaises(module["ProvisionFailed"]):
                        self.radio.provision(creds, lambda save: save())
            self.assertEqual(json.loads(out.getvalue()), {"refreshToken": "fixture-refresh"})

    def test_disconnected_session_never_releases_credentials(self):
        self.radio.stopped = "disconnected"
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertRaises(module["ProvisionFailed"]):
            self.radio.provision(SimpleNamespace(refresh_token="fixture-refresh"), lambda save: save())
        self.assertEqual(out.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
