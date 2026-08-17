declare module "./phase2-isolated-postgres.mjs" {
  export interface ClusterInfo {
    containerId: string;
    runId: string;
    role: string;
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    adminUrl: string;
    labels: Record<string, string>;
    manifestDir: string;
    manifestPath: string;
    networkName: string;
    networkCreated: boolean;
    systemIdentifier: string;
    image: string;
  }

  export interface ExecResult {
    ok: boolean;
    stdout: string;
    stderr: string;
  }

  export interface RunnerContainer {
    containerId: string;
    labels: Record<string, string>;
    networkName: string;
  }

  export function createIsolatedPostgres(opts: {
    runId: string;
    role: string;
    networkName?: string;
  }): ClusterInfo;
  export function verifyContainerIdentity(
    containerId: string,
    expectedLabels: Record<string, string>,
    expectedImage?: string,
  ): boolean;
  export function verifyLiveIdentity(
    containerId: string,
    expectedSystemIdentifier: string,
  ): boolean;
  export function verifyNetworkIdentity(
    networkName: string,
    expectedRunId?: string,
  ): boolean;
  export function teardownIsolatedPostgres(cluster: ClusterInfo): void;
  export function recoverAndTeardown(manifestDir: string): void;
  export function listProjectContainers(): string[];
  export function listProjectNetworks(): string[];
  export function manifestExists(manifestDir: string): boolean;
  export function readManifest(manifestDir: string): Record<string, unknown> | null;
  export function verifyManifestPermissions(manifestDir: string): boolean;
  export function createRunnerContainer(opts: {
    runId: string;
    networkName: string;
    mounts: Array<[string, string, string?]>;
    workDir: string;
  }): RunnerContainer;
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
}
