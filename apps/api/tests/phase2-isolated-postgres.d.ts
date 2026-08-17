// Type declarations for phase2-isolated-postgres.mjs
// Sol HOLD 第四版：--internal 网络 + 精确挂载 + 原子清单 + 全 ID 验证。

/**
 * 隔离 PostgreSQL 集群信息。
 */
export interface ClusterInfo {
  /** 完整 64 字符容器 ID */
  containerId: string;
  /** 容器名称（Docker 网络主机名） */
  containerName: string;
  /** 运行令牌 */
  runId: string;
  /** 角色："primary" 或 "secondary" */
  role: string;
  /** Docker 网络主机名 */
  host: string;
  /** PostgreSQL 端口（容器内 5432） */
  port: number;
  /** 数据库用户 */
  user: string;
  /** 数据库密码 */
  password: string;
  /** 数据库名 */
  database: string;
  /** 完整 admin URL（容器网络可达） */
  adminUrl: string;
  /** 不可变标签 */
  labels: Record<string, string>;
  /** 清单目录路径（0700） */
  manifestDir: string;
  /** 清单文件路径（0600） */
  manifestPath: string;
  /** Docker 网络名称 */
  networkName: string;
  /** Docker 网络 ID */
  networkId: string;
  /** 是否由本次调用创建网络 */
  networkCreated: boolean;
  /** PostgreSQL system_identifier */
  systemIdentifier: string;
  /** PostgreSQL 镜像 */
  image: string;
  /** 镜像 ID */
  imageId: string;
}

/**
 * Runner 容器信息。
 */
export interface RunnerContainer {
  containerId: string;
  containerName: string;
  labels: Record<string, string>;
  networkName: string;
  networkId: string;
  image: string;
  imageId: string;
  manifestDir: string;
  manifestPath: string;
  worktreePath: string;
  workDir: string;
}

/**
 * docker exec 结果。
 */
export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface CreateIsolatedPostgresOptions {
  runId: string;
  role: string;
  networkName?: string;
}

export interface CreateRunnerOptions {
  runId: string;
  networkName: string;
  worktreePath: string;
  bindMounts?: Array<[string, string]>;
  workDir: string;
}

export function createIsolatedPostgres(opts: CreateIsolatedPostgresOptions): ClusterInfo;

export function verifyContainerIdentity(
  containerId: string,
  expectedLabels: Record<string, string>,
  expectedImage?: string,
): boolean;

export function verifyFullContainerIdentity(
  containerId: string,
  expectedLabels: Record<string, string>,
  expectedImageId?: string,
  expectedNetworkId?: string,
): boolean;

export function verifyLiveIdentity(
  containerId: string,
  expectedSystemIdentifier: string,
): boolean;

export function verifyNetworkIdentity(
  networkName: string,
  expectedRunId?: string,
): boolean;

export function verifyNetworkId(
  networkName: string,
  expectedNetworkId: string,
): boolean;

export function teardownIsolatedPostgres(cluster: ClusterInfo): void;

export function recoverAndTeardown(manifestDir: string): void;

export function listProjectContainers(): string[];

export function listProjectNetworks(): string[];

export function manifestExists(manifestDir: string): boolean;

export function readManifest(
  manifestDir: string,
): {
  version: number;
  containerId: string;
  runId: string;
  role: string;
  networkName: string;
  networkId: string;
  imageId: string;
  systemIdentifier: string | null;
  phase: string;
  labels: Record<string, string>;
} | null;

export function verifyManifestPermissions(manifestDir: string): boolean;

export function createRunnerContainer(opts: CreateRunnerOptions): RunnerContainer;

export function execInRunner(
  containerId: string,
  args: string[],
  opts?: { cwd?: string },
): ExecResult;

export function execInRunnerWithEnv(
  containerId: string,
  env: Record<string, string>,
  args: string[],
  opts?: { cwd?: string },
): ExecResult;

export function teardownRunnerContainer(container: RunnerContainer): void;

export function recoverAndTeardownRunner(manifestDir: string): void;
