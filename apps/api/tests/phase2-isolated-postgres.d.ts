declare module "./phase2-isolated-postgres.mjs" {
  export interface IsolatedCluster {
    containerId: string;
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    adminUrl: string;
    labels: Record<string, string>;
    manifestDir: string;
    systemIdentifier: string;
  }

  export function createIsolatedPostgres(opts?: { runId?: string }): IsolatedCluster;
  export function verifyContainerIdentity(
    containerId: string,
    expectedLabels: Record<string, string>,
  ): boolean;
  export function verifyLiveIdentity(
    containerId: string,
    expectedSystemIdentifier: string,
  ): boolean;
  export function teardownIsolatedPostgres(cluster: {
    containerId: string;
    labels: Record<string, string>;
    manifestDir: string;
    systemIdentifier: string;
  }): void;
  export function recoverAndTeardown(manifestDir: string): void;
  export function listProjectContainers(): string[];
  export function manifestExists(manifestDir: string): boolean;
  export function getLiveIdentity(containerId: string): string;
}
