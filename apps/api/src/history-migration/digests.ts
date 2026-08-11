import { createHash } from "node:crypto";
import type { CanonicalProblem } from "@urmotiv/problem-package";
import {
  historyCandidateProblemSchema,
  historyContentDigestSchema,
  historySourceIdSchema
} from "./schema";

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function candidateContentDigest(input: {
  readonly sourceId: string;
  readonly sourceContentSha256: string;
  readonly sourceMappingSha256: string;
  readonly modelConfidence: number;
  readonly normalizationNote: string;
  readonly problem: CanonicalProblem;
}): string {
  return sha256Hex(
    JSON.stringify({
      sourceId: historySourceIdSchema.parse(input.sourceId),
      sourceContentSha256: historyContentDigestSchema.parse(
        input.sourceContentSha256
      ),
      sourceMappingSha256: historyContentDigestSchema.parse(
        input.sourceMappingSha256
      ),
      modelConfidence: input.modelConfidence,
      normalizationNote: input.normalizationNote,
      problem: historyCandidateProblemSchema.parse(input.problem)
    })
  );
}

export function sourceMappingDigest(
  mapping: {
    readonly sourcePath: string;
    readonly sourceSha256: string;
    readonly metadataNumber: string;
  },
  metadataFileSha256: string
): string {
  return sha256Hex(
    JSON.stringify({
      sourcePath: mapping.sourcePath,
      sourceSha256: mapping.sourceSha256,
      metadataNumber: mapping.metadataNumber,
      metadataFileSha256: historyContentDigestSchema.parse(metadataFileSha256)
    })
  );
}

/**
 * 计算与标题、元数据文件摘要和包摘要完全无关的来源绑定摘要。
 *
 * 绑定只取来源编号、来源内容摘要和标题无关的映射定位元组
 *（源路径、源内容摘要、元数据题号）——四者唯一确定
 * "这道题来自哪个源文件的哪条元数据映射"，不包含标题/名称、元数据文件摘要、
 * 题面、题解或包字节。因此仅修改元数据中的名称（标题）不会改变来源绑定：
 * 元数据文件摘要会变、来源映射摘要（sourceMappingSha256）会变，但来源绑定不变。
 * 回放同一绑定时会解析到既有题目编号，不会创建重复题目或覆盖后来授权修改的标题。
 *
 * 注意：sourceMappingSha256（含 metadataFileSha256）仍保留在候选记录中用于
 * 溯源/审计，但不参与身份绑定。
 */
export function sourceBindingDigest(input: {
  readonly sourceId: string;
  readonly sourceContentSha256: string;
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly metadataNumber: string;
}): string {
  return sha256Hex(
    JSON.stringify({
      sourceId: historySourceIdSchema.parse(input.sourceId),
      sourceContentSha256: historyContentDigestSchema.parse(
        input.sourceContentSha256
      ),
      sourcePath: input.sourcePath,
      sourceSha256: historyContentDigestSchema.parse(input.sourceSha256),
      metadataNumber: input.metadataNumber
    })
  );
}
