from __future__ import annotations

import importlib.util
import io
import json
import os
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
import zlib
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).with_name("parse-metadata.py")
SPREADSHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
PARSER_SPEC = importlib.util.spec_from_file_location("urmotiv_parse_metadata_tested", SCRIPT)
if PARSER_SPEC is None or PARSER_SPEC.loader is None:
    raise RuntimeError("cannot load synthetic metadata parser")
PARSER = importlib.util.module_from_spec(PARSER_SPEC)
sys.modules[PARSER_SPEC.name] = PARSER
PARSER_SPEC.loader.exec_module(PARSER)
SAFE_HEADERS = ["序号", "名称", "难度", "出题人", "学号", "QQ", "状态", "比赛", "备注", "审核意见一"]
SAFE_ROW = [
    "synthetic-001",
    "Synthetic title mentioning 3200",
    "SYNTHETIC SELF-REPORTED 3500",
    "Synthetic author",
    "SYNTHETIC-STUDENT",
    "SYNTHETIC-QQ",
    "Synthetic status",
    "Synthetic contest",
    "Synthetic private note",
    "SYNTHETIC REVIEW OPINION A",
]


class _UnseekableBuffer(io.RawIOBase):
    def __init__(self) -> None:
        self._buffer = io.BytesIO()

    def writable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return False

    def write(self, content: bytes) -> int:
        return self._buffer.write(content)

    def tell(self) -> int:
        return self._buffer.tell()

    def getvalue(self) -> bytes:
        return self._buffer.getvalue()


class ParseMetadataTest(unittest.TestCase):
    def test_layout_is_header_driven_and_private_columns_are_omitted(self) -> None:
        order = [6, 1, 9, 4, 0, 8, 2, 7, 3, 5]
        headers = [SAFE_HEADERS[index] for index in order]
        values = [SAFE_ROW[index] for index in order]
        with tempfile.TemporaryDirectory(prefix="urmotiv-metadata-test-") as directory:
            root = Path(directory)
            source = root / "synthetic.xlsx"
            output = root / "metadata.json"
            self._write_xlsx(source, headers, values)

            completed = self._run(source, output)

            self.assertEqual(completed.returncode, 0, completed.stderr)
            parsed = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(
                parsed["records"],
                [
                    {
                        "number": "synthetic-001",
                        "name": "Synthetic title mentioning 3200",
                        "authorStudentId": "SYNTHETIC-STUDENT",
                        "status": "Synthetic status",
                        "contest": "Synthetic contest",
                        "note": "Synthetic private note",
                    }
                ],
            )
            serialized = json.dumps(parsed, ensure_ascii=False)
            self.assertNotIn("SYNTHETIC SELF-REPORTED 3500", serialized)
            self.assertNotIn("SYNTHETIC-QQ", serialized)
            self.assertNotIn("SYNTHETIC REVIEW OPINION", serialized)
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)

    def test_multiple_xlsx_inputs_merge_stably_and_reject_cross_file_duplicates(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-metadata-multiple-") as directory:
            root = Path(directory)
            first = root / "first.xlsx"
            second = root / "second.xlsx"
            first_row = [*SAFE_ROW]
            second_row = [*SAFE_ROW]
            second_row[0] = "synthetic-002"
            second_row[1] = "Synthetic second title"
            self._write_xlsx(first, SAFE_HEADERS, first_row)
            self._write_xlsx(second, SAFE_HEADERS, second_row)
            output = root / "merged.json"

            completed = self._run([second, first], output)

            self.assertEqual(completed.returncode, 0, completed.stderr)
            records = json.loads(output.read_text(encoding="utf-8"))["records"]
            self.assertEqual(
                [record["number"] for record in records],
                ["synthetic-002", "synthetic-001"],
            )
            self.assertTrue(
                all(
                    set(record)
                    == {"number", "name", "authorStudentId", "status", "contest", "note"}
                    for record in records
                )
            )
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)

            duplicate_row = [*second_row]
            duplicate_row[0] = first_row[0]
            self._write_xlsx(second, SAFE_HEADERS, duplicate_row)
            duplicate_output = root / "duplicate.json"
            failed = self._run([first, second], duplicate_output)
            self._assert_fixed_failure(failed, [str(first), str(second)])
            self.assertFalse(duplicate_output.exists())

            with mock.patch.object(PARSER, "_MAX_RECORDS", 1):
                with self.assertRaises(PARSER._SafeFailure):
                    PARSER._merge_record_batches([[records[0]], [records[1]]])

    def test_multiple_xlsx_inputs_over_10mb_do_not_publish_output(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-metadata-output-limit-") as directory:
            root = Path(directory)
            first = root / "first.xlsx"
            second = root / "second.xlsx"
            large_note = "N" * 9_990

            def rows(start: int) -> list[list[str]]:
                result: list[list[str]] = []
                for index in range(start, start + 505):
                    row = [*SAFE_ROW]
                    row[0] = f"synthetic-{index:04d}"
                    row[8] = large_note
                    result.append(row)
                return result

            self._write_xlsx_rows(first, SAFE_HEADERS, rows(0))
            self._write_xlsx_rows(second, SAFE_HEADERS, rows(505))
            output = root / "oversized-merged.json"

            completed = self._run([first, second], output)

            self._assert_fixed_failure(completed, [str(first), str(second)])
            self.assertFalse(output.exists())

    def test_unknown_duplicate_and_missing_headers_fail_without_output(self) -> None:
        cases = [
            ([*SAFE_HEADERS, "未知私有列"], [*SAFE_ROW, "private"]),
            (["题号", "序号", *SAFE_HEADERS[1:]], ["x", *SAFE_ROW]),
            ([header for header in SAFE_HEADERS if header != "学号"], [value for index, value in enumerate(SAFE_ROW) if index != 4]),
        ]
        for headers, values in cases:
            with self.subTest(headers=headers), tempfile.TemporaryDirectory(prefix="urmotiv-metadata-layout-") as directory:
                root = Path(directory)
                source = root / "synthetic.xlsx"
                output = root / "metadata.json"
                self._write_xlsx(source, headers, values)
                completed = self._run(source, output)
                self.assertEqual(completed.returncode, 1)
                self.assertFalse(output.exists())

    def test_output_is_new_only_private_and_failure_leaves_no_temporary_file(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-metadata-output-") as directory:
            root = Path(directory)
            source = root / "synthetic.xlsx"
            output = root / "metadata.json"
            self._write_xlsx(source, SAFE_HEADERS, SAFE_ROW)
            output.write_text("KEEP", encoding="utf-8")
            completed = self._run(source, output)
            self.assertEqual(completed.returncode, 1)
            self.assertEqual(output.read_text(encoding="utf-8"), "KEEP")
            self.assertEqual(list(root.glob(".parse-metadata-*.tmp")), [])

            output.unlink()
            target = root / "existing-target"
            target.write_text("KEEP TARGET", encoding="utf-8")
            output.symlink_to(target)
            completed = self._run(source, output)
            self.assertEqual(completed.returncode, 1)
            self.assertTrue(output.is_symlink())
            self.assertEqual(target.read_text(encoding="utf-8"), "KEEP TARGET")
            self.assertEqual(list(root.glob(".parse-metadata-*.tmp")), [])

    def test_input_change_and_output_link_race_are_rejected_and_cleaned(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-metadata-race-") as directory:
            root = Path(directory)
            source = root / "synthetic.xlsx"
            output = root / "metadata.json"
            self._write_xlsx(source, SAFE_HEADERS, SAFE_ROW)

            real_read = PARSER.os.read
            changed = False

            def changing_read(descriptor: int, length: int) -> bytes:
                nonlocal changed
                content = real_read(descriptor, length)
                if content and not changed:
                    changed = True
                    replacement = bytearray(source.read_bytes())
                    replacement[0] ^= 0x01
                    source.write_bytes(replacement)
                return content

            with mock.patch.object(PARSER.os, "read", changing_read):
                with self.assertRaises(PARSER._SafeFailure):
                    PARSER._read_regular_file(str(source))

            real_link = PARSER.os.link

            def replacing_link(
                source_name: str,
                destination_name: str,
                *,
                src_dir_fd: int,
                dst_dir_fd: int,
                follow_symlinks: bool,
            ) -> None:
                os.unlink(source_name, dir_fd=src_dir_fd)
                attacker = os.open(
                    source_name,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o600,
                    dir_fd=src_dir_fd,
                )
                try:
                    os.write(attacker, b"ATTACKER")
                finally:
                    os.close(attacker)
                real_link(
                    source_name,
                    destination_name,
                    src_dir_fd=src_dir_fd,
                    dst_dir_fd=dst_dir_fd,
                    follow_symlinks=follow_symlinks,
                )

            with mock.patch.object(PARSER.os, "link", replacing_link):
                with self.assertRaises(PARSER._SafeFailure):
                    PARSER._write_new_private_json(str(output), {"records": [{"safe": True}]})
            self.assertFalse(output.exists())
            self.assertEqual(list(root.glob(".parse-metadata-*.tmp")), [])

    def test_input_symlink_and_xml_entities_are_rejected_with_fixed_error(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-metadata-input-") as directory:
            root = Path(directory)
            actual = root / "sensitive-private-name.xlsx"
            linked = root / "linked-private-name.xlsx"
            output = root / "metadata.json"
            self._write_xlsx(actual, SAFE_HEADERS, SAFE_ROW)
            linked.symlink_to(actual)
            completed = self._run(linked, output)
            self._assert_fixed_failure(completed, [str(actual), str(linked)])
            self.assertFalse(output.exists())

            xml = f'<!DOCTYPE x [<!ENTITY leak "secret">]><worksheet xmlns="{SPREADSHEET_NS}"><sheetData /></worksheet>'
            self._write_members(actual, {"xl/worksheets/sheet1.xml": xml.encode()})
            completed = self._run(actual, output)
            self._assert_fixed_failure(completed, ["sheet1.xml", str(actual)])

    def test_unsafe_zip_shapes_and_corrupt_crc_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-metadata-zip-") as directory:
            root = Path(directory)
            base = root / "base.xlsx"
            self._write_xlsx(base, SAFE_HEADERS, SAFE_ROW, compression=zipfile.ZIP_STORED)
            base_bytes = base.read_bytes()
            cases: dict[str, bytes] = {
                "traversal": self._xlsx_with_extra("../private-entry", b"x"),
                "windows-absolute": self._xlsx_with_extra("C:/private-entry", b"x"),
                "control-path": self._xlsx_with_extra("synthetic-\x01-private", b"x"),
                "unicode-control-path": self._xlsx_with_extra("synthetic-\x85-private", b"x"),
                "deep-path": self._xlsx_with_extra("/".join(["d"] * 17), b"x"),
                "long-path": self._xlsx_with_extra("x" * 241, b"x"),
                "long-utf8-path": self._xlsx_with_extra("界" * 81, b"x"),
                "duplicate": self._xlsx_with_casefold_duplicate(),
                "unicode-duplicate": self._xlsx_with_unicode_duplicate(),
                "symlink": self._xlsx_with_symlink(),
                "device": self._xlsx_with_device(),
                "encrypted": self._patch_first_flags(base_bytes, 0x1),
                "zip64": self._xlsx_with_zip64_marker(),
                "unsupported": self._xlsx_with_unsupported_compression(),
                "ratio": self._xlsx_with_ratio_bomb(),
                "crc": self._corrupt_first_member(base_bytes),
            }
            for case, content in cases.items():
                with self.subTest(case=case):
                    source = root / f"{case}-private.xlsx"
                    output = root / f"{case}.json"
                    source.write_bytes(content)
                    completed = self._run(source, output)
                    self._assert_fixed_failure(completed, [case, str(source), "xl/"])
                    self.assertFalse(output.exists())

    def test_raw_zip64_descriptor_and_local_header_mismatches_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-metadata-raw-zip-") as directory:
            root = Path(directory)
            base = root / "base.xlsx"
            self._write_xlsx(base, SAFE_HEADERS, SAFE_ROW)
            base_bytes = base.read_bytes()
            descriptor_bytes = self._xlsx_with_data_descriptors()
            unsigned_descriptor_bytes = self._xlsx_with_unsigned_descriptors()
            unsigned_source = root / "valid-unsigned-descriptor.xlsx"
            unsigned_output = root / "valid-unsigned-descriptor.json"
            unsigned_source.write_bytes(unsigned_descriptor_bytes)
            valid_unsigned = self._run(unsigned_source, unsigned_output)
            self.assertEqual(valid_unsigned.returncode, 0, valid_unsigned.stderr)
            cases = {
                "archive-zip64": self._add_archive_level_zip64(base_bytes),
                "descriptor-crc": self._corrupt_first_descriptor(descriptor_bytes),
                "unsigned-descriptor-crc": self._corrupt_first_unsigned_descriptor(
                    unsigned_descriptor_bytes
                ),
                "local-flags": self._patch_first_local_u16(base_bytes, 6, 0x0008),
                "local-method": self._set_first_local_u16(base_bytes, 8, zipfile.ZIP_STORED),
                "local-name": self._corrupt_first_local_name(base_bytes),
                "local-crc": self._increment_first_local_u32(base_bytes, 14),
                "local-size": self._increment_first_local_u32(base_bytes, 22),
                "local-offset": self._increment_first_central_u32(base_bytes, 42),
            }
            for case, content in cases.items():
                with self.subTest(case=case):
                    source = root / f"{case}.xlsx"
                    output = root / f"{case}.json"
                    source.write_bytes(content)
                    completed = self._run(source, output)
                    self._assert_fixed_failure(completed, [case, str(source), "xl/"])
                    self.assertFalse(output.exists())

    def test_utf16_entities_and_negative_shared_indices_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-metadata-xml-safety-") as directory:
            root = Path(directory)
            cases = {
                "utf16-entity": self._xlsx_with_utf16_entity(),
                "negative-index": self._xlsx_with_negative_shared_index(),
            }
            for case, content in cases.items():
                with self.subTest(case=case):
                    source = root / f"{case}.xlsx"
                    output = root / f"{case}.json"
                    source.write_bytes(content)
                    completed = self._run(source, output)
                    self._assert_fixed_failure(completed, [case, str(source), "xl/"])
                    self.assertFalse(output.exists())

    def test_zip_and_xml_resource_limits_fail_before_output_amplification(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-metadata-limits-") as directory:
            root = Path(directory)
            source = root / "synthetic.xlsx"
            rows = [
                [f"synthetic-{index}", "title", "difficulty", "author", "student", "qq", "status", "contest", "N" * 100, "review"]
                for index in range(3)
            ]
            self._write_xlsx_rows(source, SAFE_HEADERS, rows)
            data = source.read_bytes()

            limit_cases = [
                ("_MAX_ZIP_ENTRIES", 1),
                ("_MAX_ZIP_ENTRY_BYTES", 128),
                ("_MAX_ZIP_EXPANDED_BYTES", 256),
                ("_MAX_XML_ELEMENTS", 8),
                ("_MAX_XML_DEPTH", 2),
                ("_MAX_WORKSHEET_ROWS", 2),
                ("_MAX_CELLS_PER_ROW", 5),
                ("_MAX_WORKSHEET_CELLS", 10),
                ("_MAX_SHARED_STRINGS", 2),
                ("_MAX_SHARED_STRING_CHARS", 50),
                ("_MAX_SHARED_TOTAL_CHARS", 100),
                ("_MAX_RECORDS", 1),
            ]
            for attribute, limit in limit_cases:
                with self.subTest(limit=attribute), mock.patch.object(PARSER, attribute, limit):
                    with self.assertRaises(PARSER._SafeFailure):
                        PARSER._parse_records(data)

            records = PARSER._parse_records(data)
            with mock.patch.object(PARSER, "_MAX_OUTPUT_JSON_BYTES", 256):
                with self.assertRaises(PARSER._SafeFailure):
                    PARSER._encode_private_json({"records": records})

            oversized_field = [*SAFE_ROW]
            oversized_field[1] = "x" * 501
            self._write_xlsx(source, SAFE_HEADERS, oversized_field)
            completed = self._run(source, root / "oversized.json")
            self._assert_fixed_failure(completed, [str(source)])

            oversized_untrimmed_field = [*SAFE_ROW]
            oversized_untrimmed_field[6] = " " * 501
            self._write_xlsx(source, SAFE_HEADERS, oversized_untrimmed_field)
            completed = self._run(source, root / "oversized-untrimmed.json")
            self._assert_fixed_failure(completed, [str(source)])

            oversized_utf16_field = [*SAFE_ROW]
            oversized_utf16_field[0] = "😀" * 101
            self._write_xlsx(source, SAFE_HEADERS, oversized_utf16_field)
            completed = self._run(source, root / "oversized-utf16.json")
            self._assert_fixed_failure(completed, [str(source)])

            javascript_trimmed_field = [*SAFE_ROW]
            javascript_trimmed_field[0] = f"\ufeff{SAFE_ROW[0]}\ufeff"
            self._write_xlsx(source, SAFE_HEADERS, javascript_trimmed_field)
            trimmed_output = root / "javascript-trim.json"
            completed = self._run(source, trimmed_output)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(
                json.loads(trimmed_output.read_text(encoding="utf-8"))["records"][0]["number"],
                SAFE_ROW[0],
            )

            duplicate_rows = [[*SAFE_ROW], [*SAFE_ROW]]
            duplicate_rows[1][1] = "A distinct synthetic title"
            self._write_xlsx_rows(source, SAFE_HEADERS, duplicate_rows)
            completed = self._run(source, root / "duplicate-number.json")
            self._assert_fixed_failure(completed, [str(source)])

    @staticmethod
    def _run(
        source: Path | list[Path],
        output: Path,
    ) -> subprocess.CompletedProcess[str]:
        sources = source if isinstance(source, list) else [source]
        return subprocess.run(
            [sys.executable, str(SCRIPT), *(str(path) for path in sources), str(output)],
            check=False,
            capture_output=True,
            text=True,
        )

    def _assert_fixed_failure(self, completed: subprocess.CompletedProcess[str], secrets: list[str]) -> None:
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(completed.stderr, "历史题目元数据解析失败：输入、布局或输出未通过安全检查。\n")
        for secret in secrets:
            self.assertNotIn(secret, completed.stderr)

    @classmethod
    def _write_xlsx(
        cls,
        path: Path,
        headers: list[str],
        values: list[str],
        *,
        compression: int = zipfile.ZIP_DEFLATED,
    ) -> None:
        cls._write_xlsx_rows(path, headers, [values], compression=compression)

    @classmethod
    def _write_xlsx_rows(
        cls,
        path: Path,
        headers: list[str],
        rows: list[list[str]],
        *,
        compression: int = zipfile.ZIP_DEFLATED,
    ) -> None:
        cls._write_members(path, cls._xlsx_members(headers, rows), compression=compression)

    @classmethod
    def _xlsx_members(cls, headers: list[str], rows: list[list[str]]) -> dict[str, bytes]:
        all_values = list(dict.fromkeys([*headers, *(value for row in rows for value in row)]))
        value_indexes = {value: index for index, value in enumerate(all_values)}
        shared = "".join(f"<si><t>{value}</t></si>" for value in all_values)
        header_cells = "".join(
            f'<c r="{cls._column(index)}1" t="s"><v>{value_indexes[value]}</v></c>'
            for index, value in enumerate(headers)
        )
        record_rows = "".join(
            f'<row r="{row_index + 2}">'
            + "".join(
                f'<c r="{cls._column(column)}{row_index + 2}" t="s"><v>{value_indexes[value]}</v></c>'
                for column, value in enumerate(row)
            )
            + "</row>"
            for row_index, row in enumerate(rows)
        )
        shared_xml = (
            f'<sst xmlns="{SPREADSHEET_NS}" count="{len(all_values)}" uniqueCount="{len(all_values)}">{shared}</sst>'
        )
        sheet_xml = (
            f'<worksheet xmlns="{SPREADSHEET_NS}"><sheetData>'
            f'<row r="1">{header_cells}</row>{record_rows}'
            "</sheetData></worksheet>"
        )
        return {
            "xl/sharedStrings.xml": shared_xml.encode(),
            "xl/worksheets/sheet1.xml": sheet_xml.encode(),
        }

    @staticmethod
    def _write_members(path: Path, members: dict[str, bytes], *, compression: int = zipfile.ZIP_DEFLATED) -> None:
        with zipfile.ZipFile(path, "w", compression=compression) as archive:
            for name, content in members.items():
                archive.writestr(name, content)

    @staticmethod
    def _members_bytes(
        members: dict[str, bytes],
        *,
        compression: int = zipfile.ZIP_DEFLATED,
        unseekable: bool = False,
    ) -> bytes:
        target: io.BytesIO | _UnseekableBuffer = _UnseekableBuffer() if unseekable else io.BytesIO()
        with zipfile.ZipFile(target, "w", compression=compression) as archive:
            for name, content in members.items():
                archive.writestr(name, content)
        return target.getvalue()

    @classmethod
    def _xlsx_with_data_descriptors(cls) -> bytes:
        return cls._members_bytes(
            cls._xlsx_members(SAFE_HEADERS, [SAFE_ROW]),
            unseekable=True,
        )

    @classmethod
    def _xlsx_with_unsigned_descriptors(cls) -> bytes:
        members = cls._xlsx_members(SAFE_HEADERS, [SAFE_ROW])
        local_parts: list[bytes] = []
        central_parts: list[bytes] = []
        local_offset = 0
        central_size = 0
        for name, content in members.items():
            name_bytes = name.encode()
            compressor = zlib.compressobj(wbits=-15)
            compressed = compressor.compress(content) + compressor.flush()
            checksum = zlib.crc32(content) & 0xFFFFFFFF
            flags = 0x0808
            local = (
                struct.pack(
                    "<I5H3I2H",
                    0x04034B50,
                    20,
                    flags,
                    zipfile.ZIP_DEFLATED,
                    0,
                    0,
                    0,
                    0,
                    0,
                    len(name_bytes),
                    0,
                )
                + name_bytes
                + compressed
                + struct.pack("<III", checksum, len(compressed), len(content))
            )
            central = struct.pack(
                "<I6H3I5H2I",
                0x02014B50,
                0x0314,
                20,
                flags,
                zipfile.ZIP_DEFLATED,
                0,
                0,
                checksum,
                len(compressed),
                len(content),
                len(name_bytes),
                0,
                0,
                0,
                0,
                (stat.S_IFREG | 0o600) << 16,
                local_offset,
            ) + name_bytes
            local_parts.append(local)
            central_parts.append(central)
            local_offset += len(local)
            central_size += len(central)
        end = struct.pack(
            "<I4H2IH",
            0x06054B50,
            0,
            0,
            len(members),
            len(members),
            central_size,
            local_offset,
            0,
        )
        return b"".join([*local_parts, *central_parts, end])

    @classmethod
    def _xlsx_with_utf16_entity(cls) -> bytes:
        members = cls._xlsx_members(SAFE_HEADERS, [SAFE_ROW])
        all_values = list(dict.fromkeys([*SAFE_HEADERS, *SAFE_ROW]))
        shared = "".join(
            f"<si><t>{'&hidden;' if index == 0 else value}</t></si>"
            for index, value in enumerate(all_values)
        )
        members["xl/sharedStrings.xml"] = (
            '<?xml version="1.0" encoding="UTF-16"?>'
            '<!DOCTYPE sst [<!ENTITY hidden "序号">]>'
            f'<sst xmlns="{SPREADSHEET_NS}">{shared}</sst>'
        ).encode("utf-16")
        return cls._members_bytes(members)

    @classmethod
    def _xlsx_with_negative_shared_index(cls) -> bytes:
        members = cls._xlsx_members(SAFE_HEADERS, [SAFE_ROW])
        sheet = members["xl/worksheets/sheet1.xml"].decode()
        student_index = list(dict.fromkeys([*SAFE_HEADERS, *SAFE_ROW])).index("SYNTHETIC-STUDENT")
        original = f'<c r="E2" t="s"><v>{student_index}</v></c>'
        if original not in sheet:
            raise AssertionError("synthetic student cell missing")
        members["xl/worksheets/sheet1.xml"] = sheet.replace(
            original,
            '<c r="E2" t="s"><v>-1</v></c>',
            1,
        ).encode()
        return cls._members_bytes(members)

    @classmethod
    def _xlsx_with_extra(cls, name: str, content: bytes) -> bytes:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "x.xlsx"
            cls._write_xlsx(path, SAFE_HEADERS, SAFE_ROW)
            with zipfile.ZipFile(path, "a") as archive:
                archive.writestr(name, content)
            return path.read_bytes()

    @classmethod
    def _xlsx_with_casefold_duplicate(cls) -> bytes:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "x.xlsx"
            cls._write_xlsx(path, SAFE_HEADERS, SAFE_ROW)
            with zipfile.ZipFile(path, "a") as archive:
                archive.writestr("XL/SHAREDSTRINGS.XML", b"duplicate")
            return path.read_bytes()

    @classmethod
    def _xlsx_with_unicode_duplicate(cls) -> bytes:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "x.xlsx"
            cls._write_xlsx(path, SAFE_HEADERS, SAFE_ROW)
            with zipfile.ZipFile(path, "a") as archive:
                archive.writestr("synthetic-é.xml", b"one")
                archive.writestr("synthetic-e\u0301.xml", b"two")
            return path.read_bytes()

    @classmethod
    def _xlsx_with_symlink(cls) -> bytes:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "x.xlsx"
            cls._write_xlsx(path, SAFE_HEADERS, SAFE_ROW)
            info = zipfile.ZipInfo("synthetic-link")
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            with zipfile.ZipFile(path, "a") as archive:
                archive.writestr(info, b"target")
            return path.read_bytes()

    @classmethod
    def _xlsx_with_device(cls) -> bytes:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "x.xlsx"
            cls._write_xlsx(path, SAFE_HEADERS, SAFE_ROW)
            info = zipfile.ZipInfo("synthetic-device")
            info.create_system = 3
            info.external_attr = (stat.S_IFCHR | 0o600) << 16
            with zipfile.ZipFile(path, "a") as archive:
                archive.writestr(info, b"device")
            return path.read_bytes()

    @classmethod
    def _xlsx_with_zip64_marker(cls) -> bytes:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "x.xlsx"
            cls._write_xlsx(path, SAFE_HEADERS, SAFE_ROW)
            with zipfile.ZipFile(path, "a") as archive:
                info = zipfile.ZipInfo("synthetic-zip64")
                info.extract_version = 45
                archive.writestr(info, b"x")
            return path.read_bytes()

    @classmethod
    def _xlsx_with_unsupported_compression(cls) -> bytes:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "x.xlsx"
            cls._write_xlsx(path, SAFE_HEADERS, SAFE_ROW)
            with zipfile.ZipFile(path, "a", compression=zipfile.ZIP_BZIP2) as archive:
                archive.writestr("synthetic-bzip2", b"x")
            return path.read_bytes()

    @classmethod
    def _xlsx_with_ratio_bomb(cls) -> bytes:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "x.xlsx"
            cls._write_xlsx(path, SAFE_HEADERS, SAFE_ROW)
            with zipfile.ZipFile(path, "a", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("synthetic-bomb.bin", b"x" * 1024 * 1024)
            return path.read_bytes()

    @staticmethod
    def _add_archive_level_zip64(content: bytes) -> bytes:
        end_offset = content.rfind(b"PK\x05\x06")
        if end_offset < 0:
            raise AssertionError("synthetic ZIP missing EOCD")
        entry_count = struct.unpack_from("<H", content, end_offset + 10)[0]
        central_size = struct.unpack_from("<I", content, end_offset + 12)[0]
        central_offset = struct.unpack_from("<I", content, end_offset + 16)[0]
        zip64_end = struct.pack(
            "<IQHHIIQQQQ",
            0x06064B50,
            44,
            45,
            45,
            0,
            0,
            entry_count,
            entry_count,
            central_size,
            central_offset,
        )
        locator = struct.pack("<IIQI", 0x07064B50, 0, end_offset, 1)
        return content[:end_offset] + zip64_end + locator + content[end_offset:]

    @staticmethod
    def _corrupt_first_descriptor(content: bytes) -> bytes:
        changed = bytearray(content)
        central = changed.find(b"PK\x01\x02")
        if central < 0:
            raise AssertionError("synthetic ZIP missing central directory")
        local = struct.unpack_from("<I", changed, central + 42)[0]
        compressed_size = struct.unpack_from("<I", changed, central + 20)[0]
        name_length, extra_length = struct.unpack_from("<HH", changed, local + 26)
        descriptor = local + 30 + name_length + extra_length + compressed_size
        if changed[descriptor : descriptor + 4] != b"PK\x07\x08":
            raise AssertionError("synthetic ZIP missing data descriptor")
        changed[descriptor + 4] ^= 0x01
        return bytes(changed)

    @staticmethod
    def _corrupt_first_unsigned_descriptor(content: bytes) -> bytes:
        changed = bytearray(content)
        central = changed.find(b"PK\x01\x02")
        if central < 0:
            raise AssertionError("synthetic ZIP missing central directory")
        local = struct.unpack_from("<I", changed, central + 42)[0]
        compressed_size = struct.unpack_from("<I", changed, central + 20)[0]
        name_length, extra_length = struct.unpack_from("<HH", changed, local + 26)
        descriptor = local + 30 + name_length + extra_length + compressed_size
        if changed[descriptor : descriptor + 4] == b"PK\x07\x08":
            raise AssertionError("synthetic ZIP unexpectedly has a signed descriptor")
        changed[descriptor] ^= 0x01
        return bytes(changed)

    @staticmethod
    def _patch_first_local_u16(content: bytes, field_offset: int, flag: int) -> bytes:
        changed = bytearray(content)
        local = changed.find(b"PK\x03\x04")
        if local < 0:
            raise AssertionError("synthetic ZIP missing local header")
        value = struct.unpack_from("<H", changed, local + field_offset)[0]
        struct.pack_into("<H", changed, local + field_offset, value | flag)
        return bytes(changed)

    @staticmethod
    def _set_first_local_u16(content: bytes, field_offset: int, value: int) -> bytes:
        changed = bytearray(content)
        local = changed.find(b"PK\x03\x04")
        if local < 0:
            raise AssertionError("synthetic ZIP missing local header")
        struct.pack_into("<H", changed, local + field_offset, value)
        return bytes(changed)

    @staticmethod
    def _increment_first_local_u32(content: bytes, field_offset: int) -> bytes:
        changed = bytearray(content)
        local = changed.find(b"PK\x03\x04")
        if local < 0:
            raise AssertionError("synthetic ZIP missing local header")
        value = struct.unpack_from("<I", changed, local + field_offset)[0]
        struct.pack_into("<I", changed, local + field_offset, (value + 1) & 0xFFFFFFFF)
        return bytes(changed)

    @staticmethod
    def _increment_first_central_u32(content: bytes, field_offset: int) -> bytes:
        changed = bytearray(content)
        central = changed.find(b"PK\x01\x02")
        if central < 0:
            raise AssertionError("synthetic ZIP missing central directory")
        value = struct.unpack_from("<I", changed, central + field_offset)[0]
        struct.pack_into("<I", changed, central + field_offset, (value + 1) & 0xFFFFFFFF)
        return bytes(changed)

    @staticmethod
    def _corrupt_first_local_name(content: bytes) -> bytes:
        changed = bytearray(content)
        local = changed.find(b"PK\x03\x04")
        if local < 0:
            raise AssertionError("synthetic ZIP missing local header")
        name_length = struct.unpack_from("<H", changed, local + 26)[0]
        if name_length == 0:
            raise AssertionError("synthetic ZIP missing local name")
        changed[local + 30] ^= 0x01
        return bytes(changed)

    @staticmethod
    def _patch_first_flags(content: bytes, flag: int) -> bytes:
        changed = bytearray(content)
        local = changed.find(b"PK\x03\x04")
        central = changed.find(b"PK\x01\x02")
        if local < 0 or central < 0:
            raise AssertionError("synthetic ZIP missing headers")
        struct.pack_into("<H", changed, local + 6, struct.unpack_from("<H", changed, local + 6)[0] | flag)
        struct.pack_into("<H", changed, central + 8, struct.unpack_from("<H", changed, central + 8)[0] | flag)
        return bytes(changed)

    @staticmethod
    def _corrupt_first_member(content: bytes) -> bytes:
        changed = bytearray(content)
        local = changed.find(b"PK\x03\x04")
        name_length, extra_length = struct.unpack_from("<HH", changed, local + 26)
        data_offset = local + 30 + name_length + extra_length
        changed[data_offset] ^= 0x01
        return bytes(changed)

    @staticmethod
    def _column(index: int) -> str:
        value = index + 1
        result = ""
        while value:
            value, remainder = divmod(value - 1, 26)
            result = chr(65 + remainder) + result
        return result


if __name__ == "__main__":
    unittest.main()
