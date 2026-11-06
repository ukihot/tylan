import json
import time

import pytest

from collector.jobs import JobManager


def wait(manager, run_id, terminal=True):
    for _ in range(200):
        manager.tick()
        state = manager.states.get(run_id)
        if state and (
            not terminal or state["state"] in ("completed", "cancelled", "failed", "partial")
        ):
            return state
        time.sleep(0.005)
    raise AssertionError(manager.states)


def test_cancel_before_start_never_calls_executor(tmp_path):
    calls = []
    manager = JobManager(tmp_path, "epoch", lambda *args: calls.append(args))
    manager.cancel("run1")
    assert manager.start("run1", "key", {"mode": "passive"})["state"] == "cancelled"
    assert calls == []
    manager.close()


def test_duplicate_start_and_wrong_content(tmp_path):
    calls = []

    def collect(profile, cancelled, emit):
        calls.append(profile)
        return {"observations": [], "collectors": [], "findings": []}

    manager = JobManager(tmp_path, "epoch", collect)
    manager.start("run1", "key", {"mode": "passive"})
    assert manager.start("run1", "key", {"mode": "passive"})["runId"] == "run1"
    with pytest.raises(ValueError):
        manager.start("run1", "key", {"mode": "standard"})
    assert wait(manager, "run1")["state"] == "completed"
    assert len(calls) == 1
    manager.close()


def test_cancel_is_observed_and_old_running_recovers_as_interrupted(tmp_path):
    def collect(profile, cancelled, emit):
        while not cancelled.wait(0.005):
            pass
        return {"observations": [], "collectors": [], "findings": []}

    manager = JobManager(tmp_path, "epoch", collect)
    manager.start("run1", "key", {})
    manager.cancel("run1")
    assert wait(manager, "run1")["state"] == "cancelled"
    manager.close()
    state_file = tmp_path / "run1" / "state.json"
    state = json.loads(state_file.read_text(encoding="utf-8"))
    state["state"] = "running"
    state_file.write_text(json.dumps(state), encoding="utf-8")
    restored = JobManager(tmp_path, "newEpoch", lambda *args: pytest.fail("must not resume"))
    assert restored.states["run1"]["state"] == "interrupted"
    restored.close()


def test_worker_failure_does_not_look_completed(tmp_path):
    def collect(*args):
        raise ValueError("route changed")

    manager = JobManager(tmp_path, "epoch", collect)
    manager.start("run1", "key", {})
    state = wait(manager, "run1")
    assert state["state"] == "failed"
    assert "route changed" in state["reason"]
    manager.close()
