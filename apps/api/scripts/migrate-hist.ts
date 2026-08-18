/**
 * 历史题目迁移的命令行入口。
 *
 * 具体校验、候选生成和题目包生成都在 src/history-migration 中。本文件只读取参数，
 * 这样安全规则可以用合成数据做单元测试。所有输入和输出都必须位于服务器非 Git 私有目录。
 */
import { join } from "node:path";
import {
  assertHistoryAttachmentMappingComplete,
  assertHistoryMaterializationComplete,
  createLlmHistoryNormalizer,
  HistoryMigrationError,
  initializeHistoryGroupingWorksheet,
  initializeHistoryAttachmentMappingWorksheet,
  inventoryHistorySources,
  loadHistoryPreparationCodeSha256,
  materializeHistoryGrouping,
  packageApprovedCandidates,
  prepareHistoryCandidates,
  repairFailedHistoryCandidates,
  sealHistoryGrouping,
  sealHistoryAttachmentMapping,
  writeHistoryGroupingConfirmation,
} from "../src/history-migration/index";

type Command =
  | {
      readonly phase: "inventory";
      readonly privateRootDirectory: string;
      readonly sourceDirectory: string;
      readonly outputDirectory: string;
    }
  | {
      readonly phase: "init-grouping";
      readonly privateRootDirectory: string;
      readonly sourceInventoryFile: string;
      readonly sourceLocationsFile: string;
      readonly metadataFile: string;
      readonly outputDirectory: string;
    }
  | {
      readonly phase: "seal-grouping";
      readonly privateRootDirectory: string;
      readonly sourceDirectory: string;
      readonly sourceInventoryFile: string;
      readonly sourceLocationsFile: string;
      readonly metadataFile: string;
      readonly groupingPlanFile: string;
      readonly outputDirectory: string;
    }
  | {
      readonly phase: "confirm-grouping";
      readonly privateRootDirectory: string;
      readonly sourceInventoryFile: string;
      readonly sourceLocationsFile: string;
      readonly metadataFile: string;
      readonly groupingDirectory: string;
      readonly outputFile: string;
      readonly confirmed: true;
    }
  | {
      readonly phase: "materialize";
      readonly privateRootDirectory: string;
      readonly sourceDirectory: string;
      readonly sourceInventoryFile: string;
      readonly sourceLocationsFile: string;
      readonly metadataFile: string;
      readonly groupingDirectory: string;
      readonly groupingConfirmationFile: string;
      readonly outputDirectory: string;
    }
  | {
      readonly phase: "init-attachments";
      readonly privateRootDirectory: string;
      readonly sourceDirectory: string;
      readonly sourceInventoryFile: string;
      readonly sourceLocationsFile: string;
      readonly metadataFile: string;
      readonly groupingDirectory: string;
      readonly groupingConfirmationFile: string;
      readonly outputDirectory: string;
    }
  | {
      readonly phase: "seal-attachments";
      readonly privateRootDirectory: string;
      readonly sourceDirectory: string;
      readonly sourceInventoryFile: string;
      readonly sourceLocationsFile: string;
      readonly metadataFile: string;
      readonly groupingDirectory: string;
      readonly groupingConfirmationFile: string;
      readonly worksheetDirectory: string;
      readonly mappingPlanFile: string;
      readonly outputDirectory: string;
    }
  | {
      readonly phase: "assert-attachments";
      readonly privateRootDirectory: string;
      readonly sourceDirectory: string;
      readonly sourceInventoryFile: string;
      readonly sourceLocationsFile: string;
      readonly metadataFile: string;
      readonly groupingDirectory: string;
      readonly groupingConfirmationFile: string;
      readonly attachmentMappingDirectory: string;
    }
  | {
      readonly phase: "prepare";
      readonly privateRootDirectory: string;
      readonly materializedDirectory: string;
      readonly metadataFile: string;
      readonly outputDirectory: string;
      readonly operationTag: string;
      readonly selectionManifestFile?: string;
      readonly concurrency: number;
      readonly resume: boolean;
    }
  | {
      readonly phase: "repair-local";
      readonly privateRootDirectory: string;
      readonly materializedDirectory: string;
      readonly metadataFile: string;
      readonly preparedDirectory: string;
      readonly repairManifestFile: string;
    }
  | {
      readonly phase: "package";
      readonly privateRootDirectory: string;
      readonly materializedDirectory: string;
      readonly metadataFile: string;
      readonly preparedDirectory: string;
      readonly approvalFile: string;
      readonly outputDirectory: string;
      readonly authorMappingOutput: string;
      readonly attachmentSourceDirectory: string;
      readonly sourceInventoryFile: string;
      readonly sourceLocationsFile: string;
      readonly groupingDirectory: string;
      readonly groupingConfirmationFile: string;
      readonly attachmentMappingDirectory: string;
    };

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2));
  if (command.phase === "inventory") {
    const result = await inventoryHistorySources(command);
    process.stdout.write(
      `已登记 ${result.sourceCount} 个私有源文件：${result.textSourceCount} 个可直接分组文本、${result.archiveSourceCount} 个安全压缩包、${result.manualSourceCount} 个仍需人工处理的文件；压缩包普通条目共 ${result.archiveEntryCount} 个。\n`,
    );
    return;
  }
  if (command.phase === "init-grouping") {
    await initializeHistoryGroupingWorksheet(command);
    process.stdout.write(
      "已生成只含安全编号和计数的空白分组工作表；没有生成任何映射建议或人工确认。\n",
    );
    return;
  }
  if (command.phase === "seal-grouping") {
    const result = await sealHistoryGrouping(command);
    process.stdout.write(
      `已为 ${result.fragmentCount} 个人工选择片段计算摘要，形成 ${result.groupCount} 个完整且待单独确认的题目分组。\n`,
    );
    return;
  }
  if (command.phase === "confirm-grouping") {
    await writeHistoryGroupingConfirmation(command);
    process.stdout.write("已写出与当前源清单、元数据和分组逐项绑定的人工确认。\n");
    return;
  }
  if (command.phase === "materialize") {
    const result = await materializeHistoryGrouping(command);
    process.stdout.write(
      `已物化 ${result.sourceCount} 份一题一文件文本，共使用 ${result.fragmentCount} 个片段；完整性报告没有未处置项目。\n`,
    );
    return;
  }
  if (command.phase === "init-attachments") {
    const result = await initializeHistoryAttachmentMappingWorksheet(command);
    process.stdout.write(
      `已登记 ${result.attachmentCount} 个待人工映射附件；全部保持 unresolved，未生成完成确认。\n`,
    );
    return;
  }
  if (command.phase === "seal-attachments") {
    const result = await sealHistoryAttachmentMapping(command);
    process.stdout.write(
      `已逐项确认 ${result.resolvedItemCount} 个附件，完成标记绑定了当前清单、分组、目标和引用改写表。\n`,
    );
    return;
  }
  if (command.phase === "assert-attachments") {
    const capability = await assertHistoryAttachmentMappingComplete(command);
    process.stdout.write(
      `附件映射完成门验证通过，共 ${capability.attachmentCount} 个附件且没有 unresolved 项。\n`,
    );
    return;
  }
  if (command.phase === "prepare") {
    await assertHistoryMaterializationComplete({
      privateRootDirectory: command.privateRootDirectory,
      materializedDirectory: command.materializedDirectory,
    });
    const baseUrl = process.env.AETHER_BASE_URL;
    const apiKey = process.env.AETHER_API_KEY;
    if (baseUrl === undefined || apiKey === undefined) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "准备候选内容需要私有模型地址与密钥。");
    }
    const codeSha256 = await loadHistoryPreparationCodeSha256();
    const normalizer = createLlmHistoryNormalizer({
      baseUrl,
      apiKey,
      model: process.env.MIGRATE_MODEL ?? "deepseek-v4-flash",
      codeSha256,
    });
    const result = await prepareHistoryCandidates({
      privateRootDirectory: command.privateRootDirectory,
      sourceDirectory: join(command.materializedDirectory, "sources"),
      metadataFile: command.metadataFile,
      sourceConfirmationFile: join(
        command.materializedDirectory,
        "source-confirmation.private.json",
      ),
      outputDirectory: command.outputDirectory,
      operationTag: command.operationTag,
      resume: command.resume,
      sourceSelectorFile: command.selectionManifestFile,
      concurrency: command.concurrency,
      executionIdentity: normalizer.preparationIdentity,
      normalizer,
    });
    if (!result.complete) {
      throw new HistoryMigrationError(
        "PREPARE_INCOMPLETE",
        "本次 prepare 含失败、未确认结束或尚未处理的样本；安全报告已保留。",
      );
    }
    process.stdout.write(
      `已读取 ${result.sourceCount} 个确认源文件，生成 ${result.candidateCount} 个待人工批准的候选。\n`,
    );
    return;
  }
  if (command.phase === "repair-local") {
    await assertHistoryMaterializationComplete({
      privateRootDirectory: command.privateRootDirectory,
      materializedDirectory: command.materializedDirectory,
    });
    const result = await repairFailedHistoryCandidates({
      privateRootDirectory: command.privateRootDirectory,
      sourceDirectory: join(command.materializedDirectory, "sources"),
      metadataFile: command.metadataFile,
      sourceConfirmationFile: join(
        command.materializedDirectory,
        "source-confirmation.private.json",
      ),
      preparedDirectory: command.preparedDirectory,
      repairManifestFile: command.repairManifestFile,
    });
    if (!result.complete) {
      throw new HistoryMigrationError(
        "PREPARE_INCOMPLETE",
        "受控修复后 prepare 仍未完整结束；不发布任何完成标记。",
      );
    }
    process.stdout.write(
      `受控本地源文修复完成：本次修复 ${result.repairedCount} 份，另有 ${result.alreadyRepairedCount} 份此前已满足；当前候选共 ${result.candidateCount} 个。\n`,
    );
    return;
  }

  const attachmentMappingCapability = await assertHistoryAttachmentMappingComplete({
    privateRootDirectory: command.privateRootDirectory,
    sourceDirectory: command.attachmentSourceDirectory,
    sourceInventoryFile: command.sourceInventoryFile,
    sourceLocationsFile: command.sourceLocationsFile,
    metadataFile: command.metadataFile,
    groupingDirectory: command.groupingDirectory,
    groupingConfirmationFile: command.groupingConfirmationFile,
    attachmentMappingDirectory: command.attachmentMappingDirectory,
  });
  const result = await packageApprovedCandidates({
    privateRootDirectory: command.privateRootDirectory,
    materializedDirectory: command.materializedDirectory,
    metadataFile: command.metadataFile,
    preparedDirectory: command.preparedDirectory,
    approvalFile: command.approvalFile,
    outputDirectory: command.outputDirectory,
    authorMappingOutput: command.authorMappingOutput,
    attachmentMappingCapability,
  });
  process.stdout.write(
    `已生成 ${result.packageCount} 个题目包，另写出 ${result.authorMappingCount} 条私有作者映射。\n`,
  );
  if (result.attachmentCount !== undefined) {
    process.stdout.write(
      `本批次含 ${result.attachmentCount} 个已确认附件：${result.preservedMaterialCount} 个写入内部保全目录，其余按公开/内部用途进入题目包。\n`,
    );
  }
}

function parseCommand(argv: readonly string[]): Command {
  const phase = argv[0];
  if (phase === "inventory") {
    return {
      phase,
      privateRootDirectory: requiredOption(argv, "--private-root"),
      sourceDirectory: requiredOption(argv, "--source"),
      outputDirectory: requiredOption(argv, "--out"),
    };
  }
  if (phase === "init-grouping") {
    return {
      phase,
      privateRootDirectory: requiredOption(argv, "--private-root"),
      sourceInventoryFile: requiredOption(argv, "--inventory"),
      sourceLocationsFile: requiredOption(argv, "--source-locations"),
      metadataFile: requiredOption(argv, "--metadata"),
      outputDirectory: requiredOption(argv, "--out"),
    };
  }
  if (phase === "seal-grouping") {
    return {
      phase,
      privateRootDirectory: requiredOption(argv, "--private-root"),
      sourceDirectory: requiredOption(argv, "--source"),
      sourceInventoryFile: requiredOption(argv, "--inventory"),
      sourceLocationsFile: requiredOption(argv, "--source-locations"),
      metadataFile: requiredOption(argv, "--metadata"),
      groupingPlanFile: requiredOption(argv, "--plan"),
      outputDirectory: requiredOption(argv, "--out"),
    };
  }
  if (phase === "confirm-grouping") {
    requiredFlag(argv, "--i-have-reviewed");
    return {
      phase,
      privateRootDirectory: requiredOption(argv, "--private-root"),
      sourceInventoryFile: requiredOption(argv, "--inventory"),
      sourceLocationsFile: requiredOption(argv, "--source-locations"),
      metadataFile: requiredOption(argv, "--metadata"),
      groupingDirectory: requiredOption(argv, "--grouping"),
      outputFile: requiredOption(argv, "--out"),
      confirmed: true,
    };
  }
  if (phase === "materialize") {
    return {
      phase,
      privateRootDirectory: requiredOption(argv, "--private-root"),
      sourceDirectory: requiredOption(argv, "--source"),
      sourceInventoryFile: requiredOption(argv, "--inventory"),
      sourceLocationsFile: requiredOption(argv, "--source-locations"),
      metadataFile: requiredOption(argv, "--metadata"),
      groupingDirectory: requiredOption(argv, "--grouping"),
      groupingConfirmationFile: requiredOption(argv, "--grouping-confirmation"),
      outputDirectory: requiredOption(argv, "--out"),
    };
  }
  if (phase === "init-attachments") {
    return {
      phase,
      privateRootDirectory: requiredOption(argv, "--private-root"),
      sourceDirectory: requiredOption(argv, "--source"),
      sourceInventoryFile: requiredOption(argv, "--inventory"),
      sourceLocationsFile: requiredOption(argv, "--source-locations"),
      metadataFile: requiredOption(argv, "--metadata"),
      groupingDirectory: requiredOption(argv, "--grouping"),
      groupingConfirmationFile: requiredOption(argv, "--grouping-confirmation"),
      outputDirectory: requiredOption(argv, "--out"),
    };
  }
  if (phase === "seal-attachments") {
    requiredFlag(argv, "--i-have-reviewed");
    return {
      phase,
      privateRootDirectory: requiredOption(argv, "--private-root"),
      sourceDirectory: requiredOption(argv, "--source"),
      sourceInventoryFile: requiredOption(argv, "--inventory"),
      sourceLocationsFile: requiredOption(argv, "--source-locations"),
      metadataFile: requiredOption(argv, "--metadata"),
      groupingDirectory: requiredOption(argv, "--grouping"),
      groupingConfirmationFile: requiredOption(argv, "--grouping-confirmation"),
      worksheetDirectory: requiredOption(argv, "--worksheet"),
      mappingPlanFile: requiredOption(argv, "--plan"),
      outputDirectory: requiredOption(argv, "--out"),
    };
  }
  if (phase === "assert-attachments") {
    return {
      phase,
      privateRootDirectory: requiredOption(argv, "--private-root"),
      sourceDirectory: requiredOption(argv, "--source"),
      sourceInventoryFile: requiredOption(argv, "--inventory"),
      sourceLocationsFile: requiredOption(argv, "--source-locations"),
      metadataFile: requiredOption(argv, "--metadata"),
      groupingDirectory: requiredOption(argv, "--grouping"),
      groupingConfirmationFile: requiredOption(argv, "--grouping-confirmation"),
      attachmentMappingDirectory: requiredOption(argv, "--attachment-mapping"),
    };
  }
  if (phase === "prepare") {
    return {
      phase,
      privateRootDirectory: requiredOption(argv, "--private-root"),
      materializedDirectory: requiredOption(argv, "--materialized"),
      metadataFile: requiredOption(argv, "--metadata"),
      outputDirectory: requiredOption(argv, "--out"),
      operationTag: requiredOption(argv, "--run-tag"),
      selectionManifestFile: optionalOption(argv, "--selection-manifest"),
      concurrency: integerOption(argv, "--concurrency", 12),
      resume: argv.includes("--resume"),
    };
  }
  if (phase === "repair-local") {
    return {
      phase,
      privateRootDirectory: requiredOption(argv, "--private-root"),
      materializedDirectory: requiredOption(argv, "--materialized"),
      metadataFile: requiredOption(argv, "--metadata"),
      preparedDirectory: requiredOption(argv, "--prepared"),
      repairManifestFile: requiredOption(argv, "--repair-manifest"),
    };
  }
  if (phase === "package") {
    return {
      phase,
      privateRootDirectory: requiredOption(argv, "--private-root"),
      materializedDirectory: requiredOption(argv, "--materialized"),
      metadataFile: requiredOption(argv, "--metadata"),
      preparedDirectory: requiredOption(argv, "--prepared"),
      approvalFile: requiredOption(argv, "--approval"),
      outputDirectory: requiredOption(argv, "--out"),
      authorMappingOutput: requiredOption(argv, "--author-map-out"),
      attachmentSourceDirectory: requiredOption(argv, "--attachment-source"),
      sourceInventoryFile: requiredOption(argv, "--inventory"),
      sourceLocationsFile: requiredOption(argv, "--source-locations"),
      groupingDirectory: requiredOption(argv, "--grouping"),
      groupingConfirmationFile: requiredOption(argv, "--grouping-confirmation"),
      attachmentMappingDirectory: requiredOption(argv, "--attachment-mapping"),
    };
  }
  throw new HistoryMigrationError(
    "INVALID_ARGUMENTS",
    "必须明确选择 inventory、init-grouping、seal-grouping、confirm-grouping、materialize、init-attachments、seal-attachments、assert-attachments、prepare、repair-local 或 package 阶段。",
  );
}

function requiredOption(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      `缺少必填参数 ${name}。确认文件不能省略。`,
    );
  }
  return value;
}

function optionalOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", `参数 ${name} 缺少值。`);
  }
  return value;
}

function integerOption(argv: readonly string[], name: string, defaultValue: number): number {
  const raw = optionalOption(argv, name);
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", `${name} 必须是 1 到 20 的整数。`);
  }
  return value;
}

function requiredFlag(argv: readonly string[], name: string): void {
  if (!argv.includes(name)) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", `缺少明确确认标志 ${name}。`);
  }
}

main().catch((error: unknown) => {
  const code = error instanceof HistoryMigrationError ? error.code : "UNEXPECTED_FAILURE";
  process.stderr.write(
    `历史迁移失败（${code}）。为避免泄露私有题目，命令行不显示文件名或正文；请在私有目录核对输入和确认文件。\n`,
  );
  process.exitCode = 1;
});
