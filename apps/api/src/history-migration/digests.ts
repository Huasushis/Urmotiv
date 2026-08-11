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
 * 计算与标题和包摘要无关的来源绑定摘要。
 *
 * 绑定只取来源编号、来源内容摘要和来源映射摘要——三者唯一确定
 * "这道题来自哪个源文件的哪条元数据映射"，不包含标题、题面或包字节。
 * 因此标题改动不会改变来源绑定，回放同一绑定时会解析到既有题目编号，
 * 而不会创建重复题目或覆盖后来授权修改的标题。
 */
export function sourceBindingDigest(input: {
  readonly sourceId: string;
  readonly sourceContentSha256: string;
  readonly sourceMappingSha256: string;
}): string {
  return sha256Hex(
    JSON.stringify({
      sourceId: historySourceIdSchema.parse(input.sourceId),
      sourceContentSha256: historyContentDigestSchema.parse(
        input.sourceContentSha256
      ),
      sourceMappingSha256: historyContentDigestSchema.parse(
        input.sourceMappingSha256
      )
    })
  );
}
