#!/usr/bin/env python3
"""Emit an idempotent SQL migration for the private 59–156 review workbook.

The workbook itself is deliberately not part of the repository.  This command
only emits review labels and numeric problem ids; it never prints titles,
statements, solutions, or other workbook cells.  Run the SQL through the
private deployment database, not through a shell log collector.
"""

from __future__ import annotations

import argparse
import json
import re
import uuid
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
WORKBOOK_REL = "xl/_rels/workbook.xml.rels"
WORKBOOK = "xl/workbook.xml"
SHEET_NAME = "逐题验题"
ROWS = range(59, 157)
CONCLUSIONS = {
    "A 可直接入库": ("approve", "approved", "历史验题记录：可直接入库。"),
    "B 小修后可用": ("request_changes", "pending_review", "历史验题记录：小修后可用。"),
    "C 大修后复验": ("request_changes", "pending_review", "历史验题记录：大修后复验。"),
    "D 淘汰/不建议": ("reject", "rejected", "历史验题记录：淘汰或不建议。"),
}
NAMESPACE = uuid.UUID("b9f14f11-10a5-4eb5-bfb4-3d1adf11f6aa")


def sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def json_literal(value: object) -> str:
    return sql_string(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def read_rows(path: Path) -> list[tuple[int, str]]:
    with zipfile.ZipFile(path) as archive:
        shared_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
        shared = ["".join(node.text or "" for node in item.iter(NS + "t")) for item in shared_root.findall(NS + "si")]
        workbook = ET.fromstring(archive.read(WORKBOOK))
        relationships = ET.fromstring(archive.read(WORKBOOK_REL))
        targets = {node.attrib["Id"]: node.attrib["Target"] for node in relationships}
        sheet = next(
            targets[node.attrib[REL_NS + "id"]]
            for node in workbook.find(NS + "sheets")
            if node.attrib.get("name") == SHEET_NAME
        )
        sheet_path = sheet.lstrip("/")
        if not sheet_path.startswith("xl/"):
            sheet_path = "xl/" + sheet_path
        root = ET.fromstring(archive.read(sheet_path))
        rows: list[dict[str, str]] = []
        for row in root.findall(".//" + NS + "row"):
            values: dict[str, str] = {}
            for cell in row.findall(NS + "c"):
                column = re.match(r"[A-Z]+", cell.attrib["r"])
                if column is None:
                    continue
                value = cell.find(NS + "v")
                if value is None:
                    values[column.group()] = ""
                elif cell.attrib.get("t") == "s":
                    values[column.group()] = shared[int(value.text or "0")]
                else:
                    values[column.group()] = value.text or ""
            if values:
                rows.append(values)
    result: list[tuple[int, str]] = []
    for row in rows[1:]:
        try:
            number = int(row.get("A", ""))
        except ValueError:
            continue
        if number in ROWS:
            result.append((number, row.get("E", "")))
    if sorted(number for number, _ in result) != list(ROWS):
        raise SystemExit("历史验题工作簿必须恰好包含 59–156 共 98 条记录。")
    return result


def emit(records: list[tuple[int, str]]) -> None:
    print("BEGIN;")
    print("UPDATE problems SET external_review_enabled = (id > 156), updated_at = now() WHERE id <= 156;")
    for number, conclusion in records:
        verdict, status, reason = CONCLUSIONS.get(conclusion, ("", "", ""))
        if not verdict:
            raise SystemExit("工作簿含有未知的验题结论。")
        round_id = str(uuid.uuid5(NAMESPACE, f"round:{number}"))
        opinion_id = str(uuid.uuid5(NAMESPACE, f"opinion:{number}"))
        closed = status != "pending_review"
        round_status = "approved" if status == "approved" else "rejected" if status == "rejected" else "open"
        decided_by = "1" if closed else "NULL"
        decision_reason = sql_string(reason) if closed else "NULL"
        counted = json_literal([opinion_id]) if closed else "'[]'::jsonb"
        used = json_literal([opinion_id]) if closed else "'[]'::jsonb"
        decision_source = sql_string("manual") if closed else "NULL"
        decided_at = "now()" if closed else "NULL"
        print(
            "INSERT INTO review_rounds (id,problem_id,round,submitted_revision_id,status,rule_id,rule_version,rule_settings,"
            "submitted_by_user_id,decided_by_user_id,decision_reason,counted_opinion_ids,used_opinion_ids,used_review_item_ids,"
            f"decision_source,decided_at,created_at) SELECT {sql_string(round_id)}::uuid,p.id,1,r.id,{sql_string(round_status)}::review_round_status,"
            "'org.ustc.urmotiv.review-default.count','1.0.0','{\"countRobotReviews\":true,\"maximumRejections\":2,\"requiredApprovals\":2}'::jsonb,"
            f"1,{decided_by},{decision_reason},{counted},{used},'[]'::jsonb,{decision_source}::varchar,{decided_at},now() "
            f"FROM problems p JOIN problem_revisions r ON r.problem_id=p.id AND r.revision=p.current_revision WHERE p.id={number} "
            "AND NOT EXISTS (SELECT 1 FROM review_rounds x WHERE x.problem_id=p.id AND x.round=1);"
        )
        print(
            "INSERT INTO review_opinions (id,round_id,reviewer_user_id,source,verdict,codeforces_difficulty,quality_level,"
            "originality_level,thinking_level,coding_level,improvements,public_comment,private_note,created_at,updated_at) "
            f"SELECT {sql_string(opinion_id)}::uuid,{sql_string(round_id)}::uuid,2,'fermata'::review_source,{sql_string(verdict)}::review_verdict,"
            f"COALESCE(pr.codeforces_difficulty,1200),3,NULL,COALESCE(pr.thinking_level,3),COALESCE(pr.coding_level,3),"
            f"{sql_string(reason)},{sql_string('历史标定记录已同步；外部自动审核对本题已关闭。')},"
            f"{sql_string('历史来源：USTC 新生赛 59-156 验题记录。')},now(),now() FROM problems p "
            f"JOIN problem_revisions pr ON pr.problem_id=p.id AND pr.revision=p.current_revision WHERE p.id={number} "
            "AND NOT EXISTS (SELECT 1 FROM review_opinions o JOIN review_rounds rr ON rr.id=o.round_id "
            "WHERE rr.problem_id=p.id AND rr.round=1 AND o.reviewer_user_id=2);"
        )
        print(
            f"UPDATE problems SET status={sql_string(status)}::problem_status,current_review_round=1,status_changed_by_user_id=1,"
            f"status_reason={sql_string(reason)},updated_at=now() WHERE id={number};"
        )
    print("COMMIT;")


parser = argparse.ArgumentParser()
parser.add_argument("workbook", type=Path)
args = parser.parse_args()
emit(read_rows(args.workbook))
