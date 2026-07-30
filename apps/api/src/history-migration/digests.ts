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
