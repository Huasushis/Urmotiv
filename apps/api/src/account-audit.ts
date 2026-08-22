import type { DatabaseExecutor, DatabaseHandle } from "@urmotiv/database";
import { sql } from "drizzle-orm";
import { BatchAccountAuditWriteError } from "./batch-account";

export interface BatchAccountAuditEvent {
  readonly actorUserId: string;
  readonly requestId: string;
  readonly accountCount: number;
}

export interface BatchAccountAuditWriter {
  write(event: BatchAccountAuditEvent, executor?: DatabaseExecutor): Promise<void>;
}

export class DatabaseBatchAccountAuditWriter implements BatchAccountAuditWriter {
  public constructor(private readonly database: DatabaseHandle) {}

  public async write(
    event: BatchAccountAuditEvent,
    executor: DatabaseExecutor = this.database
  ): Promise<void> {
    try {
      await executor.execute(sql`
        INSERT INTO audit_events (
          actor_user_id, request_id, action, object_type, object_id, result, metadata
        ) VALUES (
          ${event.actorUserId}::bigint,
          ${event.requestId}::uuid,
          'user.batch_create',
          'user_batch',
          NULL,
          'success',
          ${JSON.stringify({ accountCount: event.accountCount })}::jsonb
        )
      `);
    } catch {
      throw new BatchAccountAuditWriteError();
    }
  }
}
