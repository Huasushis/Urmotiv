import {
  isDatabaseEmptyForAdminBootstrap,
  migrateDatabase,
  openAdminBootstrapForFreshSeed,
  releaseAdminBootstrapMigrationLease,
  seedCoreDatabase,
  tryAcquireAdminBootstrapMigrationLease,
  type DatabaseHandle
} from "@urmotiv/database";

export interface DeploymentMigrationResult {
  readonly adminBootstrapOpened: boolean;
}

export async function runDeploymentDatabaseMigration(
  database: DatabaseHandle
): Promise<DeploymentMigrationResult> {
  const lease = await tryAcquireAdminBootstrapMigrationLease(database).catch(() => undefined);
  if (lease === undefined) {
    throw new Error("URMOTIV_DATABASE_MIGRATION_LOCKED");
  }

  let leaseReleased = false;
  try {
    const wasEmptyBeforeMigration = await isDatabaseEmptyForAdminBootstrap(database);
    await migrateDatabase(database);
    await seedCoreDatabase(database);

    if (wasEmptyBeforeMigration) {
      const outcome = await openAdminBootstrapForFreshSeed(database, lease);
      if (outcome !== "opened") {
        throw new Error("URMOTIV_ADMIN_BOOTSTRAP_NOT_OPENED");
      }
      leaseReleased = true;
      return { adminBootstrapOpened: true };
    }

    if (!await releaseAdminBootstrapMigrationLease(database, lease)) {
      throw new Error("URMOTIV_DATABASE_MIGRATION_LOCK_LOST");
    }
    leaseReleased = true;
    return { adminBootstrapOpened: false };
  } catch {
    if (!leaseReleased) {
      await releaseAdminBootstrapMigrationLease(database, lease).catch(() => false);
    }
    throw new Error("URMOTIV_DATABASE_MIGRATION_FAILED");
  }
}
