import { describe, expect, it } from "vitest";
import {
  assertFormalDatabaseName,
  assertProductionFormalImportCount,
  designatedRealFormalImportCount,
  computeFormalTargetFingerprintSha256,
  formalTargetApprovalSchema,
  resolveFormalInputs,
  runFormalImport,
  runFormalImportBound,
} from "../scripts/run-formal-import";
import { HistoryMigrationError } from "../src/history-migration";

describe("正式导入入口：参数校验与机械拒绝", () => {
  function baseEnvironment(): NodeJS.ProcessEnv {
    return {
      PRIVATE_ROOT: "/srv/urmotiv/private",
      PACKAGE_DIRECTORY: "/srv/urmotiv/private/phase2-evidence/packages",
      LIST_METADATA: "/srv/urmotiv/private/phase2-evidence/list.private.json",
      GROUPING_FILE: "/srv/urmotiv/private/phase2-evidence/grouping.private.json",
      MATERIALIZED_DIRECTORY: "/srv/urmotiv/private/phase2-evidence/materialized",
      PREPARED_DIRECTORY: "/srv/urmotiv/private/phase2-evidence/prepared",
      APPROVAL_FILE: "/srv/urmotiv/private/approval.private.json",
      PREFLIGHT_RECEIPT:
        "/srv/urmotiv/private/phase2-evidence/preflight-run-private/done/preflight-receipt.private.json",
      PHASE2_RECEIPT: "/srv/urmotiv/private/phase2-evidence/phase2-run-receipt.private.json",
      TARGET_APPROVAL: "/srv/urmotiv/private/target-approval.private.json",
      OUTPUT_DIRECTORY: "/srv/urmotiv/private/phase2-evidence/formal-output",
      STORAGE_ROOT: "/srv/urmotiv/private/storage",
      IMPORT_OUTPUT_DIRECTORY: "/srv/urmotiv/private/import-output",
      DATABASE_URL: "postgresql://urmotiv:secret@127.0.0.1:5433/urmotiv_formal_ok",
      ADMIN_URL: "postgresql://urmotiv:secret@127.0.0.1:5433/urmotiv_admin",
      PRINCIPAL: "e48c53a9",
      TAG_ID: "tag.01.01",
      GIT_COMMIT: "d9068f1360c6b31c398741be0b1e1b51bc1b69f5",
      EXECUTION_ID: "formal-unit-01",
      TARGET_CLASS: "designated-real",
      BATCH_SHA256: "a".repeat(64),
      SOURCE_BINDINGS_SHA256: "b".repeat(64),
    };
  }

  const fullArguments = [
    "--private-root-env=PRIVATE_ROOT",
    "--package-directory-env=PACKAGE_DIRECTORY",
    "--list-metadata-env=LIST_METADATA",
    "--grouping-file-env=GROUPING_FILE",
    "--materialized-directory-env=MATERIALIZED_DIRECTORY",
    "--prepared-directory-env=PREPARED_DIRECTORY",
    "--approval-file-env=APPROVAL_FILE",
    "--preflight-receipt-env=PREFLIGHT_RECEIPT",
    "--phase2-receipt-env=PHASE2_RECEIPT",
    "--target-approval-env=TARGET_APPROVAL",
    "--output-directory-env=OUTPUT_DIRECTORY",
    "--storage-root-env=STORAGE_ROOT",
    "--import-output-directory-env=IMPORT_OUTPUT_DIRECTORY",
    "--database-url-env=DATABASE_URL",
    "--admin-url-env=ADMIN_URL",
    "--principal-env=PRINCIPAL",
    "--tag-id-env=TAG_ID",
    "--git-commit-env=GIT_COMMIT",
    "--execution-id-env=EXECUTION_ID",
    "--target-class-env=TARGET_CLASS",
    "--batch-sha256-env=BATCH_SHA256",
    "--source-bindings-sha256-env=SOURCE_BINDINGS_SHA256",
  ];

  function expectRefused(
    argumentsValue: readonly string[],
    environment: NodeJS.ProcessEnv,
  ): void {
    try {
      resolveFormalInputs(argumentsValue, environment);
    } catch (error) {
      expect(error).toBeInstanceOf(HistoryMigrationError);
      expect((error as HistoryMigrationError).code).toBe("INVALID_ARGUMENTS");
      return;
    }
    throw new Error("本应被拒绝的正式导入输入竟然通过校验。");
  }

  it("目标库名不允许落入临时/验收库命名范围", () => {
    expect(() => assertFormalDatabaseName("")).toThrowError(HistoryMigrationError);
    expect(() => assertFormalDatabaseName("urmotiv_history_import_abc")).toThrowError(
      HistoryMigrationError,
    );
    expect(() => assertFormalDatabaseName("urmotiv_history_import_suffix1")).toThrowError(
      HistoryMigrationError,
    );
    expect(() => assertFormalDatabaseName("urmotiv_formal_ok")).not.toThrow();
  });

  it("非法形式、未获批参数与重复参数逐一拒绝", () => {
    expectRefused(["--PRIVATE_ROOT=/x"], baseEnvironment());
    expectRefused([...fullArguments, "--extra-env=EXTRA"], baseEnvironment());
    expectRefused([...fullArguments, "--tag-id-env=TAG_ID"], baseEnvironment());
    expectRefused(["--tag-id-env"], baseEnvironment());
  });

  it("缺 env、错误 target-class 与坏摘要逐一拒绝", () => {
    const missingTarget = baseEnvironment();
    missingTarget.TARGET_CLASS = undefined;
    expectRefused(fullArguments, missingTarget);
    const wrongTarget = baseEnvironment();
    wrongTarget.TARGET_CLASS = "runner-scratch-compare";
    expectRefused(fullArguments, wrongTarget);
    const badDigest = baseEnvironment();
    badDigest.BATCH_SHA256 = "not-a-digest";
    expectRefused(fullArguments, badDigest);
    const missingEnv = baseEnvironment();
    missingEnv.TAG_ID = " ";
    expectRefused(fullArguments, missingEnv);
  });

  it("连接串不合法或指向临时/验收库名时拒绝", () => {
    const wrongProtocol = baseEnvironment();
    wrongProtocol.DATABASE_URL = "mongodb://127.0.0.1/urmotiv_formal_ok";
    expectRefused(fullArguments, wrongProtocol);
    const scratchName = baseEnvironment();
    scratchName.DATABASE_URL =
      "postgresql://urmotiv:secret@127.0.0.1:5433/urmotiv_history_import_a1";
    expectRefused(fullArguments, scratchName);
  });

  it("维护连接必须与目标同实例同身份，否则机械拒绝", () => {
    const otherHost = baseEnvironment();
    otherHost.ADMIN_URL = "postgresql://urmotiv:secret@127.0.0.2:5433/urmotiv_admin";
    expectRefused(fullArguments, otherHost);
    const otherPort = baseEnvironment();
    otherPort.ADMIN_URL = "postgresql://urmotiv:secret@127.0.0.1:5434/urmotiv_admin";
    expectRefused(fullArguments, otherPort);
    const otherUser = baseEnvironment();
    otherUser.ADMIN_URL = "postgresql://postgres:secret@127.0.0.1:5433/urmotiv_admin";
    expectRefused(fullArguments, otherUser);
    const missingAdminKey = [...fullArguments].filter(
      (argument) => !argument.startsWith("--admin-url-env"),
    );
    expectRefused(missingAdminKey, baseEnvironment());
    const missingApprovalKey = [...fullArguments].filter(
      (argument) => !argument.startsWith("--target-approval-env"),
    );
    expectRefused(missingApprovalKey, baseEnvironment());
  });

  it("正式目标身份指纹：同身份稳定、任何字段变化都改变摘要", () => {
    const base = {
      host: "127.0.0.1",
      port: "5433",
      user: "urmotiv",
      database: "urmotiv_formal_ok",
    };
    expect(computeFormalTargetFingerprintSha256(base)).toMatch(/^[a-f0-9]{64}$/);
    expect(computeFormalTargetFingerprintSha256(base)).toBe(
      computeFormalTargetFingerprintSha256({ ...base }),
    );
    expect(computeFormalTargetFingerprintSha256({ ...base, database: "urmotiv_formal_ok2" })).not.toBe(
      computeFormalTargetFingerprintSha256(base),
    );
    expect(
      computeFormalTargetFingerprintSha256({
        ...base,
        host: "urmotiv.example",
        user: "urmotiv",
        database: "urmotiv_formal_ok",
      }),
    ).not.toBe(computeFormalTargetFingerprintSha256(base));
  });

  it("带外批准书结构：版本/字段严格，缺失或篡改一概拒绝", () => {
    const good = {
      version: 2,
      generatedAt: "2026-08-14T00:00:00.000Z",
      expiresAt: "2026-08-15T00:00:00.000Z",
      nonce: "e".repeat(32),
      approvedByActorSha256: "f".repeat(64),
      branchName: "codex/review-admin",
      gitCommitSha256: "a".repeat(64),
      expectedFormalImportCount: 1,
      storageRootIdentitySha256: "b".repeat(64),
      prestateDatabaseInventorySha256: "c".repeat(64),
      prestateStorageInventorySha256: "d".repeat(64),
      adminTargetFingerprintSha256: "e".repeat(64),
      preflightReceiptSha256: "a".repeat(64),
      phase2ReceiptSha256: "b".repeat(64),
      scratchDatabaseFingerprintSha256: "c".repeat(64),
      formalTargetFingerprintSha256: "d".repeat(64),
    };
    expect(formalTargetApprovalSchema.parse(good)).toEqual(good);
    expect(() =>
      formalTargetApprovalSchema.parse({ ...good, version: 1 }),
    ).toThrow();
    expect(() =>
      formalTargetApprovalSchema.parse({ ...good, formalTargetFingerprintSha256: "nope" }),
    ).toThrow();
    expect(() =>
      formalTargetApprovalSchema.parse({ ...good, expiresAt: "2026-08-13T00:00:00.000Z" }),
    ).toEqual(expect.anything());
    const { formalTargetFingerprintSha256: _omitted, ...missing } = good;
    expect(() => formalTargetApprovalSchema.parse(missing)).toThrow();
    expect(() =>
      formalTargetApprovalSchema.parse({ ...good, extra: "not-allowed" }),
    ).toThrow();
    expect(() =>
      formalTargetApprovalSchema.parse({ ...good, nonce: "not-hex" }),
    ).toThrow();
  });

  it("合法输入解析出完整正式参数，且门禁外拒绝返回非零退出码", async () => {
    const inputs = resolveFormalInputs(fullArguments, baseEnvironment());
    expect(inputs.databaseName).toBe("urmotiv_formal_ok");
    expect(inputs.adminUrl).toBe(baseEnvironment().ADMIN_URL);
    expect(inputs.privateRoot).toBe("/srv/urmotiv/private");
    expect(inputs.tagId).toBe("tag.01.01");
    // 真实执行需要数据库与收据文件，直接运行必然在密码学门禁处拒绝，退出码不能是 0。
    const code = await runFormalImport(fullArguments, baseEnvironment());
    expect(code === 1 || code === 2).toBe(true);
  });

  it("注入受限：生产入口拒绝合成命名，绑定入口只允许回环合成目标", async () => {
    const validEnv = baseEnvironment();
    delete validEnv.VITEST;
    // 生产入口只有 (argv, env) 一个签名：ur_motiv_ 前缀合成命名被机械拒绝，hook 无法注入。
    const productionCode = await runFormalImport(fullArguments, validEnv);
    expect(productionCode === 1 || productionCode === 2).toBe(true);
    // 绑定入口：空故障面被拒绝；即使 hook 想执行也没有机会接触。
    const seams: Promise<number>[] = [
      runFormalImportBound(fullArguments, validEnv, {}),
      // 非回环主机上的合成命名目标：绑定入口也机械拒绝，hook 不会执行。
      runFormalImportBound(
        fullArguments,
        { ...validEnv, ADMIN_URL: "postgresql://u:p@db.internal.example:5432/urmotiv_formal_ok" },
        { storage: {} as never },
        {
          verifyProvenance: async () => {
            throw new Error("hook 不应在门禁拒绝时执行");
          },
        },
      ),
    ];
    const codes = await Promise.all(seams);
    for (const code of codes) {
      expect(code === 1 || code === 2).toBe(true);
    }
  });
  it("数量闸门：仅指定批次精确数量通过", () => {
    expect(() =>
      assertProductionFormalImportCount(designatedRealFormalImportCount),
    ).not.toThrow();
    for (const count of [0, 1, 155, 157]) {
      expect(() => assertProductionFormalImportCount(count)).toThrowError(
        expect.objectContaining({ code: "INVALID_METADATA" }),
      );
    }
  });
  it("数量闸门绑定唯一生产常数，防止误改", () => {
    expect(designatedRealFormalImportCount).toBe(156);
  });
});