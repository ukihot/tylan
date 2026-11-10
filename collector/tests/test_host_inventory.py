"""Windows gate: the fixed, read-only host inventory reports IPv6 ON/OFF/failure explicitly."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[1] / "collect-host.ps1"


def inventory(tmp_path, *extra):
    output = tmp_path / "inventory.json"
    subprocess.run(
        [
            shutil.which("powershell.exe"),
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(SCRIPT),
            "-Output",
            str(output),
            *extra,
        ],
        check=True,
        timeout=60,
        capture_output=True,
    )
    return json.loads(output.read_text(encoding="utf-8-sig"))


@pytest.mark.skipif(os.name != "nt", reason="Windows PowerShell inventory gate")
def test_ipv6_off_is_skipped_and_on_reads_local_configuration_only(tmp_path):
    off = inventory(tmp_path)
    assert off["ipv6"]["state"] == "skipped"
    assert all(a["family"] == "IPv4" for a in off["addresses"])
    on = inventory(tmp_path, "-IncludeIPv6")
    assert on["ipv6"]["state"] in ("completed", "failed")
    if on["ipv6"]["state"] == "failed":
        assert on["ipv6"]["reason"]
        assert all(a["family"] == "IPv4" for a in on["addresses"])
    assert any(a["family"] == "IPv4" for a in on["addresses"])


@pytest.mark.skipif(os.name != "nt", reason="Windows PowerShell inventory gate")
def test_route_targets_are_plain_strings(tmp_path):
    # Get-Content strings carry PSPath/PSDrive; serializing them hung ConvertTo-Json (2026-11-10).
    targets = tmp_path / "targets.txt"
    targets.write_text("\n".join(f"127.0.0.{n}" for n in range(1, 17)), encoding="utf-8")
    result = inventory(tmp_path, "-Targets", str(targets))
    assert [r["target"] for r in result["bestRoutes"]] == [f"127.0.0.{n}" for n in range(1, 17)]
