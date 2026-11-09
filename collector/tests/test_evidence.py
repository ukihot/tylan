import json
import os
from pathlib import Path

import pytest

from collector import evidence
from collector.evidence import restore_package, safe_child, seal_package, verify_package

if os.name == "nt":
    import _winapi


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


def source_with(tmp_path, files):
    source = tmp_path / "source"
    source.mkdir()
    for name, text in files.items():
        (source / name).write_text(text, encoding="utf-8")
    return source


@pytest.mark.skipif(os.name != "nt", reason="NTFS junctions are a Windows gate")
def test_junction_as_root_or_inside_root_is_rejected(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    junction_root = tmp_path / "evidence"
    _winapi.CreateJunction(str(outside), str(junction_root))
    with pytest.raises(ValueError, match="reparse"):
        safe_child(junction_root, "site/run")
    real = tmp_path / "real"
    real.mkdir()
    _winapi.CreateJunction(str(outside), str(real / "site"))
    with pytest.raises(ValueError, match="reparse"):
        safe_child(real, "site/run")


def test_failed_seal_is_never_verifiable_and_retry_converges(tmp_path, monkeypatch):
    source = source_with(tmp_path, {"a.json": "1", "b.json": "2"})
    real_replace = os.replace

    def fail_on_seal(src, dst):
        if str(dst).endswith("SEALED.json"):
            raise OSError("share disconnected")
        return real_replace(src, dst)

    monkeypatch.setattr(evidence.os, "replace", fail_on_seal)
    with pytest.raises(OSError):
        seal_package(source, tmp_path / "share")
    [unsealed] = list((tmp_path / "share").iterdir())
    with pytest.raises((ValueError, FileNotFoundError)):
        verify_package(unsealed, unsealed.name)
    monkeypatch.setattr(evidence.os, "replace", real_replace)
    package = seal_package(source, tmp_path / "share")
    assert package["hash"] == unsealed.name
    assert verify_package(Path(package["path"]), package["hash"]) == package


def test_interrupted_copy_leaves_no_partial_file(tmp_path, monkeypatch):
    source = source_with(tmp_path, {"a.json": "1", "b.json": "2"})
    real_replace = os.replace
    calls = []

    def fail_second_copy(src, dst):
        calls.append(dst)
        if len(calls) == 2:
            raise OSError("write failed")
        return real_replace(src, dst)

    monkeypatch.setattr(evidence.os, "replace", fail_second_copy)
    with pytest.raises(OSError):
        seal_package(source, tmp_path / "share")
    assert not list((tmp_path / "share").rglob("*.part"))


def test_lost_sealed_file_is_restored_only_from_identical_local_content(tmp_path):
    source = source_with(tmp_path, {"a.json": "1", "b.json": "2"})
    package = seal_package(source, tmp_path / "share")
    (Path(package["path"]) / "a.json").unlink()
    with pytest.raises((ValueError, FileNotFoundError)):
        verify_package(Path(package["path"]), package["hash"])
    assert seal_package(source, tmp_path / "share") == package
    (Path(package["path"]) / "a.json").unlink()
    (source / "a.json").write_text("changed locally", encoding="utf-8")
    with pytest.raises(ValueError):
        restore_package(source, Path(package["path"]), package["hash"])
    assert not (Path(package["path"]) / "a.json").exists()
