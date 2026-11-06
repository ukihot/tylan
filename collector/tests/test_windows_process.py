import os
import sys
import time

import pytest

from collector.windows_process import WindowsRun


@pytest.mark.skipif(os.name != "nt", reason="Windows Job Object integration gate")
def test_real_process_and_descendant_are_contained_without_network(tmp_path):
    with WindowsRun() as job:
        output, error = tmp_path / "stdout", tmp_path / "stderr"
        process = job.spawn(
            [
                sys.executable,
                "-c",
                "import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); print(p.pid,flush=True); time.sleep(60)",
            ],
            output,
            error,
        )
        for _ in range(200):
            if output.exists() and output.stat().st_size:
                break
            time.sleep(0.01)
        assert output.read_text().strip().isdigit(), error.read_text()
        assert job.active_count() >= 2
        job.stop()
        assert job.poll(process) is not None
        assert job.active_count() == 0
