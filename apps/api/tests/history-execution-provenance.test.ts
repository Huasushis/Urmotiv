import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  assertPermittedPhase2EvidenceRoot,
  permittedPhase2EvidenceRoot,
  verifyExecutionProvenance,
} from "../src/history-migration/execution-provenance";

const evidenceRoot = permittedPhase2EvidenceRoot();

beforeAll(async () => {
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  await chmod(evidenceRoot, 0o700);
});

describe("Phase-2 execution provenance", () => {
  it("只接受项目内固定、owner-only 且 Git 忽略的证据根", async () => {
    await expect(assertPermittedPhase2EvidenceRoot(evidenceRoot)).resolves.toBe(evidenceRoot);
    await expect(
      assertPermittedPhase2EvidenceRoot(join(evidenceRoot, "alternate")),
    ).rejects.toThrow("固定");
  });

  it("在读取 Git 状态前拒绝非完整提交摘要", async () => {
    await expect(verifyExecutionProvenance("deadbeef")).rejects.toThrow("完整");
  });
});
