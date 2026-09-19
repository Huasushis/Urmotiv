#!/usr/bin/env python3
"""Legacy importer disabled: workbook numbers are not database problem IDs.

Do not emit SQL before a reviewed source-to-problem mapping is available.
The former importer also invented missing ratings and discarded review text.
Its output is not suitable for production; retained database backups must be
used to reconcile any prior execution.
"""
import sys

if __name__ == "__main__":
    print(
        "HISTORY_MAPPING_REQUIRED: 旧导入器已停用。必须核对来源题号与数据库题目映射，"
        "保留完整审核记录和缺失评分；不能直接按工作簿编号写库。",
        file=sys.stderr,
    )
    raise SystemExit(2)
