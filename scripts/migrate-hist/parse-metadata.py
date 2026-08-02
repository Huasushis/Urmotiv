#!/usr/bin/env python3
"""把历史题目 XLSX 清单解析成迁移工具使用的最小私有元数据。

只保留题号、题名、作者学号、状态、比赛和备注。投题者自填难度、
QQ、作者展示名与审核列只用于识别布局，内容从不进入结果。
"""
from __future__ import annotations

import errno
import hashlib
import io
import json
import os
import re
import secrets
import stat
import struct
import sys
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
import zlib
from collections.abc import Iterable
from dataclasses import dataclass


_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_MAX_XLSX_BYTES = 64 * 1024 * 1024
_MAX_ZIP_ENTRIES = 4096
_MAX_ZIP_ENTRY_BYTES = 32 * 1024 * 1024
_MAX_ZIP_EXPANDED_BYTES = 64 * 1024 * 1024
_MAX_ZIP_RATIO = 200
_MAX_ZIP_PATH_LENGTH = 240
_MAX_ZIP_PATH_DEPTH = 16
_MAX_ZIP_SEGMENT_LENGTH = 120
_MAX_SHARED_STRINGS_BYTES = 16 * 1024 * 1024
_MAX_WORKSHEET_BYTES = 32 * 1024 * 1024
_MAX_WORKSHEET_TOTAL_BYTES = 48 * 1024 * 1024
_MAX_WORKSHEETS = 32
_MAX_HEADER_SCAN_ROWS = 20
_MAX_XML_ELEMENTS = 500_000
_MAX_XML_DEPTH = 64
_MAX_SHARED_STRINGS = 100_000
_MAX_SHARED_STRING_CHARS = 100_000
_MAX_SHARED_TOTAL_CHARS = 32 * 1024 * 1024
_MAX_WORKSHEET_ROWS = 10_001
_MAX_CELLS_PER_ROW = 512
_MAX_WORKSHEET_CELLS = 250_000
_MAX_RECORDS = 10_000
# 必须与下游 private-files.ts 的 maximumPrivateJsonBytes 完全一致，避免成功
# 发布一个历史迁移流程随后必定拒绝读取的元数据文件。
_MAX_OUTPUT_JSON_BYTES = 10_000_000
_ALLOWED_COMPRESSION = {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
_FIELD_ORDER = ("number", "name", "authorStudentId", "status", "contest", "note")
_FIELD_LENGTHS = {
    "number": 200,
    "name": 500,
    "authorStudentId": 200,
    "status": 500,
    "contest": 500,
    "note": 10_000,
}
_TRIMMED_FIELDS = frozenset({"number", "name", "authorStudentId"})
_JAVASCRIPT_TRIM_CHARACTERS = (
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)

_SAFE_HEADERS = {
    "number": {"序号", "题号", "编号"},
    "name": {"名称", "题目名称", "题名"},
    "authorStudentId": {"学号", "出题人学号", "投题人学号"},
    "status": {"状态", "题目状态"},
    "contest": {"比赛", "比赛场次", "所属比赛", "使用比赛"},
    "note": {"备注", "说明"},
}
_IGNORED_HEADERS = {
    "难度",
    "自填难度",
    "题目难度",
    "预估难度",
    "预计难度",
    "QQ",
    "QQ号",
    "联系方式",
    "联系电话",
    "手机号",
    "手机",
    "邮箱",
    "电子邮箱",
    "微信",
    "微信号",
    "出题人",
    "出题者",
    "投题人",
    "作者",
}
_REVIEW_SEQUENCE = r"[一二三四五六七八九十0-9]+"
_REVIEW_HEADER = re.compile(
    rf"^(?:(?:审核|审题)(?:意见|结果|备注)?(?:{_REVIEW_SEQUENCE})?"
    rf"|(?:审核|审题)人(?:{_REVIEW_SEQUENCE})?(?:\([\w·-]{{1,32}}\))?"
    rf"|第?{_REVIEW_SEQUENCE}(?:轮|次)?(?:审核|审题)(?:人|意见|结果|备注)?"
    rf"|(?:初审|复审|终审)(?:人|意见|结果|备注)?"
    rf"|后续(?:审核|审题)(?:意见|结果|备注)?)$"
)
_CANONICAL_SHARED_INDEX = re.compile(r"(?:0|[1-9][0-9]*)")
_WORKSHEET_MEMBER = re.compile(r"xl/worksheets/[^/]+\.xml")
_XML_ENCODING = re.compile(
    r"^\s*<\?xml\s+[^?]*\bencoding\s*=\s*(['\"])([^'\"]+)\1[^?]*\?>",
    re.IGNORECASE,
)

_EOCD_SIGNATURE = 0x06054B50
_CENTRAL_SIGNATURE = 0x02014B50
_LOCAL_SIGNATURE = 0x04034B50
_DESCRIPTOR_SIGNATURE = 0x08074B50
_ZIP64_MARKER_16 = 0xFFFF
_ZIP64_MARKER_32 = 0xFFFFFFFF
_ZIP64_EXTRA_ID = 0x0001
_SUPPORTED_COMMON_FLAGS = 0x0808
_DEFLATE_OPTION_FLAGS = 0x0006


class _SafeFailure(Exception):
    """预期的安全拒绝；消息绝不向命令行输出。"""


@dataclass
class _RawZipEntry:
    name: str
    name_bytes: bytes
    version_made: int
    version_needed: int
    flags: int
    method: int
    modified_time: int
    modified_date: int
    crc32: int
    compressed_size: int
    uncompressed_size: int
    internal_attr: int
    external_attr: int
    disk_start: int
    local_offset: int
    central_extra: bytes
    central_comment: bytes
    is_directory: bool
    content: bytes = b""


@dataclass
class _ParseBudget:
    xml_elements: int = 0
    worksheet_rows: int = 0
    worksheet_cells: int = 0


def _normalize_header(value: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", value).strip())


def _col_number(ref: str | None, expected_row: int) -> int:
    match = re.fullmatch(r"([A-Z]+)([1-9][0-9]*)", ref or "")
    if match is None or int(match.group(2)) != expected_row:
        raise _SafeFailure()
    value = 0
    for char in match.group(1):
        value = value * 26 + (ord(char) - 64)
        if value > 1_000_000:
            raise _SafeFailure()
    return value


def _read_regular_file(path: str) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise _SafeFailure() from error
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_size <= 0
            or before.st_size > _MAX_XLSX_BYTES
        ):
            raise _SafeFailure()
        chunks: list[bytes] = []
        remaining = _MAX_XLSX_BYTES + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        os.lseek(descriptor, 0, os.SEEK_SET)
        verification_digest = hashlib.sha256()
        verification_length = 0
        while verification_length <= _MAX_XLSX_BYTES:
            chunk = os.read(
                descriptor,
                min(1024 * 1024, _MAX_XLSX_BYTES + 1 - verification_length),
            )
            if not chunk:
                break
            verification_digest.update(chunk)
            verification_length += len(chunk)
        after = os.fstat(descriptor)
        fingerprint_before = (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        )
        fingerprint_after = (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        )
        if (
            fingerprint_before != fingerprint_after
            or len(data) != before.st_size
            or len(data) > _MAX_XLSX_BYTES
            or verification_length != len(data)
            or verification_digest.digest() != hashlib.sha256(data).digest()
        ):
            raise _SafeFailure()
        return data
    finally:
        os.close(descriptor)


def _find_eocd(data: bytes) -> tuple[int, int, int, int, bytes]:
    if len(data) < 22:
        raise _SafeFailure()
    scan_start = max(0, len(data) - (22 + 65_535))
    candidates: list[int] = []
    for offset in range(len(data) - 22, scan_start - 1, -1):
        if struct.unpack_from("<I", data, offset)[0] != _EOCD_SIGNATURE:
            continue
        comment_length = struct.unpack_from("<H", data, offset + 20)[0]
        if offset + 22 + comment_length == len(data):
            candidates.append(offset)
    if len(candidates) != 1:
        raise _SafeFailure()
    offset = candidates[0]
    (
        signature,
        disk_number,
        central_disk,
        entries_on_disk,
        entry_count,
        central_size,
        central_offset,
        comment_length,
    ) = struct.unpack_from("<I4H2IH", data, offset)
    if (
        signature != _EOCD_SIGNATURE
        or disk_number != 0
        or central_disk != 0
        or entries_on_disk != entry_count
        or entry_count in {0, _ZIP64_MARKER_16}
        or central_size == _ZIP64_MARKER_32
        or central_offset == _ZIP64_MARKER_32
        or entry_count > _MAX_ZIP_ENTRIES
        or central_offset + central_size != offset
    ):
        raise _SafeFailure()
    return (
        offset,
        entry_count,
        central_offset,
        central_size,
        data[offset + 22 : offset + 22 + comment_length],
    )


def _decode_zip_name(name_bytes: bytes, flags: int) -> str:
    try:
        if flags & 0x0800:
            return name_bytes.decode("utf-8")
        if any(byte >= 0x80 for byte in name_bytes):
            raise _SafeFailure()
        return name_bytes.decode("ascii")
    except UnicodeDecodeError as error:
        raise _SafeFailure() from error


def _validate_zip_path(
    name: str,
    *,
    is_directory: bool,
) -> tuple[str, tuple[str, ...]]:
    if is_directory:
        if not name.endswith("/") or name.endswith("//"):
            raise _SafeFailure()
        path = name[:-1]
    else:
        if name.endswith("/"):
            raise _SafeFailure()
        path = name
    normalized = unicodedata.normalize("NFC", path)
    original_parts = tuple(path.split("/"))
    parts = tuple(normalized.split("/"))
    if (
        not normalized
        or len(name) > _MAX_ZIP_PATH_LENGTH
        or len(normalized) > _MAX_ZIP_PATH_LENGTH
        or len(name.encode("utf-8")) > _MAX_ZIP_PATH_LENGTH
        or len(normalized.encode("utf-8")) > _MAX_ZIP_PATH_LENGTH
        or "\\" in normalized
        or normalized.startswith("/")
        or re.match(r"^[A-Za-z]:", normalized) is not None
        or len(parts) > _MAX_ZIP_PATH_DEPTH
        or len(original_parts) > _MAX_ZIP_PATH_DEPTH
        or any(
            not part
            or part in {".", ".."}
            or len(part) > _MAX_ZIP_SEGMENT_LENGTH
            or len(part.encode("utf-8")) > _MAX_ZIP_SEGMENT_LENGTH
            or any(unicodedata.category(char) in {"Cc", "Cf"} for char in part)
            for part in parts
        )
        or any(
            not part
            or part in {".", ".."}
            or len(part) > _MAX_ZIP_SEGMENT_LENGTH
            or len(part.encode("utf-8")) > _MAX_ZIP_SEGMENT_LENGTH
            or any(unicodedata.category(char) in {"Cc", "Cf"} for char in part)
            for part in original_parts
        )
    ):
        raise _SafeFailure()
    return normalized.casefold(), parts


def _reject_zip64_extra(extra: bytes) -> None:
    offset = 0
    while offset < len(extra):
        if offset + 4 > len(extra):
            raise _SafeFailure()
        field_id, field_size = struct.unpack_from("<HH", extra, offset)
        offset += 4
        if offset + field_size > len(extra) or field_id == _ZIP64_EXTRA_ID:
            raise _SafeFailure()
        offset += field_size


def _strict_decompress(entry: _RawZipEntry, compressed: bytes) -> bytes:
    try:
        if entry.method == zipfile.ZIP_STORED:
            content = compressed
        else:
            decompressor = zlib.decompressobj(-15)
            content = decompressor.decompress(compressed, entry.uncompressed_size + 1)
            if decompressor.unconsumed_tail:
                raise _SafeFailure()
            content += decompressor.flush()
            if not decompressor.eof or decompressor.unused_data or decompressor.unconsumed_tail:
                raise _SafeFailure()
    except zlib.error as error:
        raise _SafeFailure() from error
    if (
        len(content) != entry.uncompressed_size
        or len(content) > _MAX_ZIP_ENTRY_BYTES
        or zlib.crc32(content) & 0xFFFFFFFF != entry.crc32
    ):
        raise _SafeFailure()
    return content


def _descriptor_end(data: bytes, offset: int, central_offset: int, entry: _RawZipEntry) -> int:
    expected = (entry.crc32, entry.compressed_size, entry.uncompressed_size)
    if (
        offset + 16 <= central_offset
        and struct.unpack_from("<I", data, offset)[0] == _DESCRIPTOR_SIGNATURE
        and struct.unpack_from("<III", data, offset + 4) == expected
    ):
        return offset + 16
    if offset + 12 <= central_offset and struct.unpack_from("<III", data, offset) == expected:
        return offset + 12
    raise _SafeFailure()


def _validate_raw_zip(data: bytes) -> tuple[list[_RawZipEntry], bytes]:
    if not data or len(data) > _MAX_XLSX_BYTES:
        raise _SafeFailure()
    _, entry_count, central_offset, central_size, archive_comment = _find_eocd(data)
    central_end = central_offset + central_size
    entries: list[_RawZipEntry] = []
    seen_paths: set[str] = set()
    file_paths: set[str] = set()
    directory_paths: set[str] = set()
    parent_paths: set[str] = set()
    cursor = central_offset
    expanded = 0
    for _ in range(entry_count):
        if cursor + 46 > central_end:
            raise _SafeFailure()
        (
            signature,
            version_made,
            version_needed,
            flags,
            method,
            modified_time,
            modified_date,
            crc32,
            compressed_size,
            uncompressed_size,
            name_length,
            extra_length,
            comment_length,
            disk_start,
            internal_attr,
            external_attr,
            local_offset,
        ) = struct.unpack_from("<I6H3I5H2I", data, cursor)
        entry_end = cursor + 46 + name_length + extra_length + comment_length
        if entry_end > central_end:
            raise _SafeFailure()
        name_bytes = data[cursor + 46 : cursor + 46 + name_length]
        extra = data[
            cursor + 46 + name_length : cursor + 46 + name_length + extra_length
        ]
        comment = data[cursor + 46 + name_length + extra_length : entry_end]
        allowed_flags = _SUPPORTED_COMMON_FLAGS | (
            _DEFLATE_OPTION_FLAGS if method == zipfile.ZIP_DEFLATED else 0
        )
        mode = (external_attr >> 16) & 0xFFFF
        mode_type = stat.S_IFMT(mode)
        is_directory = mode_type == stat.S_IFDIR
        if (
            signature != _CENTRAL_SIGNATURE
            or version_needed >= 45
            or flags & ~allowed_flags
            or method not in _ALLOWED_COMPRESSION
            or disk_start != 0
            or compressed_size == _ZIP64_MARKER_32
            or uncompressed_size == _ZIP64_MARKER_32
            or local_offset == _ZIP64_MARKER_32
            or uncompressed_size > _MAX_ZIP_ENTRY_BYTES
            or (compressed_size == 0 and uncompressed_size > 0)
            or (
                uncompressed_size > 0
                and uncompressed_size / max(1, compressed_size) > _MAX_ZIP_RATIO
            )
            or (method == zipfile.ZIP_STORED and compressed_size != uncompressed_size)
            or mode_type not in {0, stat.S_IFREG, stat.S_IFDIR}
            or (
                is_directory
                and (
                    method != zipfile.ZIP_STORED
                    or flags & 0x0008
                    or crc32 != 0
                    or compressed_size != 0
                    or uncompressed_size != 0
                )
            )
        ):
            raise _SafeFailure()
        _reject_zip64_extra(extra)
        name = _decode_zip_name(name_bytes, flags)
        folded, parts = _validate_zip_path(name, is_directory=is_directory)
        if folded in seen_paths:
            raise _SafeFailure()
        parents = tuple("/".join(parts[:index]).casefold() for index in range(1, len(parts)))
        if any(parent in file_paths for parent in parents):
            raise _SafeFailure()
        if is_directory:
            directory_paths.add(folded)
        else:
            if folded in directory_paths or folded in parent_paths:
                raise _SafeFailure()
            file_paths.add(folded)
        seen_paths.add(folded)
        parent_paths.update(parents)
        expanded += uncompressed_size
        if (
            expanded > _MAX_ZIP_EXPANDED_BYTES
            or expanded / max(1, len(data)) > _MAX_ZIP_RATIO
        ):
            raise _SafeFailure()
        entries.append(
            _RawZipEntry(
                name=name,
                name_bytes=name_bytes,
                version_made=version_made,
                version_needed=version_needed,
                flags=flags,
                method=method,
                modified_time=modified_time,
                modified_date=modified_date,
                crc32=crc32,
                compressed_size=compressed_size,
                uncompressed_size=uncompressed_size,
                internal_attr=internal_attr,
                external_attr=external_attr,
                disk_start=disk_start,
                local_offset=local_offset,
                central_extra=extra,
                central_comment=comment,
                is_directory=is_directory,
            )
        )
        cursor = entry_end
    if cursor != central_end:
        raise _SafeFailure()

    expected_offset = 0
    for entry in sorted(entries, key=lambda item: item.local_offset):
        if entry.local_offset != expected_offset or entry.local_offset + 30 > central_offset:
            raise _SafeFailure()
        (
            signature,
            version_needed,
            flags,
            method,
            modified_time,
            modified_date,
            crc32,
            compressed_size,
            uncompressed_size,
            name_length,
            extra_length,
        ) = struct.unpack_from("<I5H3I2H", data, entry.local_offset)
        name_start = entry.local_offset + 30
        data_start = name_start + name_length + extra_length
        data_end = data_start + entry.compressed_size
        if data_start > central_offset or data_end > central_offset:
            raise _SafeFailure()
        local_name = data[name_start : name_start + name_length]
        local_extra = data[name_start + name_length : data_start]
        _reject_zip64_extra(local_extra)
        if (
            signature != _LOCAL_SIGNATURE
            or version_needed != entry.version_needed
            or flags != entry.flags
            or method != entry.method
            or modified_time != entry.modified_time
            or modified_date != entry.modified_date
            or local_name != entry.name_bytes
        ):
            raise _SafeFailure()
        local_values = (crc32, compressed_size, uncompressed_size)
        central_values = (entry.crc32, entry.compressed_size, entry.uncompressed_size)
        if entry.flags & 0x0008:
            if local_values != (0, 0, 0) and local_values != central_values:
                raise _SafeFailure()
            expected_offset = _descriptor_end(data, data_end, central_offset, entry)
        else:
            if local_values != central_values:
                raise _SafeFailure()
            expected_offset = data_end
        entry.content = _strict_decompress(entry, data[data_start:data_end])
    if expected_offset != central_offset:
        raise _SafeFailure()
    return entries, archive_comment


def _safe_zip_members(data: bytes) -> dict[str, bytes]:
    raw_entries, archive_comment = _validate_raw_zip(data)
    try:
        with zipfile.ZipFile(io.BytesIO(data), allowZip64=False) as archive:
            infos = archive.infolist()
            if len(infos) != len(raw_entries) or archive.comment != archive_comment:
                raise _SafeFailure()
            members: dict[str, bytes] = {}
            for info, raw in zip(infos, raw_entries, strict=True):
                if (
                    info.filename != raw.name
                    or info.orig_filename != raw.name
                    or info.header_offset != raw.local_offset
                    or info.flag_bits != raw.flags
                    or info.compress_type != raw.method
                    or info.CRC != raw.crc32
                    or info.compress_size != raw.compressed_size
                    or info.file_size != raw.uncompressed_size
                    or info.extract_version != raw.version_needed
                    or ((info.create_system << 8) | info.create_version) != raw.version_made
                    or info.internal_attr != raw.internal_attr
                    or info.external_attr != raw.external_attr
                    or info.volume != raw.disk_start
                    or info.extra != raw.central_extra
                    or info.comment != raw.central_comment
                    or info.is_dir() != raw.is_directory
                ):
                    raise _SafeFailure()
                if raw.is_directory:
                    if raw.content:
                        raise _SafeFailure()
                    continue
                with archive.open(info, "r") as member:
                    content = member.read(_MAX_ZIP_ENTRY_BYTES + 1)
                    if member.read(1):
                        raise _SafeFailure()
                if content != raw.content:
                    raise _SafeFailure()
                members[raw.name] = content
            return members
    except _SafeFailure:
        raise
    except (
        EOFError,
        NotImplementedError,
        OSError,
        RuntimeError,
        ValueError,
        zipfile.BadZipFile,
        zipfile.LargeZipFile,
    ) as error:
        raise _SafeFailure() from error


def _strict_utf8_xml(content: bytes, maximum: int) -> str:
    if not content or len(content) > maximum:
        raise _SafeFailure()
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise _SafeFailure() from error
    upper = text.upper()
    if "<!DOCTYPE" in upper or "<!ENTITY" in upper:
        raise _SafeFailure()
    declaration = _XML_ENCODING.match(text)
    if declaration is not None and declaration.group(2).upper().replace("_", "-") not in {
        "UTF-8",
        "UTF8",
    }:
        raise _SafeFailure()
    return text


def _bounded_events(text: str, budget: _ParseBudget | None = None):
    depth = 0
    active_budget = budget if budget is not None else _ParseBudget()
    try:
        for event, element in ET.iterparse(io.StringIO(text), events=("start", "end")):
            if event == "start":
                depth += 1
                active_budget.xml_elements += 1
                if (
                    depth > _MAX_XML_DEPTH
                    or active_budget.xml_elements > _MAX_XML_ELEMENTS
                ):
                    raise _SafeFailure()
            yield event, element, depth
            if event == "end":
                depth -= 1
        if depth != 0:
            raise _SafeFailure()
    except _SafeFailure:
        raise
    except (ET.ParseError, RecursionError, ValueError) as error:
        raise _SafeFailure() from error


def _parse_shared_strings(
    content: bytes,
    budget: _ParseBudget | None = None,
) -> list[str]:
    text = _strict_utf8_xml(content, _MAX_SHARED_STRINGS_BYTES)
    shared: list[str] = []
    root_seen = False
    current_parts: list[str] | None = None
    current_depth = 0
    current_chars = 0
    total_chars = 0
    for event, element, depth in _bounded_events(text, budget):
        if event == "start":
            if not root_seen:
                if element.tag != f"{_NS}sst" or depth != 1:
                    raise _SafeFailure()
                root_seen = True
            if element.tag == f"{_NS}si":
                if depth != 2 or current_parts is not None:
                    raise _SafeFailure()
                current_parts = []
                current_depth = depth
                current_chars = 0
            continue
        if current_parts is not None and element.tag == f"{_NS}t":
            piece = element.text or ""
            current_chars += len(piece)
            if current_chars > _MAX_SHARED_STRING_CHARS:
                raise _SafeFailure()
            current_parts.append(piece)
        if element.tag == f"{_NS}si":
            if current_parts is None or depth != current_depth:
                raise _SafeFailure()
            value = "".join(current_parts)
            total_chars += len(value)
            if len(shared) >= _MAX_SHARED_STRINGS or total_chars > _MAX_SHARED_TOTAL_CHARS:
                raise _SafeFailure()
            shared.append(value)
            current_parts = None
        element.clear()
    if not root_seen or current_parts is not None:
        raise _SafeFailure()
    return shared


def _cell_text(cell: ET.Element, shared: list[str]) -> str:
    cell_type = cell.get("t")
    if cell_type == "inlineStr":
        inline = cell.find(f"{_NS}is")
        return "" if inline is None else "".join(node.text or "" for node in inline.iter(f"{_NS}t"))
    value = cell.find(f"{_NS}v")
    text = value.text if value is not None else ""
    if cell_type == "s":
        if not text:
            return ""
        if _CANONICAL_SHARED_INDEX.fullmatch(text or "") is None:
            raise _SafeFailure()
        index = int(text)
        if index < 0 or index >= len(shared):
            raise _SafeFailure()
        return shared[index]
    return text or ""


def _row_cells(row: ET.Element, shared: list[str]) -> dict[int, str]:
    row_ref = row.get("r")
    if row_ref is None or re.fullmatch(r"[1-9][0-9]*", row_ref) is None:
        raise _SafeFailure()
    row_number = int(row_ref)
    result: dict[int, str] = {}
    for cell in row.findall(f"{_NS}c"):
        column = _col_number(cell.get("r"), row_number)
        if column in result:
            raise _SafeFailure()
        result[column] = _cell_text(cell, shared)
    return result


def _inspect_header_cells(
    cells: dict[int, str],
) -> tuple[dict[str, int] | None, int, int]:
    aliases = {
        _normalize_header(alias): field
        for field, values in _SAFE_HEADERS.items()
        for alias in values
    }
    mapping: dict[str, int] = {}
    seen_headers: set[str] = set()
    duplicate = False
    unknown = 0
    recognized = 0
    nonempty = 0
    for column, raw_header in cells.items():
        header = _normalize_header(raw_header)
        if not header:
            continue
        nonempty += 1
        if header in seen_headers:
            duplicate = True
            continue
        seen_headers.add(header)
        field = aliases.get(header)
        if field is not None:
            recognized += 1
            if field in mapping:
                duplicate = True
                continue
            mapping[field] = column
            continue
        if header in _IGNORED_HEADERS or _REVIEW_HEADER.fullmatch(header):
            recognized += 1
            continue
        unknown += 1
    if set(mapping) == set(_SAFE_HEADERS):
        if duplicate or unknown:
            raise _SafeFailure()
        return mapping, nonempty, recognized
    return None, nonempty, recognized


def _parse_worksheet(
    content: bytes,
    shared: list[str],
    budget: _ParseBudget | None = None,
) -> list[dict[str, str]] | None:
    text = _strict_utf8_xml(content, _MAX_WORKSHEET_BYTES)
    active_budget = budget if budget is not None else _ParseBudget()
    root_seen = False
    sheet_data_depth: int | None = None
    sheet_data_count = 0
    row_depth: int | None = None
    worksheet_row_count = 0
    row_references: set[str] = set()
    mapping: dict[str, int] | None = None
    records: list[dict[str, str]] = []
    record_numbers: set[str] = set()
    for event, element, depth in _bounded_events(text, active_budget):
        if event == "start":
            if not root_seen:
                if element.tag != f"{_NS}worksheet" or depth != 1:
                    raise _SafeFailure()
                root_seen = True
            if element.tag == f"{_NS}sheetData":
                if depth != 2 or sheet_data_depth is not None or sheet_data_count != 0:
                    raise _SafeFailure()
                sheet_data_depth = depth
                sheet_data_count = 1
            elif element.tag == f"{_NS}row":
                if (
                    sheet_data_depth is None
                    or depth != sheet_data_depth + 1
                    or row_depth is not None
                ):
                    raise _SafeFailure()
                worksheet_row_count += 1
                active_budget.worksheet_rows += 1
                if active_budget.worksheet_rows > _MAX_WORKSHEET_ROWS:
                    raise _SafeFailure()
                row_depth = depth
            elif element.tag == f"{_NS}c":
                if row_depth is None or depth != row_depth + 1:
                    raise _SafeFailure()
                active_budget.worksheet_cells += 1
                if active_budget.worksheet_cells > _MAX_WORKSHEET_CELLS:
                    raise _SafeFailure()
            continue

        if element.tag == f"{_NS}row":
            if row_depth is None or depth != row_depth:
                raise _SafeFailure()
            cells = element.findall(f"{_NS}c")
            if len(cells) > _MAX_CELLS_PER_ROW:
                raise _SafeFailure()
            row_reference = element.get("r")
            if row_reference is None or row_reference in row_references:
                raise _SafeFailure()
            row_references.add(row_reference)
            values = _row_cells(element, shared)
            if mapping is None:
                if worksheet_row_count <= _MAX_HEADER_SCAN_ROWS:
                    candidate, nonempty, recognized = _inspect_header_cells(values)
                    if candidate is not None:
                        mapping = candidate
                    elif nonempty > 1 or recognized > 0:
                        raise _SafeFailure()
            else:
                candidate, _, _ = _inspect_header_cells(values)
                if candidate is not None:
                    raise _SafeFailure()
                record = {
                    field: (
                        _javascript_trim(values.get(mapping[field], ""))
                        if field in _TRIMMED_FIELDS
                        else values.get(mapping[field], "")
                    )
                    for field in _FIELD_ORDER
                }
                if any(record.values()):
                    if not record["number"] or not record["name"]:
                        raise _SafeFailure()
                    if any(
                        _javascript_string_length(record[field]) > _FIELD_LENGTHS[field]
                        for field in _FIELD_ORDER
                    ):
                        raise _SafeFailure()
                    if record["number"] in record_numbers or len(records) >= _MAX_RECORDS:
                        raise _SafeFailure()
                    record_numbers.add(record["number"])
                    records.append(record)
            row_depth = None
            element.clear()
        elif element.tag == f"{_NS}sheetData":
            if sheet_data_depth is None or depth != sheet_data_depth:
                raise _SafeFailure()
            sheet_data_depth = None
            element.clear()
        elif row_depth is None:
            element.clear()
    if not root_seen or sheet_data_count != 1 or sheet_data_depth is not None or row_depth is not None:
        raise _SafeFailure()
    if mapping is None:
        return None
    if not records:
        raise _SafeFailure()
    return records


def _javascript_string_length(value: str) -> int:
    """返回 Zod/JavaScript 使用的 UTF-16 代码单元数量。"""
    return len(value.encode("utf-16-le")) // 2


def _javascript_trim(value: str) -> str:
    """与当前 Node.js String.prototype.trim 使用同一组空白字符。"""
    return value.strip(_JAVASCRIPT_TRIM_CHARACTERS)


def _parse_records(data: bytes) -> list[dict[str, str]]:
    members = _safe_zip_members(data)
    worksheets = sorted(
        (
            (name, content)
            for name, content in members.items()
            if _WORKSHEET_MEMBER.fullmatch(name)
        ),
        key=lambda item: (unicodedata.normalize("NFC", item[0]).casefold(), item[0]),
    )
    if (
        not worksheets
        or len(worksheets) > _MAX_WORKSHEETS
        or sum(len(content) for _, content in worksheets) > _MAX_WORKSHEET_TOTAL_BYTES
    ):
        raise _SafeFailure()
    budget = _ParseBudget()
    shared_bytes = members.get("xl/sharedStrings.xml")
    shared = (
        []
        if shared_bytes is None
        else _parse_shared_strings(shared_bytes, budget)
    )
    candidates: list[list[dict[str, str]]] = []
    for _, content in worksheets:
        records = _parse_worksheet(content, shared, budget)
        if records is not None:
            candidates.append(records)
            if len(candidates) > 1:
                raise _SafeFailure()
    if len(candidates) != 1:
        raise _SafeFailure()
    return candidates[0]


def _merge_record_batches(
    batches: Iterable[list[dict[str, str]]],
) -> list[dict[str, str]]:
    """按命令行输入顺序及表内行顺序合并，并跨文件复核题号。"""
    merged: list[dict[str, str]] = []
    numbers: set[str] = set()
    for batch in batches:
        if len(merged) + len(batch) > _MAX_RECORDS:
            raise _SafeFailure()
        for record in batch:
            number = record["number"]
            if number in numbers:
                raise _SafeFailure()
            numbers.add(number)
            merged.append(record)
    if not merged:
        raise _SafeFailure()
    return merged


def _encode_private_json(value: object) -> bytes:
    try:
        encoded = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    except (TypeError, UnicodeError, ValueError) as error:
        raise _SafeFailure() from error
    if len(encoded) > _MAX_OUTPUT_JSON_BYTES:
        raise _SafeFailure()
    return encoded


def _write_new_private_json(path: str, value: object) -> None:
    encoded = _encode_private_json(value)
    parent = os.path.dirname(os.path.abspath(path))
    name = os.path.basename(path)
    if not name or name in {".", ".."}:
        raise _SafeFailure()
    temporary_name = f".parse-metadata-{secrets.token_hex(16)}.tmp"
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        directory_fd = os.open(parent, flags)
    except OSError as error:
        raise _SafeFailure() from error
    temporary_fd: int | None = None
    published_fd: int | None = None
    linked = False
    try:
        directory_metadata = os.fstat(directory_fd)
        if (
            not stat.S_ISDIR(directory_metadata.st_mode)
            or directory_metadata.st_uid != os.geteuid()
            or stat.S_IMODE(directory_metadata.st_mode) & 0o077
        ):
            raise _SafeFailure()
        temporary_fd = os.open(
            temporary_name,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=directory_fd,
        )
        os.fchmod(temporary_fd, 0o600)
        offset = 0
        while offset < len(encoded):
            written = os.write(temporary_fd, encoded[offset:])
            if written <= 0:
                raise _SafeFailure()
            offset += written
        os.fsync(temporary_fd)
        temporary_metadata = os.fstat(temporary_fd)
        if (
            not stat.S_ISREG(temporary_metadata.st_mode)
            or stat.S_IMODE(temporary_metadata.st_mode) != 0o600
            or temporary_metadata.st_size != len(encoded)
        ):
            raise _SafeFailure()
        try:
            os.link(
                temporary_name,
                name,
                src_dir_fd=directory_fd,
                dst_dir_fd=directory_fd,
                follow_symlinks=False,
            )
            linked = True
        except OSError as error:
            if error.errno == errno.EEXIST:
                raise _SafeFailure() from error
            raise
        published_fd = os.open(
            name,
            os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=directory_fd,
        )
        published_metadata = os.fstat(published_fd)
        if (
            published_metadata.st_dev != temporary_metadata.st_dev
            or published_metadata.st_ino != temporary_metadata.st_ino
            or not stat.S_ISREG(published_metadata.st_mode)
            or stat.S_IMODE(published_metadata.st_mode) != 0o600
            or published_metadata.st_size != temporary_metadata.st_size
        ):
            raise _SafeFailure()
        os.fsync(published_fd)
        os.unlink(temporary_name, dir_fd=directory_fd)
        os.fsync(directory_fd)
    except Exception as error:
        if linked:
            try:
                os.unlink(name, dir_fd=directory_fd)
            except OSError:
                pass
        if isinstance(error, _SafeFailure):
            raise
        raise _SafeFailure() from error
    finally:
        if published_fd is not None:
            try:
                os.close(published_fd)
            except OSError:
                pass
        if temporary_fd is not None:
            try:
                os.close(temporary_fd)
            except OSError:
                pass
        try:
            os.unlink(temporary_name, dir_fd=directory_fd)
        except OSError:
            pass
        os.close(directory_fd)


def main() -> int:
    if len(sys.argv) < 3:
        sys.stderr.write(
            "用法：python3 parse-metadata.py <xlsx> [<xlsx> ...] <out.json>\n"
        )
        return 2
    try:
        records = _merge_record_batches(
            _parse_records(_read_regular_file(path)) for path in sys.argv[1:-1]
        )
        _write_new_private_json(sys.argv[-1], {"records": records})
    except Exception:
        # 固定错误，不包含私有路径、工作表条目名或解析器原始异常。
        sys.stderr.write("历史题目元数据解析失败：输入、布局或输出未通过安全检查。\n")
        return 1
    sys.stderr.write(f"已写出 {len(records)} 条安全元数据。\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
