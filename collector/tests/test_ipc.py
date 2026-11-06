import hashlib
import json

import pytest

from collector.ipc import decode_request, envelope_signature


def envelope(**changes):
    payload = json.dumps({"runId": "run1"})
    value = {
        "protocolVersion": 1,
        "ownerEpoch": "epoch",
        "sessionId": "session",
        "requestId": "request1",
        "idempotencyKey": "key",
        "kind": "CancelRun",
        "payloadJson": payload,
        "payloadHash": hashlib.sha256(payload.encode()).hexdigest(),
        "nonce": "nonce",
        "issuedAt": 100,
        "expiresAt": 200,
        **changes,
    }
    value["signature"] = envelope_signature(value, b"secret")
    return value


def test_ipc_rejects_old_epoch_expired_unknown_and_changed_body():
    assert decode_request(envelope(), "epoch", "session", b"secret", 150)["runId"] == "run1"
    for bad in (
        envelope(ownerEpoch="old"),
        envelope(expiresAt=149),
        envelope(kind="SaveCanonical"),
        envelope(payloadJson="{}"),
    ):
        with pytest.raises(ValueError):
            decode_request(bad, "epoch", "session", b"secret", 150)
    tampered = envelope()
    tampered["payloadHash"] = "0" * 64
    with pytest.raises(ValueError):
        decode_request(tampered, "epoch", "session", b"secret", 150)
