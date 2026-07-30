/**
 * 历史题目迁移的命令行入口。
 *
 * 具体校验、候选生成和题目包生成都在 src/history-migration 中。本文件只读取参数，
 * 这样安全规则可以用合成数据做单元测试。所有输入和输出都必须位于服务器非 Git 私有目录。
 */
import {
  createLlmHistoryNormalizer,
  HistoryMigrationError,
  packageApprovedCandidates,
  prepareHistoryCandidates
} from "../src/history-migration/index";

type Command =
  | {
      readonly phase: "prepare";
      readonly privateRootDirectory: string;
      readonly sourceDirectory: string;
      readonly metadataFile: string;
      readonly sourceConfirmationFile: string;
      readonly outputDirectory: string;
    }
  | {
      readonly phase: "package";
      readonly privateRootDirectory: string;
      readonly sourceDirectory: string;
      readonly metadataFile: string;
      readonly sourceConfirmationFile: string;
      readonly preparedDirectory: string;
      readonly approvalFile: string;
      readonly outputDirectory: string;
      readonly authorMappingOutput: string;
    };

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2));
  if (command.phase === "prepare") {
    const baseUrl = process.env.AETHER_BASE_URL;
    const apiKey = process.env.AETHER_API_KEY;
    if (baseUrl === undefined || apiKey === undefined) {
      throw new HistoryMigrationError(
        "INVALID_ARGUMENTS",
        "准备候选内容需要私有模型地址与密钥。"
      );
    }
    const result = await prepareHistoryCandidates({
      privateRootDirectory: command.privateRootDirectory,
      sourceDirectory: command.sourceDirectory,
      metadataFile: command.metadataFile,
      sourceConfirmationFile: command.sourceConfirmationFile,
      outputDirectory: command.outputDirectory,
      normalizer: createLlmHistoryNormalizer({
        baseUrl,
        apiKey,
        model: process.env.MIGRATE_MODEL ?? "deepseek-v4-flash"
      })
    });
    process.stdout.write(
      `已读取 ${result.sourceCount} 个确认源文件，生成 ${result.candidateCount} 个待人工批准的候选。\n`
    );
    return;
  }

  const result = await packageApprovedCandidates({
    privateRootDirectory: command.privateRootDirectory,
    sourceDirectory: command.sourceDirectory,
    metadataFile: command.metadataFile,
    sourceConfirmationFile: command.sourceConfirmationFile,
    preparedDirectory: command.preparedDirectory,
    approvalFile: command.approvalFile,
    outputDirectory: command.outputDirectory,
    authorMappingOutput: command.authorMappingOutput
  });
  process.stdout.write(
    `已生成 ${result.packageCount} 个题目包，另写出 ${result.authorMappingCount} 条私有作者映射。\n`
  );
}

function parseCommand(argv: readonly string[]): Command {
  const phase = argv[0];
  if (phase === "prepare") {
    return {
      phase,
      privateRootDirectory: requiredOption(argv, "--private-root"),
      sourceDirectory: requiredOption(argv, "--source"),
      metadataFile: requiredOption(argv, "--metadata"),
      sourceConfirmationFile: requiredOption(argv, "--source-confirmation"),
      outputDirectory: requiredOption(argv, "--out")
    };
  }
  if (phase === "package") {
    return {
      phase,
      privateRootDirectory: requiredOption(argv, "--private-root"),
      sourceDirectory: requiredOption(argv, "--source"),
      metadataFile: requiredOption(argv, "--metadata"),
      sourceConfirmationFile: requiredOption(argv, "--source-confirmation"),
      preparedDirectory: requiredOption(argv, "--prepared"),
      approvalFile: requiredOption(argv, "--approval"),
      outputDirectory: requiredOption(argv, "--out"),
      authorMappingOutput: requiredOption(argv, "--author-map-out")
    };
  }
  throw new HistoryMigrationError(
    "INVALID_ARGUMENTS",
    "必须明确选择 prepare 或 package 阶段。"
  );
}

function requiredOption(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      `缺少必填参数 ${name}。确认文件不能省略。`
    );
  }
  return value;
}

main().catch((error: unknown) => {
  const code =
    error instanceof HistoryMigrationError ? error.code : "UNEXPECTED_FAILURE";
  process.stderr.write(
    `历史迁移失败（${code}）。为避免泄露私有题目，命令行不显示文件名或正文；请在私有目录核对输入和确认文件。\n`
  );
  process.exitCode = 1;
});
