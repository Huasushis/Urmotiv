import type { ArchiveSummary, SafeArchive } from "./archive";
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

/**
 * The worker turns this file list into a ZIP only after it has checked paths
 * again in its isolated output directory.
 */
export interface GeneratedArchive {
  readonly mediaType: string;
  readonly fileName: string;
  readonly files: readonly GeneratedArchiveFile[];
}

export interface ProblemFormatAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;

  detect(input: ArchiveSummary): Promise<DetectionResult>;
  inspect(input: SafeArchive): Promise<ImportPreview>;
  import(input: SafeArchive, choices: ImportChoices): Promise<CanonicalProblem>;
  validateExport(problem: CanonicalProblem, options: ExportOptions): Promise<LossReport>;
  export(problem: CanonicalProblem, options: ExportOptions): Promise<GeneratedArchive>;
}
