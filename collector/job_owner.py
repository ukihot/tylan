"""Job owner launched by the existing PowerShell bridge. No socket listener, no JSON save API."""

from __future__ import annotations

import argparse
import ctypes as C
import hashlib
import hmac
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from ctypes import wintypes as W
from datetime import datetime
from pathlib import Path

from .core import JST, digest
from .evidence import atomic_json, safe_child
from .exports import offline_collection
from .ipc import decode_request
from .jobs import TERMINAL, JobManager
from .runner import Collector, execution_plan, tool_paths, validate_profile
from .windows_process import WindowsRun


class Lease:
    """PowerShell's session lease. Once stopped or expired it is never revived."""

    def __init__(self, epoch, session, now, seconds=90):
        self.epoch, self.session, self.seconds = epoch, session, seconds
        self.deadline = now + seconds

    def refresh(self, value, now, wall):
        if self.expired(now) or not isinstance(value, dict):
            return
        if value.get("ownerEpoch") == self.epoch and value.get("sessionId") == self.session:
            age = wall - value.get("time", 0)
            if abs(age) < self.seconds:
                self.deadline = now + max(0, self.seconds - age)

    def stop(self):
        self.deadline = float("-inf")

    def expired(self, now):
        return now >= self.deadline


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", value):
        raise ValueError("invalid identity")
    return value


def evidence_task(task, ipc, request_id):
    folder = safe_child(ipc / "tasks", request_id)
    folder.mkdir(parents=True, exist_ok=True)
    request, result = folder / "request.json", folder / "result.json"
    atomic_json(request, task)
    with WindowsRun() as job:
        process = job.spawn(
            [
                sys.executable,
                "-m",
                "collector.evidence_worker",
                "--request",
                str(request),
                "--result",
                str(result),
            ],
            folder / "stdout",
            folder / "stderr",
        )
        deadline = time.monotonic() + 120
        while job.poll(process) is None:
            if time.monotonic() >= deadline:
                raise TimeoutError("evidence operation timed out; canonical JSON was not changed")
            time.sleep(0.05)
        if job.poll(process) != 0:
            raise ValueError(
                (folder / "stderr").read_text(encoding="utf-8", errors="replace")[-1000:]
            )
        if result.stat().st_size > 1024 * 1024:
            raise ValueError("evidence response too large")
        return json.loads(result.read_text(encoding="utf-8"))


def diagnose(ipc, request_id, include_ipv6=True):
    paths = tool_paths()
    if not paths["powershell"]:
        raise ValueError("Windows PowerShell unavailable")
    folder = safe_child(ipc / "tasks", request_id)
    folder.mkdir(parents=True, exist_ok=True)
    output = folder / "inventory.json"
    with WindowsRun() as job:
        arguments = [
            paths["powershell"],
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(Path(__file__).with_name("collect-host.ps1")),
            "-Output",
            str(output),
        ]
        if include_ipv6:
            arguments += ["-IncludeIPv6"]
        process = job.spawn(
            arguments,
            folder / "stdout",
            folder / "stderr",
        )
        deadline = time.monotonic() + 30
        while job.poll(process) is None:
            if time.monotonic() >= deadline:
                raise TimeoutError("local diagnostics timed out")
            time.sleep(0.05)
        if job.poll(process) != 0:
            raise ValueError(
                (folder / "stderr").read_text(encoding="utf-8", errors="replace")[-1000:]
            )
        if output.stat().st_size > 10 * 1024 * 1024:
            raise ValueError("diagnostics too large")
        return {"tools": paths, "inventory": json.loads(output.read_text(encoding="utf-8-sig"))}


def run(config):
    ipc = Path(config["ipcRoot"]).resolve()
    runs = Path(config["runsRoot"]).resolve()
    epoch, session = config["ownerEpoch"], config["sessionId"]
    secret = bytes.fromhex(config["secret"])
    if len(secret) != 32:
        raise ValueError("invalid IPC secret")
    kernel = C.WinDLL("kernel32", use_last_error=True)
    kernel.CreateMutexW.argtypes, kernel.CreateMutexW.restype = (
        [W.LPVOID, W.BOOL, W.LPCWSTR],
        W.HANDLE,
    )
    kernel.WaitForSingleObject.argtypes, kernel.WaitForSingleObject.restype = (
        [W.HANDLE, W.DWORD],
        W.DWORD,
    )
    kernel.CloseHandle.argtypes = [W.HANDLE]
    kernel.ReleaseMutex.argtypes = [W.HANDLE]
    mutex = kernel.CreateMutexW(
        None, False, "Local\\TYLAN_AUDIT_" + digest(os.environ.get("USERNAME", ""))[:32]
    )
    if not mutex or kernel.WaitForSingleObject(mutex, 0) not in (0, 0x80):
        atomic_json(ipc / "ready.json", {"ownerEpoch": epoch, "state": "busy"})
        if mutex:
            kernel.CloseHandle(mutex)
        return
    for name in ("requests", "responses", "prepared", "intents", "tasks"):
        (ipc / name).mkdir(parents=True, exist_ok=True)

    def collect(profile, cancelled, emit):
        # run id is bound by the manager's acceptance, never a path from a packet.
        active = next(
            run_id for run_id, state in manager.states.items() if state["state"] not in TERMINAL
        )
        if profile.get("mode") == "offline":
            # An operator-supplied export: parsed in-process, nothing is spawned or sent.
            emit("finalizing")
            when = datetime.now(JST).isoformat(timespec="seconds")
            return offline_collection(validate_profile(profile), active, when)
        if config.get("fixture"):
            fixture = Path(config["fixture"])
            if fixture.stat().st_size > 10 * 1024 * 1024:
                raise ValueError("fixture too large")
            wrapper = json.loads(fixture.read_text(encoding="utf-8"))
            data = wrapper.get("collection", wrapper)
            data.update(profile=profile, runId=active)
            return data
        data = Collector(safe_child(runs, active) / "transient")(profile, cancelled, emit)
        data["runId"] = active
        return data

    manager = JobManager(runs, epoch, collect)
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tylan-evidence")
    pending = {}
    atomic_json(
        ipc / "ready.json",
        {"ownerEpoch": epoch, "state": "ready", "pid": os.getpid(), "tools": tool_paths()},
    )
    lease = Lease(epoch, session, time.monotonic())
    try:
        while True:
            manager.tick()
            try:
                value = json.loads((ipc / "lease.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                value = None  # absent, or PowerShell is replacing it; retry next pass
            lease.refresh(value, time.monotonic(), time.time())
            for request_file in sorted((ipc / "requests").glob("*.json")):
                request_id = request_file.stem
                response_file = ipc / "responses" / request_file.name
                if response_file.exists() or request_id in pending:
                    continue
                try:
                    if lease.expired(time.monotonic()):
                        raise ValueError("session lease expired or owner stopping")
                    if request_file.stat().st_size > 2 * 1024 * 1024:
                        raise ValueError("request too large")
                    envelope = json.loads(request_file.read_text(encoding="utf-8"))
                    if identifier(request_id) != envelope["requestId"]:
                        raise ValueError("request filename mismatch")
                    payload = decode_request(envelope, epoch, session, secret, int(time.time()))
                    kind = envelope["kind"]
                    if kind == "StopOwner":
                        lease.stop()
                        for run_id, state in list(manager.states.items()):
                            if state["state"] not in TERMINAL:
                                manager.cancel(run_id)
                        atomic_json(response_file, {"accepted": True, "ownerEpoch": epoch})
                    elif kind == "StartRun":
                        state = manager.start(
                            identifier(payload["runId"]),
                            envelope["idempotencyKey"],
                            payload["profile"],
                        )
                        atomic_json(
                            response_file,
                            {"accepted": True, "runId": state["runId"], "ownerEpoch": epoch},
                        )
                    elif kind == "CancelRun":
                        state = manager.cancel(identifier(payload["runId"]))
                        atomic_json(
                            response_file,
                            {"accepted": True, "runId": state["runId"], "ownerEpoch": epoch},
                        )
                    elif kind in ("Diagnose", "Plan"):
                        wrapper = (
                            json.loads(Path(config["fixture"]).read_text(encoding="utf-8"))
                            if config.get("fixture")
                            else {}
                        )
                        # A fixture without diagnostics still runs the real, send-free host read.
                        if "diagnostics" in wrapper:
                            diagnostic = wrapper["diagnostics"]
                            if kind == "Plan":
                                diagnostic["executionPlan"] = execution_plan(
                                    payload["profile"], diagnostic["inventory"]
                                )
                            atomic_json(
                                response_file, {"accepted": True, **diagnostic, "ownerEpoch": epoch}
                            )
                        else:
                            features = payload.get("profile", {}).get("features", {})
                            include_ipv6 = features.get(
                                "ipv6Local", payload.get("includeIPv6", True)
                            )
                            pending[request_id] = (
                                pool.submit(diagnose, ipc, request_id, include_ipv6 is True),
                                envelope,
                                payload,
                                None,
                            )
                    elif kind == "SealEvidence":
                        run_id, site_id = (
                            identifier(payload["runId"]),
                            identifier(payload["siteId"]),
                        )
                        if manager.states.get(run_id, {}).get("state") not in TERMINAL:
                            raise ValueError("run not finalized")
                        task = {
                            "operation": "seal",
                            "source": str(safe_child(runs, run_id) / "package"),
                            "destination": str(
                                safe_child(Path(config["evidenceRoot"]), site_id + "/" + run_id)
                            ),
                        }
                        pending[request_id] = (
                            pool.submit(evidence_task, task, ipc, request_id),
                            envelope,
                            payload,
                            None,
                        )
                    elif kind in ("PrepareEvidence", "VerifyEvidence"):
                        import_id = identifier(payload["importId"])
                        prepared_path = safe_child(ipc / "prepared", import_id + ".json")
                        if kind == "PrepareEvidence":
                            run_id, site_id = (
                                identifier(payload["runId"]),
                                identifier(payload["siteId"]),
                            )
                            if manager.states.get(run_id, {}).get("state") not in TERMINAL:
                                raise ValueError("collection has not finalized")
                            intent_dir = safe_child(
                                ipc / "intents", import_id + "-" + digest(payload["intent"])
                            )
                            atomic_json(intent_dir / "intent.json", payload["intent"])
                            evidence_root = Path(config["evidenceRoot"]).resolve()
                            task = {
                                "operation": "prepare",
                                "source": str(safe_child(runs, run_id) / "package"),
                                "destination": str(
                                    safe_child(evidence_root, site_id + "/" + run_id)
                                ),
                                "intentSource": str(intent_dir),
                                "intentDestination": str(
                                    safe_child(evidence_root, site_id + "/imports/" + import_id)
                                ),
                            }
                        else:
                            prepared = json.loads(prepared_path.read_text(encoding="utf-8"))
                            if prepared["candidateHash"] != payload["candidateHash"]:
                                raise ValueError("prepared candidate differs")
                            task = {
                                "operation": "verify",
                                "package": prepared["package"],
                                "intent": prepared["intent"],
                            }
                        pending[request_id] = (
                            pool.submit(evidence_task, task, ipc, request_id),
                            envelope,
                            payload,
                            prepared_path,
                        )
                except Exception as exc:
                    atomic_json(
                        response_file,
                        {"accepted": False, "error": str(exc)[:2000], "ownerEpoch": epoch},
                    )
            for request_id, (future, envelope, payload, prepared_path) in list(pending.items()):
                if not future.done():
                    continue
                try:
                    result = future.result()
                    if envelope["kind"] in ("Diagnose", "Plan", "SealEvidence"):
                        if envelope["kind"] == "Plan":
                            result["executionPlan"] = execution_plan(
                                payload["profile"], result["inventory"]
                            )
                        response = {"accepted": True, **result, "ownerEpoch": epoch}
                    elif envelope["kind"] == "PrepareEvidence":
                        result["candidateHash"] = payload["candidateHash"]
                        atomic_json(prepared_path, result)
                        response = {"accepted": True, **result, "ownerEpoch": epoch}
                    else:
                        proof = {
                            "ownerEpoch": epoch,
                            "requestId": request_id,
                            "nonce": envelope["nonce"],
                            "importId": payload["importId"],
                            "candidateHash": payload["candidateHash"],
                            "packageHash": result["package"]["hash"],
                            "intentHash": result["intent"]["hash"],
                            "verifiedAt": int(time.time()),
                            "expiresAt": int(time.time()) + 5,
                        }
                        proof_json = json.dumps(
                            proof, sort_keys=True, separators=(",", ":"), ensure_ascii=False
                        )
                        response = {
                            "accepted": True,
                            "proofJson": proof_json,
                            "signature": hmac.new(
                                secret, proof_json.encode(), hashlib.sha256
                            ).hexdigest(),
                            "ownerEpoch": epoch,
                        }
                    atomic_json(ipc / "responses" / (request_id + ".json"), response)
                except Exception as exc:
                    atomic_json(
                        ipc / "responses" / (request_id + ".json"),
                        {"accepted": False, "error": str(exc)[:2000], "ownerEpoch": epoch},
                    )
                del pending[request_id]
            if (
                lease.expired(time.monotonic())
                and not pending
                and all(s["state"] in TERMINAL for s in manager.states.values())
            ):
                break
            time.sleep(0.05)
    finally:
        manager.close()
        pool.shutdown(wait=True, cancel_futures=True)
        atomic_json(ipc / "ready.json", {"ownerEpoch": epoch, "state": "stopped"})
        kernel.ReleaseMutex(mutex)
        kernel.CloseHandle(mutex)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config_path = Path(args.config)
    config = json.loads(config_path.read_text(encoding="utf-8-sig"))
    try:
        run(config)
    except Exception as exc:
        atomic_json(
            Path(config["ipcRoot"]) / "ready.json",
            {"ownerEpoch": config["ownerEpoch"], "state": "failed", "error": str(exc)[:2000]},
        )
        raise


if __name__ == "__main__":
    main()
