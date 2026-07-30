import type { ArchiveSummary, SafeArchive } from "./archive";
import type { ProblemPackageInputKind } from "./input";
import type { CanonicalFileCategory, CanonicalProblem } from "./schema";
import type { LossReport } from "./loss-report";

export interface DetectionResult {
  /** A value from 0 to 1. The caller still asks the user to confirm the format. */
  readonly confidence: number;
  readonly reason: string;
}

export interface ImportIssue {
  readonly severity: "error" | "warning" | "info";
  readonly path?: string;
  readonly message: string;
}

export interface ImportPreview {
  readonly formatId: string;
  readonly problemCount: number;
  readonly title?: string;
  readonly files: readonly string[];
  readonly issues: readonly ImportIssue[];
}

/**
 * Conflict handling is deliberately only a declared choice. The API checks
 * whether a caller may update the selected problem before it creates a task.
 */
export interface ImportChoices {
  readonly conflictAction: "create" | "update";
  readonly targetProblemId?: string;
  readonly values?: Readonly<Record<string, unknown>>;
}

export interface ExportOptions {
  readonly exportedAt?: string;
  readonly includeFileCategories?: readonly CanonicalFileCategory[];
  readonly values?: Readonly<Record<string, unknown>>;
}

export interface GeneratedArchiveFile {
  readonly path: string;
  readonly content: Uint8Array;
}

/** The worker checks these files again before it writes a ZIP. */
export interface GeneratedZipArchive {
  /**
   * Plugin API v1 originally returned only `files`. Keep that source shape
   * assignable; new adapters should set `kind: "zip"` explicitly.
   */
  readonly kind?: "zip";
  readonly mediaType: string;
  readonly fileName: string;
  readonly files: readonly GeneratedArchiveFile[];
}

/**
 * Some OJ exchange formats are one original file rather than a ZIP. The
 * current shared transport accepts only XML for this branch.
 */
export interface GeneratedSingleFileArchive {
  readonly kind: "single_file";
  readonly mediaType: string;
  readonly fileName: string;
  readonly content: Uint8Array;
}

export type GeneratedArchive = GeneratedZipArchive | GeneratedSingleFileArchive;

export interface ProblemFormatAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  /**
   * Older adapters omitted this field and are treated as ZIP adapters.
   * A raw-file adapter must explicitly declare "single_file".
   */
  readonly inputKind?: ProblemPackageInputKind;

  detect(input: ArchiveSummary): Promise<DetectionResult>;
  inspect(input: SafeArchive): Promise<ImportPreview>;
  import(input: SafeArchive, choices: ImportChoices): Promise<CanonicalProblem>;
  validateExport(problem: CanonicalProblem, options: ExportOptions): Promise<LossReport>;
  export(problem: CanonicalProblem, options: ExportOptions): Promise<GeneratedArchive>;
}

export function inputKindForProblemFormatAdapter(
  adapter: ProblemFormatAdapter
): ProblemPackageInputKind {
  return adapter.inputKind ?? "zip";
}
