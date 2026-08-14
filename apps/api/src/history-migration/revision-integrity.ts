import { sql } from "drizzle-orm";
import type { DatabaseHandle } from "@urmotiv/database";
import type { CanonicalProblem } from "@urmotiv/problem-package";

import { sha256Hex } from "./digests";
import { HistoryMigrationError } from "./errors";

export interface CandidateProblemIdentity {
  readonly candidateId: string;
  readonly problemId: string;
}

export interface RevisionContentInventory {
  readonly revisionCount: number;
  readonly nullSolutionCount: number;
  readonly emptySolutionCount: number;
  readonly fullContentSha256: string;
  readonly frozenContentSha256: string;
  // 修订内容面向数据库行的确定性投影摘要。期望侧与数据库实拍侧都必须
  // 生成并相等；任一侧缺失即对账失败（失败关闭），不允许 OR 不对称放行。
  readonly databaseRowsSha256: string;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };
type SolutionValue = { readonly kind: "null" } | { readonly kind: "text"; readonly value: string };

function canonicalJson(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJson(item)] as const);
    return Object.fromEntries(entries);
  }
  throw new HistoryMigrationError("INVALID_METADATA", "修订内容包含不能生成完整性摘要的值。");
}

function solutionValue(value: string | null): SolutionValue {
  return value === null ? { kind: "null" } : { kind: "text", value };
}

interface CanonicalRevisionRecord {
  readonly candidateId: string;
  readonly revision: number;
  readonly title: string;
  readonly type: string;
  readonly codeforcesDifficulty: number | null;
  readonly thinkingLevel: number | null;
  readonly codingLevel: number | null;
  readonly basicStatement: string;
  readonly basicSolution: SolutionValue;
  readonly background: string;
  readonly statement: string;
  readonly inputFormat: string;
  readonly outputFormat: string;
  readonly constraints: string;
  readonly solution: string;
  readonly hints: string;
  readonly judgeConfig: JsonValue;
  readonly formatExtensions: JsonValue;
}

function canonicalRecord(candidateId: string, revision: number, problem: CanonicalProblem): CanonicalRevisionRecord {
  return {
    candidateId,
    revision,
    title: problem.title,
    type: problem.type,
    codeforcesDifficulty: problem.difficulty.codeforces ?? null,
    thinkingLevel: problem.difficulty.thinkingLevel ?? null,
    codingLevel: problem.difficulty.codingLevel ?? null,
    basicStatement: problem.content.basicStatement,
    basicSolution: solutionValue(problem.content.basicSolution),
    background: problem.content.background,
    statement: problem.content.statement,
    inputFormat: problem.content.inputFormat,
    outputFormat: problem.content.outputFormat,
    constraints: problem.content.constraints,
    solution: problem.content.solution,
    hints: problem.content.hints,
    judgeConfig: canonicalJson(problem.judge ?? {}),
    formatExtensions: canonicalJson(problem.extensions),
  };
}

function buildInventory(records: readonly CanonicalRevisionRecord[]): RevisionContentInventory {
  const ordered = [...records].sort((left, right) => {
    const candidateOrder = left.candidateId.localeCompare(right.candidateId);
    return candidateOrder === 0 ? left.revision - right.revision : candidateOrder;
  });
  const frozen = ordered.map(({ title: _title, ...record }) => record);
  return {
    revisionCount: ordered.length,
    nullSolutionCount: ordered.filter((record) => record.basicSolution.kind === "null").length,
    emptySolutionCount: ordered.filter(
      (record) => record.basicSolution.kind === "text" && record.basicSolution.value === "",
    ).length,
    fullContentSha256: sha256Hex(JSON.stringify(ordered)),
    frozenContentSha256: sha256Hex(JSON.stringify(frozen)),
    databaseRowsSha256: sha256Hex(JSON.stringify(ordered.map(canonicalJson))),
  };
}

export function expectedRevisionContentInventory(
  packages: readonly { readonly candidateId: string; readonly problem: CanonicalProblem }[],
): RevisionContentInventory {
  return buildInventory(packages.map(({ candidateId, problem }) => canonicalRecord(candidateId, 1, problem)));
}

interface RevisionRow {
  readonly problem_id: string;
  readonly revision: number;
  readonly status: string;
  readonly title: string;
  readonly type: string;
  readonly codeforces_difficulty: number | null;
  readonly thinking_level: number | null;
  readonly coding_level: number | null;
  readonly basic_statement: string;
  readonly basic_solution: string | null;
  readonly background: string;
  readonly statement: string;
  readonly input_format: string;
  readonly output_format: string;
  readonly constraints: string;
  readonly solution: string;
  readonly hints: string;
  readonly judge_config: unknown;
  readonly format_extensions: unknown;
  readonly changed_fields: unknown;
  readonly content_hash: string;
  readonly change_reason: string;
  readonly created_by_user_id: string;
  readonly created_at: string;
  readonly [key: string]: unknown;
}

export async function captureImportedRevisionContentInventory(
  database: DatabaseHandle,
  identities: readonly CandidateProblemIdentity[],
): Promise<RevisionContentInventory> {
  if (identities.length === 0) {
    throw new HistoryMigrationError("INVALID_METADATA", "修订内容清单不能使用空问题集合。");
  }
  const candidateByProblem = new Map<string, string>();
  for (const identity of identities) {
    if (candidateByProblem.has(identity.problemId)) {
      throw new HistoryMigrationError("INVALID_METADATA", "导入清单包含重复的问题身份。");
    }
    candidateByProblem.set(identity.problemId, identity.candidateId);
  }
  const ids = sql.join(identities.map(({ problemId }) => sql`${problemId}::bigint`), sql`, `);
  const rows = await database.query<RevisionRow>(
    sql`select problem_id::text as problem_id,
               revision, status::text as status, title, type::text as type,
               codeforces_difficulty, thinking_level, coding_level,
               basic_statement, basic_solution, background, statement,
               input_format, output_format, constraints, solution, hints,
               judge_config, format_extensions, changed_fields,
               content_hash, change_reason, created_by_user_id::text as created_by_user_id,
               created_at::text as created_at
          from "public"."problem_revisions"
         where problem_id in (${ids})
         order by problem_id, revision`,
  );

  const canonicalRecords: CanonicalRevisionRecord[] = [];
  for (const row of rows) {
    const candidateId = candidateByProblem.get(row.problem_id);
    if (candidateId === undefined) {
      throw new HistoryMigrationError("INVALID_METADATA", "修订内容清单出现未批准的问题身份。");
    }
    const canonical: CanonicalRevisionRecord = {
      candidateId,
      revision: row.revision,
      title: row.title,
      type: row.type,
      codeforcesDifficulty: row.codeforces_difficulty,
      thinkingLevel: row.thinking_level,
      codingLevel: row.coding_level,
      basicStatement: row.basic_statement,
      basicSolution: solutionValue(row.basic_solution),
      background: row.background,
      statement: row.statement,
      inputFormat: row.input_format,
      outputFormat: row.output_format,
      constraints: row.constraints,
      solution: row.solution,
      hints: row.hints,
      judgeConfig: canonicalJson(row.judge_config),
      formatExtensions: canonicalJson(row.format_extensions),
    };
    canonicalRecords.push(canonical);
  }
  return buildInventory(canonicalRecords);
}
