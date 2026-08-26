import { PGlite } from "@electric-sql/pglite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SQL } from "drizzle-orm";
import { drizzle as createNodePostgresDrizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as createPgliteDrizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { Pool, type PoolConfig } from "pg";
import * as schema from "./schema";

export type PostgresDatabase = NodePgDatabase<typeof schema>;
export type LocalDatabase = PgliteDatabase<typeof schema>;

interface CommonDatabaseHandle {
  execute(statement: SQL): Promise<unknown>;
  query<Row extends Record<string, unknown>>(statement: SQL): Promise<Row[]>;
  transaction<T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface DatabaseExecutor {
  execute(statement: SQL): Promise<unknown>;
  query<Row extends Record<string, unknown>>(statement: SQL): Promise<Row[]>;
}

export interface PostgresDatabaseHandle extends CommonDatabaseHandle {
  readonly kind: "postgres";
  readonly database: PostgresDatabase;
  readonly client: Pool;
}

export interface LocalDatabaseHandle extends CommonDatabaseHandle {
  readonly kind: "pglite";
  readonly database: LocalDatabase;
  readonly client: PGlite;
}

export type DatabaseHandle = PostgresDatabaseHandle | LocalDatabaseHandle;

export interface PostgresDatabaseOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly idleTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly ssl?: PoolConfig["ssl"];
  readonly applicationName?: string;
}

export interface LocalDatabaseOptions {
  /** Omit this value only for short-lived tests. A normal local setup should use a file path. */
  readonly dataDirectory?: string;
}
class ReleasingPGlite extends PGlite {
  public override async close(): Promise<void> {
    try {
      await super.close();
    } finally {
      // PGlite 0.5.4 keeps the exited WASM runtime reachable after close.
      // Release it so sequential local databases do not retain hundreds of MiB each.
      delete this.mod;
      delete this.fs;
    }
  }
}

export function createPostgresDatabase(
  options: PostgresDatabaseOptions
): PostgresDatabaseHandle {
  if (options.connectionString.trim().length === 0) {
    throw new Error("PostgreSQL 连接地址不能为空。");
  }

  const poolConfig: PoolConfig = {
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    statement_timeout: options.statementTimeoutMs ?? 30_000,
    application_name: options.applicationName ?? "urmotiv"
  };
  if (options.ssl !== undefined) {
    poolConfig.ssl = options.ssl;
  }

  const client = new Pool(poolConfig);
  const database = createNodePostgresDrizzle(client, { schema });

  return {
    kind: "postgres",
    client,
    database,
    execute: async (statement): Promise<unknown> => database.execute(statement),
    query: async <Row extends Record<string, unknown>>(statement: SQL): Promise<Row[]> =>
      rowsFromResult<Row>(await database.execute(statement)),
    transaction: async <T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T> =>
      database.transaction(async (transaction) =>
        work({
          execute: async (statement): Promise<unknown> => transaction.execute(statement),
          query: async <Row extends Record<string, unknown>>(
            statement: SQL
          ): Promise<Row[]> => rowsFromResult<Row>(await transaction.execute(statement))
        })
      ),
    close: async (): Promise<void> => client.end()
  };
}

export function createLocalDatabase(options: LocalDatabaseOptions = {}): LocalDatabaseHandle {
  if (options.dataDirectory !== undefined && options.dataDirectory.trim().length === 0) {
    throw new Error("PGlite 数据目录不能为空；短期测试请直接省略该选项。");
  }

  let dataDirectory = options.dataDirectory;
  if (dataDirectory !== undefined && !dataDirectory.includes("://")) {
    dataDirectory = resolve(dataDirectory);
    mkdirSync(dirname(dataDirectory), { recursive: true });
  }

  const client =
    dataDirectory === undefined ? new ReleasingPGlite() : new ReleasingPGlite(dataDirectory);
  const database = createPgliteDrizzle(client, { schema });

  return {
    kind: "pglite",
    client,
    database,
    execute: async (statement): Promise<unknown> => database.execute(statement),
    query: async <Row extends Record<string, unknown>>(statement: SQL): Promise<Row[]> =>
      rowsFromResult<Row>(await database.execute(statement)),
    transaction: async <T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T> =>
      database.transaction(async (transaction) =>
        work({
          execute: async (statement): Promise<unknown> => transaction.execute(statement),
          query: async <Row extends Record<string, unknown>>(
            statement: SQL
          ): Promise<Row[]> => rowsFromResult<Row>(await transaction.execute(statement))
        })
      ),
    close: async (): Promise<void> => client.close()
  };
}

function rowsFromResult<Row extends Record<string, unknown>>(result: unknown): Row[] {
  if (Array.isArray(result)) {
    return result as Row[];
  }
  if (typeof result === "object" && result !== null && "rows" in result) {
    const rows = result.rows;
    if (Array.isArray(rows)) {
      return rows as Row[];
    }
  }
  return [];
}
