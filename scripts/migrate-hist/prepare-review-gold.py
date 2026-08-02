#!/usr/bin/env python3
"""Safely prepare human gold data for historical review-flow calibration.

The historical migration source mapping remains the authority for problem content.
This tool never copies that content.  It only creates a private, manually confirmed
binding from selected spreadsheet rows to the already materialized sources.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import stat
import sys
import unicodedata
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Any


_HERE = Path(__file__).resolve().parent
_METADATA_PARSER_PATH = _HERE / "parse-metadata.py"
_METADATA_PARSER_SPEC = importlib.util.spec_from_file_location(
    "urmotiv_review_gold_safe_xlsx", _METADATA_PARSER_PATH
)
if _METADATA_PARSER_SPEC is None or _METADATA_PARSER_SPEC.loader is None:
    raise RuntimeError("safe parser unavailable")
_XLSX = importlib.util.module_from_spec(_METADATA_PARSER_SPEC)
sys.modules[_METADATA_PARSER_SPEC.name] = _XLSX
_METADATA_PARSER_SPEC.loader.exec_module(_XLSX)


_XLSX_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_SS_NS_URI = "urn:schemas-microsoft-com:office:spreadsheet"
_SS_NS = f"{{{_SS_NS_URI}}}"
_MAX_INPUTS = 2
_MAX_ROWS = 10_000
_MAX_COLUMNS = 512
_MAX_IDENTITY_COLUMNS = 8
_MAX_REVIEW_COLUMNS = 32
_MAX_IDENTITY_TEXT_UNITS = 2_000
_MAX_DECISION_TEXT_UNITS = 2_000
_MAX_CONTEST_TEXT_UNITS = 2_000
_MAX_REVIEW_TEXT_UNITS = 100_000
_MAX_PRIVATE_JSON_BYTES = 10_000_000
_MAX_SOURCE_BYTES = 2_000_000
_MAX_SOURCE_TEXT_UNITS = 500_000
_DIGEST = re.compile(r"^[0-9a-f]{64}$")
_INPUT_ID = re.compile(r"^input-[0-9]{6}$")
_WORKSHEET_ID = re.compile(r"^worksheet-[0-9]{6}$")
_ROW_ID = re.compile(r"^review-row-[0-9]{6}$")
_SOURCE_ID = re.compile(r"^source-[0-9]{6}$")
_SOURCE_PATH = re.compile(r"^source-[0-9]{6}\.(?:md|txt)$", re.IGNORECASE)
_GROUP_ID = re.compile(r"^group-[0-9]{6}$")
_CASE_ID = re.compile(r"^case-[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$")
_SUBJECT_ID = re.compile(r"^subject-[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?$")
_DATASET_ID = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
class _SafeFailure(Exception):
    """Expected rejection whose details must never reach the terminal."""


class _SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:  # pragma: no cover - argparse plumbing
        del message
        raise _SafeFailure()


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _javascript_units(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def _normalize_header(value: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", value).strip()).casefold()


def _require_dict(value: object, keys: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise _SafeFailure()
    return value


def _require_list(value: object, *, minimum: int = 0, maximum: int) -> list[Any]:
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        raise _SafeFailure()
    return value


def _require_string(value: object, maximum_units: int, *, nonempty: bool = True) -> str:
    if not isinstance(value, str) or _javascript_units(value) > maximum_units:
        raise _SafeFailure()
    if nonempty and not value.strip():
        raise _SafeFailure()
    return value


def _require_integer(value: object, *, minimum: int = 0, maximum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise _SafeFailure()
    if maximum is not None and value > maximum:
        raise _SafeFailure()
    return value


def _require_digest(value: object) -> str:
    if not isinstance(value, str) or _DIGEST.fullmatch(value) is None:
        raise _SafeFailure()
    return value


def _json_compact(value: object) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, UnicodeError, ValueError) as error:
        raise _SafeFailure() from error


def _json_pretty(value: object) -> bytes:
    try:
        encoded = (json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + "\n").encode(
            "utf-8"
        )
    except (TypeError, UnicodeError, ValueError) as error:
        raise _SafeFailure() from error
    if len(encoded) > _MAX_PRIVATE_JSON_BYTES:
        raise _SafeFailure()
    return encoded


_DIRECTORY_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
    | getattr(os, "O_CLOEXEC", 0)
)
_READ_FLAGS = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)


@dataclass
class _PrivateRoot:
    path: Path
    descriptor: int
    device: int
    inode: int

    def close(self) -> None:
        if self.descriptor >= 0:
            os.close(self.descriptor)
            self.descriptor = -1


@dataclass
class _PrivateDirectory:
    path: Path
    descriptor: int
    device: int
    inode: int

    def close(self) -> None:
        if self.descriptor >= 0:
            os.close(self.descriptor)
            self.descriptor = -1


def _open_absolute_directory(path: Path) -> int:
    if not path.is_absolute() or path != Path(os.path.abspath(path)):
        raise _SafeFailure()
    try:
        descriptor = os.open("/", _DIRECTORY_FLAGS)
        for component in path.parts[1:]:
            if component in {"", ".", ".."}:
                raise _SafeFailure()
            next_descriptor = os.open(component, _DIRECTORY_FLAGS, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except Exception as error:
        if "descriptor" in locals():
            try:
                os.close(descriptor)
            except OSError:
                pass
        if isinstance(error, _SafeFailure):
            raise
        raise _SafeFailure() from error


def _assert_private_root(root: Path) -> _PrivateRoot:
    descriptor = _open_absolute_directory(root)
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_uid != os.geteuid()
            or stat.S_IMODE(metadata.st_mode) != 0o700
        ):
            raise _SafeFailure()
        verification = _open_absolute_directory(root)
        try:
            current = os.fstat(verification)
            if (current.st_dev, current.st_ino) != (metadata.st_dev, metadata.st_ino):
                raise _SafeFailure()
        finally:
            os.close(verification)
        return _PrivateRoot(root, descriptor, metadata.st_dev, metadata.st_ino)
    except Exception:
        os.close(descriptor)
        raise


def _relative_parts(root: _PrivateRoot, path: Path) -> tuple[Path, tuple[str, ...]]:
    if not path.is_absolute():
        raise _SafeFailure()
    absolute = Path(os.path.abspath(path))
    try:
        relative = absolute.relative_to(root.path)
    except ValueError as error:
        raise _SafeFailure() from error
    if not relative.parts or any(part in {"", ".", ".."} or "/" in part for part in relative.parts):
        raise _SafeFailure()
    return absolute, tuple(relative.parts)


def _open_relative_directory(root: _PrivateRoot, parts: tuple[str, ...]) -> int:
    try:
        descriptor = os.dup(root.descriptor)
        for component in parts:
            next_descriptor = os.open(component, _DIRECTORY_FLAGS, dir_fd=descriptor)
            metadata = os.fstat(next_descriptor)
            if (
                not stat.S_ISDIR(metadata.st_mode)
                or metadata.st_uid != os.geteuid()
                or stat.S_IMODE(metadata.st_mode) != 0o700
            ):
                os.close(next_descriptor)
                raise _SafeFailure()
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except Exception as error:
        if "descriptor" in locals():
            try:
                os.close(descriptor)
            except OSError:
                pass
        if isinstance(error, _SafeFailure):
            raise
        raise _SafeFailure() from error


def _verify_root_identity(root: _PrivateRoot) -> None:
    descriptor = _open_absolute_directory(root.path)
    try:
        metadata = os.fstat(descriptor)
        if (metadata.st_dev, metadata.st_ino) != (root.device, root.inode):
            raise _SafeFailure()
    finally:
        os.close(descriptor)


def _open_parent(
    root: _PrivateRoot, path: Path
) -> tuple[Path, tuple[str, ...], int, str]:
    absolute, parts = _relative_parts(root, path)
    parent_parts = parts[:-1]
    parent = _open_relative_directory(root, parent_parts)
    return absolute, parent_parts, parent, parts[-1]


def _assert_inside(
    root: _PrivateRoot, path: Path, *, new: bool = False, directory: bool = False
) -> Path:
    absolute, parent_parts, parent, name = _open_parent(root, path)
    try:
        if new:
            try:
                os.stat(name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                _verify_root_identity(root)
                return absolute
            raise _SafeFailure()
        flags = _DIRECTORY_FLAGS if directory else _READ_FLAGS
        descriptor = os.open(name, flags, dir_fd=parent)
        try:
            metadata = os.fstat(descriptor)
            if directory:
                valid = (
                    stat.S_ISDIR(metadata.st_mode)
                    and metadata.st_uid == os.geteuid()
                    and stat.S_IMODE(metadata.st_mode) == 0o700
                )
            else:
                valid = (
                    stat.S_ISREG(metadata.st_mode)
                    and metadata.st_uid == os.geteuid()
                    and not stat.S_IMODE(metadata.st_mode) & 0o077
                )
            if not valid:
                raise _SafeFailure()
        finally:
            os.close(descriptor)
        current_parent = _open_relative_directory(root, parent_parts)
        os.close(current_parent)
        _verify_root_identity(root)
        return absolute
    except Exception as error:
        if isinstance(error, _SafeFailure):
            raise
        raise _SafeFailure() from error
    finally:
        os.close(parent)


def _file_fingerprint(metadata: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _read_all(descriptor: int, maximum: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while total <= maximum:
        chunk = os.read(descriptor, min(1024 * 1024, maximum + 1 - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
    content = b"".join(chunks)
    if not content or len(content) > maximum:
        raise _SafeFailure()
    return content


def _read_private_bytes(root: _PrivateRoot, path: Path, maximum: int) -> bytes:
    if not isinstance(maximum, int) or isinstance(maximum, bool) or maximum <= 0:
        raise _SafeFailure()
    _, parent_parts, parent, name = _open_parent(root, path)
    descriptor: int | None = None
    verification_descriptor: int | None = None
    current_parent: int | None = None
    try:
        descriptor = os.open(name, _READ_FLAGS, dir_fd=parent)
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != os.geteuid()
            or stat.S_IMODE(before.st_mode) & 0o077
            or before.st_size <= 0
            or before.st_size > maximum
        ):
            raise _SafeFailure()
        content = _read_all(descriptor, maximum)
        os.lseek(descriptor, 0, os.SEEK_SET)
        verification_content = _read_all(descriptor, maximum)
        after = os.fstat(descriptor)
        verification_descriptor = os.open(name, _READ_FLAGS, dir_fd=parent)
        current_file = os.fstat(verification_descriptor)
        current_parent = _open_relative_directory(root, parent_parts)
        current_entry = os.open(name, _READ_FLAGS, dir_fd=current_parent)
        try:
            current_path_file = os.fstat(current_entry)
        finally:
            os.close(current_entry)
        _verify_root_identity(root)
        if (
            _file_fingerprint(before) != _file_fingerprint(after)
            or _file_fingerprint(before) != _file_fingerprint(current_file)
            or _file_fingerprint(before) != _file_fingerprint(current_path_file)
            or len(content) != before.st_size
            or verification_content != content
        ):
            raise _SafeFailure()
        return content
    except Exception as error:
        if isinstance(error, _SafeFailure):
            raise
        raise _SafeFailure() from error
    finally:
        if current_parent is not None:
            os.close(current_parent)
        if verification_descriptor is not None:
            os.close(verification_descriptor)
        if descriptor is not None:
            os.close(descriptor)
        os.close(parent)


def _read_private_json(root: _PrivateRoot, path: Path) -> tuple[object, bytes]:
    data = _read_private_bytes(root, path, _MAX_PRIVATE_JSON_BYTES)
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise _SafeFailure() from error
    return value, data


def _write_private_json(root: _PrivateRoot, path: Path, value: object) -> bytes:
    encoded = _json_pretty(value)
    _, parent_parts, parent, name = _open_parent(root, path)
    descriptor: int | None = None
    verification_descriptor: int | None = None
    current_parent: int | None = None
    try:
        # The target name itself is created exclusively.  If anything fails after
        # this point, the private partial is intentionally retained.  Deleting by
        # name during rollback would reintroduce a stat/unlink replacement race.
        descriptor = os.open(
            name,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0),
            0o600,
            dir_fd=parent,
        )
        os.fchmod(descriptor, 0o600)
        offset = 0
        while offset < len(encoded):
            written = os.write(descriptor, encoded[offset:])
            if written <= 0:
                raise _SafeFailure()
            offset += written
        os.fsync(descriptor)
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.geteuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_size != len(encoded)
        ):
            raise _SafeFailure()
        verification_descriptor = os.open(name, _READ_FLAGS, dir_fd=parent)
        current_metadata = os.fstat(verification_descriptor)
        if (current_metadata.st_dev, current_metadata.st_ino) != (
            metadata.st_dev,
            metadata.st_ino,
        ):
            raise _SafeFailure()
        current_parent = _open_relative_directory(root, parent_parts)
        current_descriptor = os.open(name, _READ_FLAGS, dir_fd=current_parent)
        try:
            current_path_metadata = os.fstat(current_descriptor)
        finally:
            os.close(current_descriptor)
        if (current_path_metadata.st_dev, current_path_metadata.st_ino) != (
            metadata.st_dev,
            metadata.st_ino,
        ):
            raise _SafeFailure()
        _verify_root_identity(root)
        os.fsync(parent)
        return encoded
    except Exception as error:
        if isinstance(error, _SafeFailure):
            raise
        raise _SafeFailure() from error
    finally:
        if current_parent is not None:
            os.close(current_parent)
        if verification_descriptor is not None:
            os.close(verification_descriptor)
        if descriptor is not None:
            os.close(descriptor)
        os.close(parent)


def _directory_metadata_is_private(metadata: os.stat_result) -> bool:
    return (
        stat.S_ISDIR(metadata.st_mode)
        and metadata.st_uid == os.geteuid()
        and stat.S_IMODE(metadata.st_mode) == 0o700
    )


def _verify_private_directory_descriptor(directory: _PrivateDirectory) -> None:
    try:
        metadata = os.fstat(directory.descriptor)
    except OSError as error:
        raise _SafeFailure() from error
    if (
        not _directory_metadata_is_private(metadata)
        or (metadata.st_dev, metadata.st_ino) != (directory.device, directory.inode)
    ):
        raise _SafeFailure()


def _verify_private_directory_path(root: _PrivateRoot, directory: _PrivateDirectory) -> None:
    _, parts = _relative_parts(root, directory.path)
    current: int | None = None
    try:
        _verify_private_directory_descriptor(directory)
        current = _open_relative_directory(root, parts)
        metadata = os.fstat(current)
        if (metadata.st_dev, metadata.st_ino) != (directory.device, directory.inode):
            raise _SafeFailure()
        _verify_root_identity(root)
    except Exception as error:
        if isinstance(error, _SafeFailure):
            raise
        raise _SafeFailure() from error
    finally:
        if current is not None:
            os.close(current)


def _create_private_directory(root: _PrivateRoot, path: Path) -> _PrivateDirectory:
    absolute, parent_parts, parent, name = _open_parent(root, path)
    descriptor: int | None = None
    current_parent: int | None = None
    try:
        os.mkdir(name, 0o700, dir_fd=parent)
        descriptor = os.open(name, _DIRECTORY_FLAGS, dir_fd=parent)
        metadata = os.fstat(descriptor)
        if not _directory_metadata_is_private(metadata):
            raise _SafeFailure()
        current_parent = _open_relative_directory(root, parent_parts)
        current_descriptor = os.open(name, _DIRECTORY_FLAGS, dir_fd=current_parent)
        try:
            current = os.fstat(current_descriptor)
        finally:
            os.close(current_descriptor)
        if (current.st_dev, current.st_ino) != (metadata.st_dev, metadata.st_ino):
            raise _SafeFailure()
        _verify_root_identity(root)
        os.fsync(descriptor)
        os.fsync(parent)
        result = _PrivateDirectory(
            absolute,
            descriptor,
            metadata.st_dev,
            metadata.st_ino,
        )
        descriptor = None
        return result
    except Exception as error:
        if isinstance(error, _SafeFailure):
            raise
        raise _SafeFailure() from error
    finally:
        if current_parent is not None:
            os.close(current_parent)
        if descriptor is not None:
            os.close(descriptor)
        os.close(parent)


def _create_private_child_directory(
    root: _PrivateRoot,
    parent: _PrivateDirectory,
    name: str,
) -> _PrivateDirectory:
    if not name or name in {".", ".."} or "/" in name or "\x00" in name:
        raise _SafeFailure()
    descriptor: int | None = None
    verification: int | None = None
    try:
        _verify_private_directory_descriptor(parent)
        os.mkdir(name, 0o700, dir_fd=parent.descriptor)
        descriptor = os.open(name, _DIRECTORY_FLAGS, dir_fd=parent.descriptor)
        metadata = os.fstat(descriptor)
        if not _directory_metadata_is_private(metadata):
            raise _SafeFailure()
        verification = os.open(name, _DIRECTORY_FLAGS, dir_fd=parent.descriptor)
        current = os.fstat(verification)
        if (current.st_dev, current.st_ino) != (metadata.st_dev, metadata.st_ino):
            raise _SafeFailure()
        os.fsync(descriptor)
        os.fsync(parent.descriptor)
        result = _PrivateDirectory(
            parent.path / name,
            descriptor,
            metadata.st_dev,
            metadata.st_ino,
        )
        _verify_private_directory_path(root, parent)
        _verify_private_directory_path(root, result)
        descriptor = None
        return result
    except Exception as error:
        if isinstance(error, _SafeFailure):
            raise
        raise _SafeFailure() from error
    finally:
        if verification is not None:
            os.close(verification)
        if descriptor is not None:
            os.close(descriptor)


def _write_private_json_at(
    directory: _PrivateDirectory,
    name: str,
    value: object,
) -> bytes:
    if not name or name in {".", ".."} or "/" in name or "\x00" in name:
        raise _SafeFailure()
    encoded = _json_pretty(value)
    descriptor: int | None = None
    verification: int | None = None
    try:
        _verify_private_directory_descriptor(directory)
        descriptor = os.open(
            name,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0),
            0o600,
            dir_fd=directory.descriptor,
        )
        os.fchmod(descriptor, 0o600)
        offset = 0
        while offset < len(encoded):
            written = os.write(descriptor, encoded[offset:])
            if written <= 0:
                raise _SafeFailure()
            offset += written
        os.fsync(descriptor)
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.geteuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_nlink != 1
            or metadata.st_size != len(encoded)
        ):
            raise _SafeFailure()
        verification = os.open(name, _READ_FLAGS, dir_fd=directory.descriptor)
        current = os.fstat(verification)
        content = _read_all(verification, _MAX_PRIVATE_JSON_BYTES)
        after = os.fstat(verification)
        if (
            _file_fingerprint(metadata) != _file_fingerprint(current)
            or _file_fingerprint(current) != _file_fingerprint(after)
            or content != encoded
        ):
            raise _SafeFailure()
        _verify_private_directory_descriptor(directory)
        os.fsync(directory.descriptor)
        return encoded
    except Exception as error:
        if isinstance(error, _SafeFailure):
            raise
        raise _SafeFailure() from error
    finally:
        if verification is not None:
            os.close(verification)
        if descriptor is not None:
            os.close(descriptor)


def _verify_private_artifact_group(
    directory: _PrivateDirectory,
    expected_files: dict[str, bytes],
    expected_directories: dict[str, _PrivateDirectory] | None = None,
) -> None:
    expected_children = expected_directories or {}
    all_names = {*expected_files, *expected_children}
    if (
        len(all_names) != len(expected_files) + len(expected_children)
        or any(
            not name or name in {".", ".."} or "/" in name or "\x00" in name
            for name in all_names
        )
    ):
        raise _SafeFailure()
    try:
        _verify_private_directory_descriptor(directory)
        names = os.listdir(directory.descriptor)
        if set(names) != all_names or len(names) != len(all_names):
            raise _SafeFailure()
        for name, expected in expected_files.items():
            descriptor: int | None = None
            verification: int | None = None
            try:
                descriptor = os.open(name, _READ_FLAGS, dir_fd=directory.descriptor)
                before = os.fstat(descriptor)
                if (
                    not stat.S_ISREG(before.st_mode)
                    or before.st_uid != os.geteuid()
                    or stat.S_IMODE(before.st_mode) != 0o600
                    or before.st_nlink != 1
                    or before.st_size != len(expected)
                ):
                    raise _SafeFailure()
                content = _read_all(descriptor, _MAX_PRIVATE_JSON_BYTES)
                after = os.fstat(descriptor)
                verification = os.open(name, _READ_FLAGS, dir_fd=directory.descriptor)
                current = os.fstat(verification)
                if (
                    _file_fingerprint(before) != _file_fingerprint(after)
                    or _file_fingerprint(before) != _file_fingerprint(current)
                    or content != expected
                ):
                    raise _SafeFailure()
            finally:
                if verification is not None:
                    os.close(verification)
                if descriptor is not None:
                    os.close(descriptor)
        for name, expected in expected_children.items():
            _verify_private_directory_descriptor(expected)
            descriptor = None
            try:
                descriptor = os.open(name, _DIRECTORY_FLAGS, dir_fd=directory.descriptor)
                metadata = os.fstat(descriptor)
                if (metadata.st_dev, metadata.st_ino) != (expected.device, expected.inode):
                    raise _SafeFailure()
            finally:
                if descriptor is not None:
                    os.close(descriptor)
        if set(os.listdir(directory.descriptor)) != all_names:
            raise _SafeFailure()
        _verify_private_directory_descriptor(directory)
    except Exception as error:
        if isinstance(error, _SafeFailure):
            raise
        raise _SafeFailure() from error


def _list_private_regular_names(root: _PrivateRoot, path: Path) -> set[str]:
    _, parts = _relative_parts(root, path)
    descriptor = _open_relative_directory(root, parts)
    try:
        before = os.fstat(descriptor)
        names = os.listdir(descriptor)
        result: set[str] = set()
        for name in names:
            if not name or name in {".", ".."} or "/" in name:
                raise _SafeFailure()
            metadata = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_uid != os.geteuid()
                or stat.S_IMODE(metadata.st_mode) & 0o077
            ):
                raise _SafeFailure()
            result.add(name)
        after = os.fstat(descriptor)
        current = _open_relative_directory(root, parts)
        try:
            current_metadata = os.fstat(current)
        finally:
            os.close(current)
        _verify_root_identity(root)
        if (
            (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino)
            or (before.st_dev, before.st_ino)
            != (current_metadata.st_dev, current_metadata.st_ino)
        ):
            raise _SafeFailure()
        return result
    except Exception as error:
        if isinstance(error, _SafeFailure):
            raise
        raise _SafeFailure() from error
    finally:
        os.close(descriptor)


def _xlsx_worksheet_shape(content: bytes) -> dict[str, int]:
    text = _XLSX._strict_utf8_xml(content, _XLSX._MAX_WORKSHEET_BYTES)
    budget = _XLSX._ParseBudget()
    root_seen = False
    sheet_data_depth: int | None = None
    sheet_data_count = 0
    row_depth: int | None = None
    row_numbers: set[int] = set()
    present_rows = 0
    maximum_row = 0
    maximum_column = 0
    last_row = 0
    for event, element, depth in _XLSX._bounded_events(text, budget):
        if event == "start":
            if not root_seen:
                if element.tag != f"{_XLSX_NS}worksheet" or depth != 1:
                    raise _SafeFailure()
                root_seen = True
            if element.tag == f"{_XLSX_NS}sheetData":
                if depth != 2 or sheet_data_depth is not None or sheet_data_count != 0:
                    raise _SafeFailure()
                sheet_data_depth = depth
                sheet_data_count = 1
            elif element.tag in {f"{_XLSX_NS}mergeCells", f"{_XLSX_NS}mergeCell"}:
                raise _SafeFailure()
            elif element.tag == f"{_XLSX_NS}row":
                if sheet_data_depth is None or depth != sheet_data_depth + 1 or row_depth is not None:
                    raise _SafeFailure()
                row_depth = depth
            continue
        if element.tag == f"{_XLSX_NS}row":
            if row_depth is None or depth != row_depth:
                raise _SafeFailure()
            raw_row = element.get("r")
            if raw_row is None or re.fullmatch(r"[1-9][0-9]*", raw_row) is None:
                raise _SafeFailure()
            row_number = int(raw_row)
            if row_number in row_numbers or row_number <= last_row or row_number > _MAX_ROWS:
                raise _SafeFailure()
            row_numbers.add(row_number)
            last_row = row_number
            cells = element.findall(f"{_XLSX_NS}c")
            if len(cells) > _MAX_COLUMNS:
                raise _SafeFailure()
            columns: set[int] = set()
            last_column = 0
            for cell in cells:
                column = _XLSX._col_number(cell.get("r"), row_number)
                if column in columns or column <= last_column or column > _MAX_COLUMNS:
                    raise _SafeFailure()
                columns.add(column)
                last_column = column
                maximum_column = max(maximum_column, column)
            present_rows += 1
            maximum_row = max(maximum_row, row_number)
            row_depth = None
            element.clear()
        elif element.tag == f"{_XLSX_NS}sheetData":
            if sheet_data_depth is None or depth != sheet_data_depth:
                raise _SafeFailure()
            sheet_data_depth = None
            element.clear()
        elif row_depth is None:
            element.clear()
    if (
        not root_seen
        or sheet_data_count != 1
        or sheet_data_depth is not None
        or row_depth is not None
        or present_rows == 0
    ):
        raise _SafeFailure()
    return {
        "presentRowCount": present_rows,
        "maximumRowNumber": maximum_row,
        "maximumColumnNumber": maximum_column,
    }


def _xml_root(content: bytes) -> ET.Element:
    text = _XLSX._strict_utf8_xml(content, _XLSX._MAX_XLSX_BYTES)
    for _ in _XLSX._bounded_events(text):
        pass
    try:
        root = ET.fromstring(text)
    except (ET.ParseError, RecursionError, ValueError) as error:
        raise _SafeFailure() from error
    if root.tag != f"{_SS_NS}Workbook":
        raise _SafeFailure()
    for element in root.iter():
        for attribute in element.attrib:
            local_name = attribute.rsplit("}", 1)[-1]
            if local_name in {"MergeAcross", "MergeDown", "Span"}:
                raise _SafeFailure()
    return root


def _spreadsheetml_rows(worksheet: ET.Element) -> list[tuple[int, dict[int, ET.Element]]]:
    tables = [child for child in worksheet if child.tag == f"{_SS_NS}Table"]
    if len(tables) != 1:
        raise _SafeFailure()
    rows: list[tuple[int, dict[int, ET.Element]]] = []
    next_row = 1
    for row in tables[0]:
        if row.tag != f"{_SS_NS}Row":
            continue
        raw_index = row.get(f"{_SS_NS}Index")
        if raw_index is not None:
            if re.fullmatch(r"[1-9][0-9]*", raw_index) is None:
                raise _SafeFailure()
            explicit_row = int(raw_index)
            if explicit_row < next_row:
                raise _SafeFailure()
            next_row = explicit_row
        if next_row > _MAX_ROWS:
            raise _SafeFailure()
        cells: dict[int, ET.Element] = {}
        next_column = 1
        for cell in row:
            if cell.tag != f"{_SS_NS}Cell":
                continue
            raw_column = cell.get(f"{_SS_NS}Index")
            if raw_column is not None:
                if re.fullmatch(r"[1-9][0-9]*", raw_column) is None:
                    raise _SafeFailure()
                explicit_column = int(raw_column)
                if explicit_column < next_column:
                    raise _SafeFailure()
                next_column = explicit_column
            if next_column > _MAX_COLUMNS:
                raise _SafeFailure()
            cells[next_column] = cell
            next_column += 1
        rows.append((next_row, cells))
        next_row += 1
    if not rows:
        raise _SafeFailure()
    return rows


def _spreadsheetml_shape(worksheet: ET.Element) -> dict[str, int]:
    rows = _spreadsheetml_rows(worksheet)
    return {
        "presentRowCount": len(rows),
        "maximumRowNumber": max(row for row, _ in rows),
        "maximumColumnNumber": max((max(cells, default=0) for _, cells in rows), default=0),
    }


def _inspect_input_bytes(content: bytes) -> tuple[str, list[dict[str, int | str]]]:
    if content.startswith(b"PK\x03\x04"):
        members = _XLSX._safe_zip_members(content)
        worksheets = sorted(
            (
                (name, member)
                for name, member in members.items()
                if _XLSX._WORKSHEET_MEMBER.fullmatch(name)
            ),
            key=lambda item: (unicodedata.normalize("NFC", item[0]).casefold(), item[0]),
        )
        if len(worksheets) != 1:
            raise _SafeFailure()
        return (
            "xlsx",
            [
                {"worksheetId": f"worksheet-{index:06d}", **_xlsx_worksheet_shape(member)}
                for index, (_, member) in enumerate(worksheets, 1)
            ],
        )
    root = _xml_root(content)
    worksheets = [child for child in root if child.tag == f"{_SS_NS}Worksheet"]
    if len(worksheets) != 1:
        raise _SafeFailure()
    return (
        "spreadsheetml_xml",
        [
            {"worksheetId": f"worksheet-{index:06d}", **_spreadsheetml_shape(worksheet)}
            for index, worksheet in enumerate(worksheets, 1)
        ],
    )


def _build_inspection(
    root: _PrivateRoot, input_paths: list[Path]
) -> tuple[dict[str, object], list[bytes]]:
    if not 1 <= len(input_paths) <= _MAX_INPUTS:
        raise _SafeFailure()
    inputs: list[dict[str, object]] = []
    contents: list[bytes] = []
    digests: set[str] = set()
    for index, path in enumerate(input_paths, 1):
        content = _read_private_bytes(root, path, _XLSX._MAX_XLSX_BYTES)
        digest = _sha256(content)
        if digest in digests:
            raise _SafeFailure()
        digests.add(digest)
        format_name, worksheets = _inspect_input_bytes(content)
        contents.append(content)
        inputs.append(
            {
                "inputId": f"input-{index:06d}",
                "inputSha256": digest,
                "format": format_name,
                "worksheets": worksheets,
            }
        )
    identity = {"version": 1, "inputs": inputs}
    return {
        "version": 1,
        "inputSetSha256": _sha256(_json_compact(identity)),
        "inputs": inputs,
    }, contents


def _parse_layout(value: object, inspection: dict[str, object]) -> list[dict[str, object]]:
    root = _require_dict(
        value,
        {
            "version",
            "confirmed",
            "submitterDifficultyColumnsExcluded",
            "inputSetSha256",
            "inputs",
        },
    )
    if (
        _require_integer(root["version"], minimum=3, maximum=3) != 3
        or root["confirmed"] is not True
        or root["submitterDifficultyColumnsExcluded"] is not True
    ):
        raise _SafeFailure()
    if _require_digest(root["inputSetSha256"]) != inspection["inputSetSha256"]:
        raise _SafeFailure()
    layouts = _require_list(root["inputs"], minimum=1, maximum=_MAX_INPUTS)
    inspected = inspection["inputs"]
    if not isinstance(inspected, list) or len(layouts) != len(inspected):
        raise _SafeFailure()
    parsed: list[dict[str, object]] = []
    seen_inputs: set[str] = set()
    for item in layouts:
        entry = _require_dict(item, {"inputId", "worksheetId", "headerRow", "columns"})
        input_id = entry["inputId"]
        worksheet_id = entry["worksheetId"]
        if (
            not isinstance(input_id, str)
            or _INPUT_ID.fullmatch(input_id) is None
            or input_id in seen_inputs
            or not isinstance(worksheet_id, str)
            or _WORKSHEET_ID.fullmatch(worksheet_id) is None
        ):
            raise _SafeFailure()
        seen_inputs.add(input_id)
        inspected_input = next(
            (candidate for candidate in inspected if candidate.get("inputId") == input_id), None
        )
        if not isinstance(inspected_input, dict):
            raise _SafeFailure()
        inspected_worksheet = next(
            (
                candidate
                for candidate in inspected_input.get("worksheets", [])
                if isinstance(candidate, dict) and candidate.get("worksheetId") == worksheet_id
            ),
            None,
        )
        if not isinstance(inspected_worksheet, dict):
            raise _SafeFailure()
        header_row = _require_integer(
            entry["headerRow"],
            minimum=1,
            maximum=_require_integer(inspected_worksheet["maximumRowNumber"], minimum=1),
        )
        maximum_column = _require_integer(inspected_worksheet["maximumColumnNumber"], minimum=1)
        raw_columns = _require_list(
            entry["columns"],
            minimum=6,
            maximum=maximum_column,
        )
        column_bindings: list[dict[str, object]] = []
        role_columns: dict[str, list[int]] = {
            "metadata_number": [],
            "identity": [],
            "final_decision": [],
            "contest_use": [],
            "review_comment": [],
            "excluded_submitter_difficulty": [],
            "excluded_other": [],
        }
        last_column = 0
        for raw_column in raw_columns:
            column = _require_dict(
                raw_column,
                {"column", "role", "expectedHeader", "confirmed"},
            )
            column_number = _require_integer(
                column["column"], minimum=1, maximum=maximum_column
            )
            role = column["role"]
            expected_header = _require_string(column["expectedHeader"], 200)
            if (
                not isinstance(role, str)
                or role not in role_columns
                or column["confirmed"] is not True
                or column_number <= last_column
                or expected_header != _normalize_header(expected_header)
            ):
                raise _SafeFailure()
            last_column = column_number
            role_columns[role].append(column_number)
            column_bindings.append(
                {
                    "column": column_number,
                    "role": role,
                    "expectedHeader": expected_header,
                }
            )
        if (
            len(role_columns["metadata_number"]) != 1
            or not 1 <= len(role_columns["identity"]) <= _MAX_IDENTITY_COLUMNS
            or len(role_columns["final_decision"]) != 1
            or len(role_columns["contest_use"]) != 1
            or not 1 <= len(role_columns["review_comment"]) <= _MAX_REVIEW_COLUMNS
            or not role_columns["excluded_submitter_difficulty"]
        ):
            raise _SafeFailure()
        parsed.append(
            {
                "inputId": input_id,
                "worksheetId": worksheet_id,
                "headerRow": header_row,
                "maximumColumn": maximum_column,
                "columnBindings": column_bindings,
                "metadataColumn": role_columns["metadata_number"][0],
                "identityColumns": role_columns["identity"],
                "finalColumn": role_columns["final_decision"][0],
                "contestColumn": role_columns["contest_use"][0],
                "reviewColumns": role_columns["review_comment"],
            }
        )
    if seen_inputs != {str(item["inputId"]) for item in inspected if isinstance(item, dict)}:
        raise _SafeFailure()
    return parsed


def _xlsx_selected_token(cell: ET.Element) -> tuple[str, str | int]:
    if cell.find(f"{_XLSX_NS}f") is not None:
        raise _SafeFailure()
    kind = cell.get("t")
    if kind == "s":
        value = cell.find(f"{_XLSX_NS}v")
        raw = "" if value is None else value.text or ""
        if re.fullmatch(r"(?:0|[1-9][0-9]*)", raw) is None:
            raise _SafeFailure()
        return ("shared", int(raw))
    if kind == "inlineStr":
        inline = cell.find(f"{_XLSX_NS}is")
        return (
            "text",
            "" if inline is None else "".join(node.text or "" for node in inline.iter(f"{_XLSX_NS}t")),
        )
    if kind not in {None, "str", "n", "b"}:
        raise _SafeFailure()
    value = cell.find(f"{_XLSX_NS}v")
    return ("text", "" if value is None else value.text or "")


def _selected_shared_strings(content: bytes, wanted: set[int]) -> dict[int, str]:
    text = _XLSX._strict_utf8_xml(content, _XLSX._MAX_SHARED_STRINGS_BYTES)
    selected: dict[int, str] = {}
    current_index = -1
    current_parts: list[str] | None = None
    total_count = 0
    root_seen = False
    for event, element, depth in _XLSX._bounded_events(text):
        if event == "start" and not root_seen:
            if element.tag != f"{_XLSX_NS}sst" or depth != 1:
                raise _SafeFailure()
            root_seen = True
        if event == "start" and element.tag == f"{_XLSX_NS}si":
            if depth != 2 or current_parts is not None:
                raise _SafeFailure()
            current_index += 1
            if current_index >= _XLSX._MAX_SHARED_STRINGS:
                raise _SafeFailure()
            current_parts = []
        elif event == "end" and element.tag == f"{_XLSX_NS}t" and current_parts is not None:
            piece = element.text or ""
            if current_index in wanted:
                current_parts.append(piece)
        elif event == "end" and element.tag == f"{_XLSX_NS}si":
            if current_parts is None:
                raise _SafeFailure()
            if current_index in wanted:
                value = "".join(current_parts)
                if _javascript_units(value) > _MAX_REVIEW_TEXT_UNITS:
                    raise _SafeFailure()
                selected[current_index] = value
            total_count += 1
            current_parts = None
            element.clear()
    if (
        not root_seen
        or current_parts is not None
        or any(index >= total_count for index in wanted)
    ):
        raise _SafeFailure()
    return selected


def _selected_xlsx_rows(
    content: bytes, worksheet_index: int, selected_columns: set[int]
) -> list[tuple[int, dict[int, str]]]:
    members = _XLSX._safe_zip_members(content)
    worksheets = sorted(
        (
            (name, member)
            for name, member in members.items()
            if _XLSX._WORKSHEET_MEMBER.fullmatch(name)
        ),
        key=lambda item: (unicodedata.normalize("NFC", item[0]).casefold(), item[0]),
    )
    if not 1 <= worksheet_index <= len(worksheets):
        raise _SafeFailure()
    text = _XLSX._strict_utf8_xml(worksheets[worksheet_index - 1][1], _XLSX._MAX_WORKSHEET_BYTES)
    raw_rows: list[tuple[int, dict[int, tuple[str, str | int]]]] = []
    shared_indexes: set[int] = set()
    seen_rows: set[int] = set()
    last_row = 0
    for event, element, _ in _XLSX._bounded_events(text):
        if event != "end" or element.tag != f"{_XLSX_NS}row":
            continue
        raw_row = element.get("r")
        if raw_row is None or re.fullmatch(r"[1-9][0-9]*", raw_row) is None:
            raise _SafeFailure()
        row_number = int(raw_row)
        if row_number in seen_rows or row_number <= last_row or row_number > _MAX_ROWS:
            raise _SafeFailure()
        seen_rows.add(row_number)
        last_row = row_number
        selected: dict[int, tuple[str, str | int]] = {}
        all_columns: set[int] = set()
        cells = element.findall(f"{_XLSX_NS}c")
        if len(cells) > _MAX_COLUMNS:
            raise _SafeFailure()
        for cell in cells:
            column = _XLSX._col_number(cell.get("r"), row_number)
            if column in all_columns or column > _MAX_COLUMNS:
                raise _SafeFailure()
            all_columns.add(column)
            if column not in selected_columns:
                continue
            token = _xlsx_selected_token(cell)
            selected[column] = token
            if token[0] == "shared":
                shared_indexes.add(int(token[1]))
        raw_rows.append((row_number, selected))
        element.clear()
    shared_member = members.get("xl/sharedStrings.xml")
    if shared_indexes and shared_member is None:
        raise _SafeFailure()
    shared = {} if shared_member is None else _selected_shared_strings(shared_member, shared_indexes)
    rows: list[tuple[int, dict[int, str]]] = []
    for row_number, tokens in raw_rows:
        resolved: dict[int, str] = {}
        for column, token in tokens.items():
            if token[0] == "shared":
                value = shared.get(int(token[1]))
                if value is None:
                    raise _SafeFailure()
                resolved[column] = value
            else:
                resolved[column] = str(token[1])
        rows.append((row_number, resolved))
    return rows


def _spreadsheetml_cell_text(cell: ET.Element) -> str:
    if cell.get(f"{_SS_NS}Formula") is not None:
        raise _SafeFailure()
    data = [child for child in cell if child.tag == f"{_SS_NS}Data"]
    if len(data) > 1:
        raise _SafeFailure()
    if not data:
        return ""
    return "".join(data[0].itertext())


def _selected_spreadsheetml_rows(
    content: bytes, worksheet_index: int, selected_columns: set[int]
) -> list[tuple[int, dict[int, str]]]:
    root = _xml_root(content)
    worksheets = [child for child in root if child.tag == f"{_SS_NS}Worksheet"]
    if not 1 <= worksheet_index <= len(worksheets):
        raise _SafeFailure()
    return [
        (
            row_number,
            {
                column: _spreadsheetml_cell_text(cell)
                for column, cell in cells.items()
                if column in selected_columns
            },
        )
        for row_number, cells in _spreadsheetml_rows(worksheets[worksheet_index - 1])
    ]


def _bounded_selected_text(value: str, maximum: int) -> str:
    if _javascript_units(value) > maximum:
        raise _SafeFailure()
    return value


def _extract_review_rows(
    inspection: dict[str, object],
    contents: list[bytes],
    layouts: list[dict[str, object]],
) -> list[dict[str, object]]:
    inspected_inputs = inspection["inputs"]
    if not isinstance(inspected_inputs, list):
        raise _SafeFailure()
    rows: list[dict[str, object]] = []
    for layout in layouts:
        input_id = str(layout["inputId"])
        inspected_index = next(
            (
                index
                for index, item in enumerate(inspected_inputs)
                if isinstance(item, dict) and item.get("inputId") == input_id
            ),
            None,
        )
        if inspected_index is None:
            raise _SafeFailure()
        inspected_input = inspected_inputs[inspected_index]
        if not isinstance(inspected_input, dict):
            raise _SafeFailure()
        worksheet_id = str(layout["worksheetId"])
        worksheet_index = int(worksheet_id.removeprefix("worksheet-"))
        business_columns = {
            int(layout["metadataColumn"]),
            *[int(value) for value in layout["identityColumns"]],
            int(layout["finalColumn"]),
            int(layout["contestColumn"]),
            *[int(value) for value in layout["reviewColumns"]],
        }
        # Read every possible header position so an unlisted non-empty header
        # cannot hide a submitter-supplied field.  Only business_columns are
        # copied into the private worksheet below.
        selected_columns = set(range(1, int(layout["maximumColumn"]) + 1))
        if inspected_input["format"] == "xlsx":
            selected_rows = _selected_xlsx_rows(
                contents[inspected_index], worksheet_index, selected_columns
            )
        elif inspected_input["format"] == "spreadsheetml_xml":
            selected_rows = _selected_spreadsheetml_rows(
                contents[inspected_index], worksheet_index, selected_columns
            )
        else:
            raise _SafeFailure()
        header_row = int(layout["headerRow"])
        header = next((values for number, values in selected_rows if number == header_row), None)
        bound_columns = {
            int(binding["column"])
            for binding in layout["columnBindings"]
            if isinstance(binding, dict)
        }
        nonempty_header_columns = {
            column for column, value in (header or {}).items() if value.strip()
        }
        if header is None or bound_columns != nonempty_header_columns:
            raise _SafeFailure()
        for binding in layout["columnBindings"]:
            if not isinstance(binding, dict):
                raise _SafeFailure()
            column = int(binding["column"])
            if _normalize_header(header[column]) != binding["expectedHeader"]:
                raise _SafeFailure()
        for row_number, values in selected_rows:
            if row_number <= header_row:
                continue
            metadata_number = _XLSX._javascript_trim(
                values.get(int(layout["metadataColumn"]), "")
            )
            selected_values = [values.get(column, "") for column in business_columns]
            if not metadata_number and not any(value.strip() for value in selected_values):
                continue
            if not metadata_number:
                raise _SafeFailure()
            identity_values = [
                _bounded_selected_text(values.get(int(column), ""), _MAX_IDENTITY_TEXT_UNITS)
                for column in layout["identityColumns"]
            ]
            final_text = _bounded_selected_text(
                values.get(int(layout["finalColumn"]), ""), _MAX_DECISION_TEXT_UNITS
            )
            contest_text = _bounded_selected_text(
                values.get(int(layout["contestColumn"]), ""), _MAX_CONTEST_TEXT_UNITS
            )
            review_comments = [
                _bounded_selected_text(values.get(int(column), ""), _MAX_REVIEW_TEXT_UNITS)
                for column in layout["reviewColumns"]
            ]
            raw = {
                "inputId": input_id,
                "worksheetId": worksheet_id,
                "sourceRowNumber": row_number,
                "metadataNumber": metadata_number,
                "identityValues": identity_values,
                "finalDecisionText": final_text,
                "contestUseText": contest_text,
                "reviewComments": review_comments,
                "reviewCommentPresent": any(comment.strip() for comment in review_comments),
            }
            rows.append(
                {
                    "rowId": f"review-row-{len(rows) + 1:06d}",
                    **raw,
                    "rowEvidenceSha256": _sha256(_json_compact({"version": 1, **raw})),
                }
            )
            if len(rows) > _MAX_ROWS:
                raise _SafeFailure()
    if not rows:
        raise _SafeFailure()
    return rows


def _validate_source_confirmation(value: object) -> dict[str, object]:
    root = _require_dict(value, {"version", "confirmed", "metadataFileSha256", "mappings"})
    if (
        _require_integer(root["version"], minimum=1, maximum=1) != 1
        or root["confirmed"] is not True
    ):
        raise _SafeFailure()
    _require_digest(root["metadataFileSha256"])
    mappings = _require_list(root["mappings"], minimum=1, maximum=_MAX_ROWS)
    paths: set[str] = set()
    numbers: set[str] = set()
    for mapping in mappings:
        item = _require_dict(mapping, {"sourcePath", "sourceSha256", "metadataNumber"})
        path = _require_string(item["sourcePath"], 240)
        number = _XLSX._javascript_trim(_require_string(item["metadataNumber"], 200))
        _require_digest(item["sourceSha256"])
        folded = unicodedata.normalize("NFC", path).casefold()
        if _SOURCE_PATH.fullmatch(path) is None or folded in paths or number in numbers:
            raise _SafeFailure()
        paths.add(folded)
        numbers.add(number)
    return root


def _validate_materialize_report(value: object) -> dict[str, object]:
    root = _require_dict(
        value,
        {
            "version",
            "phase",
            "sourceInventorySha256",
            "groupingBatchSha256",
            "fragmentCount",
            "sourceCount",
            "unresolvedItemCount",
            "sources",
        },
    )
    if (
        _require_integer(root["version"], minimum=2, maximum=2) != 2
        or root["phase"] != "materialize"
        or _require_integer(root["unresolvedItemCount"], maximum=0) != 0
    ):
        raise _SafeFailure()
    _require_digest(root["sourceInventorySha256"])
    _require_digest(root["groupingBatchSha256"])
    _require_integer(root["fragmentCount"])
    source_count = _require_integer(root["sourceCount"], minimum=1, maximum=_MAX_ROWS)
    sources = _require_list(root["sources"], minimum=1, maximum=_MAX_ROWS)
    if source_count != len(sources):
        raise _SafeFailure()
    for source in sources:
        item = _require_dict(
            source,
            {
                "groupId",
                "sourceId",
                "sourceSha256",
                "fragmentCount",
                "byteLength",
                "characterCount",
                "status",
            },
        )
        if (
            not isinstance(item["groupId"], str)
            or _GROUP_ID.fullmatch(item["groupId"]) is None
            or not isinstance(item["sourceId"], str)
            or _SOURCE_ID.fullmatch(item["sourceId"]) is None
            or item["status"] != "ready_for_prepare"
        ):
            raise _SafeFailure()
        _require_digest(item["sourceSha256"])
        _require_integer(item["fragmentCount"], minimum=1)
        _require_integer(item["byteLength"], minimum=1, maximum=_MAX_SOURCE_BYTES)
        _require_integer(item["characterCount"], minimum=1, maximum=_MAX_SOURCE_TEXT_UNITS)
    return root


def _validate_materialize_marker(value: object) -> dict[str, object]:
    root = _require_dict(
        value,
        {
            "version",
            "phase",
            "reportSha256",
            "sourceConfirmationSha256",
            "sourceSetSha256",
            "groupingBatchSha256",
            "sourceCount",
            "fragmentCount",
            "unresolvedItemCount",
        },
    )
    if (
        _require_integer(root["version"], minimum=2, maximum=2) != 2
        or root["phase"] != "materialize"
        or _require_integer(root["unresolvedItemCount"], maximum=0) != 0
    ):
        raise _SafeFailure()
    for field in (
        "reportSha256",
        "sourceConfirmationSha256",
        "sourceSetSha256",
        "groupingBatchSha256",
    ):
        _require_digest(root[field])
    _require_integer(root["sourceCount"], minimum=1, maximum=_MAX_ROWS)
    _require_integer(root["fragmentCount"])
    return root


def _load_materialization(root: _PrivateRoot, directory: Path) -> dict[str, object]:
    materialized = _assert_inside(root, directory, directory=True)
    sources_directory = _assert_inside(root, materialized / "sources", directory=True)
    confirmation_value, _ = _read_private_json(
        root, materialized / "source-confirmation.private.json"
    )
    report_value, _ = _read_private_json(root, materialized / "report.json")
    marker_value, marker_bytes = _read_private_json(root, materialized / "MATERIALIZE_COMPLETE")
    confirmation = _validate_source_confirmation(confirmation_value)
    report = _validate_materialize_report(report_value)
    marker = _validate_materialize_marker(marker_value)
    mappings = confirmation["mappings"]
    report_sources = report["sources"]
    if not isinstance(mappings, list) or not isinstance(report_sources, list):
        raise _SafeFailure()
    if (
        len(mappings) != len(report_sources)
        or marker["sourceCount"] != len(mappings)
        or marker["fragmentCount"] != report["fragmentCount"]
        or marker["groupingBatchSha256"] != report["groupingBatchSha256"]
        or marker["reportSha256"] != _sha256(_json_compact(report))
        or marker["sourceConfirmationSha256"] != _sha256(_json_compact(confirmation))
    ):
        raise _SafeFailure()
    sources: list[dict[str, object]] = []
    expected_names: set[str] = set()
    source_set: list[dict[str, object]] = []
    for index, (mapping, report_source) in enumerate(zip(mappings, report_sources, strict=True), 1):
        if not isinstance(mapping, dict) or not isinstance(report_source, dict):
            raise _SafeFailure()
        source_id = f"source-{index:06d}"
        source_path = str(mapping["sourcePath"])
        if (
            report_source["sourceId"] != source_id
            or report_source["sourceSha256"] != mapping["sourceSha256"]
        ):
            raise _SafeFailure()
        content = _read_private_bytes(root, sources_directory / source_path, _MAX_SOURCE_BYTES)
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError as error:
            raise _SafeFailure() from error
        digest = _sha256(content)
        if (
            digest != mapping["sourceSha256"]
            or len(content) != report_source["byteLength"]
            or _javascript_units(text) != report_source["characterCount"]
            or _javascript_units(text) > _MAX_SOURCE_TEXT_UNITS
            or not text.strip()
        ):
            raise _SafeFailure()
        expected_names.add(source_path)
        source_set.append(
            {"sourceId": source_id, "sourceSha256": digest, "byteLength": len(content)}
        )
        sources.append(
            {
                "sourceId": source_id,
                "sourcePath": source_path,
                "sourceSha256": digest,
                "metadataNumber": mapping["metadataNumber"],
            }
        )
    actual_names = _list_private_regular_names(root, sources_directory)
    if actual_names != expected_names:
        raise _SafeFailure()
    if marker["sourceSetSha256"] != _sha256(
        _json_compact({"version": 1, "sources": source_set})
    ):
        raise _SafeFailure()
    return {
        "sourceConfirmationSha256": _sha256(_json_compact(confirmation)),
        "materializationCompleteSha256": _sha256(marker_bytes),
        "sources": sources,
    }


def _worksheet_value(
    inspection: dict[str, object],
    inspection_file_sha256: str,
    layout_sha256: str,
    rows: list[dict[str, object]],
    materialization: dict[str, object],
) -> dict[str, object]:
    return {
        "version": 1,
        "inputSetSha256": inspection["inputSetSha256"],
        "inspectionFileSha256": inspection_file_sha256,
        "layoutFileSha256": layout_sha256,
        "sourceConfirmationSha256": materialization["sourceConfirmationSha256"],
        "materializationCompleteSha256": materialization["materializationCompleteSha256"],
        "rows": rows,
        "sources": materialization["sources"],
    }


def _load_init_artifacts(
    root: _PrivateRoot, directory: Path
) -> tuple[dict[str, object], bytes]:
    checked = _assert_inside(root, directory, directory=True)
    worksheet_value, worksheet_bytes = _read_private_json(
        root, checked / "review-worksheet.private.json"
    )
    skeleton_value, skeleton_bytes = _read_private_json(
        root, checked / "review-plan.skeleton.private.json"
    )
    tuning_value, tuning_bytes = _read_private_json(
        root, checked / "tuning-history.skeleton.private.json"
    )
    marker_value, _ = _read_private_json(root, checked / "REVIEW_WORKSHEET_COMPLETE")
    marker = _require_dict(
        marker_value,
        {
            "version",
            "phase",
            "worksheetSha256",
            "planSkeletonSha256",
            "tuningHistorySkeletonSha256",
            "rowCount",
            "sourceCount",
            "reviewCommentRowCount",
        },
    )
    if (
        _require_integer(marker["version"], minimum=1, maximum=1) != 1
        or marker["phase"] != "review_gold_worksheet"
    ):
        raise _SafeFailure()
    for field in ("worksheetSha256", "planSkeletonSha256", "tuningHistorySkeletonSha256"):
        _require_digest(marker[field])
    _require_integer(marker["rowCount"], minimum=1, maximum=_MAX_ROWS)
    _require_integer(marker["sourceCount"], minimum=1, maximum=_MAX_ROWS)
    _require_integer(marker["reviewCommentRowCount"], maximum=_MAX_ROWS)
    if (
        marker["worksheetSha256"] != _sha256(worksheet_bytes)
        or marker["planSkeletonSha256"] != _sha256(skeleton_bytes)
        or marker["tuningHistorySkeletonSha256"] != _sha256(tuning_bytes)
        or not isinstance(worksheet_value, dict)
        or marker["rowCount"] != len(worksheet_value.get("rows", []))
        or marker["sourceCount"] != len(worksheet_value.get("sources", []))
        or marker["reviewCommentRowCount"]
        != sum(
            1
            for row in worksheet_value.get("rows", [])
            if isinstance(row, dict) and row.get("reviewCommentPresent") is True
        )
    ):
        raise _SafeFailure()
    return worksheet_value, worksheet_bytes


def _parse_plan(
    value: object, worksheet: dict[str, object], worksheet_sha256: str
) -> tuple[str, list[dict[str, object]]]:
    root = _require_dict(
        value,
        {
            "version",
            "confirmed",
            "submitterDifficultyColumnsExcludedReconfirmed",
            "datasetId",
            "worksheetSha256",
            "sourceConfirmationSha256",
            "cases",
        },
    )
    dataset_id = root["datasetId"]
    if (
        _require_integer(root["version"], minimum=3, maximum=3) != 3
        or root["confirmed"] is not True
        or root["submitterDifficultyColumnsExcludedReconfirmed"] is not True
        or not isinstance(dataset_id, str)
        or _DATASET_ID.fullmatch(dataset_id) is None
        or root["worksheetSha256"] != worksheet_sha256
        or root["sourceConfirmationSha256"] != worksheet.get("sourceConfirmationSha256")
    ):
        raise _SafeFailure()
    rows = {
        row.get("rowId"): row
        for row in worksheet.get("rows", [])
        if isinstance(row, dict) and isinstance(row.get("rowId"), str)
    }
    sources = {
        source.get("sourceId"): source
        for source in worksheet.get("sources", [])
        if isinstance(source, dict) and isinstance(source.get("sourceId"), str)
    }
    cases = _require_list(root["cases"], minimum=1, maximum=_MAX_ROWS)
    parsed: list[dict[str, object]] = []
    case_ids: set[str] = set()
    subject_ids: set[str] = set()
    row_ids: set[str] = set()
    source_ids: set[str] = set()
    content_hashes: set[str] = set()
    for raw_case in cases:
        if not isinstance(raw_case, dict):
            raise _SafeFailure()
        scope = raw_case.get("evaluationScope")
        common_keys = {
            "caseId",
            "subjectId",
            "rowId",
            "sourceId",
            "sourceSha256",
            "purpose",
            "evaluationScope",
            "confirmed",
        }
        if scope == "verdict_and_taste":
            expected_keys = common_keys | {"verdict", "contestUse"}
        elif scope == "originality_only":
            expected_keys = common_keys | {"sameProblemAsExisting"}
        else:
            raise _SafeFailure()
        case = _require_dict(
            raw_case,
            expected_keys,
        )
        case_id = case["caseId"]
        subject_id = case["subjectId"]
        row_id = case["rowId"]
        source_id = case["sourceId"]
        source_sha256 = _require_digest(case["sourceSha256"])
        if (
            not isinstance(case_id, str)
            or _CASE_ID.fullmatch(case_id) is None
            or not isinstance(subject_id, str)
            or _SUBJECT_ID.fullmatch(subject_id) is None
            or not isinstance(row_id, str)
            or _ROW_ID.fullmatch(row_id) is None
            or not isinstance(source_id, str)
            or _SOURCE_ID.fullmatch(source_id) is None
            or case["purpose"] not in {"development", "holdout"}
            or case["confirmed"] is not True
        ):
            raise _SafeFailure()
        if scope == "verdict_and_taste":
            if case["verdict"] not in {"accepted", "rejected"} or case[
                "contestUse"
            ] not in {"used", "not_used", "unknown"}:
                raise _SafeFailure()
        elif case["sameProblemAsExisting"] is not True:
            raise _SafeFailure()
        row = rows.get(row_id)
        source = sources.get(source_id)
        if (
            row is None
            or source is None
            or (
                scope == "verdict_and_taste"
                and not str(row.get("finalDecisionText", "")).strip()
            )
            or row.get("metadataNumber") != source.get("metadataNumber")
            or source.get("sourceSha256") != source_sha256
            or case_id in case_ids
            or subject_id in subject_ids
            or row_id in row_ids
            or source_id in source_ids
            or source_sha256 in content_hashes
        ):
            raise _SafeFailure()
        case_ids.add(case_id)
        subject_ids.add(subject_id)
        row_ids.add(row_id)
        source_ids.add(source_id)
        content_hashes.add(source_sha256)
        parsed.append({**case, "row": row, "source": source})
    return dataset_id, parsed


def _parse_tuning_history(value: object) -> list[dict[str, str]]:
    root = _require_dict(value, {"version", "confirmedComplete", "developmentSamples"})
    if (
        _require_integer(root["version"], minimum=1, maximum=1) != 1
        or root["confirmedComplete"] is not True
    ):
        raise _SafeFailure()
    samples = _require_list(root["developmentSamples"], maximum=100_000)
    parsed: list[dict[str, str]] = []
    pairs: set[tuple[str, str]] = set()
    content_subjects: dict[str, str] = {}
    for sample in samples:
        item = _require_dict(sample, {"subjectId", "contentSha256"})
        subject = item["subjectId"]
        content = _require_digest(item["contentSha256"])
        if (
            not isinstance(subject, str)
            or _SUBJECT_ID.fullmatch(subject) is None
            or (subject, content) in pairs
            or (content in content_subjects and content_subjects[content] != subject)
        ):
            raise _SafeFailure()
        pairs.add((subject, content))
        content_subjects[content] = subject
        parsed.append({"subjectId": subject, "contentSha256": content})
    return parsed


def _command_inspect(arguments: argparse.Namespace) -> dict[str, int]:
    root = _assert_private_root(Path(arguments.private_root))
    try:
        return _command_inspect_anchored(root, arguments)
    finally:
        root.close()


def _command_inspect_anchored(
    root: _PrivateRoot, arguments: argparse.Namespace
) -> dict[str, int]:
    output = _assert_inside(root, Path(arguments.out), new=True)
    inspection, _ = _build_inspection(root, [Path(path) for path in arguments.input])
    _write_private_json(root, output, inspection)
    worksheets = inspection["inputs"]
    if not isinstance(worksheets, list):
        raise _SafeFailure()
    return {
        "inputs": len(worksheets),
        "worksheets": sum(len(item["worksheets"]) for item in worksheets if isinstance(item, dict)),
        "columns": sum(
            sum(sheet["maximumColumnNumber"] for sheet in item["worksheets"])
            for item in worksheets
            if isinstance(item, dict)
        ),
    }


def _command_init(arguments: argparse.Namespace) -> dict[str, int]:
    root = _assert_private_root(Path(arguments.private_root))
    try:
        return _command_init_anchored(root, arguments)
    finally:
        root.close()


def _command_init_anchored(
    root: _PrivateRoot, arguments: argparse.Namespace
) -> dict[str, int]:
    inspection_raw, inspection_bytes = _read_private_json(root, Path(arguments.inspection))
    if not isinstance(inspection_raw, dict):
        raise _SafeFailure()
    recomputed, contents = _build_inspection(root, [Path(path) for path in arguments.input])
    if inspection_raw != recomputed:
        raise _SafeFailure()
    layout_raw, layout_bytes = _read_private_json(root, Path(arguments.layout))
    layouts = _parse_layout(layout_raw, recomputed)
    materialization = _load_materialization(root, Path(arguments.materialized))
    rows = _extract_review_rows(recomputed, contents, layouts)
    worksheet = _worksheet_value(
        recomputed,
        _sha256(inspection_bytes),
        _sha256(layout_bytes),
        rows,
        materialization,
    )
    output = _create_private_directory(root, Path(arguments.out))
    try:
        worksheet_bytes = _write_private_json_at(
            output, "review-worksheet.private.json", worksheet
        )
        skeleton = {
            "version": 3,
            "confirmed": False,
            "submitterDifficultyColumnsExcludedReconfirmed": False,
            "datasetId": "",
            "worksheetSha256": _sha256(worksheet_bytes),
            "sourceConfirmationSha256": materialization["sourceConfirmationSha256"],
            "cases": [],
        }
        skeleton_bytes = _write_private_json_at(
            output, "review-plan.skeleton.private.json", skeleton
        )
        tuning_skeleton = {
            "version": 1,
            "confirmedComplete": False,
            "developmentSamples": [],
        }
        tuning_bytes = _write_private_json_at(
            output, "tuning-history.skeleton.private.json", tuning_skeleton
        )
        artifacts = {
            "review-worksheet.private.json": worksheet_bytes,
            "review-plan.skeleton.private.json": skeleton_bytes,
            "tuning-history.skeleton.private.json": tuning_bytes,
        }
        marker = {
            "version": 1,
            "phase": "review_gold_worksheet",
            "worksheetSha256": _sha256(worksheet_bytes),
            "planSkeletonSha256": _sha256(skeleton_bytes),
            "tuningHistorySkeletonSha256": _sha256(tuning_bytes),
            "rowCount": len(rows),
            "sourceCount": len(materialization["sources"]),
            "reviewCommentRowCount": sum(
                1 for row in rows if row["reviewCommentPresent"] is True
            ),
        }
        _verify_private_artifact_group(output, artifacts)
        _verify_private_directory_path(root, output)
        marker_bytes = _write_private_json_at(output, "REVIEW_WORKSHEET_COMPLETE", marker)
        _verify_private_artifact_group(
            output,
            {**artifacts, "REVIEW_WORKSHEET_COMPLETE": marker_bytes},
        )
        _verify_private_directory_path(root, output)
        return {
            "rows": len(rows),
            "sources": len(materialization["sources"]),
            "withComments": sum(
                1 for row in rows if row["reviewCommentPresent"] is True
            ),
        }
    finally:
        output.close()


def _command_seal(arguments: argparse.Namespace) -> dict[str, int]:
    root = _assert_private_root(Path(arguments.private_root))
    try:
        return _command_seal_anchored(root, arguments)
    finally:
        root.close()


def _command_seal_anchored(
    root: _PrivateRoot, arguments: argparse.Namespace
) -> dict[str, int]:
    inspection_raw, inspection_bytes = _read_private_json(root, Path(arguments.inspection))
    if not isinstance(inspection_raw, dict):
        raise _SafeFailure()
    recomputed, contents = _build_inspection(root, [Path(path) for path in arguments.input])
    if inspection_raw != recomputed:
        raise _SafeFailure()
    layout_raw, layout_bytes = _read_private_json(root, Path(arguments.layout))
    layouts = _parse_layout(layout_raw, recomputed)
    materialization = _load_materialization(root, Path(arguments.materialized))
    rows = _extract_review_rows(recomputed, contents, layouts)
    expected_worksheet = _worksheet_value(
        recomputed,
        _sha256(inspection_bytes),
        _sha256(layout_bytes),
        rows,
        materialization,
    )
    saved_worksheet, saved_worksheet_bytes = _load_init_artifacts(
        root, Path(arguments.worksheet)
    )
    if saved_worksheet != expected_worksheet:
        raise _SafeFailure()
    plan_value, plan_bytes = _read_private_json(root, Path(arguments.plan))
    dataset_id, cases = _parse_plan(
        plan_value, saved_worksheet, _sha256(saved_worksheet_bytes)
    )
    tuning_value, tuning_bytes = _read_private_json(root, Path(arguments.tuning_history))
    prior_development = _parse_tuning_history(tuning_value)
    prior_subjects = {sample["subjectId"] for sample in prior_development}
    prior_contents = {sample["contentSha256"] for sample in prior_development}
    prior_content_subjects = {
        sample["contentSha256"]: sample["subjectId"] for sample in prior_development
    }
    current_development_subjects = {
        str(case["subjectId"]) for case in cases if case["purpose"] == "development"
    }
    current_development_contents = {
        str(case["sourceSha256"]) for case in cases if case["purpose"] == "development"
    }
    for case in cases:
        if case["purpose"] != "development":
            continue
        historical_subject = prior_content_subjects.get(str(case["sourceSha256"]))
        if historical_subject is not None and historical_subject != case["subjectId"]:
            raise _SafeFailure()
    for case in cases:
        if case["purpose"] != "holdout":
            continue
        if (
            case["subjectId"] in prior_subjects | current_development_subjects
            or case["sourceSha256"] in prior_contents | current_development_contents
        ):
            raise _SafeFailure()

    output = _create_private_directory(root, Path(arguments.out))
    gold_directory: _PrivateDirectory | None = None
    try:
        gold_directory = _create_private_child_directory(root, output, "gold")
        evidence_entries: list[dict[str, object]] = []
        source_bindings: list[dict[str, object]] = []
        development_additions: list[dict[str, str]] = []
        gold_artifacts: dict[str, bytes] = {}
        for case in cases:
            row = case["row"]
            source = case["source"]
            if not isinstance(row, dict) or not isinstance(source, dict):
                raise _SafeFailure()
            gold: dict[str, object] = {
                "version": 2,
                "artifactKind": "historical_review_gold",
                "caseId": case["caseId"],
                "reviewCommentPresent": row["reviewCommentPresent"],
                "evaluationScope": case["evaluationScope"],
            }
            if case["evaluationScope"] == "verdict_and_taste":
                gold.update(
                    {
                        "verdict": case["verdict"],
                        "contestUse": case["contestUse"],
                    }
                )
            else:
                # An originality-only case has no verdict field by construction, so a
                # scorer cannot accidentally include it in pass/reject accuracy.
                gold["sameProblemAsExisting"] = case["sameProblemAsExisting"]
            gold_name = f"{case['caseId']}.json"
            gold_bytes = _write_private_json_at(gold_directory, gold_name, gold)
            gold_artifacts[gold_name] = gold_bytes
            evidence_entries.append(
                {
                    "caseId": case["caseId"],
                    "purpose": case["purpose"],
                    "evaluationScope": case["evaluationScope"],
                    "materializedSourceSha256": case["sourceSha256"],
                    "goldFile": f"gold/{gold_name}",
                    "goldSha256": _sha256(gold_bytes),
                }
            )
            source_bindings.append(
                {
                    "caseId": case["caseId"],
                    "subjectId": case["subjectId"],
                    "sourceId": case["sourceId"],
                    "sourcePath": source["sourcePath"],
                    "sourceSha256": case["sourceSha256"],
                    "rowEvidenceSha256": row["rowEvidenceSha256"],
                }
            )
            if case["purpose"] == "development":
                development_additions.append(
                    {
                        "subjectId": str(case["subjectId"]),
                        "contentSha256": str(case["sourceSha256"]),
                    }
                )
        evidence = {
            "version": 1,
            "artifactKind": "historical_review_gold_evidence",
            "datasetId": dataset_id,
            "entries": evidence_entries,
        }
        evidence_bytes = _write_private_json_at(
            output, "review-gold-evidence.private.json", evidence
        )
        bindings = {
            "version": 1,
            "sourceConfirmationSha256": materialization["sourceConfirmationSha256"],
            "materializationCompleteSha256": materialization["materializationCompleteSha256"],
            "worksheetSha256": _sha256(saved_worksheet_bytes),
            "cases": source_bindings,
        }
        bindings_bytes = _write_private_json_at(
            output, "source-bindings.private.json", bindings
        )
        additions = {
            "version": 1,
            "priorTuningHistorySha256": _sha256(tuning_bytes),
            "developmentSamples": development_additions,
        }
        additions_bytes = _write_private_json_at(
            output, "tuning-history-additions.private.json", additions
        )
        output_artifacts = {
            "review-gold-evidence.private.json": evidence_bytes,
            "source-bindings.private.json": bindings_bytes,
            "tuning-history-additions.private.json": additions_bytes,
        }
        gold_set_sha256 = _sha256(
            _json_compact(
                {
                    "version": 1,
                    "gold": [
                        {"caseId": entry["caseId"], "goldSha256": entry["goldSha256"]}
                        for entry in evidence_entries
                    ],
                }
            )
        )
        marker = {
            "version": 1,
            "phase": "historical_review_gold_evidence",
            "evidenceSha256": _sha256(evidence_bytes),
            "sourceBindingsSha256": _sha256(bindings_bytes),
            "tuningHistorySha256": _sha256(tuning_bytes),
            "tuningHistoryAdditionsSha256": _sha256(additions_bytes),
            "planSha256": _sha256(plan_bytes),
            "goldSetSha256": gold_set_sha256,
            "caseCount": len(cases),
            "developmentCount": sum(1 for case in cases if case["purpose"] == "development"),
            "holdoutCount": sum(1 for case in cases if case["purpose"] == "holdout"),
            "verdictAndTasteCount": sum(
                1 for case in cases if case["evaluationScope"] == "verdict_and_taste"
            ),
            "originalityOnlyCount": sum(
                1 for case in cases if case["evaluationScope"] == "originality_only"
            ),
        }
        _verify_private_artifact_group(gold_directory, gold_artifacts)
        _verify_private_artifact_group(
            output,
            output_artifacts,
            {"gold": gold_directory},
        )
        _verify_private_directory_path(root, gold_directory)
        _verify_private_directory_path(root, output)
        marker_bytes = _write_private_json_at(output, "REVIEW_GOLD_COMPLETE", marker)
        _verify_private_artifact_group(gold_directory, gold_artifacts)
        _verify_private_artifact_group(
            output,
            {**output_artifacts, "REVIEW_GOLD_COMPLETE": marker_bytes},
            {"gold": gold_directory},
        )
        _verify_private_directory_path(root, gold_directory)
        _verify_private_directory_path(root, output)
        return {
            "cases": len(cases),
            "development": sum(1 for case in cases if case["purpose"] == "development"),
            "holdout": sum(1 for case in cases if case["purpose"] == "holdout"),
            "originalityOnly": sum(
                1 for case in cases if case["evaluationScope"] == "originality_only"
            ),
        }
    finally:
        if gold_directory is not None:
            gold_directory.close()
        output.close()


def _arguments(argv: list[str]) -> argparse.Namespace:
    parser = _SafeArgumentParser(add_help=True)
    commands = parser.add_subparsers(dest="command", required=True)
    inspect = commands.add_parser("inspect")
    inspect.add_argument("--private-root", required=True)
    inspect.add_argument("--input", action="append", required=True)
    inspect.add_argument("--out", required=True)
    initialize = commands.add_parser("init")
    initialize.add_argument("--private-root", required=True)
    initialize.add_argument("--input", action="append", required=True)
    initialize.add_argument("--inspection", required=True)
    initialize.add_argument("--layout", required=True)
    initialize.add_argument("--materialized", required=True)
    initialize.add_argument("--out", required=True)
    seal = commands.add_parser("seal")
    seal.add_argument("--private-root", required=True)
    seal.add_argument("--input", action="append", required=True)
    seal.add_argument("--inspection", required=True)
    seal.add_argument("--layout", required=True)
    seal.add_argument("--materialized", required=True)
    seal.add_argument("--worksheet", required=True)
    seal.add_argument("--plan", required=True)
    seal.add_argument("--tuning-history", required=True)
    seal.add_argument("--out", required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        arguments = _arguments(sys.argv[1:] if argv is None else argv)
        if arguments.command == "inspect":
            summary = _command_inspect(arguments)
            sys.stderr.write(
                f"历史审核输入检查完成：{summary['inputs']} 份输入，"
                f"{summary['worksheets']} 个工作表，安全列计数 {summary['columns']}。\n"
            )
        elif arguments.command == "init":
            summary = _command_init(arguments)
            sys.stderr.write(
                f"已生成私有人工复核材料：{summary['rows']} 行，"
                f"{summary['sources']} 个已确认源，{summary['withComments']} 行有审核意见。\n"
            )
        elif arguments.command == "seal":
            summary = _command_seal(arguments)
            sys.stderr.write(
                f"已封存 {summary['cases']} 条人工 Gold：development {summary['development']}，"
                f"holdout {summary['holdout']}，originality_only {summary['originalityOnly']}。\n"
            )
        else:  # pragma: no cover - argparse enforces the command
            raise _SafeFailure()
        return 0
    except (Exception, KeyboardInterrupt, SystemExit) as error:
        if isinstance(error, SystemExit) and error.code == 0:
            raise
        sys.stderr.write("历史审核 Gold 准备失败：输入、确认或输出未通过安全检查。\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
