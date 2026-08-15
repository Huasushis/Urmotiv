/**
 * 第 2 阶段验收导入 CLI。只接收环境变量名，不含任何 hook/故障注入通道；
 * 测试组合用 tests/history-migration/phase2-runner-harness.ts（仅测试目录可见）。
 */
import {
  runPhase2Acceptance,
} from "../src/history-migration/phase2-runner-core";

export {
  runPhase2Acceptance,
  runPhase2Bound,
  completePhase2TerminalCleanup,
  type Phase2RunnerHooks,
} from "../src/history-migration/phase2-runner-core";
export { resolveRunnerInputs, preflightReceiptSchema, phase2RunReceiptSchema } from "../src/history-migration/runner-inputs";
export type { RunnerInputs, TargetClass, PreflightReceipt, Phase2RunReceipt } from "../src/history-migration/runner-inputs";
export { importManifestName, targetApprovalTemplateName, cleanupRecoveryEvidenceName, runReceiptName, runPassMarkerName, recoveryMarkerName, cleanupMarkerName, cleanupRefusedMarkerName } from "../src/history-migration/pipeline-constants";

if (import.meta.url === `file://${process.argv[1]}`) {
  runPhase2Acceptance(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
