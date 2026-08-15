/**
 * 正式导入 CLI：唯一生产入口，不提供任何 hook/故障注入面。
 * 测试组合通过 src/history-migration/formal-runner-core.ts 的
 * runFormalImportBound 显式注入并受回环+合成命名门限制。
 */
import { runFormalImport } from "../src/history-migration/formal-runner-core";

export {
  runFormalImport,
  runFormalImportBound,
  resolveFormalInputs,
  computeFormalTargetFingerprintSha256,
  computeFormalAdminFingerprintSha256,
  computeStorageRootIdentitySha256,
  parsePostgresIdentity,
  assertFormalDatabaseName,
  assertProductionFormalDatabaseName,
  assertProductionFormalImportCount,
  designatedRealFormalImportCount,
  assertSyntheticFormalDatabaseAllowed,
  formalTargetApprovalSchema,
  formalReceiptName,
  formalPassMarkerName,
  formalRetiredPassReceiptName,
  formalRetiredPassMarkerName,
  formalPassRetirementEvidenceName,
  formalBackupVerifiedMarkerName,
  formalRollbackVerifiedMarkerName,
  formalRestoreRefusedMarkerName,
  formalBackupEvidenceName,
  formalRollbackEvidenceName,
  formalCleanupPendingEvidenceName,
  completeFormalFinalizationCleanup,
} from "../src/history-migration/formal-runner-core";
export type {
  FormalImportHooks,
  FormalImportTestSeam,
  FormalTargetApproval,
  FormalTargetIdentity,
  FormalInputs,
  FormalImportPassSummary,
} from "../src/history-migration/formal-runner-core";

if (import.meta.url === `file://${process.argv[1]}`) {
  runFormalImport(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
