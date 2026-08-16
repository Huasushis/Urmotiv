// Phase-2 验收 Gate9 一次性 PostgreSQL 集群隔离。
//
// 设计目标（Sol HOLD 修复 A 重做）：
// 不再用子进程可写的登记册/HMAC 作为删除归属权凭据。取而代之，
// 父进程独占创建一个项目专属的、一次性的 Docker PostgreSQL 17 容器，
// 子进程只拿到这个隔离集群的连接参数——无法接触任何共享/正式集群。
// 容器有随机凭据、随机回环端口、唯一标签，仅绑定 127.0.0.1。
// 清理时只按精确容器 ID + 标签停止/移除该容器及其卷，绝不模式删除。
//
// 安全保证：
// 1. 子进程只有隔离集群的 host/port/user/password/database，没有共享集群凭据。
// 2. 集群内任何数据库操作都被物理限制在一次性容器内。
// 3. 拆除只验证精确容器 ID 和标签后执行，绝不按名称模式删除。
// 4. 拆除不完整时保留私有清单供恢复；恢复只按清单中的精确 ID/标签操作。
// 5. 成功拆除后不留任何项目专属容器/卷/进程残留。
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const nodeRequire = createRequire(import.meta.url);

const PG_IMAGE = "docker.m.daocloud.io/library/postgres:17-alpine";
const LABEL_PREFIX = "urmotiv.gate9";
const MANIFEST_PREFIX = "urmotiv-gate9-cluster-";

/**
 * 生成随机密码（base64url，PostgreSQL 接受）。
 * @returns {string}
 */
function randomPassword() {
  return randomBytes(24).toString("base64url").slice(0, 32);
}

/**
 * 获取一个可用的随机回环端口（OS 分配后立即释放）。
 * @returns {number}
 */
function randomLoopbackPort() {
  // Node 的 net.listen 是异步的——用 execFileSync 同步获取一个 OS 分配的端口。
  const port = execFileSync("node", ["-e", `
    const net = require("node:net");
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      console.log(s.address().port);
      s.close();
    });
  `], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return parseInt(port, 10);
}

/**
 * 同步执行 docker 命令，返回 stdout（trim）。
 * @param {string[]} args
 * @returns {string}
 */
function docker(args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * 同步查询 PostgreSQL system_identifier。
 * 通过 docker exec 在容器内运行 psql，避免依赖宿主机 psql 或异步 pg。
 *
 * @param {string} containerId
 * @returns {string}
 */
function querySystemIdentifier(containerId) {
  const out = docker([
    "exec", containerId,
    "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c",
    "select system_identifier from pg_control_system()",
  ]);
  return out.trim();
}

/**
 * 同步查询活身份：system_identifier + inet_server_addr + inet_server_port。
 *
 * @param {string} containerId
 * @returns {string}
 */
function queryLiveIdentity(containerId) {
  const out = docker([
    "exec", containerId,
    "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c",
    "select system_identifier || ':' || inet_server_addr() || ':' || inet_server_port() || ':' || current_user || ':' || current_database() from pg_control_system()",
  ]);
  return out.trim();
}

/**
 * 等待 PostgreSQL 就绪。
 * @param {string} containerId
 * @param {number} timeoutMs
 */
function waitForPostgresReady(containerId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const out = docker([
        "exec", containerId,
        "pg_isready", "-U", "postgres", "-d", "postgres",
      ]);
      if (out.includes("accepting connections")) return;
    } catch {
      // 容器可能还在启动。
    }
    sleep(500);
  }
  throw new Error(`隔离 PostgreSQL 容器 ${containerId} 在 ${timeoutMs}ms 内未就绪。`);
}

function sleep(ms) {
  execFileSync("sleep", [`${ms / 1000}`], { stdio: "ignore" });
}

/**
 * 创建一个一次性隔离 PostgreSQL 17 容器。
 * 仅绑定 127.0.0.1，随机端口/凭据/标签，私有 0700 状态目录。
 *
 * @param {object} [opts]
 * @param {string} [opts.runId] - 可选运行标识（用于标签）
 * @returns {{
 *   containerId: string,
 *   host: string,
 *   port: number,
 *   user: string,
 *   password: string,
 *   database: string,
 *   adminUrl: string,
 *   labels: Record<string, string>,
 *   manifestDir: string,
 *   systemIdentifier: string,
 * }}
 */
export function createIsolatedPostgres(opts = {}) {
  const runId = opts.runId ?? randomUUID().replaceAll("-", "").slice(0, 16);
  const labels = {
    [`${LABEL_PREFIX}.run-id`]: runId,
    [`${LABEL_PREFIX}.managed`]: "true",
    [`${LABEL_PREFIX}.disposable`]: "true",
    [`${LABEL_PREFIX}.created-by`]: `pid-${process.pid}`,
  };
  const labelArgs = Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]);

  const password = randomPassword();
  const user = "postgres";
  const database = "postgres";
  const port = randomLoopbackPort();

  // 创建容器（不使用 --rm，由我们显式管理拆除）。
  const createArgs = [
    "create",
    ...labelArgs,
    "-e", `POSTGRES_PASSWORD=${password}`,
    "-e", `POSTGRES_USER=${user}`,
    "-e", `POSTGRES_DB=${database}`,
    "-p", `127.0.0.1:${port}:5432`,
    "--restart=no",
    PG_IMAGE,
  ];
  const containerId = docker(createArgs);

  // 启动容器。
  docker(["start", containerId]);

  // 等待 PostgreSQL 就绪。
  waitForPostgresReady(containerId, 60_000);

  // 采集集群 system_identifier（用于活身份验证）。
  const systemIdentifier = querySystemIdentifier(containerId);

  // 构建连接 URL。
  const adminUrl = `postgres://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;

  // 创建私有 0700 状态目录和清单文件（用于崩溃恢复）。
  const manifestDir = join(tmpdir(), `${MANIFEST_PREFIX}${runId}`);
  mkdirSync(manifestDir, { recursive: true, mode: 0o700 });
  chmodSync(manifestDir, 0o700);
  const manifest = {
    containerId,
    runId,
    host: "127.0.0.1",
    port,
    user,
    database,
    labels,
    systemIdentifier,
    createdAt: new Date().toISOString(),
    pid: process.pid,
  };
  const manifestPath = join(manifestDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  chmodSync(manifestPath, 0o600);

  return {
    containerId,
    host: "127.0.0.1",
    port,
    user,
    password,
    database,
    adminUrl,
    labels,
    manifestDir,
    systemIdentifier,
  };
}

/**
 * 验证容器身份：容器 ID 存在且标签匹配。
 * @param {string} containerId
 * @param {Record<string, string>} expectedLabels
 * @returns {boolean}
 */
export function verifyContainerIdentity(containerId, expectedLabels) {
  try {
    const inspect = JSON.parse(docker(["inspect", containerId]));
    if (!Array.isArray(inspect) || inspect.length === 0) return false;
    const info = inspect[0];
    const actualLabels = info.Config?.Labels ?? {};
    for (const [key, value] of Object.entries(expectedLabels)) {
      if (actualLabels[key] !== value) return false;
    }
    if (actualLabels[`${LABEL_PREFIX}.managed`] !== "true") return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 验证活身份：容器内 psql 查询 system_identifier 是否与创建时一致。
 * @param {string} containerId
 * @param {string} expectedSystemIdentifier
 * @returns {boolean}
 */
export function verifyLiveIdentity(containerId, expectedSystemIdentifier) {
  try {
    const actual = querySystemIdentifier(containerId);
    return actual === expectedSystemIdentifier;
  } catch {
    return false;
  }
}

/**
 * 拆除隔离 PostgreSQL 容器。
 * 先验证容器身份（精确 ID + 标签）和活身份，然后 stop + rm。
 * 拆除成功后移除清单目录。拆除失败时保留清单供恢复。
 *
 * @param {object} cluster
 * @param {string} cluster.containerId
 * @param {Record<string, string>} cluster.labels
 * @param {string} cluster.manifestDir
 * @param {string} cluster.systemIdentifier
 */
export function teardownIsolatedPostgres({ containerId, labels, manifestDir, systemIdentifier }) {
  // 1. 验证容器身份（精确 ID + 标签）。
  if (!verifyContainerIdentity(containerId, labels)) {
    throw new Error(`容器身份验证失败：${containerId} 标签不匹配，拒绝拆除。`);
  }
  // 2. 验证活身份（如果容器还在运行）。
  try {
    const state = JSON.parse(docker(["inspect", containerId]))[0]?.State;
    if (state?.Running) {
      if (!verifyLiveIdentity(containerId, systemIdentifier)) {
        throw new Error("活身份不匹配：system_identifier 与创建时不一致，拒绝拆除。");
      }
    }
  } catch (error) {
    if (error.message.includes("活身份")) throw error;
    // 容器可能已停止——继续 rm。
  }
  // 3. 停止容器（10s 宽限）。
  try {
    docker(["stop", "-t", "10", containerId]);
  } catch {
    // 可能已停止。
  }
  // 4. 移除容器（含 --volumes 清理匿名卷）。
  try {
    docker(["rm", "-v", containerId]);
  } catch {
    // 可能已被移除。
  }
  // 5. 验证容器已消失。
  try {
    docker(["inspect", containerId]);
    throw new Error(`容器 ${containerId} 拆除后仍存在。`);
  } catch (error) {
    if (error.message.includes("仍存在")) throw error;
    // inspect 失败说明容器已移除——正确。
  }
  // 6. 移除清单目录。
  if (existsSync(manifestDir)) {
    rmSync(manifestDir, { recursive: true, force: true });
    if (existsSync(manifestDir)) {
      throw new Error(`清单目录 ${manifestDir} 移除失败。`);
    }
  }
}

/**
 * 从清单目录恢复并拆除遗留的隔离集群。
 * 仅按清单中的精确容器 ID 和标签操作，绝不模式删除。
 *
 * @param {string} manifestDir
 */
export function recoverAndTeardown(manifestDir) {
  const manifestPath = join(manifestDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`清单文件不存在：${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  teardownIsolatedPostgres({
    containerId: manifest.containerId,
    labels: manifest.labels,
    manifestDir,
    systemIdentifier: manifest.systemIdentifier,
  });
}

/**
 * 列出所有遗留的项目专属容器（通过标签过滤）。
 * @returns {string[]}
 */
export function listProjectContainers() {
  try {
    const filter = `${LABEL_PREFIX}.managed=true`;
    const out = docker(["ps", "-a", "--filter", `label=${filter}`, "-q"]);
    if (out.trim().length === 0) return [];
    return out.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * 检查清单目录是否存在（用于检测不完整拆除）。
 * @param {string} manifestDir
 * @returns {boolean}
 */
export function manifestExists(manifestDir) {
  return existsSync(join(manifestDir, "manifest.json"));
}

/**
 * 查询容器内的活身份字符串（用于测试断言）。
 * @param {string} containerId
 * @returns {string}
 */
export function getLiveIdentity(containerId) {
  return queryLiveIdentity(containerId);
}
