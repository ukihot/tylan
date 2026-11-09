"""One state writer; collection work reports events and cannot edit the canonical file."""

from __future__ import annotations

import json
import queue
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .core import digest
from .evidence import atomic_json

TERMINAL = {"completed", "partial", "failed", "cancelled", "interrupted"}


class JobManager:
    def __init__(self, root, epoch, collector):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.epoch, self.collector = epoch, collector
        self.states, self.keys, self.controls = {}, {}, {}
        self.events = queue.Queue()
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tylan-collection")
        self.futures = {}
        for file in self.root.glob("*/state.json"):
            try:
                state = json.loads(file.read_text(encoding="utf-8"))
                if file.parent.name != state["runId"] or not re.fullmatch(
                    r"[a-zA-Z0-9_-]{1,64}", state["runId"]
                ):
                    raise ValueError("invalid run identity")
                if state["state"] not in TERMINAL:
                    state.update(
                        state="interrupted", reason="previous job owner ended; never resumed"
                    )
                    atomic_json(file, state)
                self.states[state["runId"]] = state
                if state.get("key"):
                    self.keys[state["key"]] = state["runId"]
            except (ValueError, KeyError, OSError) as exc:
                # Corrupt state must block new active work, not silently disappear.
                self.pool.shutdown(wait=False, cancel_futures=True)
                raise ValueError(f"invalid persisted run: {file.name}") from exc

    def persist(self, state):
        state["sequence"] = state.get("sequence", 0) + 1
        atomic_json(self.root / state["runId"] / "state.json", state)

    def start(self, run_id, key, profile):
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", run_id) or not key or len(key) > 100:
            raise ValueError("invalid run/key")
        content_hash = digest(profile)
        known_id = self.keys.get(key)
        if known_id:
            known = self.states[known_id]
            if known["inputHash"] != content_hash:
                raise ValueError("idempotency key content conflict")
            return known
        if run_id in self.states:
            state = self.states[run_id]
            if state["state"] != "cancelled":
                raise ValueError("run identity conflict")
            state.update(key=key, inputHash=content_hash)
            self.keys[key] = run_id
            self.persist(state)
            return state
        if any(s["state"] not in TERMINAL for s in self.states.values()):
            raise ValueError("another run is active")
        state = {
            "runId": run_id,
            "ownerEpoch": self.epoch,
            "key": key,
            "inputHash": content_hash,
            "state": "queued",
            "stage": "validating",
            "stages": [],
            "progress": None,
            "sequence": 0,
            "reason": None,
        }
        self.persist(state)
        self.states[run_id], self.keys[key] = state, run_id
        cancel = self.controls[run_id] = threading.Event()
        self.futures[run_id] = self.pool.submit(self._work, run_id, profile, cancel)
        return state

    def _work(self, run_id, profile, cancel):
        def emit(stage, progress=None):
            # progress: {"done", "total"} for counted work or {"startedAt", "endsAt"} for a window.
            self.events.put((run_id, "stage", (stage, progress), time.time()))

        self.events.put((run_id, "running", None, time.time()))
        try:
            result = self.collector(profile, cancel, emit)
            self.events.put((run_id, "result", result, time.time()))
        except Exception as exc:
            self.events.put((run_id, "failed", str(exc)[:2000], time.time()))

    def cancel(self, run_id):
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", run_id):
            raise ValueError("invalid run id")
        state = self.states.get(run_id)
        if not state:
            state = {
                "runId": run_id,
                "ownerEpoch": self.epoch,
                "state": "cancelled",
                "stage": "notStarted",
                "sequence": 0,
                "reason": "cancelled before acceptance",
            }
            self.states[run_id] = state
        elif state["state"] not in TERMINAL:
            state["state"] = "cancelling"
            self.controls[run_id].set()
        self.persist(state)
        return state

    def tick(self):
        while not self.events.empty():
            run_id, event, value, when = self.events.get_nowait()
            state = self.states[run_id]
            if event == "running":
                state.setdefault("startedAt", when)
                if state["state"] != "cancelling":
                    state["state"] = "running"
            elif event == "stage":
                stage, progress = value
                state.update(stage=stage, progress=progress, stageStartedAt=when)
                if stage not in state.setdefault("stages", []):
                    state["stages"].append(stage)
            elif event == "result":
                encoded = json.dumps(value, ensure_ascii=False).encode()
                if len(encoded) > 10 * 1024 * 1024:
                    state.update(state="failed", reason="result exceeds 10MiB")
                else:
                    atomic_json(self.root / run_id / "package" / "result.json", value)
                    partial = any(c["state"] != "completed" for c in value.get("collectors", []))
                    state["state"] = (
                        "cancelled"
                        if self.controls[run_id].is_set()
                        else "partial"
                        if partial
                        else "completed"
                    )
                    state.update(stage="finalized", progress=None)
            elif event == "failed":
                state.update(
                    state="cancelled" if self.controls[run_id].is_set() else "failed", reason=value
                )
            try:
                self.persist(state)
            except OSError:
                for cancel in self.controls.values():
                    cancel.set()
                raise

    def close(self):
        for cancel in self.controls.values():
            cancel.set()
        self.pool.shutdown(wait=True, cancel_futures=True)
        self.tick()
