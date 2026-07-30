/**
 * 实现已移动到 @urmotiv/jobs 的 worker-types.ts，这里保留同名转发，
 * 使 worker 应用与其测试的导入路径保持不变。
 */
export {
  ConsoleJobLogger,
  PermanentJobError,
  jobHandlerResultSchema,
  jobLogOutcomes,
  validateItemReport,
  type JobHandler,
  type JobHandlerContext,
  type JobHandlerResult,
  type JobLogEvent,
  type JobLogger
} from "@urmotiv/jobs";
