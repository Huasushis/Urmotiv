export type HistoryMigrationErrorCode =
  | "INVALID_ARGUMENTS"
  | "INVALID_METADATA"
  | "INVALID_SOURCE_CONFIRMATION"
  | "INVALID_GROUPING"
  | "INVALID_ATTACHMENT_MAPPING"
  | "INVALID_CANDIDATE_APPROVAL"
  | "INVALID_SOURCE_SELECTION"
  | "INVALID_CANDIDATE_SEED"
  | "SOURCE_MAPPING_MISSING"
  | "SOURCE_MAPPING_CHANGED"
  | "SOURCE_FILE_INVALID"
  | "SOURCE_TOO_LARGE"
  | "SOURCE_DIGEST_MISMATCH"
  | "GROUPING_CHANGED"
  | "ATTACHMENT_MAPPING_CHANGED"
  | "ATTACHMENT_MAPPING_INCOMPLETE"
  | "ATTACHMENT_PACKAGING_UNAVAILABLE"
  | "INVALID_ATTACHMENT_MAPPING_CAPABILITY"
  | "FRAGMENT_OUT_OF_RANGE"
  | "NORMALIZATION_FAILED"
  | "PREPARE_INCOMPLETE"
  | "PREPARE_RESUME_UNSAFE"
  | "CANDIDATE_INVALID"
  | "CANDIDATE_CHANGED"
  | "CANDIDATE_NOT_FOUND"
  | "REPAIR_MANIFEST_INVALID"
  | "REPAIR_REJECTED"
  | "DUPLICATE_ASSIGNMENT"
  | "OUTPUT_ALREADY_EXISTS"
  | "OUTPUT_WRITE_FAILED"
  | "LEASE_BUSY"
  | "SOURCE_INTENT_MISMATCH"
  | "LEASE_LOST"
  | "RECOVERY_PENDING"
  | "CLEANUP_FAILED"
  | "NOT_AUTHORIZED"
  | "INTERNAL_ERROR";
export class HistoryMigrationError extends Error {
  public readonly code: HistoryMigrationErrorCode;

  public constructor(code: HistoryMigrationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
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
  /** Safe HTTP status class (e.g. "4xx"/"5xx") if available; never the raw body. */
  public readonly httpStatusClass: string | undefined;

  public constructor(failureKind: HistoryNormalizationFailureKind, message: string, httpStatusClass: string | undefined = undefined) {
    super("NORMALIZATION_FAILED", message);
    this.name = "HistoryNormalizationError";
    this.failureKind = failureKind;
    this.httpStatusClass = httpStatusClass;
  }
}
