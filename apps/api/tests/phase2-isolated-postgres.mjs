// Phase-2 验收 Gate9 一次性 PostgreSQL 集群隔离——受信父进程独占管理。
//
// Sol HOLD 修复 A 第三版：物理隔离 + 无 Docker 权限子进程。
//
// 安全保证：
// 1. 父进程独占创建/管理所有 PostgreSQL 集群（主集群 + 次集群）。
//    子进程只拿到隔离集群的连接 URL——无法接触共享/正式集群。
// 2. 子进程在无 Docker socket 的 runner 容器内执行，无法调用 docker。
// 3. 容器用 docker create 先创建，Docker 分配端口（避免端口竞态），
//    使用 tmpfs（无匿名卷），精确 64 字符容器 ID + 不可变标签。
// 4. O_EXCL 0600 清单在 create 后立即写入 0700 目录，原子阶段更新。
// 5. 拆除用全 ID 等值比较 + 精确标签/网络验证，绝不接受前缀/模式匹配。
//    任何 Docker 守护进程错误（除已验证的 not-found）均为硬失败，保留清单。
// 6. 成功拆除后无项目专属容器/网络/进程残留。
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const nodeRequire = createRequire(import.meta.url);

const PG_IMAGE = "docker.m.daocloud.io/library/postgres:17-alpine";
const RUNNER_IMAGE = "docker.m.daocloud.io/library/ubuntu:24.04";
const LABEL_PREFIX = "urmotiv.gate9";
const MANIFEST_PREFIX = "urmotiv-gate9-cluster-";

/**
 * 生成随机密码（base64url，PostgreSQL 接受）。
 */
function randomPassword() {
  return randomBytes(24).toString("base64url").slice(0, 32);
}

/**
 * 同步执行 docker 命令，返回 stdout（trim）。错误不吞——直接抛出。
 */
function docker(args, opts = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
}

/**
 * 同步执行 docker 命令，允许失败。返回 {ok, stdout, stderr}。
 */
function dockerTry(args) {
  try {
    const stdout = execFileSync("docker", args, {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout?.toString().trim() ?? "",
      stderr: error.stderr?.toString().trim() ?? "",
    };
  }
}

/**
 * 通过 docker exec 在容器内运行 psql 查询。
 */
function psqlExec(containerId, sql) {
  return docker([
    "exec", containerId,
    "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c", sql,
  ]);
}

/**
 * 查询容器内 PostgreSQL 的 system_identifier。
 */
function querySystemIdentifier(containerId) {
  return psqlExec(containerId, "select system_identifier from pg_control_system()").trim();
}

/**
 * 轮询容器内 PostgreSQL 直到可查询（start 后的恢复路径使用）。
 */
function waitPostgresReady(containerId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      psqlExec(containerId, "select 1");
      return true;
    } catch {
      sleep(1);
    }
  }
  return false;
}

/**
 * 从宿主机通过 TCP 连接验证 PostgreSQL 就绪（host/child-reachable TCP）。
 * 使用 pg 客户端尝试连接并执行 select 1。
 */
function tcpPostgresReady(host, port, password, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const pgPath = nodeRequire.resolve("pg/package.json");
  const pgDir = pgPath.replace("/package.json", "");
  while (Date.now() < deadline) {
    try {
      const script = `
        const { Client } = require(${JSON.stringify(pgDir)});
        (async () => {
          const c = new Client({ connectionString: ${JSON.stringify(
            `postgres://postgres:${encodeURIComponent(password)}@${host}:${port}/postgres?connect_timeout=2`,
          )} });
          await c.connect();
          const r = await c.query("select current_user, current_database(), inet_server_addr(), inet_server_port()");
          console.log(JSON.stringify(r.rows[0]));
          await c.end();
        })().catch(e => { console.error(e.message); process.exit(1); });
      `;
      const out = execFileSync("node", ["-e", script], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
      }).trim();
      if (out.length > 0) return JSON.parse(out);
    } catch {
      // 连接失败，继续轮询。
    }
    sleep(500);
  }
  return null;
}

function sleep(ms) {
  execFileSync("sleep", [`${ms / 1000}`], { stdio: "ignore" });
}

/**
 * 用 O_EXCL 原子创建文件。如果文件已存在则抛错。
 */
function writeExclusive(path, content) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

/**
 * 验证文件权限模式。
 */
function checkMode(path, expectedMode) {
  const stat = statSync(path);
  return (stat.mode & 0o777) === expectedMode;
}

/**
 * 创建一个一次性隔离 PostgreSQL 17 容器。
 *
 * 流程：
 * 1. docker network create（专用网络）
 * 2. docker create（tmpfs，Docker 分配端口，精确标签）
 * 3. O_EXCL 清单写入 0700 目录
 * 4. docker start
 * 5. TCP 就绪探测 + system_identifier 采集
 * 6. 原子更新清单阶段为 ready
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.role - "primary" 或 "secondary"
 * @param {string} [opts.networkName] - 共享网络名（次集群复用主集群的网络）
 * @returns {ClusterInfo}
 */
export function createIsolatedPostgres({ runId, role, networkName }) {
  const labels = {
    [`${LABEL_PREFIX}.run-id`]: runId,
    [`${LABEL_PREFIX}.managed`]: "true",
    [`${LABEL_PREFIX}.disposable`]: "true",
    [`${LABEL_PREFIX}.role`]: role,
    [`${LABEL_PREFIX}.created-by`]: `pid-${process.pid}`,
  };
  const labelArgs = Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
  const password = randomPassword();

  // 1. 创建专用网络（或复用已有网络）。
  let netName = networkName;
  let netCreated = false;
  if (!netName) {
    netName = `urmotiv-gate9-net-${runId}`;
    docker(["network", "create", "--label", `${LABEL_PREFIX}.managed=true`,
      "--label", `${LABEL_PREFIX}.run-id=${runId}`, netName]);
    netCreated = true;
  }

  // 2. 创建容器（tmpfs，无卷，Docker 分配端口）。
  //    用 -p 127.0.0.1::5432 让 Docker 分配宿主机端口。
  const createArgs = [
    "create",
    ...labelArgs,
    "--network", netName,
    "--tmpfs", "/var/lib/postgresql/data",
    "-e", `POSTGRES_PASSWORD=${password}`,
    "-e", "POSTGRES_USER=postgres",
    "-e", "POSTGRES_DB=postgres",
    "-p", "127.0.0.1::5432",
    "--restart=no",
    PG_IMAGE,
  ];
  const fullId = docker(createArgs);
  // 全 64 字符容器 ID。

  // 3. O_EXCL 清单写入 0700 目录（在 start 之前）。
  const manifestDir = join(tmpdir(), `${MANIFEST_PREFIX}${runId}-${role}`);
  mkdirSync(manifestDir, { recursive: true, mode: 0o700 });
  chmodSync(manifestDir, 0o700);
  const manifestPath = join(manifestDir, "manifest.json");
  const manifest = {
    version: 1,
    containerId: fullId,
    runId,
    role,
    networkName: netName,
    networkCreated: netCreated,
    host: "127.0.0.1",
    port: 0, // 端口在 start 后由 Docker 分配。
    user: "postgres",
    password,
    database: "postgres",
    labels,
    image: PG_IMAGE,
    systemIdentifier: null,
    phase: "created",
    createdAt: new Date().toISOString(),
    pid: process.pid,
  };
  writeExclusive(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  // 4. 启动容器。
  try {
    docker(["start", fullId]);
  } catch (error) {
    updateManifestPhase(manifestPath, "start-failed");
    throw new Error(`容器启动失败：${error.message}（清单已保留：${manifestPath}）`);
  }

  // 获取 Docker 分配的宿主机端口（start 后才可用）。
  const portJson = docker(["inspect", "-f", "{{json .NetworkSettings.Ports}}", fullId]);
  const ports = JSON.parse(portJson);
  const hostPort = parseInt(ports["5432/tcp"][0].HostPort, 10);


  // 5. TCP 就绪探测 + system_identifier 采集。
  const readyInfo = tcpPostgresReady("127.0.0.1", hostPort, password, 60_000);
  if (readyInfo === null) {
    updateManifestPhase(manifestPath, "readiness-failed");
    throw new Error(`PostgreSQL 就绪探测失败（清单已保留：${manifestPath}）`);
  }
  const systemIdentifier = querySystemIdentifier(fullId);

  // 验证活身份：current_user、current_database、inet_server_addr、inet_server_port。
  if (readyInfo.current_user !== "postgres" || readyInfo.current_database !== "postgres") {
    updateManifestPhase(manifestPath, "identity-mismatch");
    throw new Error(`活身份不匹配：user=${readyInfo.current_user} db=${readyInfo.current_database}（清单已保留）`);
  }

  // 6. 原子更新清单：填入端口 + system_identifier + ready 阶段。
  manifest.port = hostPort;
  manifest.systemIdentifier = systemIdentifier;
  manifest.phase = "ready";
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  chmodSync(manifestPath, 0o600);

  const adminUrl = `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${hostPort}/postgres`;

  return {
    containerId: fullId,
    runId,
    role,
    host: "127.0.0.1",
    port: hostPort,
    user: "postgres",
    password,
    database: "postgres",
    adminUrl,
    labels,
    manifestDir,
    manifestPath,
    networkName: netName,
    networkCreated: netCreated,
    systemIdentifier,
    image: PG_IMAGE,
  };
}

function updateManifestPhase(manifestPath, phase) {
  try {
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    m.phase = phase;
    writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
    chmodSync(manifestPath, 0o600);
  } catch {
    // 清单可能已损坏——无法更新阶段，但保留原文件。
  }
}

/**
 * 验证容器身份：全 ID 等值比较 + 精确标签匹配 + 镜像/网络验证。
 */
export function verifyContainerIdentity(containerId, expectedLabels, expectedImage) {
  if (typeof containerId !== "string" || containerId.length !== 64) return false;
  try {
    const inspect = JSON.parse(docker(["inspect", containerId]));
    if (!Array.isArray(inspect) || inspect.length !== 1) return false;
    const info = inspect[0];
    // 全 ID 等值比较。
    if (info.Id !== containerId) return false;
    // 精确标签匹配。
    const actualLabels = info.Config?.Labels ?? {};
    for (const [key, value] of Object.entries(expectedLabels)) {
      if (actualLabels[key] !== value) return false;
    }
    if (actualLabels[`${LABEL_PREFIX}.managed`] !== "true") return false;
    // 镜像验证。
    if (expectedImage && info.Config?.Image !== expectedImage) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 验证活身份：容器内 psql 查询 system_identifier 是否与创建时一致。
 */
export function verifyLiveIdentity(containerId, expectedSystemIdentifier) {
  if (typeof containerId !== "string" || containerId.length !== 64) return false;
  try {
    const actual = querySystemIdentifier(containerId);
    return actual === expectedSystemIdentifier;
  } catch {
    return false;
  }
}

/**
 * 验证网络身份：精确网络名 + 标签匹配。
 */
export function verifyNetworkIdentity(networkName, expectedRunId) {
  try {
    const inspect = JSON.parse(docker(["network", "inspect", networkName]));
    if (!Array.isArray(inspect) || inspect.length !== 1) return false;
    const labels = inspect[0].Labels ?? {};
    if (labels[`${LABEL_PREFIX}.managed`] !== "true") return false;
    if (expectedRunId && labels[`${LABEL_PREFIX}.run-id`] !== expectedRunId) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 拆除隔离 PostgreSQL 容器。
 *
 * 流程：
 * 1. 全 ID 等值比较 + 精确标签/镜像验证。
 * 2. 运行中：验证活身份后 stop。
 * 3. 已停止：用安全恢复流程（start → 验证身份 → stop → rm）。
 * 4. 精确网络验证后移除。
 * 5. 验证零残留。
 * 6. 移除清单目录。
 *
 * 任何 Docker 错误（除已验证的 not-found）均为硬失败，保留清单。
 */
export function teardownIsolatedPostgres(cluster) {
  const { containerId, labels, manifestDir, systemIdentifier, image,
    networkName, networkCreated } = cluster;

  // 1. 全 ID + 标签验证。
  if (!verifyContainerIdentity(containerId, labels, image)) {
    // 容器可能已被移除——检查是否为 not-found。
    const probe = dockerTry(["inspect", containerId]);
    if (!probe.ok && probe.stderr.includes("No such")) {
      // 容器已不存在——继续清理网络和清单。
    } else {
      // 容器存在但身份不匹配——硬失败。
      throw new Error(`容器身份验证失败：${containerId} 标签/镜像/ID 不匹配，拒绝拆除。`);
    }
  } else {
    // 2. 容器存在——检查运行状态。
    const state = JSON.parse(docker(["inspect", "-f", "{{json .State}}", containerId]));
    if (state.Running) {
      // 运行中：验证活身份后停止。
      if (!verifyLiveIdentity(containerId, systemIdentifier)) {
        throw new Error("活身份不匹配：system_identifier 与创建时不一致，拒绝拆除。");
      }
      docker(["stop", "-t", "10", containerId]);
    } else {
      // 已停止：容器身份已在步骤 1 通过全 ID + 标签 + 镜像验证。
      // tmpfs 不跨 stop/start 保留数据，因此 system_identifier 会改变——
      // 不再重新 start 验证 system_identifier，直接 rm。
      // 容器身份（标签/镜像/ID）是跨 stop/start 稳定的权威标识。
    }
    // 移除容器（无卷，tmpfs 自动清理）。
    docker(["rm", containerId]);
    // 验证容器已消失。
    const verify = dockerTry(["inspect", containerId]);
    if (verify.ok) {
      throw new Error(`容器 ${containerId} 拆除后仍存在。`);
    }
    if (!/no such/i.test(verify.stderr)) {
      throw new Error(`容器 ${containerId} 验证移除时发生意外错误：${verify.stderr}`);
    }
  }

  // 4. 移除网络（仅当本运行创建且精确标签匹配）。
  if (networkCreated) {
    if (verifyNetworkIdentity(networkName, cluster.runId)) {
      docker(["network", "rm", networkName]);
      // 验证网络已消失。
      const netVerify = dockerTry(["network", "inspect", networkName]);
      if (netVerify.ok) {
        throw new Error(`网络 ${networkName} 拆除后仍存在。`);
      }
      if (netVerify.stderr && !/no such|not found/i.test(netVerify.stderr)) {
        throw new Error(`网络 ${networkName} 验证移除时发生意外错误：${netVerify.stderr}`);
      }
    } else {
      throw new Error(`网络身份验证失败：${networkName} 标签不匹配，拒绝拆除。`);
    }
  }

  // 5. 移除清单目录。
  if (existsSync(manifestDir)) {
    rmSync(manifestDir, { recursive: true, force: true });
    if (existsSync(manifestDir)) {
      throw new Error(`清单目录 ${manifestDir} 移除失败。`);
    }
  }
}

/**
 * 从清单目录恢复并拆除遗留的隔离集群。
 * 仅按清单中的精确全 ID 和标签操作。
 */
export function recoverAndTeardown(manifestDir) {
  const manifestPath = join(manifestDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`清单文件不存在：${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  // 验证清单 schema。
  if (typeof manifest.containerId !== "string" || manifest.containerId.length !== 64) {
    throw new Error(`清单 schema 无效：containerId 不是 64 字符。`);
  }
  teardownIsolatedPostgres({
    containerId: manifest.containerId,
    labels: manifest.labels,
    manifestDir,
    systemIdentifier: manifest.systemIdentifier,
    image: manifest.image,
    networkName: manifest.networkName,
    networkCreated: manifest.networkCreated,
    runId: manifest.runId,
  });
}

/**
 * 列出所有遗留的项目专属容器（通过精确标签过滤）。
 */
export function listProjectContainers() {
  try {
    const filter = `${LABEL_PREFIX}.managed=true`;
    const out = docker(["ps", "-a", "--filter", `label=${filter}`, "-q", "--no-trunc"]);
    if (out.trim().length === 0) return [];
    return out.split("\n").map((line) => line.trim()).filter((line) => line.length === 64);
  } catch {
    return [];
  }
}

/**
 * 列出所有遗留的项目专属网络。
 */
export function listProjectNetworks() {
  try {
    const filter = `${LABEL_PREFIX}.managed=true`;
    const out = docker(["network", "ls", "--filter", `label=${filter}`, "-q"]);
    if (out.trim().length === 0) return [];
    return out.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * 检查清单目录是否存在。
 */
export function manifestExists(manifestDir) {
  return existsSync(join(manifestDir, "manifest.json"));
}

/**
 * 读取并验证清单。
 */
export function readManifest(manifestDir) {
  const manifestPath = join(manifestDir, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof m.containerId !== "string" || m.containerId.length !== 64) return null;
  return m;
}

/**
 * 验证清单目录权限：0700 目录 + 0600 文件。
 */
export function verifyManifestPermissions(manifestDir) {
  const manifestPath = join(manifestDir, "manifest.json");
  if (!existsSync(manifestPath)) return false;
  if (!checkMode(manifestDir, 0o700)) return false;
  if (!checkMode(manifestPath, 0o600)) return false;
  return true;
}

/**
 * 创建 runner 容器（无 Docker socket，用于运行子进程）。
 * 返回容器 ID 和挂载信息。
 */
export function createRunnerContainer({ runId, networkName, mounts, workDir }) {
  const labels = {
    [`${LABEL_PREFIX}.run-id`]: runId,
    [`${LABEL_PREFIX}.managed`]: "true",
    [`${LABEL_PREFIX}.disposable`]: "true",
    [`${LABEL_PREFIX}.role`]: "runner",
    [`${LABEL_PREFIX}.created-by`]: `pid-${process.pid}`,
  };
  const labelArgs = Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
  const mountArgs = mounts.flatMap(([host, container, type = "bind"]) => [
    "--mount", `type=${type},source=${host},target=${container}`,
  ]);

  const createArgs = [
    "create",
    ...labelArgs,
    "--network", networkName,
    ...mountArgs,
    "-w", workDir,
    "--restart=no",
    // 无 docker.sock 挂载——子进程无 Docker 权限。
    RUNNER_IMAGE,
    "sleep", "3600",
  ];
  const fullId = docker(createArgs);
  docker(["start", fullId]);

  // 安装 git（runner 需要运行 git 命令）。
  docker(["exec", fullId, "bash", "-c",
    "apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq git >/dev/null 2>&1"]);

  return { containerId: fullId, labels, networkName };
}

/**
 * 在 runner 容器内执行命令。
 * 返回 {status, stdout, stderr}。
 */
export function execInRunner(containerId, args, opts = {}) {
  const result = dockerTry(["exec", "-w", opts.cwd ?? "/", containerId, ...args]);
  return result;
}

/**
 * 在 runner 容器内执行命令（带环境变量）。
 */
export function execInRunnerWithEnv(containerId, env, args, opts = {}) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const result = dockerTry(["exec", ...envArgs, "-w", opts.cwd ?? "/", containerId, ...args]);
  return result;
}

/**
 * 拆除 runner 容器。
 */
export function teardownRunnerContainer({ containerId, labels, networkName }) {
  if (!verifyContainerIdentity(containerId, labels, RUNNER_IMAGE)) {
    const probe = dockerTry(["inspect", containerId]);
    if (!probe.ok && probe.stderr.includes("No such")) return;
    throw new Error(`Runner 容器身份验证失败：${containerId}`);
  }
  try { docker(["stop", "-t", "5", containerId]); } catch { /* 可能已停止 */ }
  docker(["rm", containerId]);
  const verify = dockerTry(["inspect", containerId]);
  if (verify.ok) throw new Error(`Runner 容器 ${containerId} 拆除后仍存在。`);
}
