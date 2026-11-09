"""AUTO-11/16: a stopped or expired owner is never revived by a late lease file."""

import hashlib
import json
import os
import threading
import time

import pytest

from collector import job_owner
from collector.evidence import atomic_json
from collector.ipc import envelope_signature
from collector.job_owner import Lease, run

FRESH = {"ownerEpoch": "e", "sessionId": "s", "time": 1000}


def test_lease_is_never_revived_after_stop_or_expiry():
    lease = Lease("e", "s", 0)
    lease.refresh(FRESH, 10, 1000)
    assert not lease.expired(50)
    lease.stop()
    lease.refresh(FRESH, 11, 1000)
    assert lease.expired(12)
    late = Lease("e", "s", 0)
    late.refresh(FRESH, 91, 1091)
    assert late.expired(92)
    foreign = Lease("e", "s", 0)
    foreign.refresh({**FRESH, "sessionId": "other"}, 10, 1000)
    assert foreign.expired(90)


def send(ipc, secret, request_id, kind, payload):
    text = json.dumps(payload)
    now = int(time.time())
    request = {
        "protocolVersion": 1,
        "ownerEpoch": "epoch1",
        "sessionId": "epoch1",
        "requestId": request_id,
        "idempotencyKey": request_id,
        "kind": kind,
        "payloadJson": text,
        "payloadHash": hashlib.sha256(text.encode()).hexdigest(),
        "nonce": "n" + request_id,
        "issuedAt": now,
        "expiresAt": now + 60,
    }
    request["signature"] = envelope_signature(request, bytes.fromhex(secret))
    atomic_json(ipc / "requests" / f"{request_id}.json", request)


class SlowCollector:
    """Stands in for Nmap/TShark: runs until cancelled and then finalizes slowly."""

    def __init__(self, root):
        pass

    def __call__(self, profile, cancelled, emit):
        cancelled.wait(10)
        time.sleep(0.3)
        return {"observations": [], "collectors": [], "findings": []}


@pytest.mark.skipif(os.name != "nt", reason="named mutex owner is Windows-only")
def test_stop_owner_exits_even_while_powershell_keeps_renewing(tmp_path, monkeypatch):
    monkeypatch.setattr(job_owner, "Collector", SlowCollector)
    secret = "ab" * 32
    ipc = tmp_path / "ipc"
    config = {
        "ipcRoot": str(ipc),
        "runsRoot": str(tmp_path / "runs"),
        "ownerEpoch": "epoch1",
        "sessionId": "epoch1",
        "secret": secret,
        "evidenceRoot": str(tmp_path / "evidence"),
    }
    owner = threading.Thread(target=run, args=(config,), daemon=True)
    owner.start()
    for _ in range(200):
        if (ipc / "ready.json").exists():
            break
        time.sleep(0.02)
    send(ipc, secret, "start1", "StartRun", {"runId": "run1", "profile": {"mode": "passive"}})
    for _ in range(200):
        if (ipc / "responses" / "start1.json").exists():
            break
        time.sleep(0.02)
    send(ipc, secret, "stop1", "StopOwner", {})
    deadline = time.monotonic() + 5
    while owner.is_alive() and time.monotonic() < deadline:
        lease = {"ownerEpoch": "epoch1", "sessionId": "epoch1", "time": int(time.time())}
        try:
            atomic_json(ipc / "lease.json", lease)
        except PermissionError:
            pass  # the owner is reading it; PowerShell retries on its next loop too
        time.sleep(0.05)
    assert not owner.is_alive(), "owner re-extended its lease after StopOwner"
    state = json.loads((tmp_path / "runs" / "run1" / "state.json").read_text(encoding="utf-8"))
    assert state["state"] == "cancelled"
    assert json.loads((ipc / "ready.json").read_text(encoding="utf-8"))["state"] == "stopped"
