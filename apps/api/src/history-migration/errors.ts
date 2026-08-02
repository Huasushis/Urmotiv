export type HistoryMigrationErrorCode =
  | "INVALID_ARGUMENTS"
  | "INVALID_METADATA"
  | "INVALID_SOURCE_CONFIRMATION"
  | "INVALID_GROUPING"
  | "INVALID_CANDIDATE_APPROVAL"
  | "SOURCE_MAPPING_MISSING"
  | "SOURCE_MAPPING_CHANGED"
  | "SOURCE_FILE_INVALID"
  | "SOURCE_TOO_LARGE"
  | "SOURCE_DIGEST_MISMATCH"
  | "GROUPING_CHANGED"
  | "FRAGMENT_OUT_OF_RANGE"
  | "NORMALIZATION_FAILED"
  | "PREPARE_INCOMPLETE"
  | "PREPARE_RESUME_UNSAFE"
  | "CANDIDATE_INVALID"
  | "CANDIDATE_CHANGED"
  | "CANDIDATE_NOT_FOUND"
  | "DUPLICATE_ASSIGNMENT"
  | "OUTPUT_ALREADY_EXISTS"
  | "OUTPUT_WRITE_FAILED";

export class HistoryMigrationError extends Error {
  public readonly code: HistoryMigrationErrorCode;

  public constructor(code: HistoryMigrationErrorCode, message: string) {
    super(message);
    this.name = "HistoryMigrationError";
    this.code = code;
  }
}

export const historyNormalizationFailureKinds = [
  "http_429",
  "http_499",
  "http_status",
  "cancelled",
  "connection",
  "first_output_timeout",
  "output_idle_timeout",
  "maximum_duration_timeout",
  "protocol",
  "schema",
  "eof_incomplete",
  "invalid_json",
  "invalid_utf8",
  "response_too_large",
  "source_validation",
  "candidate_validation",
  "internal",
] as const;

export type HistoryNormalizationFailureKind = (typeof historyNormalizationFailureKinds)[number];

/**
 * 模型失败只携带固定分类和不含正文的安全消息。调用方据此写检查点，
 * 不得把传输层异常、响应正文或模型原始回答写入报告。
 */
export class HistoryNormalizationError extends HistoryMigrationError {
  public readonly failureKind: HistoryNormalizationFailureKind;

  public constructor(failureKind: HistoryNormalizationFailureKind, message: string) {
    super("NORMALIZATION_FAILED", message);
    this.name = "HistoryNormalizationError";
    this.failureKind = failureKind;
  }
}
