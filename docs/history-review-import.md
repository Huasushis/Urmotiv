# 导入历史审核记录

这项工具供有服务器访问权的管理员迁移旧审核记录，不会调用模型。原题号和数据库 ID 是两套编号，必须先用原题文件或已核实的来源对应关系建立映射；不能按工作簿行号直接更新数据库。

## 保留什么

- 原始结论、建议难度、正确性说明、问题、修改要求和查重来源等内容以完整分节文本保存，在题目“审核记录”中展开查看。
- A 类“可直接入库”设为已通过；B 类“小修后可用”、C 类“大修后复验”保持待审核；D 类“淘汰或不建议”设为不通过。
- 不把文字难度转换成未经标定的 CF 分数，不生成缺失的质量、思维或代码评分。原记录未填写的字段保持空白。
- 历史题即使缺少基础题解也能保留审核档案，不伪造题解来通过新投稿校验。之后新投稿仍使用原来的完整性检查。
- 导入的题目关闭外部验题。另可指定一批未审核的旧题仅关闭外部验题；不会改它们的状态。新题默认仍开启。

## 准备私有文件

先备份数据库，再在隔离数据库验证。整理为权限 `600` 的 JSON 文件，文件及原始资料均不得加入 Git。

```json
{
  "version": 1,
  "actorUserId": "1",
  "records": [{
    "problemId": "42",
    "expectedRevision": 3,
    "expectedContentHash": "替换为已核实修订的64位十六进制content_hash",
    "review": {
      "version": 1,
      "sourceSha256": "替换为原始审核文件的64位SHA256",
      "sourceNumber": 59,
      "conclusion": "B",
      "sections": [
        { "label": "正确性核验", "content": "这里填写原始记录，保留完整文本。" },
        { "label": "建议难度", "content": "" }
      ]
    }
  }],
  "disableExternalReview": []
}
```

示例中的编号和摘要是占位值，不可直接执行。`disableExternalReview` 的每项同样包含 `problemId`、`expectedRevision`、`expectedContentHash`。操作者必须是能查看并管理这些题目状态的真人管理员，明确拒绝依然生效。

## 预演与应用

在已配置 `DATABASE_URL` 的 API 运行环境中执行：

```bash
pnpm --filter @urmotiv/api exec tsx src/import-historical-reviews-cli.ts /secure/reviews.json
```

默认完整执行后回滚，只输出计数。核对预演结果及备份后，使用同一文件加 `--apply`：

```bash
pnpm --filter @urmotiv/api exec tsx src/import-historical-reviews-cli.ts /secure/reviews.json --apply
```

整批在一个数据库事务中执行。编号重复、内容摘要不匹配、权限不足或某条记录失败都会整批回滚。已有活跃审核不会被覆盖；重复运行同一批已成功导入的数据不会重复创建审核轮次。更改同一来源记录的内容或把它改绑到另一题会报冲突，需要先人工核实。

旧 `scripts/migrate-hist/sync-review-records.py` 已停用：它曾把题号当作数据库 ID，丢失详细说明并补造评分，不可继续用于迁移。
