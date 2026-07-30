/**
 * 实现已移动到 @urmotiv/jobs 的 problem-package-handlers.ts，这里保留同名转发，
 * 使 worker 应用与其测试的导入路径保持不变。
 */
export {
  InMemoryExportArtifactWriter,
  InMemoryFixedRevisionExportReader,
  InMemoryVerifiedImportArchiveReader,
  builtinProblemPackageAdapters,
  createProblemPackageExportHandler,
  createProblemPackageImportHandler,
  registerProblemPackageHandlers,
  type AtomicImportedProblemWriter,
  type ExportArtifactWriter,
  type ExportProblemFileDescriptor,
  type ExportProblemRevision,
  type ExportReadAuthorization,
  type FixedRevisionExportReader,
  type ProblemPackageExportHandlerDependencies,
  type ProblemPackageImportHandlerDependencies,
  type VerifiedImportArchiveReader
} from "@urmotiv/jobs";
