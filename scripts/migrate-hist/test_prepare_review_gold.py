from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import copy
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).with_name("prepare-review-gold.py")
SPEC = importlib.util.spec_from_file_location("urmotiv_prepare_review_gold_tested", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load review gold tool")
TOOL = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = TOOL
SPEC.loader.exec_module(TOOL)

XLSX_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
SS_NS = "urn:schemas-microsoft-com:office:spreadsheet"
PRIVATE_DIFFICULTY = "SYNTHETIC SUBMITTER DIFFICULTY MUST NEVER APPEAR"
PRIVATE_TITLE_A = "SYNTHETIC PRIVATE TITLE A"
PRIVATE_TITLE_B = "SYNTHETIC PRIVATE TITLE B"
PRIVATE_REVIEW_A = "SYNTHETIC RAW REVIEW ACCEPT"
PRIVATE_REVIEW_B = "SYNTHETIC RAW REVIEW ORIGINAL"


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _compact(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


class PrepareReviewGoldTest(unittest.TestCase):
    def test_blank_shared_string_cell_is_empty_but_invalid_index_is_rejected(self) -> None:
        blank = ET.fromstring(
            f'<c xmlns="{XLSX_NS}" t="s"><v /></c>'
        )
        self.assertEqual(TOOL._xlsx_selected_token(blank), ("text", ""))

        invalid = ET.fromstring(
            f'<c xmlns="{XLSX_NS}" t="s"><v>-1</v></c>'
        )
        with self.assertRaises(TOOL._SafeFailure):
            TOOL._xlsx_selected_token(invalid)

    def test_xlsx_requires_explicit_plan_and_seals_only_safe_gold(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-review-gold-") as directory:
            root = self._private_root(Path(directory))
            source = root / "SENSITIVE-HISTORICAL-LIST.xlsx"
            self._write_xlsx(source)
            materialized = self._write_materialization(root)
            inspection = root / "inspection.private.json"

            inspected = self._run(
                "inspect",
                "--private-root",
                str(root),
                "--input",
                str(source),
                "--out",
                str(inspection),
            )
            self.assertEqual(inspected.returncode, 0, inspected.stderr)
            self.assertNotIn("SENSITIVE", inspected.stderr)
            self.assertNotIn(PRIVATE_DIFFICULTY, inspected.stderr)
            inspection_value = self._read_json(inspection)
            self.assertEqual(set(inspection_value), {"version", "inputSetSha256", "inputs"})
            self.assertNotIn(PRIVATE_TITLE_A, inspection.read_text(encoding="utf-8"))

            layout = root / "layout.private.json"
            self._write_layout(layout, inspection_value["inputSetSha256"])
            worksheet_directory = root / "worksheet"
            initialized = self._run(
                "init",
                "--private-root",
                str(root),
                "--input",
                str(source),
                "--inspection",
                str(inspection),
                "--layout",
                str(layout),
                "--materialized",
                str(materialized),
                "--out",
                str(worksheet_directory),
            )
            self.assertEqual(initialized.returncode, 0, initialized.stderr)
            worksheet_file = worksheet_directory / "review-worksheet.private.json"
            worksheet_text = worksheet_file.read_text(encoding="utf-8")
            self.assertIn(PRIVATE_REVIEW_A, worksheet_text)
            self.assertIn(PRIVATE_REVIEW_B, worksheet_text)
            self.assertNotIn(PRIVATE_DIFFICULTY, worksheet_text)
            skeleton_text = (worksheet_directory / "review-plan.skeleton.private.json").read_text(
                encoding="utf-8"
            )
            self.assertNotIn(PRIVATE_REVIEW_A, skeleton_text)
            self.assertFalse(self._read_json(worksheet_directory / "review-plan.skeleton.private.json")["confirmed"])

            worksheet = self._read_json(worksheet_file)
            sources = worksheet["sources"]
            plan = root / "review-plan.private.json"
            self._write_json(
                plan,
                {
                    "version": 3,
                    "confirmed": True,
                    "submitterDifficultyColumnsExcludedReconfirmed": True,
                    "datasetId": "synthetic-review-gold-v1",
                    "worksheetSha256": _sha256(worksheet_file.read_bytes()),
                    "sourceConfirmationSha256": worksheet["sourceConfirmationSha256"],
                    "cases": [
                        {
                            "caseId": "case-development-a",
                            "subjectId": "subject-synthetic-a",
                            "rowId": "review-row-000001",
                            "sourceId": sources[0]["sourceId"],
                            "sourceSha256": sources[0]["sourceSha256"],
                            "purpose": "development",
                            "evaluationScope": "verdict_and_taste",
                            "verdict": "accepted",
                            "contestUse": "used",
                            "confirmed": True,
                        },
                        {
                            "caseId": "case-holdout-b",
                            "subjectId": "subject-synthetic-b",
                            "rowId": "review-row-000002",
                            "sourceId": sources[1]["sourceId"],
                            "sourceSha256": sources[1]["sourceSha256"],
                            "purpose": "holdout",
                            "evaluationScope": "originality_only",
                            "sameProblemAsExisting": True,
                            "confirmed": True,
                        },
                    ],
                },
            )
            tuning = root / "tuning-history.private.json"
            self._write_json(
                tuning,
                {"version": 1, "confirmedComplete": True, "developmentSamples": []},
            )
            output = root / "sealed"
            sealed = self._run(
                "seal",
                "--private-root",
                str(root),
                "--input",
                str(source),
                "--inspection",
                str(inspection),
                "--layout",
                str(layout),
                "--materialized",
                str(materialized),
                "--worksheet",
                str(worksheet_directory),
                "--plan",
                str(plan),
                "--tuning-history",
                str(tuning),
                "--out",
                str(output),
            )
            self.assertEqual(sealed.returncode, 0, sealed.stderr)
            self.assertIn("originality_only 1", sealed.stderr)
            manifest = self._read_json(output / "review-gold-evidence.private.json")
            self.assertEqual(manifest["artifactKind"], "historical_review_gold_evidence")
            self.assertEqual(
                set(manifest["entries"][0]),
                {
                    "caseId",
                    "purpose",
                    "evaluationScope",
                    "materializedSourceSha256",
                    "goldFile",
                    "goldSha256",
                },
            )
            self.assertEqual(manifest["entries"][1]["evaluationScope"], "originality_only")
            self.assertEqual(manifest["entries"][1]["purpose"], "holdout")
            for entry in manifest["entries"]:
                gold = output / entry["goldFile"]
                self.assertEqual(_sha256(gold.read_bytes()), entry["goldSha256"])
            originality_gold = self._read_json(output / manifest["entries"][1]["goldFile"])
            self.assertTrue(originality_gold["sameProblemAsExisting"])
            self.assertNotIn("verdict", originality_gold)
            self.assertNotIn("contestUse", originality_gold)
            verdict_gold = self._read_json(output / manifest["entries"][0]["goldFile"])
            self.assertEqual(verdict_gold["contestUse"], "used")
            self.assertNotIn("contestUsed", verdict_gold)
            formal_text = "\n".join(
                path.read_text(encoding="utf-8")
                for path in output.rglob("*")
                if path.is_file()
            )
            for private_value in (
                PRIVATE_DIFFICULTY,
                PRIVATE_TITLE_A,
                PRIVATE_TITLE_B,
                PRIVATE_REVIEW_A,
                PRIVATE_REVIEW_B,
                "synthetic-001",
                "synthetic-002",
            ):
                self.assertNotIn(private_value, formal_text)
            self.assertNotIn("difficulty", formal_text.casefold())
            self.assertFalse((output / "sources").exists())
            self._assert_private_tree(output)

    def test_spreadsheetml_xml_is_supported_without_inferring_gold(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-review-gold-xml-") as directory:
            root = self._private_root(Path(directory))
            source = root / "synthetic.xml"
            self._write_spreadsheetml(source)
            materialized = self._write_materialization(root)
            inspection = root / "inspection.private.json"
            self.assertEqual(
                self._run(
                    "inspect",
                    "--private-root",
                    str(root),
                    "--input",
                    str(source),
                    "--out",
                    str(inspection),
                ).returncode,
                0,
            )
            inspected = self._read_json(inspection)
            self.assertEqual(inspected["inputs"][0]["format"], "spreadsheetml_xml")
            layout = root / "layout.private.json"
            self._write_layout(layout, inspected["inputSetSha256"])
            worksheet_directory = root / "worksheet"
            completed = self._run(
                "init",
                "--private-root",
                str(root),
                "--input",
                str(source),
                "--inspection",
                str(inspection),
                "--layout",
                str(layout),
                "--materialized",
                str(materialized),
                "--out",
                str(worksheet_directory),
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            worksheet = (worksheet_directory / "review-worksheet.private.json").read_text(
                encoding="utf-8"
            )
            self.assertIn(PRIVATE_REVIEW_A, worksheet)
            self.assertNotIn(PRIVATE_DIFFICULTY, worksheet)
            skeleton = self._read_json(worksheet_directory / "review-plan.skeleton.private.json")
            self.assertEqual(skeleton["cases"], [])
            self.assertFalse(skeleton["confirmed"])

    def test_two_inputs_remain_separate_until_a_human_plan_maps_them(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-review-gold-two-inputs-") as directory:
            root = self._private_root(Path(directory))
            xlsx = root / "synthetic-older.xlsx"
            xml = root / "synthetic-newer.xml"
            self._write_xlsx(xlsx)
            self._write_spreadsheetml(xml)
            materialized = self._write_materialization(root)
            inspection = root / "inspection.private.json"
            inspected = self._run(
                "inspect",
                "--private-root",
                str(root),
                "--input",
                str(xlsx),
                "--input",
                str(xml),
                "--out",
                str(inspection),
            )
            self.assertEqual(inspected.returncode, 0, inspected.stderr)
            inspection_value = self._read_json(inspection)
            self.assertEqual(len(inspection_value["inputs"]), 2)
            layout = root / "layout.private.json"
            self._write_json(
                layout,
                self._layout_value(inspection_value["inputSetSha256"], input_count=2),
            )
            worksheet_directory = root / "worksheet"
            initialized = self._run(
                "init",
                "--private-root",
                str(root),
                "--input",
                str(xlsx),
                "--input",
                str(xml),
                "--inspection",
                str(inspection),
                "--layout",
                str(layout),
                "--materialized",
                str(materialized),
                "--out",
                str(worksheet_directory),
            )
            self.assertEqual(initialized.returncode, 0, initialized.stderr)
            worksheet = self._read_json(
                worksheet_directory / "review-worksheet.private.json"
            )
            self.assertEqual(len(worksheet["rows"]), 3)
            self.assertEqual(
                {row["inputId"] for row in worksheet["rows"]},
                {"input-000001", "input-000002"},
            )
            self.assertEqual(
                self._read_json(worksheet_directory / "review-plan.skeleton.private.json")[
                    "cases"
                ],
                [],
            )

    def test_difficulty_column_cannot_enter_layout_or_output(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-review-gold-difficulty-") as directory:
            root = self._private_root(Path(directory))
            source = root / "synthetic.xlsx"
            self._write_xlsx(source)
            materialized = self._write_materialization(root)
            inspection = root / "inspection.private.json"
            self._run(
                "inspect",
                "--private-root",
                str(root),
                "--input",
                str(source),
                "--out",
                str(inspection),
            )
            inspected = self._read_json(inspection)
            output = root / "worksheet"
            base_layout = self._layout_value(inspected["inputSetSha256"])
            for role in ("identity", "review_comment"):
                with self.subTest(disguised_as=role):
                    disguised = copy.deepcopy(base_layout)
                    disguised["inputs"][0]["columns"][2]["role"] = role
                    layout = root / f"layout-disguised-{role}.private.json"
                    self._write_json(layout, disguised)
                    failed = self._run(
                        "init",
                        "--private-root",
                        str(root),
                        "--input",
                        str(source),
                        "--inspection",
                        str(inspection),
                        "--layout",
                        str(layout),
                        "--materialized",
                        str(materialized),
                        "--out",
                        str(output),
                    )
                    self._assert_fixed_failure(failed)
                    self.assertFalse(output.exists())

            incomplete_layout = copy.deepcopy(base_layout)
            incomplete_layout["inputs"][0]["columns"].pop()
            incomplete = root / "layout-missing-header.private.json"
            self._write_json(incomplete, incomplete_layout)
            failed = self._run(
                "init",
                "--private-root",
                str(root),
                "--input",
                str(source),
                "--inspection",
                str(inspection),
                "--layout",
                str(incomplete),
                "--materialized",
                str(materialized),
                "--out",
                str(output),
            )
            self._assert_fixed_failure(failed)
            self.assertFalse(output.exists())

            unknown_field_layout = copy.deepcopy(base_layout)
            unknown_field_layout["inputs"][0]["columns"][0]["difficulty"] = 3
            second_layout = root / "layout-with-forbidden-field.private.json"
            self._write_json(second_layout, unknown_field_layout)
            failed = self._run(
                "init",
                "--private-root",
                str(root),
                "--input",
                str(source),
                "--inspection",
                str(inspection),
                "--layout",
                str(second_layout),
                "--materialized",
                str(materialized),
                "--out",
                str(output),
            )
            self._assert_fixed_failure(failed)

    def test_explicit_mapping_and_holdout_tuning_history_are_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-review-gold-binding-") as directory:
            root = self._private_root(Path(directory))
            source = root / "synthetic.xlsx"
            self._write_xlsx(source)
            materialized = self._write_materialization(root)
            inspection = root / "inspection.private.json"
            self._run(
                "inspect",
                "--private-root",
                str(root),
                "--input",
                str(source),
                "--out",
                str(inspection),
            )
            inspected = self._read_json(inspection)
            layout = root / "layout.private.json"
            self._write_layout(layout, inspected["inputSetSha256"])
            worksheet_directory = root / "worksheet"
            self.assertEqual(
                self._run(
                    "init",
                    "--private-root",
                    str(root),
                    "--input",
                    str(source),
                    "--inspection",
                    str(inspection),
                    "--layout",
                    str(layout),
                    "--materialized",
                    str(materialized),
                    "--out",
                    str(worksheet_directory),
                ).returncode,
                0,
            )
            worksheet_file = worksheet_directory / "review-worksheet.private.json"
            worksheet = self._read_json(worksheet_file)
            sources = worksheet["sources"]

            # The row/source pair is deliberately crossed.  Equality of identifiers is
            # only a validation after an explicit human pair; the tool never selects it.
            crossed_plan = root / "crossed-plan.private.json"
            self._write_json(
                crossed_plan,
                self._plan_value(
                    worksheet,
                    worksheet_file,
                    row_id="review-row-000001",
                    source=sources[1],
                    purpose="development",
                ),
            )
            tuning = root / "tuning.private.json"
            self._write_json(
                tuning,
                {"version": 1, "confirmedComplete": True, "developmentSamples": []},
            )
            crossed_output = root / "crossed-output"
            failed = self._seal(
                root,
                source,
                inspection,
                layout,
                materialized,
                worksheet_directory,
                crossed_plan,
                tuning,
                crossed_output,
            )
            self._assert_fixed_failure(failed)
            self.assertFalse(crossed_output.exists())

            holdout_plan = root / "holdout-plan.private.json"
            self._write_json(
                holdout_plan,
                self._plan_value(
                    worksheet,
                    worksheet_file,
                    row_id="review-row-000001",
                    source=sources[0],
                    purpose="holdout",
                ),
            )
            self._write_json(
                tuning,
                {
                    "version": 1,
                    "confirmedComplete": True,
                    "developmentSamples": [
                        {
                            "subjectId": "subject-synthetic-a",
                            "contentSha256": sources[0]["sourceSha256"],
                        }
                    ],
                },
                replace=True,
            )
            overlap_output = root / "overlap-output"
            failed = self._seal(
                root,
                source,
                inspection,
                layout,
                materialized,
                worksheet_directory,
                holdout_plan,
                tuning,
                overlap_output,
            )
            self._assert_fixed_failure(failed)
            self.assertFalse(overlap_output.exists())

            development_plan_value = self._plan_value(
                worksheet,
                worksheet_file,
                row_id="review-row-000001",
                source=sources[0],
                purpose="development",
            )
            development_plan_value["cases"][0]["subjectId"] = "subject-renamed"
            renamed_plan = root / "renamed-development-plan.private.json"
            self._write_json(renamed_plan, development_plan_value)
            renamed_output = root / "renamed-development-output"
            failed = self._seal(
                root,
                source,
                inspection,
                layout,
                materialized,
                worksheet_directory,
                renamed_plan,
                tuning,
                renamed_output,
            )
            self._assert_fixed_failure(failed)
            self.assertFalse(renamed_output.exists())

            # The same subject may legitimately have a different historical content
            # version; only reassigning an existing content digest is forbidden.
            allowed_plan = root / "same-subject-new-version-plan.private.json"
            self._write_json(
                allowed_plan,
                self._plan_value(
                    worksheet,
                    worksheet_file,
                    row_id="review-row-000001",
                    source=sources[0],
                    purpose="development",
                ),
            )
            self._write_json(
                tuning,
                {
                    "version": 1,
                    "confirmedComplete": True,
                    "developmentSamples": [
                        {
                            "subjectId": "subject-synthetic-a",
                            "contentSha256": "f" * 64,
                        }
                    ],
                },
                replace=True,
            )
            allowed_output = root / "same-subject-new-version-output"
            allowed = self._seal(
                root,
                source,
                inspection,
                layout,
                materialized,
                worksheet_directory,
                allowed_plan,
                tuning,
                allowed_output,
            )
            self.assertEqual(allowed.returncode, 0, allowed.stderr)

    def test_spreadsheetml_ambiguous_grid_and_multiple_sheets_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-review-gold-grid-") as directory:
            root = self._private_root(Path(directory))

            def merged(attribute: str) -> ET.Element:
                source = root / f"{attribute}.xml"
                self._write_spreadsheetml(source)
                document = ET.parse(source)
                target_name = "Row" if attribute == "Span" else "Cell"
                target = next(
                    element
                    for element in document.getroot().iter()
                    if element.tag == f"{{{SS_NS}}}{target_name}"
                )
                target.set(f"{{{SS_NS}}}{attribute}", "1")
                source.write_bytes(
                    ET.tostring(document.getroot(), encoding="utf-8", xml_declaration=True)
                )
                os.chmod(source, 0o600)
                return document.getroot()

            cases: list[tuple[str, Path]] = []
            for attribute in ("MergeAcross", "MergeDown", "Span"):
                merged(attribute)
                cases.append((attribute, root / f"{attribute}.xml"))

            row_regression = root / "row-regression.xml"
            self._write_spreadsheetml(row_regression)
            row_document = ET.parse(row_regression)
            rows = [
                element
                for element in row_document.getroot().iter()
                if element.tag == f"{{{SS_NS}}}Row"
            ]
            rows[0].set(f"{{{SS_NS}}}Index", "3")
            rows[1].set(f"{{{SS_NS}}}Index", "2")
            row_regression.write_bytes(
                ET.tostring(row_document.getroot(), encoding="utf-8", xml_declaration=True)
            )
            os.chmod(row_regression, 0o600)
            cases.append(("row-regression", row_regression))

            cell_regression = root / "cell-regression.xml"
            self._write_spreadsheetml(cell_regression)
            cell_document = ET.parse(cell_regression)
            cells = [
                element
                for element in cell_document.getroot().iter()
                if element.tag == f"{{{SS_NS}}}Cell"
            ]
            cells[0].set(f"{{{SS_NS}}}Index", "3")
            cells[1].set(f"{{{SS_NS}}}Index", "2")
            cell_regression.write_bytes(
                ET.tostring(cell_document.getroot(), encoding="utf-8", xml_declaration=True)
            )
            os.chmod(cell_regression, 0o600)
            cases.append(("cell-regression", cell_regression))

            multiple_xml = root / "multiple.xml"
            self._write_spreadsheetml(multiple_xml)
            multiple_document = ET.parse(multiple_xml)
            worksheet = next(
                element
                for element in multiple_document.getroot()
                if element.tag == f"{{{SS_NS}}}Worksheet"
            )
            multiple_document.getroot().append(copy.deepcopy(worksheet))
            multiple_xml.write_bytes(
                ET.tostring(multiple_document.getroot(), encoding="utf-8", xml_declaration=True)
            )
            os.chmod(multiple_xml, 0o600)
            cases.append(("multiple-xml", multiple_xml))

            multiple_xlsx = root / "multiple.xlsx"
            self._write_xlsx(multiple_xlsx)
            with zipfile.ZipFile(multiple_xlsx, "a", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr(
                    "xl/worksheets/sheet2.xml",
                    archive.read("xl/worksheets/sheet1.xml"),
                )
            os.chmod(multiple_xlsx, 0o600)
            cases.append(("multiple-xlsx", multiple_xlsx))

            for index, (name, source) in enumerate(cases, 1):
                with self.subTest(case=name):
                    output = root / f"inspection-{index}.private.json"
                    failed = self._run(
                        "inspect",
                        "--private-root",
                        str(root),
                        "--input",
                        str(source),
                        "--out",
                        str(output),
                    )
                    self._assert_fixed_failure(failed)
                    self.assertFalse(output.exists())

    def test_originality_plan_is_strict_and_does_not_require_final_decision(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-review-gold-originality-") as directory:
            root = self._private_root(Path(directory))
            source = root / "synthetic.xlsx"
            self._write_xlsx(source, blank_second_final=True)
            materialized = self._write_materialization(root)
            inspection = root / "inspection.private.json"
            self.assertEqual(
                self._run(
                    "inspect",
                    "--private-root",
                    str(root),
                    "--input",
                    str(source),
                    "--out",
                    str(inspection),
                ).returncode,
                0,
            )
            layout = root / "layout.private.json"
            self._write_layout(layout, self._read_json(inspection)["inputSetSha256"])
            worksheet_directory = root / "worksheet"
            self.assertEqual(
                self._run(
                    "init",
                    "--private-root",
                    str(root),
                    "--input",
                    str(source),
                    "--inspection",
                    str(inspection),
                    "--layout",
                    str(layout),
                    "--materialized",
                    str(materialized),
                    "--out",
                    str(worksheet_directory),
                ).returncode,
                0,
            )
            worksheet_file = worksheet_directory / "review-worksheet.private.json"
            worksheet = self._read_json(worksheet_file)
            source_binding = worksheet["sources"][1]
            base_case = {
                "caseId": "case-originality-only",
                "subjectId": "subject-synthetic-b",
                "rowId": "review-row-000002",
                "sourceId": source_binding["sourceId"],
                "sourceSha256": source_binding["sourceSha256"],
                "purpose": "holdout",
                "evaluationScope": "originality_only",
                "sameProblemAsExisting": True,
                "confirmed": True,
            }
            plan_base = {
                "version": 3,
                "confirmed": True,
                "submitterDifficultyColumnsExcludedReconfirmed": True,
                "datasetId": "synthetic-originality-v1",
                "worksheetSha256": _sha256(worksheet_file.read_bytes()),
                "sourceConfirmationSha256": worksheet["sourceConfirmationSha256"],
            }
            tuning = root / "tuning.private.json"
            self._write_json(
                tuning,
                {"version": 1, "confirmedComplete": True, "developmentSamples": []},
            )
            valid_plan = root / "valid-plan.private.json"
            self._write_json(valid_plan, {**plan_base, "cases": [base_case]})
            valid_output = root / "valid-output"
            valid = self._seal(
                root,
                source,
                inspection,
                layout,
                materialized,
                worksheet_directory,
                valid_plan,
                tuning,
                valid_output,
            )
            self.assertEqual(valid.returncode, 0, valid.stderr)
            gold = self._read_json(valid_output / "gold" / "case-originality-only.json")
            self.assertNotIn("verdict", gold)
            self.assertNotIn("contestUse", gold)

            extra_plan = root / "extra-plan.private.json"
            self._write_json(
                extra_plan,
                {**plan_base, "cases": [{**base_case, "verdict": "rejected"}]},
            )
            extra_output = root / "extra-output"
            failed = self._seal(
                root,
                source,
                inspection,
                layout,
                materialized,
                worksheet_directory,
                extra_plan,
                tuning,
                extra_output,
            )
            self._assert_fixed_failure(failed)
            self.assertFalse(extra_output.exists())

            verdict_case = dict(base_case)
            verdict_case.pop("sameProblemAsExisting")
            verdict_case.update(
                {
                    "evaluationScope": "verdict_and_taste",
                    "verdict": "rejected",
                    "contestUse": "unknown",
                }
            )
            verdict_plan = root / "verdict-plan.private.json"
            self._write_json(verdict_plan, {**plan_base, "cases": [verdict_case]})
            verdict_output = root / "verdict-output"
            failed = self._seal(
                root,
                source,
                inspection,
                layout,
                materialized,
                worksheet_directory,
                verdict_plan,
                tuning,
                verdict_output,
            )
            self._assert_fixed_failure(failed)
            self.assertFalse(verdict_output.exists())

    def test_contest_use_is_a_strict_three_state_value(self) -> None:
        source_sha256 = "a" * 64
        worksheet_sha256 = "b" * 64
        source_confirmation_sha256 = "c" * 64
        worksheet = {
            "sourceConfirmationSha256": source_confirmation_sha256,
            "rows": [
                {
                    "rowId": "review-row-000001",
                    "metadataNumber": "synthetic-001",
                    "finalDecisionText": "synthetic decision",
                }
            ],
            "sources": [
                {
                    "sourceId": "source-000001",
                    "metadataNumber": "synthetic-001",
                    "sourceSha256": source_sha256,
                }
            ],
        }
        base_case = {
            "caseId": "case-synthetic-a",
            "subjectId": "subject-synthetic-a",
            "rowId": "review-row-000001",
            "sourceId": "source-000001",
            "sourceSha256": source_sha256,
            "purpose": "development",
            "evaluationScope": "verdict_and_taste",
            "verdict": "accepted",
            "confirmed": True,
        }
        plan = {
            "version": 3,
            "confirmed": True,
            "submitterDifficultyColumnsExcludedReconfirmed": True,
            "datasetId": "synthetic-three-state-v1",
            "worksheetSha256": worksheet_sha256,
            "sourceConfirmationSha256": source_confirmation_sha256,
        }
        for contest_use in ("used", "not_used", "unknown"):
            with self.subTest(accepted=contest_use):
                _, cases = TOOL._parse_plan(
                    {**plan, "cases": [{**base_case, "contestUse": contest_use}]},
                    worksheet,
                    worksheet_sha256,
                )
                self.assertEqual(cases[0]["contestUse"], contest_use)
        for invalid in (True, False, None, "", "not-used"):
            with self.subTest(rejected=invalid):
                with self.assertRaises(TOOL._SafeFailure):
                    TOOL._parse_plan(
                        {**plan, "cases": [{**base_case, "contestUse": invalid}]},
                        worksheet,
                        worksheet_sha256,
                    )
        with self.assertRaises(TOOL._SafeFailure):
            TOOL._parse_plan(
                {**plan, "cases": [{**base_case, "contestUsed": True}]},
                worksheet,
                worksheet_sha256,
            )

    def test_tuning_history_keeps_multiple_versions_per_subject(self) -> None:
        first = "a" * 64
        second = "b" * 64
        parsed = TOOL._parse_tuning_history(
            {
                "version": 1,
                "confirmedComplete": True,
                "developmentSamples": [
                    {"subjectId": "subject-synthetic-a", "contentSha256": first},
                    {"subjectId": "subject-synthetic-a", "contentSha256": second},
                ],
            }
        )
        self.assertEqual(len(parsed), 2)
        with self.assertRaises(TOOL._SafeFailure):
            TOOL._parse_tuning_history(
                {
                    "version": 1,
                    "confirmedComplete": True,
                    "developmentSamples": [
                        {"subjectId": "subject-synthetic-a", "contentSha256": first},
                        {"subjectId": "subject-synthetic-a", "contentSha256": first},
                    ],
                }
            )
        with self.assertRaises(TOOL._SafeFailure):
            TOOL._parse_tuning_history(
                {
                    "version": 1,
                    "confirmedComplete": True,
                    "developmentSamples": [
                        {"subjectId": "subject-synthetic-a", "contentSha256": first},
                        {"subjectId": "subject-synthetic-b", "contentSha256": first},
                    ],
                }
            )

    def test_private_reads_reject_final_and_ancestor_replacement_races(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-review-gold-race-") as directory:
            root_path = self._private_root(Path(directory))

            def exercise(kind: str) -> None:
                parent = root_path / kind
                parent.mkdir(mode=0o700)
                os.chmod(parent, 0o700)
                source = parent / "input.private.json"
                source.write_bytes(b'{"safe":true}\n')
                os.chmod(source, 0o600)
                anchor = TOOL._assert_private_root(root_path)
                real_read = TOOL.os.read
                changed = False

                def replacing_read(descriptor: int, length: int) -> bytes:
                    nonlocal changed
                    content = real_read(descriptor, length)
                    if content and not changed:
                        changed = True
                        if kind == "final-replacement":
                            source.unlink()
                            source.write_bytes(b'{"safe":false}\n')
                            os.chmod(source, 0o600)
                        else:
                            old_parent = root_path / "ancestor-original"
                            parent.rename(old_parent)
                            parent.mkdir(mode=0o700)
                            os.chmod(parent, 0o700)
                            replacement = parent / source.name
                            replacement.write_bytes(b'{"safe":false}\n')
                            os.chmod(replacement, 0o600)
                    return content

                try:
                    with mock.patch.object(TOOL.os, "read", replacing_read):
                        with self.assertRaises(TOOL._SafeFailure):
                            TOOL._read_private_bytes(anchor, source, 1024)
                finally:
                    anchor.close()

            exercise("final-replacement")
            exercise("ancestor-replacement")

    def test_write_failure_after_fstat_never_deletes_a_concurrent_replacement(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-review-gold-write-race-") as directory:
            root_path = self._private_root(Path(directory))
            output = root_path / "output.private.json"
            replacement = b'{"belongsTo":"other-writer"}\n'
            anchor = TOOL._assert_private_root(root_path)
            real_fstat = TOOL.os.fstat
            replaced = False

            def replace_after_fstat(descriptor: int) -> os.stat_result:
                nonlocal replaced
                metadata = real_fstat(descriptor)
                if not replaced and output.exists():
                    path_metadata = output.stat(follow_symlinks=False)
                    if (path_metadata.st_dev, path_metadata.st_ino) != (
                        metadata.st_dev,
                        metadata.st_ino,
                    ):
                        return metadata
                    replaced = True
                    output.unlink()
                    output.write_bytes(replacement)
                    os.chmod(output, 0o600)
                return metadata

            try:
                with mock.patch.object(TOOL.os, "fstat", replace_after_fstat):
                    with self.assertRaises(TOOL._SafeFailure):
                        TOOL._write_private_json(anchor, output, {"owned": True})
            finally:
                anchor.close()
            self.assertTrue(replaced)
            self.assertEqual(output.read_bytes(), replacement)

    def test_directory_failure_after_fstat_never_deletes_a_concurrent_replacement(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-review-gold-dir-race-") as directory:
            root_path = self._private_root(Path(directory))
            output = root_path / "output"
            displaced = root_path / "displaced-original"
            anchor = TOOL._assert_private_root(root_path)
            real_fstat = TOOL.os.fstat
            replaced = False

            def replace_after_fstat(descriptor: int) -> os.stat_result:
                nonlocal replaced
                metadata = real_fstat(descriptor)
                if not replaced and output.exists():
                    path_metadata = output.stat(follow_symlinks=False)
                    if (path_metadata.st_dev, path_metadata.st_ino) != (
                        metadata.st_dev,
                        metadata.st_ino,
                    ):
                        return metadata
                    replaced = True
                    output.rename(displaced)
                    output.mkdir(mode=0o700)
                    os.chmod(output, 0o700)
                return metadata

            try:
                with mock.patch.object(TOOL.os, "fstat", replace_after_fstat):
                    with self.assertRaises(TOOL._SafeFailure):
                        TOOL._create_private_directory(anchor, output)
                with self.assertRaises(TOOL._SafeFailure):
                    TOOL._create_private_directory(anchor, output)
            finally:
                anchor.close()
            self.assertTrue(replaced)
            self.assertTrue(output.is_dir())
            self.assertTrue(displaced.is_dir())

    def test_init_rejects_output_directory_replacement_between_writes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-review-gold-init-dir-race-") as directory:
            root = self._private_root(Path(directory))
            source = root / "synthetic.xlsx"
            self._write_xlsx(source)
            materialized = self._write_materialization(root)
            inspection = root / "inspection.private.json"
            inspected = self._run(
                "inspect",
                "--private-root",
                str(root),
                "--input",
                str(source),
                "--out",
                str(inspection),
            )
            self.assertEqual(inspected.returncode, 0, inspected.stderr)
            layout = root / "layout.private.json"
            self._write_layout(layout, self._read_json(inspection)["inputSetSha256"])
            output = root / "worksheet-raced"
            displaced = root / "worksheet-raced-partial"
            arguments = TOOL.argparse.Namespace(
                private_root=str(root),
                input=[str(source)],
                inspection=str(inspection),
                layout=str(layout),
                materialized=str(materialized),
                out=str(output),
            )
            anchor = TOOL._assert_private_root(root)
            real_write = TOOL._write_private_json_at
            replaced = False

            def replace_after_first_write(
                target: object, name: str, value: object
            ) -> bytes:
                nonlocal replaced
                content = real_write(target, name, value)
                if not replaced and name == "review-worksheet.private.json":
                    replaced = True
                    output.rename(displaced)
                    output.mkdir(mode=0o700)
                    os.chmod(output, 0o700)
                return content

            try:
                with mock.patch.object(
                    TOOL, "_write_private_json_at", replace_after_first_write
                ):
                    with self.assertRaises(TOOL._SafeFailure):
                        TOOL._command_init_anchored(anchor, arguments)
            finally:
                anchor.close()

            self.assertTrue(replaced)
            self.assertEqual(list(output.iterdir()), [])
            self.assertTrue((displaced / "review-worksheet.private.json").is_file())
            self.assertTrue((displaced / "review-plan.skeleton.private.json").is_file())
            self.assertTrue((displaced / "tuning-history.skeleton.private.json").is_file())
            self.assertFalse((output / "REVIEW_WORKSHEET_COMPLETE").exists())
            self.assertFalse((displaced / "REVIEW_WORKSHEET_COMPLETE").exists())

    def test_seal_rejects_output_directory_replacement_between_writes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-review-gold-seal-dir-race-") as directory:
            root = self._private_root(Path(directory))
            source = root / "synthetic.xlsx"
            self._write_xlsx(source)
            materialized = self._write_materialization(root)
            inspection = root / "inspection.private.json"
            inspected = self._run(
                "inspect",
                "--private-root",
                str(root),
                "--input",
                str(source),
                "--out",
                str(inspection),
            )
            self.assertEqual(inspected.returncode, 0, inspected.stderr)
            layout = root / "layout.private.json"
            self._write_layout(layout, self._read_json(inspection)["inputSetSha256"])
            worksheet_directory = root / "worksheet"
            initialized = self._run(
                "init",
                "--private-root",
                str(root),
                "--input",
                str(source),
                "--inspection",
                str(inspection),
                "--layout",
                str(layout),
                "--materialized",
                str(materialized),
                "--out",
                str(worksheet_directory),
            )
            self.assertEqual(initialized.returncode, 0, initialized.stderr)
            worksheet_file = worksheet_directory / "review-worksheet.private.json"
            worksheet = self._read_json(worksheet_file)
            plan = root / "plan.private.json"
            self._write_json(
                plan,
                self._plan_value(
                    worksheet,
                    worksheet_file,
                    row_id="review-row-000001",
                    source=worksheet["sources"][0],
                    purpose="development",
                ),
            )
            tuning = root / "tuning.private.json"
            self._write_json(
                tuning,
                {"version": 1, "confirmedComplete": True, "developmentSamples": []},
            )
            output = root / "sealed-raced"
            displaced = root / "sealed-raced-partial"
            arguments = TOOL.argparse.Namespace(
                private_root=str(root),
                input=[str(source)],
                inspection=str(inspection),
                layout=str(layout),
                materialized=str(materialized),
                worksheet=str(worksheet_directory),
                plan=str(plan),
                tuning_history=str(tuning),
                out=str(output),
            )
            anchor = TOOL._assert_private_root(root)
            real_write = TOOL._write_private_json_at
            replaced = False

            def replace_after_first_write(
                target: object, name: str, value: object
            ) -> bytes:
                nonlocal replaced
                content = real_write(target, name, value)
                if not replaced and name == "case-synthetic-a.json":
                    replaced = True
                    output.rename(displaced)
                    output.mkdir(mode=0o700)
                    os.chmod(output, 0o700)
                return content

            try:
                with mock.patch.object(
                    TOOL, "_write_private_json_at", replace_after_first_write
                ):
                    with self.assertRaises(TOOL._SafeFailure):
                        TOOL._command_seal_anchored(anchor, arguments)
            finally:
                anchor.close()

            self.assertTrue(replaced)
            self.assertEqual(list(output.iterdir()), [])
            self.assertTrue((displaced / "gold" / "case-synthetic-a.json").is_file())
            self.assertTrue((displaced / "review-gold-evidence.private.json").is_file())
            self.assertTrue((displaced / "source-bindings.private.json").is_file())
            self.assertTrue(
                (displaced / "tuning-history-additions.private.json").is_file()
            )
            self.assertFalse((output / "REVIEW_GOLD_COMPLETE").exists())
            self.assertFalse((displaced / "REVIEW_GOLD_COMPLETE").exists())

    def test_partial_output_is_retained_but_cannot_be_loaded_as_complete(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-review-gold-partial-") as directory:
            root_path = self._private_root(Path(directory))
            output = root_path / "partial-worksheet"
            artifact = output / "review-worksheet.private.json"
            anchor = TOOL._assert_private_root(root_path)
            real_write = TOOL.os.write
            write_count = 0

            def fail_after_partial_write(descriptor: int, content: bytes) -> int:
                nonlocal write_count
                write_count += 1
                if write_count == 1:
                    return real_write(descriptor, content[:1])
                raise OSError("synthetic write failure")

            try:
                created = TOOL._create_private_directory(anchor, output)
                try:
                    with mock.patch.object(TOOL.os, "write", fail_after_partial_write):
                        with self.assertRaises(TOOL._SafeFailure):
                            TOOL._write_private_json_at(
                                created,
                                "review-worksheet.private.json",
                                {"synthetic": True},
                            )
                    self.assertTrue(artifact.is_file())
                    partial = artifact.read_bytes()
                    self.assertEqual(partial, b"{")
                    self.assertFalse((output / "REVIEW_WORKSHEET_COMPLETE").exists())
                    with self.assertRaises(TOOL._SafeFailure):
                        TOOL._load_init_artifacts(anchor, output)
                    with self.assertRaises(TOOL._SafeFailure):
                        TOOL._write_private_json_at(
                            created,
                            "review-worksheet.private.json",
                            {"replacement": True},
                        )
                    self.assertEqual(artifact.read_bytes(), partial)
                finally:
                    created.close()
            finally:
                anchor.close()

    def test_verify_sealed_xml_emits_exact_safe_attestation_without_writes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-review-gold-verify-") as directory:
            root = self._private_root(Path(directory))
            fixture = self._create_verification_fixture(root)
            before = self._tree_snapshot(root)
            verified = self._verify_fixture(fixture)
            expected = self._expected_attestation(fixture)
            expected_stdout = json.dumps(
                expected,
                ensure_ascii=False,
                allow_nan=False,
                indent=2,
            ) + "\n"
            self.assertEqual(verified.returncode, 0, verified.stderr)
            self.assertEqual(verified.stderr, "")
            self.assertEqual(verified.stdout, expected_stdout)
            self.assertEqual(verified.stdout.count("\n", len(verified.stdout.rstrip("\n"))), 1)
            self.assertEqual(self._tree_snapshot(root), before)
            self.assertEqual(
                list(json.loads(verified.stdout)),
                [
                    "schemaVersion",
                    "artifactKind",
                    "protocolVersion",
                    "verificationStatus",
                    "upstreamDatasetId",
                    "verifier",
                    "artifacts",
                    "reviewInputs",
                    "cases",
                    "counts",
                    "verificationFingerprint",
                ],
            )
            for private_value in (
                PRIVATE_DIFFICULTY,
                PRIVATE_TITLE_A,
                PRIVATE_REVIEW_A,
                "SYNTHETIC ACCEPTED RAW",
                str(root),
            ):
                self.assertNotIn(private_value, verified.stdout)

    def test_verify_sealed_recomputes_every_layer_and_rejects_tampering(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-review-gold-tamper-") as directory:
            parent = Path(directory)
            baseline = self._private_root(parent)
            self._create_verification_fixture(baseline)
            tamper_cases = [
                ("raw-input", "synthetic.xml", "append"),
                ("inspection", "inspection.private.json", "append"),
                ("layout", "layout.private.json", "append"),
                ("source-confirmation", "materialized/source-confirmation.private.json", "confirmation"),
                ("materialization-report", "materialized/report.json", "report"),
                ("materialized-source", "materialized/sources/source-000001.md", "append"),
                ("materialization-complete", "materialized/MATERIALIZE_COMPLETE", "append"),
                ("worksheet", "worksheet/review-worksheet.private.json", "append"),
                ("plan-skeleton", "worksheet/review-plan.skeleton.private.json", "append"),
                ("tuning-skeleton", "worksheet/tuning-history.skeleton.private.json", "append"),
                ("worksheet-complete", "worksheet/REVIEW_WORKSHEET_COMPLETE", "append"),
                ("plan", "plan.private.json", "append"),
                ("tuning", "tuning.private.json", "append"),
                ("sealed-marker", "sealed/REVIEW_GOLD_COMPLETE", "append"),
                ("evidence", "sealed/review-gold-evidence.private.json", "append"),
                ("bindings", "sealed/source-bindings.private.json", "append"),
                ("gold", "sealed/gold/case-synthetic-a.json", "append"),
                ("additions", "sealed/tuning-history-additions.private.json", "append"),
            ]
            for index, (name, relative, action) in enumerate(tamper_cases, 1):
                with self.subTest(layer=name):
                    clone = parent / f"tampered-{index:02d}"
                    shutil.copytree(baseline, clone)
                    os.chmod(clone, 0o700)
                    target = clone / relative
                    if action == "report":
                        value = self._read_json(target)
                        value["fragmentCount"] += 1
                        self._write_json(target, value, replace=True)
                    elif action == "confirmation":
                        value = self._read_json(target)
                        value["metadataFileSha256"] = "f" * 64
                        self._write_json(target, value, replace=True)
                    else:
                        self._append_tamper(target)
                    failed = self._verify_fixture(
                        self._verification_fixture_paths(clone)
                    )
                    self._assert_fixed_failure(failed)
                    self.assertEqual(failed.stdout, "")

    def test_verify_sealed_rejects_inventory_links_and_permissions(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-review-gold-inventory-") as directory:
            parent = Path(directory)
            baseline = self._private_root(parent)
            self._create_verification_fixture(baseline)

            def extra_top(root: Path) -> None:
                path = root / "sealed" / "extra.private.json"
                path.write_bytes(b"{}\n")
                os.chmod(path, 0o600)

            def extra_gold(root: Path) -> None:
                path = root / "sealed" / "gold" / "extra.json"
                path.write_bytes(b"{}\n")
                os.chmod(path, 0o600)

            def hard_link(root: Path) -> None:
                os.link(
                    root / "sealed" / "review-gold-evidence.private.json",
                    root / "outside-hard-link.private.json",
                )

            def symbolic_link(root: Path) -> None:
                gold = root / "sealed" / "gold" / "case-synthetic-a.json"
                detached = root / "detached-gold.private.json"
                gold.rename(detached)
                gold.symlink_to(detached)

            def file_permission(root: Path) -> None:
                os.chmod(
                    root / "sealed" / "source-bindings.private.json",
                    0o640,
                )

            def directory_permission(root: Path) -> None:
                os.chmod(root / "sealed" / "gold", 0o750)

            scenarios = (
                ("extra-top", extra_top),
                ("extra-gold", extra_gold),
                ("hard-link", hard_link),
                ("symbolic-link", symbolic_link),
                ("file-permission", file_permission),
                ("directory-permission", directory_permission),
            )
            for index, (name, mutate) in enumerate(scenarios, 1):
                with self.subTest(case=name):
                    clone = parent / f"unsafe-{index:02d}"
                    shutil.copytree(baseline, clone)
                    os.chmod(clone, 0o700)
                    mutate(clone)
                    failed = self._verify_fixture(
                        self._verification_fixture_paths(clone)
                    )
                    self._assert_fixed_failure(failed)
                    self.assertEqual(failed.stdout, "")

    def test_verify_sealed_rejects_false_verifier_identity_parameters(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-review-gold-identity-") as directory:
            root = self._private_root(Path(directory))
            fixture = self._create_verification_fixture(root)
            scenarios = (
                {"code_version": "0" * 40},
                {"code_version": "g" * 40},
                {"runner_sha256": "0" * 64},
                {"runner_sha256": "f" * 64},
                {"dependency_sha256": "0" * 64},
                {"dependency_sha256": "e" * 64},
            )
            before = self._tree_snapshot(root)
            for values in scenarios:
                with self.subTest(values=values):
                    failed = self._verify_fixture(fixture, **values)
                    self._assert_fixed_failure(failed)
                    self.assertEqual(failed.stdout, "")
            self.assertEqual(self._tree_snapshot(root), before)

    def test_verify_sealed_holds_materialized_and_worksheet_directory_identity(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-review-gold-anchor-") as directory:
            parent = Path(directory)
            baseline = self._private_root(parent)
            self._create_verification_fixture(baseline)
            scenarios = (
                ("materialized", "MATERIALIZE_COMPLETE"),
                ("worksheet", "REVIEW_WORKSHEET_COMPLETE"),
            )
            for index, (fixture_key, trigger_name) in enumerate(scenarios, 1):
                with self.subTest(directory=fixture_key):
                    clone = parent / f"anchor-race-{index}"
                    shutil.copytree(baseline, clone)
                    os.chmod(clone, 0o700)
                    fixture = self._verification_fixture_paths(clone)
                    target = fixture[fixture_key]
                    detached = clone / f"detached-{fixture_key}"
                    arguments = self._verification_arguments(fixture)
                    real_read = TOOL._read_private_json_at
                    replaced = False

                    def replace_after_completion_read(
                        anchored: object,
                        name: str,
                    ) -> tuple[object, bytes]:
                        nonlocal replaced
                        value = real_read(anchored, name)
                        if (
                            not replaced
                            and anchored.path == target
                            and name == trigger_name
                        ):
                            replaced = True
                            target.rename(detached)
                            shutil.copytree(detached, target)
                            os.chmod(target, 0o700)
                        return value

                    with mock.patch.object(
                        TOOL,
                        "_read_private_json_at",
                        replace_after_completion_read,
                    ):
                        with self.assertRaises(TOOL._SafeFailure):
                            TOOL._command_verify_sealed(arguments)
                    self.assertTrue(replaced)
                    self.assertTrue(target.is_dir())
                    self.assertTrue(detached.is_dir())

    def test_verify_sealed_rereads_exact_derived_bytes_after_validation(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-review-gold-reread-") as directory:
            parent = Path(directory)
            baseline = self._private_root(parent)
            self._create_verification_fixture(baseline)
            scenarios = (
                "materialized-report",
                "materialized-source",
                "worksheet-skeleton",
            )
            for index, scenario in enumerate(scenarios, 1):
                with self.subTest(artifact=scenario):
                    clone = parent / f"reread-race-{index}"
                    shutil.copytree(baseline, clone)
                    os.chmod(clone, 0o700)
                    fixture = self._verification_fixture_paths(clone)
                    arguments = self._verification_arguments(fixture)
                    real_json_read = TOOL._read_private_json_at
                    real_bytes_read = TOOL._read_private_bytes_at
                    replaced = False

                    def replace_json_after_read(
                        anchored: object,
                        name: str,
                    ) -> tuple[object, bytes]:
                        nonlocal replaced
                        value = real_json_read(anchored, name)
                        target: Path | None = None
                        if (
                            scenario == "materialized-report"
                            and anchored.path == fixture["materialized"]
                            and name == "MATERIALIZE_COMPLETE"
                        ):
                            target = fixture["materialized"] / "report.json"
                        elif (
                            scenario == "worksheet-skeleton"
                            and anchored.path == fixture["worksheet"]
                            and name == "REVIEW_WORKSHEET_COMPLETE"
                        ):
                            target = (
                                fixture["worksheet"]
                                / "review-plan.skeleton.private.json"
                            )
                        if target is not None and not replaced:
                            replaced = True
                            target.unlink()
                            target.write_bytes(b'{"replacement":true}\n')
                            os.chmod(target, 0o600)
                        return value

                    def replace_source_after_read(
                        anchored: object,
                        name: str,
                        maximum: int,
                    ) -> bytes:
                        nonlocal replaced
                        content = real_bytes_read(anchored, name, maximum)
                        if (
                            scenario == "materialized-source"
                            and not replaced
                            and anchored.path == fixture["materialized"] / "sources"
                            and name == "source-000001.md"
                        ):
                            replaced = True
                            target = anchored.path / name
                            target.unlink()
                            target.write_bytes(b"replacement source bytes\n")
                            os.chmod(target, 0o600)
                        return content

                    patches = (
                        mock.patch.object(
                            TOOL, "_read_private_json_at", replace_json_after_read
                        ),
                        mock.patch.object(
                            TOOL, "_read_private_bytes_at", replace_source_after_read
                        ),
                    )
                    with patches[0], patches[1]:
                        with self.assertRaises(TOOL._SafeFailure):
                            TOOL._command_verify_sealed(arguments)
                    self.assertTrue(replaced)

    def test_verify_sealed_requires_exact_0600_for_derived_artifacts(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-review-gold-modes-") as directory:
            parent = Path(directory)
            baseline = self._private_root(parent)
            self._create_verification_fixture(baseline)
            protected_files = (
                "materialized/source-confirmation.private.json",
                "materialized/report.json",
                "materialized/MATERIALIZE_COMPLETE",
                "materialized/sources/source-000001.md",
                "worksheet/review-worksheet.private.json",
                "worksheet/review-plan.skeleton.private.json",
                "worksheet/tuning-history.skeleton.private.json",
                "worksheet/REVIEW_WORKSHEET_COMPLETE",
            )
            for index, relative in enumerate(protected_files, 1):
                with self.subTest(file=relative):
                    clone = parent / f"mode-{index:02d}"
                    shutil.copytree(baseline, clone)
                    os.chmod(clone, 0o700)
                    os.chmod(clone / relative, 0o400)
                    failed = self._verify_fixture(
                        self._verification_fixture_paths(clone)
                    )
                    self._assert_fixed_failure(failed)
                    self.assertEqual(failed.stdout, "")

    def test_non_verifier_seal_keeps_owner_only_read_compatibility(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-review-gold-compat-") as directory:
            root = self._private_root(Path(directory))
            fixture = self._create_verification_fixture(root)
            os.chmod(
                fixture["materialized"] / "sources" / "source-000001.md",
                0o400,
            )
            os.chmod(
                fixture["worksheet"] / "review-worksheet.private.json",
                0o400,
            )
            output = root / "sealed-owner-read-compatible"
            sealed = self._seal(
                root,
                fixture["source"],
                fixture["inspection"],
                fixture["layout"],
                fixture["materialized"],
                fixture["worksheet"],
                fixture["plan"],
                fixture["tuning"],
                output,
            )
            self.assertEqual(sealed.returncode, 0, sealed.stderr)

    def test_verify_sealed_rejects_dataset_without_development_case(self) -> None:
        with tempfile.TemporaryDirectory(prefix="urmotiv-review-gold-no-development-") as directory:
            root = self._private_root(Path(directory))
            fixture = self._create_verification_fixture(root)
            plan = self._read_json(fixture["plan"])
            plan["cases"][0]["purpose"] = "holdout"
            holdout_plan = root / "holdout-only-plan.private.json"
            self._write_json(holdout_plan, plan)
            holdout_sealed = root / "holdout-only-sealed"
            sealed = self._seal(
                root,
                fixture["source"],
                fixture["inspection"],
                fixture["layout"],
                fixture["materialized"],
                fixture["worksheet"],
                holdout_plan,
                fixture["tuning"],
                holdout_sealed,
            )
            self.assertEqual(sealed.returncode, 0, sealed.stderr)
            holdout_fixture = {
                **fixture,
                "plan": holdout_plan,
                "sealed": holdout_sealed,
            }
            failed = self._verify_fixture(holdout_fixture)
            self._assert_fixed_failure(failed)
            self.assertEqual(failed.stdout, "")

    def _create_verification_fixture(self, root: Path) -> dict[str, Path]:
        source = root / "synthetic.xml"
        self._write_spreadsheetml(source)
        materialized = self._write_materialization(root)
        inspection = root / "inspection.private.json"
        inspected = self._run(
            "inspect",
            "--private-root",
            str(root),
            "--input",
            str(source),
            "--out",
            str(inspection),
        )
        self.assertEqual(inspected.returncode, 0, inspected.stderr)
        layout = root / "layout.private.json"
        self._write_layout(layout, self._read_json(inspection)["inputSetSha256"])
        worksheet = root / "worksheet"
        initialized = self._run(
            "init",
            "--private-root",
            str(root),
            "--input",
            str(source),
            "--inspection",
            str(inspection),
            "--layout",
            str(layout),
            "--materialized",
            str(materialized),
            "--out",
            str(worksheet),
        )
        self.assertEqual(initialized.returncode, 0, initialized.stderr)
        worksheet_file = worksheet / "review-worksheet.private.json"
        worksheet_value = self._read_json(worksheet_file)
        plan = root / "plan.private.json"
        self._write_json(
            plan,
            self._plan_value(
                worksheet_value,
                worksheet_file,
                row_id="review-row-000001",
                source=worksheet_value["sources"][0],
                purpose="development",
            ),
        )
        tuning = root / "tuning.private.json"
        self._write_json(
            tuning,
            {"version": 1, "confirmedComplete": True, "developmentSamples": []},
        )
        sealed = root / "sealed"
        completed = self._seal(
            root,
            source,
            inspection,
            layout,
            materialized,
            worksheet,
            plan,
            tuning,
            sealed,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return self._verification_fixture_paths(root)

    @staticmethod
    def _verification_fixture_paths(root: Path) -> dict[str, Path]:
        return {
            "root": root,
            "source": root / "synthetic.xml",
            "inspection": root / "inspection.private.json",
            "layout": root / "layout.private.json",
            "materialized": root / "materialized",
            "worksheet": root / "worksheet",
            "plan": root / "plan.private.json",
            "tuning": root / "tuning.private.json",
            "sealed": root / "sealed",
        }

    def _verify_fixture(
        self,
        fixture: dict[str, Path],
        *,
        code_version: str | None = None,
        runner_sha256: str | None = None,
        dependency_sha256: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        expected_runner, expected_dependency = self._verifier_hashes()
        return self._run(
            "verify-sealed",
            "--private-root",
            str(fixture["root"]),
            "--input",
            str(fixture["source"]),
            "--inspection",
            str(fixture["inspection"]),
            "--layout",
            str(fixture["layout"]),
            "--materialized",
            str(fixture["materialized"]),
            "--worksheet",
            str(fixture["worksheet"]),
            "--plan",
            str(fixture["plan"]),
            "--tuning-history",
            str(fixture["tuning"]),
            "--sealed",
            str(fixture["sealed"]),
            "--verifier-code-version",
            code_version or "1" * 40,
            "--verifier-runner-sha256",
            runner_sha256 or expected_runner,
            "--verifier-dependency-code-sha256",
            dependency_sha256 or expected_dependency,
        )

    def _verification_arguments(
        self, fixture: dict[str, Path]
    ) -> argparse.Namespace:
        runner_sha256, dependency_sha256 = self._verifier_hashes()
        return TOOL.argparse.Namespace(
            private_root=str(fixture["root"]),
            input=[str(fixture["source"])],
            inspection=str(fixture["inspection"]),
            layout=str(fixture["layout"]),
            materialized=str(fixture["materialized"]),
            worksheet=str(fixture["worksheet"]),
            plan=str(fixture["plan"]),
            tuning_history=str(fixture["tuning"]),
            sealed=str(fixture["sealed"]),
            verifier_code_version="1" * 40,
            verifier_runner_sha256=runner_sha256,
            verifier_dependency_code_sha256=dependency_sha256,
        )

    @staticmethod
    def _verifier_hashes() -> tuple[str, str]:
        paths = (
            "scripts/migrate-hist/parse-metadata.py",
            "scripts/migrate-hist/prepare-review-gold.py",
        )
        repository = SCRIPT.parents[2]
        contents = {path: (repository / path).read_bytes() for path in sorted(paths)}
        payload = bytearray()
        for path in sorted(contents):
            path_bytes = path.encode("ascii")
            file_bytes = contents[path]
            payload.extend(str(len(path_bytes)).encode("ascii"))
            payload.extend(b":")
            payload.extend(path_bytes)
            payload.extend(b"\x00")
            payload.extend(str(len(file_bytes)).encode("ascii"))
            payload.extend(b":")
            payload.extend(file_bytes)
            payload.extend(b"\x00")
        return _sha256(contents["scripts/migrate-hist/prepare-review-gold.py"]), _sha256(
            bytes(payload)
        )

    def _expected_attestation(self, fixture: dict[str, Path]) -> dict[str, object]:
        inspection = self._read_json(fixture["inspection"])
        layout_bytes = fixture["layout"].read_bytes()
        confirmation = self._read_json(
            fixture["materialized"] / "source-confirmation.private.json"
        )
        report = self._read_json(fixture["materialized"] / "report.json")
        materialization_marker_path = fixture["materialized"] / "MATERIALIZE_COMPLETE"
        materialization_marker = self._read_json(materialization_marker_path)
        worksheet_path = fixture["worksheet"] / "review-worksheet.private.json"
        worksheet_completion_path = fixture["worksheet"] / "REVIEW_WORKSHEET_COMPLETE"
        worksheet = self._read_json(worksheet_path)
        plan = self._read_json(fixture["plan"])
        evidence_path = fixture["sealed"] / "review-gold-evidence.private.json"
        bindings_path = fixture["sealed"] / "source-bindings.private.json"
        additions_path = fixture["sealed"] / "tuning-history-additions.private.json"
        marker_path = fixture["sealed"] / "REVIEW_GOLD_COMPLETE"
        evidence = self._read_json(evidence_path)
        bindings = self._read_json(bindings_path)
        marker = self._read_json(marker_path)
        runner_sha256, dependency_sha256 = self._verifier_hashes()
        bound_by_case = {case["caseId"]: case for case in bindings["cases"]}
        evidence_by_case = {entry["caseId"]: entry for entry in evidence["entries"]}
        cases = []
        for planned in plan["cases"]:
            binding = bound_by_case[planned["caseId"]]
            evidence_entry = evidence_by_case[planned["caseId"]]
            cases.append(
                {
                    "caseId": planned["caseId"],
                    "subjectId": planned["subjectId"],
                    "purpose": planned["purpose"],
                    "evaluationScope": planned["evaluationScope"],
                    "sourceId": planned["sourceId"],
                    "sourcePath": binding["sourcePath"],
                    "sourceSha256": planned["sourceSha256"],
                    "rowEvidenceSha256": binding["rowEvidenceSha256"],
                    "goldSha256": evidence_entry["goldSha256"],
                }
            )
        attestation: dict[str, object] = {
            "schemaVersion": 1,
            "artifactKind": "urmotiv_review_gold_verification_attestation",
            "protocolVersion": "urmotiv-review-gold-verify-sealed-v1",
            "verificationStatus": "complete",
            "upstreamDatasetId": plan["datasetId"],
            "verifier": {
                "repository": "Urmotiv",
                "codeVersion": "1" * 40,
                "runnerPath": "scripts/migrate-hist/prepare-review-gold.py",
                "runnerSha256": runner_sha256,
                "dependencyCodeSha256": dependency_sha256,
                "dependencyFileCount": 2,
            },
            "artifacts": {
                "reviewGoldCompleteSha256": _sha256(marker_path.read_bytes()),
                "evidenceSha256": _sha256(evidence_path.read_bytes()),
                "sourceBindingsSha256": _sha256(bindings_path.read_bytes()),
                "tuningHistorySha256": _sha256(fixture["tuning"].read_bytes()),
                "tuningHistoryAdditionsSha256": _sha256(additions_path.read_bytes()),
                "planSha256": _sha256(fixture["plan"].read_bytes()),
                "worksheetSha256": _sha256(worksheet_path.read_bytes()),
                "worksheetCompletionSha256": _sha256(worksheet_completion_path.read_bytes()),
                "inspectionSha256": _sha256(fixture["inspection"].read_bytes()),
                "layoutSha256": _sha256(layout_bytes),
                "inputSetSha256": inspection["inputSetSha256"],
                "sourceConfirmationCanonicalSha256": _sha256(_compact(confirmation)),
                "materializationCompleteSha256": _sha256(
                    materialization_marker_path.read_bytes()
                ),
                "materializationReportCanonicalSha256": _sha256(_compact(report)),
                "materializationSourceSetSha256": materialization_marker[
                    "sourceSetSha256"
                ],
            },
            "reviewInputs": [
                {
                    "inputId": item["inputId"],
                    "format": item["format"],
                    "inputSha256": item["inputSha256"],
                }
                for item in inspection["inputs"]
            ],
            "cases": cases,
            "counts": {
                "caseCount": marker["caseCount"],
                "developmentCount": marker["developmentCount"],
                "holdoutCount": marker["holdoutCount"],
                "verdictAndTasteCount": marker["verdictAndTasteCount"],
                "originalityOnlyCount": marker["originalityOnlyCount"],
                "reviewInputCount": len(inspection["inputs"]),
                "materializedSourceCount": report["sourceCount"],
            },
        }
        canonical = json.dumps(
            attestation,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        attestation["verificationFingerprint"] = _sha256(canonical)
        return attestation

    @staticmethod
    def _tree_snapshot(root: Path) -> list[tuple[str, str, int, str]]:
        snapshot: list[tuple[str, str, int, str]] = []
        paths = [root, *sorted(root.rglob("*"), key=lambda path: path.as_posix())]
        for path in paths:
            metadata = path.lstat()
            relative = "." if path == root else path.relative_to(root).as_posix()
            mode = stat.S_IMODE(metadata.st_mode)
            if stat.S_ISREG(metadata.st_mode):
                snapshot.append((relative, "file", mode, _sha256(path.read_bytes())))
            elif stat.S_ISDIR(metadata.st_mode):
                snapshot.append((relative, "directory", mode, str(metadata.st_nlink)))
            elif stat.S_ISLNK(metadata.st_mode):
                snapshot.append((relative, "symlink", mode, os.readlink(path)))
            else:
                snapshot.append((relative, "other", mode, ""))
        return snapshot

    @staticmethod
    def _append_tamper(path: Path) -> None:
        path.write_bytes(path.read_bytes() + b" ")
        os.chmod(path, 0o600)

    def _seal(
        self,
        root: Path,
        source: Path,
        inspection: Path,
        layout: Path,
        materialized: Path,
        worksheet: Path,
        plan: Path,
        tuning: Path,
        output: Path,
    ) -> subprocess.CompletedProcess[str]:
        return self._run(
            "seal",
            "--private-root",
            str(root),
            "--input",
            str(source),
            "--inspection",
            str(inspection),
            "--layout",
            str(layout),
            "--materialized",
            str(materialized),
            "--worksheet",
            str(worksheet),
            "--plan",
            str(plan),
            "--tuning-history",
            str(tuning),
            "--out",
            str(output),
        )

    @staticmethod
    def _plan_value(
        worksheet: dict[str, object],
        worksheet_file: Path,
        *,
        row_id: str,
        source: dict[str, object],
        purpose: str,
    ) -> dict[str, object]:
        return {
            "version": 3,
            "confirmed": True,
            "submitterDifficultyColumnsExcludedReconfirmed": True,
            "datasetId": "synthetic-review-gold-v1",
            "worksheetSha256": _sha256(worksheet_file.read_bytes()),
            "sourceConfirmationSha256": worksheet["sourceConfirmationSha256"],
            "cases": [
                {
                    "caseId": "case-synthetic-a",
                    "subjectId": "subject-synthetic-a",
                    "rowId": row_id,
                    "sourceId": source["sourceId"],
                    "sourceSha256": source["sourceSha256"],
                    "purpose": purpose,
                    "evaluationScope": "verdict_and_taste",
                    "verdict": "accepted",
                    "contestUse": "used",
                    "confirmed": True,
                }
            ],
        }

    @staticmethod
    def _write_layout(path: Path, input_set_sha256: str) -> None:
        PrepareReviewGoldTest._write_json(
            path,
            PrepareReviewGoldTest._layout_value(input_set_sha256),
        )

    @staticmethod
    def _column_binding(column: int, role: str, expected_header: str) -> dict[str, object]:
        return {
            "column": column,
            "role": role,
            "expectedHeader": expected_header,
            "confirmed": True,
        }

    @staticmethod
    def _layout_value(input_set_sha256: str, *, input_count: int = 1) -> dict[str, object]:
        return {
            "version": 3,
            "confirmed": True,
            "submitterDifficultyColumnsExcluded": True,
            "inputSetSha256": input_set_sha256,
            "inputs": [
                {
                    "inputId": f"input-{index:06d}",
                    "worksheetId": "worksheet-000001",
                    "headerRow": 1,
                    "columns": [
                        PrepareReviewGoldTest._column_binding(
                            1, "metadata_number", "题号"
                        ),
                        PrepareReviewGoldTest._column_binding(2, "identity", "题名"),
                        PrepareReviewGoldTest._column_binding(
                            3, "excluded_submitter_difficulty", "难度"
                        ),
                        PrepareReviewGoldTest._column_binding(
                            4, "final_decision", "最终结果"
                        ),
                        PrepareReviewGoldTest._column_binding(5, "contest_use", "比赛使用"),
                        PrepareReviewGoldTest._column_binding(
                            6, "review_comment", "审核意见一"
                        ),
                        PrepareReviewGoldTest._column_binding(
                            7, "review_comment", "审核意见二"
                        ),
                    ],
                }
                for index in range(1, input_count + 1)
            ],
        }

    @staticmethod
    def _private_root(path: Path) -> Path:
        root = path / "private"
        root.mkdir(mode=0o700)
        os.chmod(root, 0o700)
        return root.resolve()

    @staticmethod
    def _write_json(path: Path, value: object, *, replace: bool = False) -> None:
        if replace and path.exists():
            path.unlink()
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.chmod(path, 0o600)

    @staticmethod
    def _read_json(path: Path) -> object:
        return json.loads(path.read_text(encoding="utf-8"))

    @staticmethod
    def _write_xlsx(path: Path, *, blank_second_final: bool = False) -> None:
        headers = ["题号", "题名", "难度", "最终结果", "比赛使用", "审核意见一", "审核意见二"]
        rows = [
            [
                "synthetic-001",
                PRIVATE_TITLE_A,
                PRIVATE_DIFFICULTY,
                "SYNTHETIC ACCEPTED RAW",
                "SYNTHETIC CONTEST USED RAW",
                PRIVATE_REVIEW_A,
                "",
            ],
            [
                "synthetic-002",
                PRIVATE_TITLE_B,
                PRIVATE_DIFFICULTY,
                "" if blank_second_final else "SYNTHETIC REJECTED RAW",
                "SYNTHETIC NOT USED RAW",
                PRIVATE_REVIEW_B,
                "SYNTHETIC SECOND RAW REVIEW",
            ],
        ]
        values = list(dict.fromkeys([*headers, *(value for row in rows for value in row)]))
        indexes = {value: index for index, value in enumerate(values)}
        shared_root = ET.Element(f"{{{XLSX_NS}}}sst")
        for value in values:
            item = ET.SubElement(shared_root, f"{{{XLSX_NS}}}si")
            text = ET.SubElement(item, f"{{{XLSX_NS}}}t")
            text.text = value
        worksheet = ET.Element(f"{{{XLSX_NS}}}worksheet")
        sheet_data = ET.SubElement(worksheet, f"{{{XLSX_NS}}}sheetData")
        for row_number, row_values in enumerate([headers, *rows], 1):
            row = ET.SubElement(sheet_data, f"{{{XLSX_NS}}}row", {"r": str(row_number)})
            for column, value in enumerate(row_values, 1):
                cell = ET.SubElement(
                    row,
                    f"{{{XLSX_NS}}}c",
                    {"r": f"{PrepareReviewGoldTest._column(column)}{row_number}", "t": "s"},
                )
                data = ET.SubElement(cell, f"{{{XLSX_NS}}}v")
                data.text = str(indexes[value])
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("xl/sharedStrings.xml", ET.tostring(shared_root, encoding="utf-8"))
            archive.writestr("xl/worksheets/sheet1.xml", ET.tostring(worksheet, encoding="utf-8"))
        os.chmod(path, 0o600)

    @staticmethod
    def _write_spreadsheetml(path: Path) -> None:
        ET.register_namespace("ss", SS_NS)
        workbook = ET.Element(f"{{{SS_NS}}}Workbook")
        worksheet = ET.SubElement(workbook, f"{{{SS_NS}}}Worksheet")
        table = ET.SubElement(worksheet, f"{{{SS_NS}}}Table")
        rows = [
            ["题号", "题名", "难度", "最终结果", "比赛使用", "审核意见一", "审核意见二"],
            [
                "synthetic-001",
                PRIVATE_TITLE_A,
                PRIVATE_DIFFICULTY,
                "SYNTHETIC ACCEPTED RAW",
                "SYNTHETIC CONTEST USED RAW",
                PRIVATE_REVIEW_A,
                "",
            ],
        ]
        for row_values in rows:
            row = ET.SubElement(table, f"{{{SS_NS}}}Row")
            for value in row_values:
                cell = ET.SubElement(row, f"{{{SS_NS}}}Cell")
                data = ET.SubElement(cell, f"{{{SS_NS}}}Data")
                data.text = value
        path.write_bytes(ET.tostring(workbook, encoding="utf-8", xml_declaration=True))
        os.chmod(path, 0o600)

    @staticmethod
    def _column(index: int) -> str:
        result = ""
        value = index
        while value:
            value, remainder = divmod(value - 1, 26)
            result = chr(65 + remainder) + result
        return result

    @staticmethod
    def _write_materialization(root: Path) -> Path:
        directory = root / "materialized"
        sources_directory = directory / "sources"
        directory.mkdir(mode=0o700)
        sources_directory.mkdir(mode=0o700)
        os.chmod(directory, 0o700)
        os.chmod(sources_directory, 0o700)
        texts = [
            "Synthetic statement and solution A.\n",
            "Synthetic statement and solution B.\n",
        ]
        mappings = []
        report_sources = []
        source_set = []
        for index, text in enumerate(texts, 1):
            source_id = f"source-{index:06d}"
            source_path = f"{source_id}.md"
            content = text.encode()
            digest = _sha256(content)
            path = sources_directory / source_path
            path.write_bytes(content)
            os.chmod(path, 0o600)
            mappings.append(
                {
                    "sourcePath": source_path,
                    "sourceSha256": digest,
                    "metadataNumber": f"synthetic-{index:03d}",
                }
            )
            report_sources.append(
                {
                    "groupId": f"group-{index:06d}",
                    "sourceId": source_id,
                    "sourceSha256": digest,
                    "fragmentCount": 1,
                    "byteLength": len(content),
                    "characterCount": len(text.encode("utf-16-le")) // 2,
                    "status": "ready_for_prepare",
                }
            )
            source_set.append(
                {"sourceId": source_id, "sourceSha256": digest, "byteLength": len(content)}
            )
        confirmation = {
            "version": 1,
            "confirmed": True,
            "metadataFileSha256": "1" * 64,
            "mappings": mappings,
        }
        report = {
            "version": 2,
            "phase": "materialize",
            "sourceInventorySha256": "2" * 64,
            "groupingBatchSha256": "3" * 64,
            "fragmentCount": 2,
            "sourceCount": 2,
            "unresolvedItemCount": 0,
            "sources": report_sources,
        }
        marker = {
            "version": 2,
            "phase": "materialize",
            "reportSha256": _sha256(_compact(report)),
            "sourceConfirmationSha256": _sha256(_compact(confirmation)),
            "sourceSetSha256": _sha256(_compact({"version": 1, "sources": source_set})),
            "groupingBatchSha256": "3" * 64,
            "sourceCount": 2,
            "fragmentCount": 2,
            "unresolvedItemCount": 0,
        }
        PrepareReviewGoldTest._write_json(
            directory / "source-confirmation.private.json", confirmation
        )
        PrepareReviewGoldTest._write_json(directory / "report.json", report)
        PrepareReviewGoldTest._write_json(directory / "MATERIALIZE_COMPLETE", marker)
        return directory

    @staticmethod
    def _run(*arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), *arguments],
            check=False,
            capture_output=True,
            text=True,
        )

    @staticmethod
    def _assert_fixed_failure(completed: subprocess.CompletedProcess[str]) -> None:
        assert completed.returncode == 1
        assert (
            completed.stderr
            == "历史审核 Gold 准备失败：输入、确认或输出未通过安全检查。\n"
        )
        assert "SENSITIVE" not in completed.stderr
        assert PRIVATE_DIFFICULTY not in completed.stderr

    @staticmethod
    def _assert_private_tree(root: Path) -> None:
        for path in [root, *root.rglob("*")]:
            mode = stat.S_IMODE(path.lstat().st_mode)
            if path.is_dir():
                assert mode == 0o700
            else:
                assert mode == 0o600


if __name__ == "__main__":
    unittest.main()
