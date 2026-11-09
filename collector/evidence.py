"""Immutable evidence packages. Never writes the canonical network JSON."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import time
import uuid
from pathlib import Path

MAX_BYTES = 200 * 1024 * 1024


def sha_file(path):
    hasher = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    with temp.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        stream.flush()
        os.fsync(stream.fileno())
    for attempt in range(50):
        try:
            os.replace(temp, path)
            return
        except PermissionError:
            # Windows refuses to replace a file another process is reading at this instant.
            if attempt == 49:
                temp.unlink(missing_ok=True)
                raise
            time.sleep(0.02)


def is_reparse(path):
    """lstat, not stat: NTFS junctions are not symlinks to pathlib and stat() follows them."""
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return False
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def safe_child(root, relative):
    given = Path(root).absolute()
    rel = Path(relative)
    if rel.is_absolute() or not rel.parts or any(p in (".", "..") or ":" in p for p in rel.parts):
        raise ValueError("unsafe evidence path")
    if is_reparse(given):
        raise ValueError("reparse point prohibited at evidence root")
    root = given.resolve()
    candidate = root.joinpath(rel)
    for item in [candidate, *candidate.parents]:
        if item == root:
            break
        if is_reparse(item):
            raise ValueError("reparse point prohibited")
    if not candidate.resolve().is_relative_to(root):
        raise ValueError("evidence path escapes root")
    return candidate


def verify_package(path, expected_hash):
    path = Path(path)
    manifest_path = safe_child(path, "manifest.json")
    seal_path = safe_child(path, "SEALED.json")
    if manifest_path.stat().st_size > 1024 * 1024 or seal_path.stat().st_size > 4096:
        raise ValueError("manifest too large")
    seal = json.loads(seal_path.read_text(encoding="utf-8"))
    if sha_file(manifest_path) != expected_hash or seal.get("manifestHash") != expected_hash:
        raise ValueError("evidence seal mismatch")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if set(manifest) != {"files"} or not 0 < len(manifest["files"]) <= 10000:
        raise ValueError("invalid manifest")
    total = 0
    seen = set()
    for item in manifest["files"]:
        if set(item) != {"path", "size", "sha256"} or item["path"] in seen:
            raise ValueError("invalid manifest item")
        seen.add(item["path"])
        file = safe_child(path, item["path"])
        total += item["size"]
        if (
            item["size"] < 0
            or total > MAX_BYTES
            or file.stat().st_size != item["size"]
            or sha_file(file) != item["sha256"]
        ):
            raise ValueError("evidence content mismatch")
    return {"path": str(path), "hash": expected_hash}


def seal_package(source, destination):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    files = []
    total = 0
    for file in sorted(source.rglob("*")):
        relative = file.relative_to(source).as_posix()
        safe_child(source, relative)
        if not file.is_file():
            continue
        if file.name in ("SEALED.json", "manifest.json"):
            raise ValueError("reserved package name")
        total += file.stat().st_size
        if total > MAX_BYTES or len(files) >= 10000:
            raise ValueError("evidence capacity exceeded")
        files.append({"path": relative, "size": file.stat().st_size, "sha256": sha_file(file)})
    if not files:
        raise ValueError("empty evidence package")
    manifest = {"files": files}
    raw = json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    package_hash = hashlib.sha256(raw).hexdigest()
    path = safe_child(destination, package_hash)
    if (path / "SEALED.json").exists():
        try:
            return verify_package(path, package_hash)
        except (ValueError, OSError):
            return restore_package(source, path, package_hash)
    path.mkdir(parents=True, exist_ok=True)
    for item in files:
        origin, target = safe_child(source, item["path"]), safe_child(path, item["path"])
        if target.exists():
            if sha_file(target) != item["sha256"]:
                raise ValueError("existing unsealed content differs")
            continue
        copy_verified(origin, target, item)
    atomic_json(path / "manifest.json", manifest)
    # Verify all content from the destination before making the seal visible.
    for item in files:
        if sha_file(safe_child(path, item["path"])) != item["sha256"]:
            raise ValueError("destination verification failed")
    atomic_json(path / "SEALED.json", {"manifestHash": package_hash})
    return verify_package(path, package_hash)


def copy_verified(origin, target, item):
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + "." + uuid.uuid4().hex + ".part")
    try:
        with origin.open("rb") as src, temporary.open("xb") as dst:
            for chunk in iter(lambda: src.read(1024 * 1024), b""):
                dst.write(chunk)
            dst.flush()
            os.fsync(dst.fileno())
        if temporary.stat().st_size != item["size"] or sha_file(temporary) != item["sha256"]:
            raise ValueError("copy verification failed")
        os.replace(temporary, target)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def restore_package(source, path, expected_hash):
    """Re-copies only missing files whose local bytes still match the sealed manifest.

    A present file with other content is damage: it is never overwritten.
    """
    source, path = Path(source).resolve(), Path(path)
    manifest_path = safe_child(path, "manifest.json")
    if sha_file(manifest_path) != expected_hash:
        raise ValueError("sealed manifest damaged; evidence cannot be restored")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for item in manifest["files"]:
        target = safe_child(path, item["path"])
        if target.exists():
            if sha_file(target) != item["sha256"]:
                raise ValueError("sealed evidence content damaged; re-investigation required")
            continue
        origin = safe_child(source, item["path"])
        if not origin.is_file() or sha_file(origin) != item["sha256"]:
            raise ValueError(
                "evidence missing and no identical local copy; re-investigation required"
            )
        copy_verified(origin, target, item)
    return verify_package(path, expected_hash)
