/**
 * 历史导入预检 CLI。只接收环境变量名，不含任何 hook/故障注入通道；
 * 测试组合用 tests/history-migration/ 下测试专用模块注入依赖。预检不写库，
 * 仅产出零变更 re-itemized receipts（.private.json）。
 */
import { runHistoryImportPreflight } from "../src/history-migration/preflight-core";

export {
  resolvePreflightInputs,
  preflightReceiptName,
  preflightPassMarkerName,
  runHistoryImportPreflight,
} from "../src/history-migration/preflight-core";
export type {
  PreflightInputs,
  HistoryImportPreflightHooks,
  TargetClass,
} from "../src/history-migration/preflight-core";

if (import.meta.url === `file://${process.argv[1]}`) {
  runHistoryImportPreflight(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
