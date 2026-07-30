export type HistoryMigrationErrorCode =
  | "INVALID_ARGUMENTS"
  | "INVALID_METADATA"
  | "INVALID_SOURCE_CONFIRMATION"
  | "INVALID_CANDIDATE_APPROVAL"
  | "SOURCE_MAPPING_MISSING"
  | "SOURCE_MAPPING_CHANGED"
  | "SOURCE_FILE_INVALID"
  | "SOURCE_TOO_LARGE"
  | "SOURCE_DIGEST_MISMATCH"
  | "NORMALIZATION_FAILED"
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
