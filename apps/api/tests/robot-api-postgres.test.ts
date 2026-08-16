import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPostgresDatabase,
  migrateDatabase,
  seedCoreDatabase,
  type PostgresDatabaseHandle
} from "@urmotiv/database";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { DatabaseContestStore } from "../src/database-contest-store";
import { databaseDemoUserIds, seedDatabaseDemoData } from "../src/database-demo";
import { DatabaseDataStore } from "../src/database-store";
import { DatabaseReviewItemStore } from "../src/review-item-store";
import { DatabaseRobotStore, digestRobotToken } from "../src/robot-store";
import { DatabaseServiceAccountTokenStore } from "../src/service-account-store";
import { DatabaseTagCatalogService } from "../src/tag-catalog-service";
// 不再需要 registerOwnedDatabase——隔离集群方案中数据库在一次性容器内创建。

const adminUrl = process.env.URMOTIV_TEST_POSTGRES_ADMIN_URL;
const describePostgres = adminUrl === undefined ? describe.skip : describe;
const origin = "http://localhost:5173";
const token = "urt_postgres_robot_fixture_0123456789abcdef";
const temporaryDirectories: string[] = [];

describePostgres("机器人租约的真实 PostgreSQL 并发边界", () => {
  let databaseName = "";
  let databaseUrl = "";
  let database: PostgresDatabaseHandle | undefined;
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    if (adminUrl === undefined) return;
    databaseName = `urmotiv_robot_lease_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    if (!/^urmotiv_robot_lease_[a-z0-9_]+$/.test(databaseName)) {
      throw new Error("测试数据库名称无效。");
    }
    const admin = createPostgresDatabase({
      connectionString: adminUrl,
      maxConnections: 2,
      statementTimeoutMs: 10_000,
      applicationName: "urmotiv-robot-lease-test-admin"
    });
    try {
      await admin.execute(sql`CREATE DATABASE ${sql.identifier(databaseName)}`);
      // 隔离集群方案中无需登记——容器拆除即清理。
    } finally {
      await admin.close();
    }
    databaseUrl = databaseConnectionString(adminUrl, databaseName);
    database = createPostgresDatabase({
      connectionString: databaseUrl,
      maxConnections: 16,
      statementTimeoutMs: 10_000,
      applicationName: "urmotiv-robot-lease-test"
    });
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
    if (adminUrl === undefined || databaseName.length === 0) return;
    const admin = createPostgresDatabase({
      connectionString: adminUrl,
      maxConnections: 2,
      statementTimeoutMs: 10_000,
      applicationName: "urmotiv-robot-lease-test-cleanup"
    });
    try {
      await admin.execute(sql`DROP DATABASE ${sql.identifier(databaseName)}`);
    } finally {
      await admin.close();
    }
  });

  it("门禁拒绝活租约，并发领取续租完成及关闭竞态无重复或死锁", async () => {
    if (database === undefined) throw new Error("未建立真实 PostgreSQL 测试数据库。");
    await migrateDatabase(database, { migrationsFolder: migrationFolderThrough(8) });
    await seedCoreDatabase(database);
    await seedDatabaseDemoData(database);
    const legacyTarget = await insertLegacyLeaseFixture(database);
    await database.execute(sql`
      DELETE FROM review_assignments WHERE id = ${legacyTarget.assignmentId}::uuid
    `);
    let releaseLegacyClaim = (): void => undefined;
    let reportLegacyInsert = (): void => undefined;
    const legacyClaimMayCommit = new Promise<void>((resolve) => {
      releaseLegacyClaim = resolve;
    });
    const legacyInsertFinished = new Promise<void>((resolve) => {
      reportLegacyInsert = resolve;
    });
    const legacyClaim = database.transaction(async (transaction) => {
      const inserted = await transaction.query<{ id: string }>(sql`
        WITH inserted AS (
          INSERT INTO review_assignments (
            id, round_id, reviewer_user_id, assigned_by_user_id, reason, expires_at
          ) VALUES (
            ${legacyTarget.assignmentId}::uuid, ${legacyTarget.roundId}::uuid,
            ${BigInt(databaseDemoUserIds.robot)}, ${BigInt(databaseDemoUserIds.robot)},
            '真实 PostgreSQL 迁移门禁测试', now() + interval '1 hour'
          )
          RETURNING id, round_id
        )
        SELECT inserted.id::text AS id
        FROM inserted
        JOIN review_rounds round ON round.id = inserted.round_id
      `);
      expect(inserted).toEqual([{ id: legacyTarget.assignmentId }]);
      reportLegacyInsert();
      await legacyClaimMayCommit;
    });
    await legacyInsertFinished;
    await expect(migrateDatabase(database)).rejects.toThrow(
      /robot review lease migration requires the API to be stopped and database transactions to be drained/
    );
    releaseLegacyClaim();
    await legacyClaim;
    await expect(migrateDatabase(database)).rejects.toThrow(
      /robot review lease migration requires all live robot leases to finish/
    );
    await database.execute(sql`
      UPDATE review_assignments
      SET created_at = now() - interval '2 hours',
          expires_at = now() - interval '1 hour'
      WHERE reason = '真实 PostgreSQL 迁移门禁测试'
    `);
    await migrateDatabase(database, { migrationsFolder: migrationFolderThrough(11) });
    const catalogGateAssignmentId = randomUUID();
    await database.execute(sql`
      INSERT INTO review_assignments (
        id, round_id, reviewer_user_id, assigned_by_user_id, reason,
        assignment_kind, claimed_problem_revision, claimed_submitted_revision_id, expires_at
      )
      SELECT
        ${catalogGateAssignmentId}::uuid,
        assignment.round_id,
        assignment.reviewer_user_id,
        assignment.assigned_by_user_id,
        '真实 PostgreSQL 标签目录快照迁移门禁测试',
        'robot',
        assignment.claimed_problem_revision,
        assignment.claimed_submitted_revision_id,
        now() + interval '1 hour'
      FROM review_assignments assignment
      WHERE assignment.reason = '真实 PostgreSQL 迁移门禁测试'
    `);
    await expect(migrateDatabase(database)).rejects.toThrow(
      /robot tag catalog snapshot migration requires all robot leases to finish/
    );
    await database.execute(sql`
      DELETE FROM review_assignments WHERE id = ${catalogGateAssignmentId}::uuid
    `);
    await migrateDatabase(database);
    const archived = await database.query<{
      closure_reason: string;
      claimed_tag_catalog_version: number | null;
    }>(sql`
      SELECT closure_reason::text AS closure_reason, claimed_tag_catalog_version
      FROM review_assignments
      WHERE reason = '真实 PostgreSQL 迁移门禁测试'
    `);
    expect(archived).toEqual([{
      closure_reason: "expired",
      claimed_tag_catalog_version: null,
    }]);
    await database.execute(sql`
      UPDATE problems
      SET status = 'rejected'
      WHERE id = (
        SELECT round.problem_id
        FROM review_assignments assignment
        JOIN review_rounds round ON round.id = assignment.round_id
        WHERE assignment.reason = '真实 PostgreSQL 迁移门禁测试'
      )
    `);

    const tokenId = await insertToken(database);
    const store = new DatabaseDataStore(database);
    app = await createApp({
      demoAuthEnabled: true,
      store,
      contestStore: new DatabaseContestStore(database),
      demoUserIds: Object.values(databaseDemoUserIds),
      demoLoginUserIds: databaseDemoUserIds,
      reviewItems: new DatabaseReviewItemStore(database),
      robots: new DatabaseRobotStore(database),
      tagCatalog: new DatabaseTagCatalogService(database)
    });

    const problem = await createPendingProblem(app);
    const concurrentClaims = await startMany(8, () => claim(app!));
    const claimedItems = concurrentClaims.flatMap((response) => {
      expect(response.statusCode).toBe(200);
      return (response.json() as { items: ClaimedTask[] }).items;
    });
    expect(claimedItems).toHaveLength(1);
    const task = claimedItems[0];
    if (task === undefined) throw new Error("并发领取没有返回任务。");
    expect(task.problem.id).toBe(problem.id);
    expect(await database.query<{ claimed_tag_catalog_version: number }>(sql`
      SELECT claimed_tag_catalog_version
      FROM review_assignments
      WHERE id = ${task.assignmentId}::uuid
    `)).toEqual([{ claimed_tag_catalog_version: task.tagCatalog.version }]);

    const renewalPayload = {
      requestId: randomUUID(),
      expectedLeaseExpiresAt: task.leaseExpiresAt,
      leaseSeconds: 300
    };
    const [firstRenewal, secondRenewal] = await startTogether(
      () => renew(app!, task.assignmentId, renewalPayload),
      () => renew(app!, task.assignmentId, renewalPayload)
    );
    expect(firstRenewal.statusCode).toBe(200);
    expect(secondRenewal.statusCode).toBe(200);
    expect(secondRenewal.json()).toEqual(firstRenewal.json());
    const renewedLease = (firstRenewal.json() as { leaseExpiresAt: string }).leaseExpiresAt;

    const completionPayload = completion(task, renewedLease, randomUUID());
    const [firstCompletion, secondCompletion] = await startTogether(
      () => complete(app!, task.assignmentId, completionPayload),
      () => complete(app!, task.assignmentId, completionPayload)
    );
    expect(firstCompletion.statusCode).toBe(200);
    expect(secondCompletion.statusCode).toBe(200);
    expect(secondCompletion.json()).toEqual(firstCompletion.json());

    const effects = await database.query<{
      opinions: number;
      renew_operations: number;
      complete_operations: number;
      complete_audits: number;
    }>(sql`
      SELECT
        (SELECT count(*)::integer FROM review_opinions WHERE reviewer_user_id = ${BigInt(databaseDemoUserIds.robot)}) AS opinions,
        (SELECT count(*)::integer FROM review_assignment_operations WHERE operation = 'renew') AS renew_operations,
        (SELECT count(*)::integer FROM review_assignment_operations WHERE operation = 'complete') AS complete_operations,
        (SELECT count(*)::integer FROM audit_events WHERE action = 'robot.review.complete') AS complete_audits
    `);
    expect(effects).toEqual([{
      opinions: 1,
      renew_operations: 1,
      complete_operations: 1,
      complete_audits: 1
    }]);

    const raceProblem = await createPendingProblem(app);
    const raceClaim = await claim(app);
    const raceTask = (raceClaim.json() as { items: ClaimedTask[] }).items[0];
    if (raceTask === undefined || raceTask.problem.id !== raceProblem.id) {
      throw new Error("未取得关闭竞态任务。");
    }
    const leaderCookie = await login(app, databaseDemoUserIds.leader);
    const [completionResponse, decisionResponse] = await startTogether(
      () => complete(
        app!,
        raceTask.assignmentId,
        completion(raceTask, raceTask.leaseExpiresAt, randomUUID())
      ),
      () => app!.inject({
        method: "POST",
        url: `/api/v1/problems/${raceProblem.id}/review-decision`,
        headers: { cookie: leaderCookie, origin },
        payload: {
          expectedRound: raceTask.problem.reviewRound,
          expectedRevision: raceTask.problem.revision,
          decision: "reject",
          reason: "公开构造的并发终审"
        }
      })
    );
    expect([200, 404]).toContain(completionResponse.statusCode);
    expect(decisionResponse.statusCode).toBe(200);
    const raceAssignment = await database.query<{ closure_reason: string }>(sql`
      SELECT closure_reason::text AS closure_reason
      FROM review_assignments
      WHERE id = ${raceTask.assignmentId}::uuid
    `);
    expect(["completed", "round_closed"]).toContain(raceAssignment[0]?.closure_reason);

    const contentProblem = await createPendingProblem(app);
    const contentClaim = await claim(app);
    const contentTask = (contentClaim.json() as { items: ClaimedTask[] }).items[0];
    if (contentTask === undefined || contentTask.problem.id !== contentProblem.id) {
      throw new Error("未取得内容变化竞态任务。");
    }
    const authorCookie = await login(app, databaseDemoUserIds.author);
    const [completionDuringEdit, editDuringCompletion] = await startTogether(
      () => complete(
        app!,
        contentTask.assignmentId,
        completion(contentTask, contentTask.leaseExpiresAt, randomUUID())
      ),
      () => app!.inject({
        method: "PATCH",
        url: `/api/v1/problems/${contentProblem.id}`,
        headers: { cookie: authorCookie, origin },
        payload: {
          expectedRevision: contentTask.problem.revision,
          content: {
            basicStatement: "输入一个数。",
            basicSolution: "直接处理。",
            background: "公开构造的并发补充背景。"
          }
        }
      })
    );
    expect([200, 404]).toContain(completionDuringEdit.statusCode);
    expect(editDuringCompletion.statusCode).toBe(200);
    const contentEffects = await database.query<{
      closure_reason: string;
      opinions: number;
    }>(sql`
      SELECT assignment.closure_reason::text AS closure_reason,
             (
               SELECT count(*)::integer
               FROM review_opinions opinion
               WHERE opinion.round_id = assignment.round_id
                 AND opinion.reviewer_user_id = assignment.reviewer_user_id
             ) AS opinions
      FROM review_assignments assignment
      WHERE assignment.id = ${contentTask.assignmentId}::uuid
    `);
    expect(contentEffects[0]?.closure_reason).toBe(
      completionDuringEdit.statusCode === 200 ? "completed" : "content_changed"
    );
    expect(contentEffects[0]?.opinions).toBe(completionDuringEdit.statusCode === 200 ? 1 : 0);
    const contentDecision = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${contentProblem.id}/review-decision`,
      headers: { cookie: leaderCookie, origin },
      payload: {
        expectedRound: contentTask.problem.reviewRound,
        expectedRevision: contentTask.problem.revision + 1,
        decision: "reject",
        reason: "结束公开构造的内容竞态题"
      }
    });
    expect(contentDecision.statusCode).toBe(200);

    const permissionProblem = await createPendingProblem(app);
    const permissionClaim = await claim(app);
    const permissionTask = (permissionClaim.json() as { items: ClaimedTask[] }).items[0];
    if (permissionTask === undefined || permissionTask.problem.id !== permissionProblem.id) {
      throw new Error("未取得撤权竞态任务。");
    }
    const racingRenewal = {
      requestId: randomUUID(),
      expectedLeaseExpiresAt: permissionTask.leaseExpiresAt,
      leaseSeconds: 300
    };
    const [renewalDuringRevoke] = await startTogether(
      () => renew(app!, permissionTask.assignmentId, racingRenewal),
      () => database!.execute(sql`
        INSERT INTO permission_grants (
          id, subject_user_id, permission_name, effect, scope, object_type, object_id,
          granted_by_user_id, reason
        ) VALUES (
          ${randomUUID()}::uuid, ${BigInt(databaseDemoUserIds.robot)}, 'problem.review',
          'deny', 'object', 'problem', ${permissionProblem.id}, 0,
          '真实 PostgreSQL 撤权竞态测试'
        )
      `)
    );
    expect([200, 404]).toContain(renewalDuringRevoke.statusCode);
    const leaseAfterRace = renewalDuringRevoke.statusCode === 200
      ? (renewalDuringRevoke.json() as { leaseExpiresAt: string }).leaseExpiresAt
      : permissionTask.leaseExpiresAt;
    const deniedRenewal = await renew(app, permissionTask.assignmentId, {
      requestId: randomUUID(),
      expectedLeaseExpiresAt: leaseAfterRace,
      leaseSeconds: 300
    });
    expect(deniedRenewal.statusCode).toBe(404);
    const revokedAssignment = await database.query<{ closure_reason: string }>(sql`
      SELECT closure_reason::text AS closure_reason
      FROM review_assignments
      WHERE id = ${permissionTask.assignmentId}::uuid
    `);
    expect(revokedAssignment).toEqual([{ closure_reason: "permission_revoked" }]);

    const tokenRaceProblem = await createPendingProblem(app);
    const tokenRaceClaim = await claim(app);
    const tokenRaceTask = (tokenRaceClaim.json() as { items: ClaimedTask[] }).items[0];
    if (tokenRaceTask === undefined || tokenRaceTask.problem.id !== tokenRaceProblem.id) {
      throw new Error("未取得令牌撤销竞态任务。");
    }
    const tokenStore = new DatabaseServiceAccountTokenStore(database);
    const [completionDuringTokenRevoke, revokedToken] = await startTogether(
      () => complete(
        app!,
        tokenRaceTask.assignmentId,
        completion(tokenRaceTask, tokenRaceTask.leaseExpiresAt, randomUUID())
      ),
      () => tokenStore.revokeToken(
        databaseDemoUserIds.robot,
        tokenId,
        databaseDemoUserIds.administrator,
        randomUUID()
      )
    );
    expect(revokedToken).toBeDefined();
    expect([200, 401, 404]).toContain(completionDuringTokenRevoke.statusCode);
    const tokenRaceEffects = await database.query<{
      closure_reason: string | null;
      opinions: number;
    }>(sql`
      SELECT assignment.closure_reason::text AS closure_reason,
             (
               SELECT count(*)::integer
               FROM review_opinions opinion
               WHERE opinion.round_id = assignment.round_id
                 AND opinion.reviewer_user_id = assignment.reviewer_user_id
             ) AS opinions
      FROM review_assignments assignment
      WHERE assignment.id = ${tokenRaceTask.assignmentId}::uuid
    `);
    expect(tokenRaceEffects[0]?.opinions).toBe(
      completionDuringTokenRevoke.statusCode === 200 ? 1 : 0
    );
    expect(tokenRaceEffects[0]?.closure_reason).toBe(
      completionDuringTokenRevoke.statusCode === 200
        ? "completed"
        : completionDuringTokenRevoke.statusCode === 404
          ? "permission_revoked"
          : null
    );
    const afterTokenRevoke = await renew(app, tokenRaceTask.assignmentId, {
      requestId: randomUUID(),
      expectedLeaseExpiresAt: tokenRaceTask.leaseExpiresAt,
      leaseSeconds: 300
    });
    expect(afterTokenRevoke.statusCode).toBe(401);
  }, 120_000);
});

interface ClaimedTask {
  readonly assignmentId: string;
  readonly leaseExpiresAt: string;
  readonly problem: { readonly id: string; readonly revision: number; readonly reviewRound: number };
  readonly tagCatalog: {
    readonly version: number;
    readonly tags: ReadonlyArray<{ readonly id: string }>;
  };
}

function migrationFolderThrough(lastIndex: number): string {
  const source = new URL("../../../packages/database/migrations/", import.meta.url);
  const directory = mkdtempSync(join(tmpdir(), "urmotiv-pg-migrations-"));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", source), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const entries = journal.entries.filter((entry) => entry.idx <= lastIndex);
  for (const entry of entries) {
    cpSync(new URL(`${entry.tag}.sql`, source), join(directory, `${entry.tag}.sql`));
  }
  writeFileSync(
    join(directory, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries }),
    { encoding: "utf8", mode: 0o600 }
  );
  return directory;
}

function databaseConnectionString(connectionString: string, targetDatabaseName: string): string {
  const queryIndex = connectionString.indexOf("?");
  const endpoint = queryIndex === -1 ? connectionString : connectionString.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : connectionString.slice(queryIndex);
  const separator = endpoint.lastIndexOf("/");
  if (separator < "postgresql://".length) {
    throw new Error("测试数据库连接地址无效。");
  }
  return `${endpoint.slice(0, separator + 1)}${targetDatabaseName}${query}`;
}

async function insertLegacyLeaseFixture(database: PostgresDatabaseHandle): Promise<{
  readonly assignmentId: string;
  readonly problemId: string;
  readonly roundId: string;
}> {
  return database.transaction(async (transaction) => {
    const problemRows = await transaction.query<{ id: string }>(sql`
      INSERT INTO problems (owner_id, status, current_revision, current_review_round)
      VALUES (${BigInt(databaseDemoUserIds.author)}, 'pending_review', 1, 1)
      RETURNING id::text AS id
    `);
    const problemId = problemRows[0]?.id;
    if (problemId === undefined) throw new Error("未建立迁移门禁题目。");
    const revisionId = randomUUID();
    const roundId = randomUUID();
    const assignmentId = randomUUID();
    await transaction.execute(sql`
      INSERT INTO problem_revisions (
        id, problem_id, revision, status, title, type, basic_statement, basic_solution,
        content_hash, change_reason, created_by_user_id
      ) VALUES (
        ${revisionId}::uuid, ${BigInt(problemId)}, 1, 'pending_review', '公开构造迁移题',
        'traditional', '公开构造题面', '公开构造题解',
        '0000000000000000000000000000000000000000000000000000000000000000',
        '迁移门禁测试', ${BigInt(databaseDemoUserIds.author)}
      )
    `);
    await transaction.execute(sql`
      INSERT INTO tags (id, name, group_name, description)
      VALUES (
        'fixture.robot-lease', '公开迁移夹具知识点', '公开迁移夹具分类',
        '用于验证跨版本迁移的公开测试夹具'
      )
      ON CONFLICT (id) DO NOTHING
    `);
    await transaction.execute(sql`
      INSERT INTO problem_revision_tags (revision_id, tag_id)
      VALUES (${revisionId}::uuid, 'fixture.robot-lease')
    `);
    await transaction.execute(sql`
      INSERT INTO review_rounds (
        id, problem_id, round, submitted_revision_id, status, rule_id, rule_version,
        submitted_by_user_id
      ) VALUES (
        ${roundId}::uuid, ${BigInt(problemId)}, 1, ${revisionId}::uuid, 'open',
        'fixture', '1', ${BigInt(databaseDemoUserIds.author)}
      )
    `);
    await transaction.execute(sql`
      INSERT INTO review_assignments (
        id, round_id, reviewer_user_id, assigned_by_user_id, reason, expires_at
      ) VALUES (
        ${assignmentId}::uuid, ${roundId}::uuid, ${BigInt(databaseDemoUserIds.robot)},
        ${BigInt(databaseDemoUserIds.robot)}, '真实 PostgreSQL 迁移门禁测试',
        now() + interval '1 hour'
      )
    `);
    return { assignmentId, problemId, roundId };
  });
}

async function insertToken(database: PostgresDatabaseHandle): Promise<string> {
  const tokenId = randomUUID();
  await database.execute(sql`
    INSERT INTO api_tokens (
      id, user_id, name, token_prefix, token_digest, source_cidrs, created_by_user_id
    ) VALUES (
      ${tokenId}::uuid, ${BigInt(databaseDemoUserIds.robot)}, '真实 PostgreSQL 测试令牌',
      'urv_pgtest01', ${createHash("sha256").update(token).digest("hex")}, '[]'::jsonb, 0
    )
  `);
  for (const permission of ["auth.login", "problem.view.all", "problem.review"]) {
    await database.execute(sql`
      INSERT INTO api_token_permissions (id, token_id, permission_name, effect, scope)
      VALUES (${randomUUID()}::uuid, ${tokenId}::uuid, ${permission}, 'allow', 'global')
    `);
  }
  expect(digestRobotToken(token)).toHaveLength(64);
  return tokenId;
}

async function login(app: FastifyInstance, userId: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/demo-login",
    headers: { origin },
    payload: { userId }
  });
  expect(response.statusCode).toBe(200);
  const value = response.headers["set-cookie"];
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined) throw new Error("测试登录没有返回会话 Cookie。");
  return first.split(";", 1)[0] as string;
}

async function createPendingProblem(app: FastifyInstance): Promise<{ id: string }> {
  const author = await login(app, databaseDemoUserIds.author);
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/problems",
    headers: { cookie: author, origin },
    payload: {
      title: "公开构造的 PostgreSQL 并发题",
      type: "traditional",
      tagIds: ["catalog.tag.02.09"],
      content: { basicStatement: "输入一个数。", basicSolution: "直接处理。" }
    }
  });
  expect(created.statusCode).toBe(200);
  const draft = created.json() as { id: string; revision: number };
  const submitted = await app.inject({
    method: "POST",
    url: `/api/v1/problems/${draft.id}/submit`,
    headers: { cookie: author, origin },
    payload: { expectedRevision: draft.revision }
  });
  expect(submitted.statusCode).toBe(200);
  return { id: draft.id };
}

function robotHeaders(): Record<string, string> {
  return { authorization: `Bearer ${token}`, origin };
}

function claim(app: FastifyInstance) {
  return app.inject({
    method: "POST",
    url: "/api/v1/robot/review-tasks/claim",
    headers: robotHeaders(),
    payload: { maximumTasks: 1, leaseSeconds: 300 }
  });
}

function renew(app: FastifyInstance, assignmentId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/v1/robot/review-tasks/${assignmentId}/renew`,
    headers: robotHeaders(),
    payload
  });
}

function complete(app: FastifyInstance, assignmentId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/v1/robot/review-tasks/${assignmentId}/complete`,
    headers: robotHeaders(),
    payload
  });
}

function completion(task: ClaimedTask, leaseExpiresAt: string, requestId: string) {
  return {
    requestId,
    expectedLeaseExpiresAt: leaseExpiresAt,
    expectedProblemRevision: task.problem.revision,
    expectedTagCatalogVersion: task.tagCatalog.version,
    experimentVersion: "postgres-concurrency-v1",
    modelProfileName: "public-fixture",
    review: {
      verdict: "approve",
      codeforcesDifficulty: 1600,
      qualityLevel: 4,
      thinkingLevel: 3,
      codingLevel: 2,
      tagIds: [task.tagCatalog.tags[0]?.id ?? "catalog.tag.02.09"],
      improvements: "公开构造的并发测试意见。",
      expectedRound: task.problem.reviewRound
    }
  };
}

async function startTogether<T, U>(left: () => Promise<T>, right: () => Promise<U>) {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = barrier.then(left);
  const second = barrier.then(right);
  release();
  return Promise.all([first, second]);
}

async function startMany<T>(count: number, operation: () => Promise<T>): Promise<T[]> {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = Array.from({ length: count }, () => barrier.then(operation));
  release();
  return Promise.all(pending);
}
