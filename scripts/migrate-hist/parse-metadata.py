#!/usr/bin/env python3
"""把 USTC题目列表.xlsx 解析成迁移工具用的 metadata.json（仅标准库）。

只保留迁移需要的列，**主动剔除 QQ 号等个人隐私信息**，也不导入审核人之后难以追踪的列。
输出文件属于私有数据，必须留在非 Git 目录（.gitignore 已覆盖）。

用法：
    python3 parse-metadata.py <xlsx路径> <输出 metadata.json 路径>
"""
from __future__ import annotations

import json
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def _col_number(ref: str) -> int:
    letters = re.match(r"[A-Z]+", ref or "A").group(0)
    value = 0
    for ch in letters:
        value = value * 26 + (ord(ch) - 64)
    return value


def _difficulty_from_name(name: str) -> int | None:
    """题目难度写在名称里，通常是区间（如“约2000分”“3000~3300”）。取中点并四舍五入到整百。"""
    numbers = [int(n) for n in re.findall(r"\d{3,4}", name)]
    numbers = [n for n in numbers if 800 <= n <= 3500]
    if not numbers:
        return None
    midpoint = sum(numbers[:2]) / len(numbers[:2])
    rounded = round(midpoint / 100) * 100
    return max(800, min(3500, rounded))


def main() -> int:
    if len(sys.argv) != 3:
        sys.stderr.write("用法：python3 parse-metadata.py <xlsx> <out.json>\n")
        return 2
    xlsx_path, out_path = sys.argv[1], sys.argv[2]

    archive = zipfile.ZipFile(xlsx_path)
    shared: list[str] = []
    if "xl/sharedStrings.xml" in archive.namelist():
        root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
        for si in root.findall(f"{_NS}si"):
            shared.append("".join(t.text or "" for t in si.iter(f"{_NS}t")))

    sheet = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
    data = sheet.find(f"{_NS}sheetData")
    rows = data.findall(f"{_NS}row") if data is not None else []

    records = []
    for row in rows[1:]:  # 跳过表头
        cells: dict[int, str] = {}
        for cell in row.findall(f"{_NS}c"):
            value_node = cell.find(f"{_NS}v")
            text = value_node.text if value_node is not None else ""
            if cell.get("t") == "s" and text and text.isdigit():
                text = shared[int(text)]
            cells[_col_number(cell.get("r"))] = (text or "").strip()

        number = cells.get(1, "")
        name = cells.get(2, "")
        if not number or not name:
            continue
        # 列：1序号 2名称 3难度 4出题人 5学号 6QQ(剔除) 7状态 8比赛 9备注 10-12审核人(剔除)
        records.append(
            {
                "number": number,
                "name": name,
                "difficultyText": cells.get(3, ""),
                "difficultyGuess": _difficulty_from_name(name + " " + cells.get(3, "")),
                "authorStudentId": cells.get(5, ""),
                "status": cells.get(7, ""),
                "contest": cells.get(8, ""),
                "note": cells.get(9, ""),
            }
        )

    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump({"records": records}, handle, ensure_ascii=False, indent=2)
    sys.stderr.write(f"已写出 {len(records)} 条元数据（已剔除 QQ 号与审核人列）。\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
