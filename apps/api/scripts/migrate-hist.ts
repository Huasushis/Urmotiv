/**
 * 历史题目规范化迁移工具。
 *
 * 把 hist_problem/ 里格式各异的历史题目（单题 md、含图片的 zip、一个文件多道题、
 * 编号区间）用一个便宜的大模型规范化成 Urmotiv 的统一题目结构，产出可走既有导入
 * 管线的原生题目包，并为每一题写出预览 JSON 供人工确认后再导入。
 *
 * 安全：输入题目内容属于协会私有资料。本工具只在服务器非 Git 私有目录运行，
 * 输出（预览、原生包）也写入私有目录；日志只打印编号与长度，不打印题面正文。
 * 规范化使用的模型密钥由环境变量提供，不写入任何输出。
 *
 * 依赖：借用 @urmotiv/api 工作区的 @urmotiv/problem-package（原生包）与
 * @urmotiv/contracts（结构校验）。用法：
 *   env AETHER_BASE_URL=.. AETHER_API_KEY=.. \
 *     tsx apps/api/scripts/migrate-hist.ts \
 *       --source <hist_problem目录> --metadata <metadata.json> --out <输出目录> [--limit N] [--only 15,100]
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalProblemSchema,
  urmotivNativeAdapter,
  writeZipArchive,
  type CanonicalProblem
} from "@urmotiv/problem-package";
import { z } from "zod";

interface Args {
  source: string;
  metadata: string;
  out: string;
  limit: number;
  only: Set<string> | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const source = get("--source");
  const metadata = get("--metadata");
  const out = get("--out");
  if (source === undefined || metadata === undefined || out === undefined) {
    throw new Error("必须提供 --source、--metadata、--out。");
  }
  const only = get("--only");
  return {
    source,
    metadata,
    out,
    limit: Number.parseInt(get("--limit") ?? "0", 10) || Number.POSITIVE_INFINITY,
    only: only === undefined ? null : new Set(only.split(",").map((value) => value.trim()))
  };
}

const metadataRecordSchema = z.object({
  number: z.string(),
  name: z.string(),
  difficultyText: z.string().default(""),
  difficultyGuess: z.number().int().nullable().default(null),
  authorStudentId: z.string().default(""),
  status: z.string().default(""),
  contest: z.string().default(""),
  note: z.string().default("")
});
type MetadataRecord = z.infer<typeof metadataRecordSchema>;

/** 模型被要求输出的结构；再由本工具映射到 canonicalProblemSchema。 */
const normalizedSchema = z.object({
  problems: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        type: z.string().default("traditional"),
        basicStatement: z.string().trim().min(1),
        basicSolution: z.string().trim().min(1),
        statement: z.string().default(""),
        inputFormat: z.string().default(""),
        outputFormat: z.string().default(""),
        constraints: z.string().default(""),
        samples: z
          .array(z.object({ input: z.coerce.string().default(""), output: z.coerce.string().default(""), explanation: z.coerce.string().default("") }))
          .default([]),
        tags: z.array(z.string()).default([]),
        confidence: z.coerce.number().min(0).max(1).catch(0.5).default(0.5),
        migrationNote: z.string().default("")
      })
    )
    .min(1)
    .max(30)
});

interface ProblemSource {
  readonly key: string;
  readonly text: string;
  readonly assetNames: readonly string[];
}

function readProblemSources(sourceDir: string): ProblemSource[] {
  const entries = readdirSync(sourceDir);
  const sources: ProblemSource[] = [];
  for (const entry of entries) {
    if (entry.endsWith(".md")) {
      const key = entry.replace(/\.md$/, "");
      // 附件类 md（如 “N-附件.md”）跳过，只处理题面 md。
      if (key.includes("附件")) continue;
      sources.push({
        key,
        text: readFileSync(join(sourceDir, entry), "utf8"),
        assetNames: []
      });
    }
    // zip 里的 md 由调用方预先解压到同名目录再传入；本工具只读 md 文本，
    // 图片等二进制附件在人工确认阶段单独上传，不进入 LLM。
  }
  return sources;
}

function matchMetadata(records: MetadataRecord[], key: string): MetadataRecord | undefined {
  const leading = key.match(/^\d+/)?.[0];
  return records.find((record) => record.number === key || record.number === leading);
}

async function normalizeWithLlm(
  source: ProblemSource,
  metadata: MetadataRecord | undefined,
  baseUrl: string,
  apiKey: string,
  model: string
): Promise<z.infer<typeof normalizedSchema>> {
  const system =
    "你是算法竞赛题库迁移助手。给你一段历史题目的原始文本（可能包含题面、数据范围、题解，" +
    "有时一个文件里有多道题）。请整理成结构化 JSON。要求：" +
    "1) 若含多道题，拆成 problems 数组的多项；2) basicStatement 是完整可读的题面（Markdown），" +
    "basicSolution 是题解（没有就写“（迁移时缺题解，待补充）”）；3) 样例若能识别就放进 samples；" +
    "4) 只做整理和归类，不要编造原文没有的内容；5) migrationNote 里写下你做的关键处置（如“拆分自合并文件”）。" +
    "只输出 JSON：{\"problems\":[{title,type,basicStatement,basicSolution,statement,inputFormat,outputFormat,constraints,samples:[{input,output,explanation}],tags,confidence,migrationNote}]}。";
  const metaLine = metadata
    ? `参考元数据（可能不准，仅供命名与难度参考）：题号 ${metadata.number}，名称「${metadata.name}」，难度参考 ${metadata.difficultyGuess ?? "未知"}，备注：${metadata.note.slice(0, 500)}`
    : "（没有匹配到元数据）";
  const user = `${metaLine}\n\n原始文本：\n${source.text.slice(0, 40_000)}`;

  let response: Response | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 240_000);
    try {
      response = await fetch(new URL("chat/completions", ensureSlash(baseUrl)), {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          stream: false,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ]
        })
      });
    } catch {
      response = undefined;
    } finally {
      clearTimeout(timer);
    }
    if (response !== undefined && response.ok) break;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 3_000));
  }
  if (response === undefined || !response.ok) {
    throw new Error(`模型请求失败，状态码 ${response?.status ?? "超时"}`);
  }
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("模型响应内容不是文本。");
  }
  const jsonText = content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
  return normalizedSchema.parse(JSON.parse(jsonText));
}

function normalizeType(raw: string): "traditional" | "interactive" | "submit_answer" {
  const value = raw.toLowerCase();
  if (value.includes("interactive") || raw.includes("交互")) return "interactive";
  if (value.includes("submit") || raw.includes("提交答案")) return "submit_answer";
  return "traditional";
}

function toCanonical(
  problem: z.infer<typeof normalizedSchema>["problems"][number],
  metadata: MetadataRecord | undefined
): CanonicalProblem {
  const difficulty = metadata?.difficultyGuess ?? null;
  const type = normalizeType(problem.type);
  return canonicalProblemSchema.parse({
    title: problem.title,
    type,
    tags: problem.tags.filter((tag) => tag.length > 0).slice(0, 30),
    difficulty: difficulty === null ? {} : { codeforces: difficulty },
    content: {
      basicStatement: problem.basicStatement,
      basicSolution: problem.basicSolution,
      statement: problem.statement,
      inputFormat: problem.inputFormat,
      outputFormat: problem.outputFormat,
      constraints: problem.constraints
    },
    samples: problem.samples.map((sample) => ({
      input: sample.input,
      output: sample.output,
      explanation: sample.explanation
    })),
    files: [],
    provenance: {
      sourceSystem: "ustc-hist",
      ...(metadata?.number ? { sourceProblemId: metadata.number } : {})
    },
    extensions: {
      migration: {
        confidence: problem.confidence,
        note: problem.migrationNote,
        authorStudentId: metadata?.authorStudentId ?? "",
        originalName: metadata?.name ?? ""
      }
    }
  });
}

async function main(): Promise<void> {
  const args = parseArgs();
  const baseUrl = process.env.AETHER_BASE_URL;
  const apiKey = process.env.AETHER_API_KEY;
  const model = process.env.MIGRATE_MODEL ?? "deepseek-v4-flash";
  if (!baseUrl || !apiKey) {
    throw new Error("需要 AETHER_BASE_URL 与 AETHER_API_KEY 环境变量。");
  }
  mkdirSync(args.out, { recursive: true });
  mkdirSync(join(args.out, "previews"), { recursive: true });
  mkdirSync(join(args.out, "packages"), { recursive: true });

  const metadata = z
    .object({ records: z.array(metadataRecordSchema) })
    .parse(JSON.parse(readFileSync(args.metadata, "utf8"))).records;

  const sources = readProblemSources(args.source).filter(
    (source) => args.only === null || args.only.has(source.key) || args.only.has(source.key.match(/^\d+/)?.[0] ?? "")
  );

  let processed = 0;
  let emitted = 0;
  const report: Array<Record<string, unknown>> = [];
  for (const source of sources) {
    if (processed >= args.limit) break;
    processed += 1;
    const meta = matchMetadata(metadata, source.key);
    try {
      const normalized = await normalizeWithLlm(source, meta, baseUrl, apiKey, model);
      for (const [index, problem] of normalized.problems.entries()) {
        const canonical = toCanonical(problem, meta);
        const slug = `${source.key}${normalized.problems.length > 1 ? `-${index + 1}` : ""}`;
        writeFileSync(
          join(args.out, "previews", `${slug}.json`),
          JSON.stringify(canonical, null, 2),
          "utf8"
        );
        const archive = await urmotivNativeAdapter.export(canonical, {
          exportedAt: "2026-07-26T00:00:00.000Z"
        });
        writeFileSync(join(args.out, "packages", `${slug}.zip`), Buffer.from(writeZipArchive(archive.files)));
        emitted += 1;
        report.push({
          slug,
          title: problem.title,
          confidence: problem.confidence,
          difficulty: meta?.difficultyGuess ?? null,
          statementLength: problem.basicStatement.length,
          hasSolution: !problem.basicSolution.includes("待补充"),
          migrationNote: problem.migrationNote
        });
        process.stdout.write(
          `[ok] ${slug} 置信度=${problem.confidence.toFixed(2)} 题面长度=${problem.basicStatement.length}\n`
        );
      }
    } catch (error) {
      report.push({ slug: source.key, error: error instanceof Error ? error.message : "未知错误" });
      process.stdout.write(`[fail] ${source.key}: ${error instanceof Error ? error.message : "未知错误"}\n`);
    }
  }

  writeFileSync(join(args.out, "report.json"), JSON.stringify({ processed, emitted, report }, null, 2), "utf8");
  process.stdout.write(`\n处理 ${processed} 个源文件，产出 ${emitted} 道题目包。预览与包在 ${args.out}。\n`);
}

function ensureSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

// 保留：将来若需要按内容摘要去重，可用它给每题打指纹。
export function sourceFingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

main().catch((error) => {
  process.stderr.write(`迁移失败：${error instanceof Error ? error.message : "未知错误"}\n`);
  process.exitCode = 1;
});
