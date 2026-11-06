"""Authenticated, bounded local-file messages; no HTTP or canonical-file protocol."""

import hashlib
import hmac
import json
import re

KINDS = {
    "StartRun",
    "CancelRun",
    "SealEvidence",
    "PrepareEvidence",
    "VerifyEvidence",
    "Diagnose",
    "Plan",
    "StopOwner",
}
SIGNED_FIELDS = (
    "protocolVersion",
    "ownerEpoch",
    "sessionId",
    "requestId",
    "kind",
    "payloadHash",
    "nonce",
    "issuedAt",
    "expiresAt",
    "idempotencyKey",
)


def envelope_signature(value, secret):
    message = "\n".join(str(value[k]) for k in SIGNED_FIELDS)
    return hmac.new(secret, message.encode("utf-8"), hashlib.sha256).hexdigest()


def decode_request(value, epoch, session, secret, now):
    required = set(SIGNED_FIELDS) | {"payloadJson", "signature"}
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError("invalid request fields")
    if (
        value["protocolVersion"] != 1
        or value["ownerEpoch"] != epoch
        or value["sessionId"] != session
        or value["kind"] not in KINDS
    ):
        raise ValueError("unsupported protocol/session/request")
    for key in ("requestId", "nonce", "idempotencyKey"):
        if not isinstance(value[key], str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", value[key]):
            raise ValueError("invalid request identity")
    if (
        type(value["issuedAt"]) is not int
        or type(value["expiresAt"]) is not int
        or not value["issuedAt"] - 5 <= now <= value["expiresAt"]
        or value["expiresAt"] - value["issuedAt"] > 300
    ):
        raise ValueError("expired request")
    payload = value["payloadJson"]
    if (
        not isinstance(payload, str)
        or len(payload.encode()) > 1024 * 1024
        or hashlib.sha256(payload.encode()).hexdigest() != value["payloadHash"]
    ):
        raise ValueError("invalid payload hash/size")
    if not hmac.compare_digest(envelope_signature(value, secret), value["signature"]):
        raise ValueError("invalid request authentication")
    decoded = json.loads(payload)
    if not isinstance(decoded, dict):
        raise ValueError("expected object payload")
    return decoded
