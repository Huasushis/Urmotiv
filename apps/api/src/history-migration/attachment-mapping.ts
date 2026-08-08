import { isAbsolute, join, relative, resolve } from "node:path";
import { isSafeArchivePath } from "@urmotiv/problem-package";
import { z } from "zod";
import { sha256Hex } from "./digests";
import { HistoryMigrationError } from "./errors";
import {
  type LoadVerifiedHistoryAttachmentContextOptions,
  type VerifiedHistoryAttachmentContext,
  loadVerifiedHistoryAttachmentContext,
} from "./grouping-workflow";
import { historyGroupIdSchema, historyMetadataIdSchema, historyZipEntryIdSchema } from "./grouping";
import {
  assertPathsInsidePrivateRoot,
  withStablePrivateJsonFile,
  withStablePrivateDirectoryAccess,
  writeNewPrivateJsonBundleWithFinalMarker,
} from "./private-files";
import { historyContentDigestSchema, historySourceIdSchema } from "./schema";

const historyAttachmentIdSchema = z
  .string()
  .regex(/^attachment-[0-9]{6}$/, "附件安全编号格式不正确。");

const historyAttachmentBindingsSchema = z
  .object({
    sourceInventorySha256: historyContentDigestSchema,
    sourceLocationsSha256: historyContentDigestSchema,
    manualReviewSha256: historyContentDigestSchema,
    metadataFileSha256: historyContentDigestSchema,
    groupingSha256: historyContentDigestSchema,
    groupingBatchSha256: historyContentDigestSchema,
    groupingConfirmationSha256: historyContentDigestSchema,
  })
  .strict();

const historyAttachmentLocatorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("zip_entry"),
      sourceId: historySourceIdSchema,
      entryId: historyZipEntryIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("text_range"),
      sourceId: historySourceIdSchema,
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
    })
    .strict()
    .refine((value) => value.end > value.start, "附件文本范围不正确。"),
  z
    .object({
      kind: z.literal("whole_file"),
      sourceId: historySourceIdSchema,
    })
    .strict(),
]);

const historyAttachmentWorksheetItemSchema = z
  .object({
    attachmentId: historyAttachmentIdSchema,
    locator: historyAttachmentLocatorSchema,
    sourceContentSha256: historyContentDigestSchema,
    contentSha256: historyContentDigestSchema,
    byteLength: z.number().int().nonnegative(),
    sourceBindingSha256: historyContentDigestSchema,
  })
  .strict();

export const historyAttachmentWorksheetSchema = z
  .object({
    version: z.literal(1),
    phase: z.literal("attachment_mapping_worksheet"),
    bindings: historyAttachmentBindingsSchema,
    groups: z
      .array(
        z
          .object({
            groupId: historyGroupIdSchema,
            metadataId: historyMetadataIdSchema,
          })
          .strict(),
      )
      .max(10_000),
    attachments: z.array(historyAttachmentWorksheetItemSchema).max(100_000),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssues(
      value.groups.map((group) => group.groupId),
      context,
      ["groups"],
      "题目分组安全编号不能重复。",
    );
    addDuplicateIssues(
      value.groups.map((group) => group.metadataId),
      context,
      ["groups"],
      "元数据安全编号不能重复。",
    );
    addDuplicateIssues(
      value.attachments.map((attachment) => attachment.attachmentId),
      context,
      ["attachments"],
      "附件安全编号不能重复。",
    );
    addDuplicateIssues(
      value.attachments.map((attachment) => attachment.sourceBindingSha256),
      context,
      ["attachments"],
      "同一个源附件不能重复列入工作表。",
    );
  });

export const historyAttachmentSemanticRoles = [
  "statement_asset",
  "contestant_attachment",
  "solution_original",
  "reference_implementation_candidate",
  "judge_material_candidate",
  "authoring_material",
] as const;

const dispositionNoteSchema = z.string().trim().min(1).max(2_000);
const safeTargetNameSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((value) => isSafeAttachmentTargetName(value), "附件安全目标名不正确。");
const statementReferenceSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => isSafeStatementReference(value), "题面资源原引用不安全或有歧义。");

const attachmentPlanBaseShape = {
  attachmentId: historyAttachmentIdSchema,
  sourceBindingSha256: historyContentDigestSchema,
};

const unresolvedAttachmentPlanItemSchema = z
  .object({
    ...attachmentPlanBaseShape,
    status: z.literal("unresolved"),
    reason: dispositionNoteSchema,
    confirmed: z.literal(true),
  })
  .strict();

const resolvedAttachmentPlanBaseShape = {
  ...attachmentPlanBaseShape,
  status: z.literal("resolved"),
  reviewNote: dispositionNoteSchema,
  confirmed: z.literal(true),
};

const problemGroupTargetBaseShape = {
  groupId: historyGroupIdSchema,
  metadataId: historyMetadataIdSchema,
  targetName: safeTargetNameSchema,
};

const problemGroupTargetSchema = z.object(problemGroupTargetBaseShape).strict();
const statementAssetTargetSchema = z
  .object({
    ...problemGroupTargetBaseShape,
    statementReferences: z.array(statementReferenceSchema).min(1).max(100),
  })
  .strict();
const problemGroupsScopeSchema = z
  .object({
    kind: z.literal("problem_groups"),
    targets: z.array(problemGroupTargetSchema).min(1).max(10_000),
  })
  .strict();
const statementAssetScopeSchema = z
  .object({
    kind: z.literal("problem_groups"),
    targets: z.array(statementAssetTargetSchema).min(1).max(10_000),
  })
  .strict();
const batchInternalScopeSchema = z
  .object({
    kind: z.literal("batch_internal"),
    targetName: safeTargetNameSchema,
  })
  .strict();

const resolvedAttachmentPlanItemSchema = z.union([
  z
    .object({
      ...resolvedAttachmentPlanBaseShape,
      semanticRole: z.literal("statement_asset"),
      visibility: z.literal("public"),
      scope: statementAssetScopeSchema,
    })
    .strict(),
  z
    .object({
      ...resolvedAttachmentPlanBaseShape,
      semanticRole: z.literal("contestant_attachment"),
      visibility: z.literal("public"),
      scope: problemGroupsScopeSchema,
    })
    .strict(),
  ...[
    "solution_original",
    "reference_implementation_candidate",
    "judge_material_candidate",
    "authoring_material",
  ].map((semanticRole) =>
    z
      .object({
        ...resolvedAttachmentPlanBaseShape,
        semanticRole: z.literal(
          semanticRole as
            | "solution_original"
            | "reference_implementation_candidate"
            | "judge_material_candidate"
            | "authoring_material",
        ),
        visibility: z.literal("internal"),
        scope:
          semanticRole === "judge_material_candidate" || semanticRole === "authoring_material"
            ? z.union([problemGroupsScopeSchema, batchInternalScopeSchema])
            : problemGroupsScopeSchema,
      })
      .strict(),
  ),
]);

const attachmentMappingPlanItemSchema = z.union([
  unresolvedAttachmentPlanItemSchema,
  resolvedAttachmentPlanItemSchema,
]);

export const historyAttachmentMappingPlanSchema = z
  .object({
    version: z.literal(1),
    confirmed: z.literal(true),
    worksheetSha256: historyContentDigestSchema,
    mappings: z.array(attachmentMappingPlanItemSchema).max(100_000),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssues(
      value.mappings.map((mapping) => mapping.attachmentId),
      context,
      ["mappings"],
      "同一个附件安全编号不能重复映射。",
    );
  });

const mappedAttachmentBaseShape = {
  attachmentId: historyAttachmentIdSchema,
  locator: historyAttachmentLocatorSchema,
  sourceContentSha256: historyContentDigestSchema,
  contentSha256: historyContentDigestSchema,
  byteLength: z.number().int().nonnegative(),
  sourceBindingSha256: historyContentDigestSchema,
};

const unresolvedMappedAttachmentSchema = z
  .object({
    ...mappedAttachmentBaseShape,
    status: z.literal("unresolved"),
    reason: dispositionNoteSchema,
    confirmed: z.literal(true),
  })
  .strict();

const resolvedMappedAttachmentBaseShape = {
  ...mappedAttachmentBaseShape,
  status: z.literal("resolved"),
  reviewNote: dispositionNoteSchema,
  confirmed: z.literal(true),
};

const safeTargetPathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => isSafeArchivePath(value), "附件目标路径不安全。");
const mappedProblemGroupTargetSchema = z
  .object({
    ...problemGroupTargetBaseShape,
    targetPath: safeTargetPathSchema,
  })
  .strict();
const mappedStatementAssetTargetSchema = z
  .object({
    ...problemGroupTargetBaseShape,
    targetPath: safeTargetPathSchema,
    statementReferences: z.array(statementReferenceSchema).min(1).max(100),
  })
  .strict();
const mappedProblemGroupsScopeSchema = z
  .object({
    kind: z.literal("problem_groups"),
    targets: z.array(mappedProblemGroupTargetSchema).min(1).max(10_000),
  })
  .strict();
const mappedStatementAssetScopeSchema = z
  .object({
    kind: z.literal("problem_groups"),
    targets: z.array(mappedStatementAssetTargetSchema).min(1).max(10_000),
  })
  .strict();
const mappedBatchInternalScopeSchema = z
  .object({
    kind: z.literal("batch_internal"),
    targetName: safeTargetNameSchema,
    preservationPath: safeTargetPathSchema,
  })
  .strict();

const resolvedMappedAttachmentSchema = z.union([
  z
    .object({
      ...resolvedMappedAttachmentBaseShape,
      semanticRole: z.literal("statement_asset"),
      visibility: z.literal("public"),
      scope: mappedStatementAssetScopeSchema,
    })
    .strict(),
  z
    .object({
      ...resolvedMappedAttachmentBaseShape,
      semanticRole: z.literal("contestant_attachment"),
      visibility: z.literal("public"),
      scope: mappedProblemGroupsScopeSchema,
    })
    .strict(),
  ...[
    "solution_original",
    "reference_implementation_candidate",
    "judge_material_candidate",
    "authoring_material",
  ].map((semanticRole) =>
    z
      .object({
        ...resolvedMappedAttachmentBaseShape,
        semanticRole: z.literal(
          semanticRole as
            | "solution_original"
            | "reference_implementation_candidate"
            | "judge_material_candidate"
            | "authoring_material",
        ),
        visibility: z.literal("internal"),
        scope:
          semanticRole === "judge_material_candidate" || semanticRole === "authoring_material"
            ? z.union([mappedProblemGroupsScopeSchema, mappedBatchInternalScopeSchema])
            : mappedProblemGroupsScopeSchema,
      })
      .strict(),
  ),
]);

const mappedAttachmentSchema = z.union([
  unresolvedMappedAttachmentSchema,
  resolvedMappedAttachmentSchema,
]);

const referenceRewriteSchema = z
  .object({
    groupId: historyGroupIdSchema,
    metadataId: historyMetadataIdSchema,
    from: statementReferenceSchema,
    to: z
      .string()
      .min(1)
      .max(240)
      .refine((value) => isSafeArchivePath(value), "题面资源目标路径不安全。"),
  })
  .strict();

const preservationEntrySchema = z
  .object({
    attachmentId: historyAttachmentIdSchema,
    semanticRole: z.enum(["judge_material_candidate", "authoring_material"]),
    targetName: safeTargetNameSchema,
    preservationPath: safeTargetPathSchema,
    sourceBindingSha256: historyContentDigestSchema,
    contentSha256: historyContentDigestSchema,
  })
  .strict();

export const historyAttachmentMappingSchema = z
  .object({
    version: z.literal(1),
    phase: z.literal("attachment_mapping"),
    status: z.enum(["complete", "blocked"]),
    confirmed: z.literal(true),
    bindings: historyAttachmentBindingsSchema,
    worksheetSha256: historyContentDigestSchema,
    mappingPlanSha256: historyContentDigestSchema,
    mappings: z.array(mappedAttachmentSchema).max(100_000),
    referenceRewrites: z.array(referenceRewriteSchema).max(100_000),
    preservationEntries: z.array(preservationEntrySchema).max(100_000),
    unresolvedItemCount: z.number().int().nonnegative(),
  })
  .strict();

const historyAttachmentMappingReportSchema = z
  .object({
    version: z.literal(1),
    phase: z.literal("attachment_mapping"),
    status: z.enum(["complete", "blocked"]),
    attachmentCount: z.number().int().nonnegative(),
    resolvedItemCount: z.number().int().nonnegative(),
    unresolvedItemCount: z.number().int().nonnegative(),
    referenceRewriteCount: z.number().int().nonnegative(),
    problemGroupTargetCount: z.number().int().nonnegative(),
    preservationEntryCount: z.number().int().nonnegative(),
    publicItemCount: z.number().int().nonnegative(),
    internalItemCount: z.number().int().nonnegative(),
    roles: z
      .array(
        z
          .object({
            semanticRole: z.enum(historyAttachmentSemanticRoles),
            count: z.number().int().positive(),
          })
          .strict(),
      )
      .max(historyAttachmentSemanticRoles.length),
  })
  .strict();

const historyAttachmentWorksheetCompleteSchema = z
  .object({
    version: z.literal(1),
    phase: z.literal("attachment_mapping_worksheet"),
    bindings: historyAttachmentBindingsSchema,
    worksheetSha256: historyContentDigestSchema,
    skeletonSha256: historyContentDigestSchema,
    attachmentCount: z.number().int().nonnegative(),
    unresolvedItemCount: z.number().int().nonnegative(),
    reviewed: z.literal(false),
  })
  .strict();

const historyAttachmentMappingCompleteSchema = z
  .object({
    version: z.literal(1),
    phase: z.literal("attachment_mapping"),
    status: z.literal("complete"),
    bindings: historyAttachmentBindingsSchema,
    mappingSha256: historyContentDigestSchema,
    reportSha256: historyContentDigestSchema,
    attachmentSetSha256: historyContentDigestSchema,
    referenceRewritesSha256: historyContentDigestSchema,
    preservationEntriesSha256: historyContentDigestSchema,
    attachmentCount: z.number().int().nonnegative(),
    unresolvedItemCount: z.literal(0),
  })
  .strict();

export type HistoryAttachmentMapping = z.infer<typeof historyAttachmentMappingSchema>;
type HistoryAttachmentWorksheet = z.infer<typeof historyAttachmentWorksheetSchema>;
type HistoryAttachmentMappingPlan = z.infer<typeof historyAttachmentMappingPlanSchema>;
type MappedAttachment = z.infer<typeof mappedAttachmentSchema>;

export interface InitializeHistoryAttachmentMappingWorksheetOptions
  extends LoadVerifiedHistoryAttachmentContextOptions {
  readonly outputDirectory: string;
}

export interface SealHistoryAttachmentMappingOptions
  extends LoadVerifiedHistoryAttachmentContextOptions {
  readonly worksheetDirectory: string;
  readonly mappingPlanFile: string;
  readonly outputDirectory: string;
}

export interface AssertHistoryAttachmentMappingCompleteOptions
  extends LoadVerifiedHistoryAttachmentContextOptions {
  readonly attachmentMappingDirectory: string;
}

export interface HistoryAttachmentMappingResult {
  readonly attachmentCount: number;
  readonly resolvedItemCount: number;
  readonly unresolvedItemCount: number;
  readonly complete: boolean;
}

export interface HistoryAttachmentMappingCapability {
  readonly mapping: HistoryAttachmentMapping;
  readonly attachmentCount: number;
  readonly groupingBatchSha256: string;
}

const attachmentCapabilityOptions = new WeakMap<
  HistoryAttachmentMappingCapability,
  AssertHistoryAttachmentMappingCompleteOptions
>();

/** 核心打包器调用此函数，不能接受调用方自行构造的普通 mapping 对象。 */
export async function revalidateHistoryAttachmentMappingCapability(
  capability: HistoryAttachmentMappingCapability,
  expected: {
    readonly privateRootDirectory: string;
    readonly metadataFile: string;
  },
): Promise<HistoryAttachmentMappingCapability> {
  const options = attachmentCapabilityOptions.get(capability);
  if (
    options === undefined ||
    resolve(options.privateRootDirectory) !== resolve(expected.privateRootDirectory) ||
    resolve(options.metadataFile) !== resolve(expected.metadataFile)
  ) {
    throw new HistoryMigrationError(
      "INVALID_ATTACHMENT_MAPPING_CAPABILITY",
      "打包必须使用本进程中由当前批次附件完成门签发的能力。",
    );
  }
  return assertHistoryAttachmentMappingComplete(options);
}

/** 生成只含安全编号、摘要和计数的附件人工核对骨架。 */
export async function initializeHistoryAttachmentMappingWorksheet(
  options: InitializeHistoryAttachmentMappingWorksheetOptions,
): Promise<HistoryAttachmentMappingResult> {
  await assertPathsInsidePrivateRoot(options.privateRootDirectory, [
    { path: options.outputDirectory, kind: "new" },
  ]);
  assertOutputOutsideSource(options.sourceDirectory, options.outputDirectory);
  const context = await loadVerifiedHistoryAttachmentContext(options);
  const worksheet = createAttachmentWorksheet(context);
  const worksheetSha256 = sha256Hex(JSON.stringify(worksheet));
  const skeleton = {
    version: 1,
    confirmed: false,
    worksheetSha256,
    mappings: worksheet.attachments.map((attachment) => ({
      attachmentId: attachment.attachmentId,
      sourceBindingSha256: attachment.sourceBindingSha256,
      status: "unresolved",
      reason: "",
      confirmed: false,
    })),
  } as const;
  const skeletonSha256 = sha256Hex(JSON.stringify(skeleton));

  await writeNewPrivateJsonBundleWithFinalMarker(
    options.outputDirectory,
    [
      { name: "attachment-worksheet.json", value: worksheet },
      { name: "attachment-mapping-plan.skeleton.private.json", value: skeleton },
    ],
    {
      name: "ATTACHMENT_WORKSHEET_COMPLETE",
      value: {
        version: 1,
        phase: "attachment_mapping_worksheet",
        bindings: context.bindings,
        worksheetSha256,
        skeletonSha256,
        attachmentCount: worksheet.attachments.length,
        unresolvedItemCount: worksheet.attachments.length,
        reviewed: false,
      },
    },
  );

  return {
    attachmentCount: worksheet.attachments.length,
    resolvedItemCount: 0,
    unresolvedItemCount: worksheet.attachments.length,
    complete: false,
  };
}

/**
 * 封存人工计划。未知项会被原样保留并写出 BLOCKED 标记；只有逐附件完成
 * 题目归属、语义、可见性、目标名和确认后才写 COMPLETE。
 */
export async function sealHistoryAttachmentMapping(
  options: SealHistoryAttachmentMappingOptions,
): Promise<HistoryAttachmentMappingResult> {
  await assertPathsInsidePrivateRoot(options.privateRootDirectory, [
    { path: options.worksheetDirectory, kind: "existing" },
    { path: join(options.worksheetDirectory, "attachment-worksheet.json"), kind: "existing" },
    {
      path: join(options.worksheetDirectory, "attachment-mapping-plan.skeleton.private.json"),
      kind: "existing",
    },
    {
      path: join(options.worksheetDirectory, "ATTACHMENT_WORKSHEET_COMPLETE"),
      kind: "existing",
    },
    { path: options.mappingPlanFile, kind: "existing" },
    { path: options.outputDirectory, kind: "new" },
  ]);
  assertOutputOutsideSource(options.sourceDirectory, options.outputDirectory);

  const context = await loadVerifiedHistoryAttachmentContext(options);
  const worksheet = await loadVerifiedAttachmentWorksheet(options.worksheetDirectory, context);
  return withStablePrivateJsonFile(options.mappingPlanFile, async (planInput) => {
    const plan = parsePrivateInput(
      historyAttachmentMappingPlanSchema,
      planInput.value,
      "人工附件映射计划格式不正确或没有明确确认。",
    );
    if (plan.worksheetSha256 !== sha256Hex(JSON.stringify(worksheet))) {
      throw new HistoryMigrationError(
        "ATTACHMENT_MAPPING_CHANGED",
        "附件工作表已经变化，原来的人工映射计划已失效。",
      );
    }

    const mapping = createReviewedAttachmentMapping(context, worksheet, plan, planInput.sha256);
    const report = createAttachmentMappingReport(mapping);
    const mappingSha256 = sha256Hex(JSON.stringify(mapping));
    const reportSha256 = sha256Hex(JSON.stringify(report));
    const complete = mapping.unresolvedItemCount === 0;
    const marker = complete
      ? {
          version: 1,
          phase: "attachment_mapping",
          status: "complete",
          bindings: context.bindings,
          mappingSha256,
          reportSha256,
          attachmentSetSha256: attachmentSetSha256(mapping),
          referenceRewritesSha256: sha256Hex(JSON.stringify(mapping.referenceRewrites)),
          preservationEntriesSha256: sha256Hex(JSON.stringify(mapping.preservationEntries)),
          attachmentCount: mapping.mappings.length,
          unresolvedItemCount: 0,
        }
      : {
          version: 1,
          phase: "attachment_mapping",
          status: "blocked",
          bindings: context.bindings,
          mappingSha256,
          reportSha256,
          attachmentCount: mapping.mappings.length,
          unresolvedItemCount: mapping.unresolvedItemCount,
        };
    const markerName = complete ? "ATTACHMENT_MAPPING_COMPLETE" : "ATTACHMENT_MAPPING_BLOCKED";

    await writeNewPrivateJsonBundleWithFinalMarker(
      options.outputDirectory,
      [
        { name: "attachment-mapping.private.json", value: mapping },
        { name: "report.json", value: report },
      ],
      { name: markerName, value: marker },
    );

    const result = {
      attachmentCount: mapping.mappings.length,
      resolvedItemCount: mapping.mappings.length - mapping.unresolvedItemCount,
      unresolvedItemCount: mapping.unresolvedItemCount,
      complete,
    };
    if (!complete) {
      throw new HistoryMigrationError(
        "ATTACHMENT_MAPPING_INCOMPLETE",
        "仍有附件被明确保留为 unresolved；已写出私有阻断报告，不能继续打包。",
      );
    }
    return result;
  });
}

/**
 * 后续附件物化与打包必须先调用此门。BLOCKED、缺少标记、摘要替换、源目录
 * 变化或目标路径冲突都固定失败，不能只读取人工计划自行放行。
 */
export async function assertHistoryAttachmentMappingComplete(
  options: AssertHistoryAttachmentMappingCompleteOptions,
): Promise<HistoryAttachmentMappingCapability> {
  await assertPathsInsidePrivateRoot(options.privateRootDirectory, [
    { path: options.attachmentMappingDirectory, kind: "existing" },
  ]);
  const capability: HistoryAttachmentMappingCapability = await withStablePrivateDirectoryAccess(
    options.attachmentMappingDirectory,
    async (directory) => {
      await directory.assertDirectoryMode();
      const blockedName = "ATTACHMENT_MAPPING_BLOCKED";
      const completeName = "ATTACHMENT_MAPPING_COMPLETE";
      const mappingName = "attachment-mapping.private.json";
      const reportName = "report.json";
      const blockedMarker = await directory.readJsonIfExists(blockedName);
      const completeMarker = await directory.readJsonIfExists(completeName);
      const blockedExists = blockedMarker !== undefined;
      const completeExists = completeMarker !== undefined;
      if (blockedExists && completeExists) {
        throw new HistoryMigrationError(
          "ATTACHMENT_MAPPING_CHANGED",
          "附件映射不能同时带有 BLOCKED 和 COMPLETE 标记。",
        );
      }
      if (blockedExists) {
        throw new HistoryMigrationError(
          "ATTACHMENT_MAPPING_INCOMPLETE",
          "附件映射带有 BLOCKED 标记，不能作为完整映射继续打包。",
        );
      }
      if (!completeExists) {
        throw new HistoryMigrationError(
          "ATTACHMENT_MAPPING_INCOMPLETE",
          "附件映射缺少唯一的 COMPLETE 标记，不能继续打包。",
        );
      }

      const context = await loadVerifiedHistoryAttachmentContext(options);
      const mapping = parsePrivateInput(
        historyAttachmentMappingSchema,
        await directory.readJson(mappingName),
        "附件映射文件格式不正确。",
      );
      const report = parsePrivateInput(
        historyAttachmentMappingReportSchema,
        await directory.readJson(reportName),
        "附件映射报告格式不正确。",
      );
      const marker = parsePrivateInput(
        historyAttachmentMappingCompleteSchema,
        completeMarker,
        "附件映射没有可验证的完整完成标记。",
      );
      if (
        mapping.status !== "complete" ||
        mapping.unresolvedItemCount !== 0 ||
        !bindingsEqual(mapping.bindings, context.bindings) ||
        mapping.worksheetSha256 !== sha256Hex(JSON.stringify(createAttachmentWorksheet(context)))
      ) {
        throw new HistoryMigrationError(
          "ATTACHMENT_MAPPING_CHANGED",
          "附件映射与当前源清单或题目分组不一致。",
        );
      }
      const expectedMapping = validateCompleteMappedAttachments(context, mapping);
      const expectedReport = createAttachmentMappingReport(expectedMapping);
      const expectedMappingSha256 = sha256Hex(JSON.stringify(expectedMapping));
      const expectedReportSha256 = sha256Hex(JSON.stringify(expectedReport));
      if (
        JSON.stringify(mapping) !== JSON.stringify(expectedMapping) ||
        JSON.stringify(report) !== JSON.stringify(expectedReport) ||
        !bindingsEqual(marker.bindings, context.bindings) ||
        marker.mappingSha256 !== expectedMappingSha256 ||
        marker.reportSha256 !== expectedReportSha256 ||
        marker.attachmentSetSha256 !== attachmentSetSha256(expectedMapping) ||
        marker.referenceRewritesSha256 !==
          sha256Hex(JSON.stringify(expectedMapping.referenceRewrites)) ||
        marker.preservationEntriesSha256 !==
          sha256Hex(JSON.stringify(expectedMapping.preservationEntries)) ||
        marker.attachmentCount !== expectedMapping.mappings.length
      ) {
        throw new HistoryMigrationError(
          "ATTACHMENT_MAPPING_CHANGED",
          "附件映射、报告、目标集合或完成标记已经不一致。",
        );
      }
      const blockedAtEnd = await directory.readJsonIfExists(blockedName);
      const markerAtEnd = await directory.readJsonIfExists(completeName);
      const mappingAtEnd = await directory.readJson(mappingName);
      const reportAtEnd = await directory.readJson(reportName);
      if (
        blockedAtEnd !== undefined ||
        markerAtEnd === undefined ||
        JSON.stringify(markerAtEnd) !== JSON.stringify(marker) ||
        JSON.stringify(mappingAtEnd) !== JSON.stringify(mapping) ||
        JSON.stringify(reportAtEnd) !== JSON.stringify(report)
      ) {
        throw new HistoryMigrationError(
          "ATTACHMENT_MAPPING_CHANGED",
          "附件映射目录或最终状态在核对结束前发生变化。",
        );
      }
      return Object.freeze({
        mapping,
        attachmentCount: mapping.mappings.length,
        groupingBatchSha256: mapping.bindings.groupingBatchSha256,
      });
    },
  );
  attachmentCapabilityOptions.set(capability, { ...options });
  return capability;
}

function createAttachmentWorksheet(
  context: VerifiedHistoryAttachmentContext,
): HistoryAttachmentWorksheet {
  return historyAttachmentWorksheetSchema.parse({
    version: 1,
    phase: "attachment_mapping_worksheet",
    bindings: context.bindings,
    groups: context.groups,
    attachments: context.attachments.map((attachment, index) => ({
      attachmentId: makeAttachmentId(index + 1),
      ...attachment,
    })),
  });
}

async function loadVerifiedAttachmentWorksheet(
  worksheetDirectory: string,
  context: VerifiedHistoryAttachmentContext,
): Promise<HistoryAttachmentWorksheet> {
  return withStablePrivateDirectoryAccess(worksheetDirectory, async (directory) => {
    const worksheetName = "attachment-worksheet.json";
    const skeletonName = "attachment-mapping-plan.skeleton.private.json";
    const markerName = "ATTACHMENT_WORKSHEET_COMPLETE";
    await directory.assertDirectoryMode();
    const worksheet = parsePrivateInput(
      historyAttachmentWorksheetSchema,
      await directory.readJson(worksheetName),
      "附件工作表格式不正确。",
    );
    const skeleton = await directory.readJson(skeletonName);
    const marker = parsePrivateInput(
      historyAttachmentWorksheetCompleteSchema,
      await directory.readJson(markerName),
      "附件工作表没有可验证的完成标记。",
    );
    const expected = createAttachmentWorksheet(context);
    const worksheetSha256 = sha256Hex(JSON.stringify(worksheet));
    if (
      JSON.stringify(worksheet) !== JSON.stringify(expected) ||
      !bindingsEqual(marker.bindings, context.bindings) ||
      marker.worksheetSha256 !== worksheetSha256 ||
      marker.skeletonSha256 !== sha256Hex(JSON.stringify(skeleton)) ||
      marker.attachmentCount !== worksheet.attachments.length ||
      marker.unresolvedItemCount !== worksheet.attachments.length
    ) {
      throw new HistoryMigrationError(
        "ATTACHMENT_MAPPING_CHANGED",
        "附件工作表、人工计划骨架或上游摘要已经变化。",
      );
    }
    const markerAtEnd = await directory.readJson(markerName);
    const worksheetAtEnd = await directory.readJson(worksheetName);
    const skeletonAtEnd = await directory.readJson(skeletonName);
    if (
      JSON.stringify(markerAtEnd) !== JSON.stringify(marker) ||
      JSON.stringify(worksheetAtEnd) !== JSON.stringify(worksheet) ||
      JSON.stringify(skeletonAtEnd) !== JSON.stringify(skeleton)
    ) {
      throw new HistoryMigrationError(
        "ATTACHMENT_MAPPING_CHANGED",
        "附件工作表目录或完成标记在核对结束前发生变化。",
      );
    }
    return worksheet;
  });
}

function createReviewedAttachmentMapping(
  context: VerifiedHistoryAttachmentContext,
  worksheet: HistoryAttachmentWorksheet,
  plan: HistoryAttachmentMappingPlan,
  mappingPlanSha256: string,
): HistoryAttachmentMapping {
  if (plan.mappings.length !== worksheet.attachments.length) {
    throw new HistoryMigrationError(
      "INVALID_ATTACHMENT_MAPPING",
      "每个附件都必须在人工计划中恰好出现一次；未知项必须显式写为 unresolved。",
    );
  }
  const groupsById = new Map(context.groups.map((group) => [group.groupId, group] as const));
  const mappings: MappedAttachment[] = [];
  const targetPaths = new Set<string>();
  const preservationPaths = new Set<string>();
  const references = new Set<string>();

  for (const [index, expected] of worksheet.attachments.entries()) {
    const supplied = plan.mappings[index];
    if (
      supplied === undefined ||
      supplied.attachmentId !== expected.attachmentId ||
      supplied.sourceBindingSha256 !== expected.sourceBindingSha256
    ) {
      throw new HistoryMigrationError(
        "ATTACHMENT_MAPPING_CHANGED",
        "附件人工计划遗漏、重排或替换了已登记的源附件。",
      );
    }
    if (supplied.status === "unresolved") {
      mappings.push({
        ...expected,
        status: "unresolved",
        reason: supplied.reason,
        confirmed: true,
      });
      continue;
    }

    if (supplied.scope.kind === "problem_groups") {
      const targets = supplied.scope.targets.map((target) => {
        const group = groupsById.get(target.groupId);
        if (group === undefined || group.metadataId !== target.metadataId) {
          throw new HistoryMigrationError(
            "INVALID_ATTACHMENT_MAPPING",
            "附件指向的题目分组与元数据安全编号不匹配。",
          );
        }
        const targetPath = targetPathForProblemTarget(
          expected,
          supplied.semanticRole,
          supplied.visibility,
          target.targetName,
        );
        const targetKey = `${target.groupId}\0${foldPath(targetPath)}`;
        if (targetPaths.has(targetKey)) {
          throw new HistoryMigrationError(
            "INVALID_ATTACHMENT_MAPPING",
            "同一题目组内不能有相同或只靠大小写、Unicode 形式区分的目标路径。",
          );
        }
        targetPaths.add(targetKey);
        if (supplied.semanticRole === "statement_asset") {
          const statementTarget = target as z.infer<typeof statementAssetTargetSchema>;
          for (const reference of statementTarget.statementReferences) {
            const referenceKey = `${target.groupId}\0${reference}`;
            if (references.has(referenceKey)) {
              throw new HistoryMigrationError(
                "INVALID_ATTACHMENT_MAPPING",
                "同一题面的原资源引用不能重复映射。",
              );
            }
            references.add(referenceKey);
          }
          return { ...statementTarget, targetPath };
        }
        return { ...target, targetPath };
      });
      mappings.push({
        ...expected,
        ...supplied,
        scope: { kind: "problem_groups", targets },
      } as MappedAttachment);
      continue;
    }

    if (
      supplied.semanticRole !== "judge_material_candidate" &&
      supplied.semanticRole !== "authoring_material"
    ) {
      throw new HistoryMigrationError(
        "INVALID_ATTACHMENT_MAPPING",
        "批次内部保全只允许不直接进入题目包的内部命题或评测候选材料。",
      );
    }
    validateOrdinaryTargetName(expected.attachmentId, supplied.scope.targetName);
    const preservationPath = `preservation/internal/${supplied.scope.targetName}`;
    const foldedPreservationPath = foldPath(preservationPath);
    if (preservationPaths.has(foldedPreservationPath)) {
      throw new HistoryMigrationError(
        "INVALID_ATTACHMENT_MAPPING",
        "批次内部保全目标不能重复或只靠大小写、Unicode 形式区分。",
      );
    }
    preservationPaths.add(foldedPreservationPath);
    mappings.push({
      ...expected,
      ...supplied,
      scope: { ...supplied.scope, preservationPath },
    } as MappedAttachment);
  }

  const unresolvedItemCount = mappings.filter((mapping) => mapping.status === "unresolved").length;
  const referenceRewrites = referenceRewritesForMappings(mappings);
  const preservationEntries = preservationEntriesForMappings(mappings);
  return historyAttachmentMappingSchema.parse({
    version: 1,
    phase: "attachment_mapping",
    status: unresolvedItemCount === 0 ? "complete" : "blocked",
    confirmed: true,
    bindings: context.bindings,
    worksheetSha256: plan.worksheetSha256,
    mappingPlanSha256,
    mappings,
    referenceRewrites,
    preservationEntries,
    unresolvedItemCount,
  });
}

function validateCompleteMappedAttachments(
  context: VerifiedHistoryAttachmentContext,
  mapping: HistoryAttachmentMapping,
): HistoryAttachmentMapping {
  const worksheet = createAttachmentWorksheet(context);
  const plan = historyAttachmentMappingPlanSchema.parse({
    version: 1,
    confirmed: true,
    worksheetSha256: mapping.worksheetSha256,
    mappings: mapping.mappings.map((item) => {
      if (item.status !== "resolved") {
        throw new HistoryMigrationError(
          "ATTACHMENT_MAPPING_INCOMPLETE",
          "完整附件映射中仍含 unresolved 项。",
        );
      }
      const {
        locator: _locator,
        sourceContentSha256: _sourceSha256,
        contentSha256: _contentSha256,
        byteLength: _byteLength,
        scope,
        ...planItem
      } = item;
      if (scope.kind === "problem_groups") {
        return {
          ...planItem,
          scope: {
            kind: "problem_groups" as const,
            targets: scope.targets.map(({ targetPath: _targetPath, ...target }) => target),
          },
        };
      }
      const { preservationPath: _preservationPath, ...batchScope } = scope;
      return { ...planItem, scope: batchScope };
    }),
  });
  return createReviewedAttachmentMapping(context, worksheet, plan, mapping.mappingPlanSha256);
}

function targetPathForProblemTarget(
  expected: HistoryAttachmentWorksheet["attachments"][number],
  semanticRole: (typeof historyAttachmentSemanticRoles)[number],
  visibility: "public" | "internal",
  targetName: string,
): string {
  if (semanticRole === "statement_asset") {
    const match = /^([0-9a-f]{64})\.([A-Za-z0-9]+)$/.exec(targetName);
    if (match?.[1] !== expected.contentSha256) {
      throw new HistoryMigrationError(
        "INVALID_ATTACHMENT_MAPPING",
        "题面资源目标名必须由当前附件内容摘要和人工确认的安全扩展名组成。",
      );
    }
    return `assets/${targetName}`;
  }
  validateOrdinaryTargetName(expected.attachmentId, targetName);
  return `attachments/${visibility}/${targetName}`;
}

function validateOrdinaryTargetName(attachmentId: string, targetName: string): void {
  const expectedPrefix = `${attachmentId}.`;
  const extension = targetName.slice(expectedPrefix.length);
  if (!targetName.startsWith(expectedPrefix) || !/^[A-Za-z0-9]+$/.test(extension)) {
    throw new HistoryMigrationError(
      "INVALID_ATTACHMENT_MAPPING",
      "普通附件目标名必须使用附件安全编号和人工确认的安全扩展名。",
    );
  }
}

function referenceRewritesForMappings(
  mappings: readonly MappedAttachment[],
): Array<z.infer<typeof referenceRewriteSchema>> {
  return mappings.flatMap((mapping) =>
    mapping.status === "resolved" &&
    mapping.semanticRole === "statement_asset" &&
    mapping.scope.kind === "problem_groups"
      ? mapping.scope.targets.flatMap((target) =>
          target.statementReferences.map((reference) => ({
            groupId: target.groupId,
            metadataId: target.metadataId,
            from: reference,
            to: target.targetPath,
          })),
        )
      : [],
  );
}

function preservationEntriesForMappings(
  mappings: readonly MappedAttachment[],
): Array<z.infer<typeof preservationEntrySchema>> {
  return mappings.flatMap((mapping) =>
    mapping.status === "resolved" && mapping.scope.kind === "batch_internal"
      ? [
          {
            attachmentId: mapping.attachmentId,
            semanticRole: mapping.semanticRole as "judge_material_candidate" | "authoring_material",
            targetName: mapping.scope.targetName,
            preservationPath: mapping.scope.preservationPath,
            sourceBindingSha256: mapping.sourceBindingSha256,
            contentSha256: mapping.contentSha256,
          },
        ]
      : [],
  );
}

function createAttachmentMappingReport(
  mapping: HistoryAttachmentMapping,
): z.infer<typeof historyAttachmentMappingReportSchema> {
  const resolved = mapping.mappings.filter(
    (item): item is Extract<MappedAttachment, { status: "resolved" }> => item.status === "resolved",
  );
  const roleCounts = new Map<(typeof historyAttachmentSemanticRoles)[number], number>();
  for (const item of resolved) {
    roleCounts.set(item.semanticRole, (roleCounts.get(item.semanticRole) ?? 0) + 1);
  }
  return historyAttachmentMappingReportSchema.parse({
    version: 1,
    phase: "attachment_mapping",
    status: mapping.status,
    attachmentCount: mapping.mappings.length,
    resolvedItemCount: resolved.length,
    unresolvedItemCount: mapping.unresolvedItemCount,
    referenceRewriteCount: mapping.referenceRewrites.length,
    problemGroupTargetCount: resolved.reduce(
      (count, item) =>
        count + (item.scope.kind === "problem_groups" ? item.scope.targets.length : 0),
      0,
    ),
    preservationEntryCount: mapping.preservationEntries.length,
    publicItemCount: resolved.filter((item) => item.visibility === "public").length,
    internalItemCount: resolved.filter((item) => item.visibility === "internal").length,
    roles: historyAttachmentSemanticRoles.flatMap((semanticRole) => {
      const count = roleCounts.get(semanticRole);
      return count === undefined ? [] : [{ semanticRole, count }];
    }),
  });
}

function attachmentSetSha256(mapping: HistoryAttachmentMapping): string {
  return sha256Hex(
    JSON.stringify({
      version: 1,
      attachments: mapping.mappings.map((item) => ({
        attachmentId: item.attachmentId,
        sourceBindingSha256: item.sourceBindingSha256,
        contentSha256: item.contentSha256,
        ...(item.status === "resolved" ? { scope: item.scope } : {}),
      })),
      preservationEntries: mapping.preservationEntries,
    }),
  );
}

function makeAttachmentId(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence <= 0 || sequence > 999_999) {
    throw new HistoryMigrationError("INVALID_ATTACHMENT_MAPPING", "附件数量超过工具支持的范围。");
  }
  return `attachment-${sequence.toString().padStart(6, "0")}`;
}

function isSafeAttachmentTargetName(value: string): boolean {
  return (
    value.normalize("NFC") === value &&
    !/[\p{Cc}\p{Cf}]/u.test(value) &&
    !value.includes("/") &&
    !value.includes("\\") &&
    isSafeArchivePath(value)
  );
}

function isSafeStatementReference(value: string): boolean {
  if (
    value !== value.trim() ||
    value.normalize("NFC") !== value ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  ) {
    return false;
  }
  const suffixIndex = value.search(/[?#]/);
  const encodedPath = suffixIndex < 0 ? value : value.slice(0, suffixIndex);
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    return false;
  }
  while (decodedPath.startsWith("./")) decodedPath = decodedPath.slice(2);
  return decodedPath.length > 0 && isSafeArchivePath(decodedPath);
}

function foldPath(path: string): string {
  return path
    .normalize("NFC")
    .toLocaleUpperCase("en-US")
    .toLocaleLowerCase("en-US")
    .normalize("NFC");
}

function bindingsEqual(
  first: z.infer<typeof historyAttachmentBindingsSchema>,
  second: z.infer<typeof historyAttachmentBindingsSchema>,
): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function assertOutputOutsideSource(sourceDirectory: string, outputPath: string): void {
  const pathFromSource = relative(resolve(sourceDirectory), resolve(outputPath));
  if (
    pathFromSource.length === 0 ||
    (!pathFromSource.startsWith("..") && !isAbsolute(pathFromSource))
  ) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "附件映射输出不能放在本批私有源目录内部。",
    );
  }
}

function parsePrivateInput<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new HistoryMigrationError("INVALID_ATTACHMENT_MAPPING", message);
  }
  return parsed.data;
}

function addDuplicateIssues(
  values: readonly string[],
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  message: string,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({ code: "custom", path: [...path, index], message });
    }
    seen.add(value);
  }
}
