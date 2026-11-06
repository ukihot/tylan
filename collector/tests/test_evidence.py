import json
from pathlib import Path

import pytest

from collector.evidence import seal_package, verify_package


def test_evidence_is_sealed_verified_and_reused(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "observations.json").write_text('{"value":"日本語"}', encoding="utf-8")
    package = seal_package(source, tmp_path / "share")
    assert verify_package(Path(package["path"]), package["hash"]) == package
    assert seal_package(source, tmp_path / "share") == package
    (Path(package["path"]) / "observations.json").write_text("broken", encoding="utf-8")
    with pytest.raises(ValueError):
        verify_package(Path(package["path"]), package["hash"])
    with pytest.raises(ValueError):
        seal_package(source, tmp_path / "share")


def test_unsealed_and_traversing_manifest_cannot_be_verified(tmp_path):
    with pytest.raises((ValueError, FileNotFoundError)):
        verify_package(tmp_path, "0" * 64)
    (tmp_path / "manifest.json").write_text(
        json.dumps({"files": [{"path": "../outside", "size": 1, "sha256": "0" * 64}]})
    )
    (tmp_path / "SEALED.json").write_text("{}")
    with pytest.raises(ValueError):
        verify_package(tmp_path, "0" * 64)
