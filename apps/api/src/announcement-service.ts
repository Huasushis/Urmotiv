import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { DatabaseHandle, DatabaseExecutor } from "@urmotiv/database";
import { announcementSchema, type AnnouncementInput } from "@urmotiv/contracts";
import { hasPermission } from "./permissions";
import { lockUserPolicyForAuthorization } from "./database-store";
import { notFound, conflict } from "./errors";
import type { StoredUser } from "./domain";

export class AnnouncementService {
  constructor(private readonly database: DatabaseHandle) {}
  private audience(userId: string): SQL {
    return sql`a.published AND (
      a.audience='all' OR
      (a.audience='newcomers' AND EXISTS(SELECT 1 FROM users u WHERE u.id=${BigInt(userId)} AND u.created_at>=now()-a.newcomer_days*interval '1 day')) OR
      (a.audience='roles' AND EXISTS(SELECT 1 FROM role_memberships m JOIN roles r ON r.id=m.role_id WHERE m.user_id=${BigInt(userId)} AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>now()) AND a.role_ids ? r.id::text))
    )`;
  }
  private async authorized(
    tx: DatabaseExecutor,
    actorId: string,
    manage: boolean,
  ): Promise<StoredUser> {
    const user = await lockUserPolicyForAuthorization(tx, BigInt(actorId));
    if (
      !user ||
      user.disabled ||
      user.accountType !== "human" ||
      !hasPermission(user, "auth.login", {}, new Date()) ||
      (manage && !hasPermission(user, "announcement.manage", {}, new Date()))
    )
      throw notFound();
    return user;
  }
  async list(
    actorId: string,
    options: {
      manage?: boolean;
      page: number;
      pageSize: number;
      popup?: boolean;
    },
  ) {
    return this.database.transaction(async (tx) => {
      await this.authorized(tx, actorId, !!options.manage);
      const visible = options.manage ? sql`true` : this.audience(actorId);
      const unread = sql`coalesce(ar.revision,0)<a.revision`;
      const filter = options.popup
        ? sql`${visible} AND a.popup AND ${unread}`
        : visible;
      const join = sql`FROM announcements a LEFT JOIN announcement_reads ar ON ar.announcement_id=a.id AND ar.user_id=${BigInt(actorId)}`;
      const counts = await tx.query<{ total: number; unread: number }>(
        sql`SELECT count(*)::int AS total,count(*) FILTER(WHERE ${unread})::int AS unread ${join} WHERE ${visible}`,
      );
      const rows = await tx.query(
        sql`SELECT a.*,coalesce(ar.revision,0)>=a.revision AS read ${join} WHERE ${filter} ORDER BY a.pinned DESC,a.updated_at DESC,a.id LIMIT ${options.pageSize} OFFSET ${(options.page - 1) * options.pageSize}`,
      );
      return {
        items: rows.map((row) =>
          announcementSchema.parse({
            id: row.id,
            title: row.title,
            body: row.body,
            audience: row.audience,
            roleIds: row.role_ids,
            newcomerDays: row.newcomer_days,
            pinned: row.pinned,
            popup: row.popup,
            published: row.published,
            revision: row.revision,
            createdAt: new Date(row.created_at as string).toISOString(),
            updatedAt: new Date(row.updated_at as string).toISOString(),
            read: row.read,
          }),
        ),
        total: counts[0]!.total,
        unread: counts[0]!.unread,
      };
    });
  }
  async save(
    actorId: string,
    input: AnnouncementInput,
    requestId: string,
    id?: string,
    expectedRevision?: number,
  ) {
    return this.database.transaction(async (tx) => {
      await this.authorized(tx, actorId, true);
      if (input.audience === "roles") {
        const roles = await tx.query(
          sql`SELECT id FROM roles WHERE id IN (${sql.join(
            input.roleIds.map((id) => sql`${id}::uuid`),
            sql`,`,
          )})`,
        );
        if (roles.length !== new Set(input.roleIds).size) throw notFound();
      }
      const announcementId = id ?? randomUUID();
      if (id) {
        const current = await tx.query<{ revision: number }>(
          sql`SELECT revision FROM announcements WHERE id=${id}::uuid FOR UPDATE`,
        );
        if (!current[0]) throw notFound();
        if (current[0].revision !== expectedRevision)
          throw conflict("公告已被修改，请重新读取后再保存。");
        await tx.execute(
          sql`UPDATE announcements SET title=${input.title},body=${input.body},audience=${input.audience},role_ids=${JSON.stringify(input.roleIds)}::jsonb,newcomer_days=${input.newcomerDays},pinned=${input.pinned},popup=${input.popup},published=${input.published},revision=revision+1,updated_at=now() WHERE id=${id}::uuid`,
        );
      } else {
        await tx.execute(
          sql`INSERT INTO announcements(id,title,body,audience,role_ids,newcomer_days,pinned,popup,published,created_by_user_id) VALUES(${announcementId}::uuid,${input.title},${input.body},${input.audience},${JSON.stringify(input.roleIds)}::jsonb,${input.newcomerDays},${input.pinned},${input.popup},${input.published},${BigInt(actorId)})`,
        );
      }
      await tx.execute(
        sql`INSERT INTO audit_events(actor_user_id,request_id,action,object_type,object_id,result,metadata) VALUES(${BigInt(actorId)},${requestId}::uuid,'announcement.save','announcement',${announcementId},'success',${JSON.stringify({ published: input.published, pinned: input.pinned })}::jsonb)`,
      );
      return { id: announcementId };
    });
  }
  async markRead(actorId: string, id: string, revision: number) {
    await this.database.transaction(async (tx) => {
      await this.authorized(tx, actorId, false);
      const rows = await tx.query<{ revision: number }>(
        sql`SELECT a.revision FROM announcements a WHERE a.id=${id}::uuid AND ${this.audience(actorId)} FOR SHARE`,
      );
      if (!rows[0]) throw notFound();
      if (rows[0].revision !== revision)
        throw conflict("公告已更新，请刷新后阅读。");
      await tx.execute(
        sql`INSERT INTO announcement_reads(announcement_id,user_id,revision) VALUES(${id}::uuid,${BigInt(actorId)},${revision}) ON CONFLICT(announcement_id,user_id) DO UPDATE SET revision=excluded.revision,read_at=now()`,
      );
    });
    return { ok: true as const };
  }
  async roles(actorId: string) {
    return this.database.transaction(async (tx) => {
      await this.authorized(tx, actorId, true);
      return {
        items: await tx.query<{ id: string; name: string }>(
          sql`SELECT id::text,name FROM (SELECT id,display_name AS name FROM roles) r ORDER BY name,id`,
        ),
      };
    });
  }
}
