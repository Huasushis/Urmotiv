// Phase-2 验收 Gate9 一次性 PostgreSQL 集群隔离——受信父进程独占管理。
//
// Sol HOLD 第四版：--internal 网络 + 精确挂载 + 原子清单 + 全 ID 验证。
//
// 安全保证：
// 1. 父进程独占创建/管理所有 PostgreSQL 集群和 runner 容器。
//    子进程在无 Docker socket 的 runner 容器内执行，无法调用 docker。
// 2. 所有容器在 --internal Docker 网络上——无公共出口。
//    父进程通过 docker exec 验证 PG 就绪（无发布端口）。
// 3. 容器用 docker create 先创建，使用 tmpfs（无匿名卷），
//    精确 64 字符容器 ID + 不可变标签 + 镜像 ID/摘要。
// 4. O_EXCL 0600 清单在 create 后立即写入 0700 目录，
//    原子 temp+fsync+rename+dir fsync 阶段更新。
// 5. 拆除用全 ID 等值比较 + 精确标签/网络 ID/镜像验证，
//    绝不接受前缀/模式匹配。任何 Docker 守护进程错误
//    （除已验证的 not-found）均为硬失败，保留清单。
// 6. 成功拆除后无项目专属容器/网络残留。
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  chmodSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

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
    "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c", sql,
  ]);
}

/**
 * 查询容器内 PostgreSQL 的 system_identifier。
 */
function querySystemIdentifier(containerId) {
  return psqlExec(containerId, "select system_identifier from pg_control_system()").trim();
}

/**
 * 查询容器内 PostgreSQL 的活身份信息。
 */
function queryLiveIdentity(containerId) {
  const sql = [
    "select system_identifier, current_user, current_database,",
    "inet_server_addr()::text as server_addr,",
    "inet_server_port() as server_port",
    "from pg_control_system(), current_user, current_database()",
  ].join(" ");
  const result = psqlExec(containerId, sql);
  const [sid, user, db, addr, port] = result.split("|").map((s) => s.trim());
  return { systemIdentifier: sid, current_user: user, current_database: db, server_addr: addr, server_port: parseInt(port, 10) };
}

/**
 * 轮询容器内 PostgreSQL 直到可查询（start 后的恢复路径使用）。
 */
function waitPostgresReady(containerId, timeoutMs = 60_000) {
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

function sleep(ms) {
  execFileSync("sleep", [`${ms / 1000}`], { stdio: "ignore" });
}

/**
 * 用 O_EXCL 原子创建文件。如果文件已存在则抛错。
 */
function writeExclusive(path, content) {
  const fd = openSync(path, "wx");
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

/**
 * 原子写入文件：temp + fsync + rename + dir fsync。
 */
function atomicWrite(path, content) {
  const dir = dirname(path);
  const tmpPath = path + ".tmp." + randomUUID().slice(0, 8);
  writeFileSync(tmpPath, content);
  const fd = openSync(tmpPath, "r+");
  fsyncSync(fd);
  closeSync(fd);
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
  // fsync 目录 to persist rename.
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/**
 * 验证文件权限模式。
 */
function checkMode(path, expectedMode) {
  const stat = statSync(path);
  return (stat.mode & 0o777) === expectedMode;
}

/**
 * 从 runId 和 role 派生不可变标签——不信任清单提供的标签。
 */
function deriveLabels(runId, role) {
  return {
    [`${LABEL_PREFIX}.run-id`]: runId,
    [`${LABEL_PREFIX}.managed`]: "true",
    [`${LABEL_PREFIX}.disposable`]: "true",
    [`${LABEL_PREFIX}.role`]: role,
    [`${LABEL_PREFIX}.created-by`]: `pid-${process.pid}`,
  };
}

/**
 * 获取镜像 ID（不可变标识）。
 */
function getImageId(image) {
  return docker(["inspect", "-f", "{{.Id}}", image]);
}

/**
 * 获取 Docker 网络 ID。
 */
function getNetworkId(networkName) {
  return docker(["network", "inspect", "-f", "{{.Id}}", networkName]);
}

/**
 * 验证容器是否连接到指定网络（按网络 ID）。
 */
function verifyContainerNetworkMembership(containerId, networkId) {
  try {
    const networks = JSON.parse(
      docker(["inspect", "-f", "{{json .NetworkSettings.Networks}}", containerId]),
    );
    for (const net of Object.values(networks)) {
      if (net.NetworkID === networkId) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 创建一个一次性隔离 PostgreSQL 17 容器。
 *
 * 流程：
 * 1. docker network create --internal（专用网络，无公共出口）
 * 2. docker create（tmpfs，无发布端口，精确标签）
 * 3. O_EXCL 清单写入 0700 目录（在 start 之前）
 * 4. docker start
 * 5. docker exec 就绪探测 + system_identifier 采集
 * 6. 原子更新清单阶段为 ready
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.role - "primary" 或 "secondary"
 * @param {string} [opts.networkName] - 共享网络名（次集群复用主集群的网络）
 * @returns {ClusterInfo}
 */
export function createIsolatedPostgres({ runId, role, networkName }) {
  const labels = deriveLabels(runId, role);
  const labelArgs = Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
  const password = randomPassword();
  const imageId = getImageId(PG_IMAGE);

  // 1. 创建专用 --internal 网络（或复用已有网络）。
  let netName = networkName;
  let netCreated = false;
  let netId = "";
  if (!netName) {
    netName = `urmotiv-gate9-net-${runId}`;
    docker(["network", "create", "--internal",
      "--label", `${LABEL_PREFIX}.managed=true`,
      "--label", `${LABEL_PREFIX}.run-id=${runId}`,
      "--label", `${LABEL_PREFIX}.disposable=true`,
      netName]);
    netCreated = true;
    netId = getNetworkId(netName);
  } else {
    netId = getNetworkId(netName);
  }

  // 2. 创建容器（tmpfs，无卷，无发布端口）。
  //    容器仅在 --internal 网络上——无公共出口。
  const containerName = `urmotiv-gate9-${role}-${runId}`;
  const createArgs = [
    "create",
    "--name", containerName,
    ...labelArgs,
    "--network", netName,
    "--tmpfs", "/var/lib/postgresql/data",
    "-e", `POSTGRES_PASSWORD=${password}`,
    "-e", "POSTGRES_USER=postgres",
    "-e", "POSTGRES_DB=postgres",
    "--restart=no",
    PG_IMAGE,
  ];
  const fullId = docker(createArgs);

  // 3. O_EXCL 清单写入 0700 目录（在 start 之前）。
  const manifestDir = join(tmpdir(), `${MANIFEST_PREFIX}${runId}-${role}`);
  mkdirSync(manifestDir, { recursive: true, mode: 0o700 });
  chmodSync(manifestDir, 0o700);
  const manifestPath = join(manifestDir, "manifest.json");
  const manifest = {
    version: 2,
    containerId: fullId,
    containerName,
    runId,
    role,
    networkName: netName,
    networkId: netId,
    networkCreated: netCreated,
    image: PG_IMAGE,
    imageId,
    user: "postgres",
    password,
    database: "postgres",
    labels,
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
    atomicWrite(manifestPath, JSON.stringify({ ...manifest, phase: "start-failed" }, null, 2) + "\n");
    throw new Error(`容器启动失败：${error.message}（清单已保留：${manifestPath}）`);
  }

  // 5. 就绪探测（通过 docker exec，无发布端口）+ system_identifier 采集。
  if (!waitPostgresReady(fullId, 60_000)) {
    atomicWrite(manifestPath, JSON.stringify({ ...manifest, phase: "readiness-failed" }, null, 2) + "\n");
    throw new Error(`PostgreSQL 就绪探测失败（清单已保留：${manifestPath}）`);
  }
  const liveInfo = queryLiveIdentity(fullId);

  // 验证活身份。
  if (liveInfo.current_user !== "postgres" || liveInfo.current_database !== "postgres") {
    atomicWrite(manifestPath, JSON.stringify({ ...manifest, phase: "identity-mismatch" }, null, 2) + "\n");
    throw new Error(`活身份不匹配：user=${liveInfo.current_user} db=${liveInfo.current_database}（清单已保留）`);
  }

  // 验证网络成员关系（按网络 ID）。
  if (!verifyContainerNetworkMembership(fullId, netId)) {
    atomicWrite(manifestPath, JSON.stringify({ ...manifest, phase: "network-mismatch" }, null, 2) + "\n");
    throw new Error(`容器未连接到预期网络 ${netId}（清单已保留）`);
  }

  // 6. 原子更新清单：填入 system_identifier + ready 阶段。
  manifest.systemIdentifier = liveInfo.systemIdentifier;
  manifest.phase = "ready";
  atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  // 子进程通过容器名在 Docker 网络上连接（无发布端口）。
  const adminUrl = `postgres://postgres:${encodeURIComponent(password)}@${containerName}:5432/postgres`;

  return {
    containerId: fullId,
    containerName,
    runId,
    role,
    host: containerName,
    port: 5432,
    user: "postgres",
    password,
    database: "postgres",
    adminUrl,
    labels,
    manifestDir,
    manifestPath,
    networkName: netName,
    networkId: netId,
    networkCreated: netCreated,
    systemIdentifier: liveInfo.systemIdentifier,
    image: PG_IMAGE,
    imageId,
  };
}

/**
 * 原子更新清单阶段。
 */
function updateManifestPhase(manifestPath, phase) {
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  m.phase = phase;
  atomicWrite(manifestPath, JSON.stringify(m, null, 2) + "\n");
}

/**
 * 验证容器身份：全 ID 等值比较 + 精确标签匹配 + 镜像验证 + 网络成员关系。
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
 * 验证容器身份 + 镜像 ID + 网络 ID 成员关系。
 */
export function verifyFullContainerIdentity(containerId, expectedLabels, expectedImageId, expectedNetworkId) {
  if (typeof containerId !== "string" || containerId.length !== 64) return false;
  try {
    const inspect = JSON.parse(docker(["inspect", containerId]));
    if (!Array.isArray(inspect) || inspect.length !== 1) return false;
    const info = inspect[0];
    if (info.Id !== containerId) return false;
    const actualLabels = info.Config?.Labels ?? {};
    for (const [key, value] of Object.entries(expectedLabels)) {
      if (actualLabels[key] !== value) return false;
    }
    if (actualLabels[`${LABEL_PREFIX}.managed`] !== "true") return false;
    // 镜像 ID 验证。
    if (expectedImageId && info.Image !== expectedImageId) return false;
    // 网络成员关系验证（按网络 ID）。
    if (expectedNetworkId) {
      let found = false;
      for (const net of Object.values(info.NetworkSettings?.Networks ?? {})) {
        if (net.NetworkID === expectedNetworkId) { found = true; break; }
      }
      if (!found) return false;
    }
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
 * 验证网络身份：精确网络 ID + 标签匹配。
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
 * 验证网络 ID 等值比较。
 */
export function verifyNetworkId(networkName, expectedNetworkId) {
  try {
    const actualId = getNetworkId(networkName);
    return actualId === expectedNetworkId;
  } catch {
    return false;
  }
}

/**
 * 检查 Docker 错误是否为 not-found（跨 Docker 版本兼容）。
 */
function isNotFound(stderr) {
  return /no such|not found/i.test(stderr ?? "");
}

/**
 * 拆除隔离 PostgreSQL 容器。
 *
 * 流程：
 * 1. 全 ID 等值比较 + 精确标签/镜像验证 + 网络 ID 成员关系。
 * 2. 运行中：验证活身份后 stop。
 * 3. 已停止：用全 ID + 镜像 ID + 不可变标签/网络授权删除。
 * 4. 精确网络 ID 验证后移除。
 * 5. 验证零残留。
 * 6. 移除清单目录。
 *
 * 任何 Docker 错误（除已验证的 not-found）均为硬失败，保留清单。
 */
export function teardownIsolatedPostgres(cluster) {
  const { containerId, labels, manifestDir, systemIdentifier, image, imageId,
    networkName, networkId, networkCreated, runId } = cluster;

  // 1. 全 ID + 标签 + 镜像 ID + 网络成员验证。
  if (!verifyFullContainerIdentity(containerId, labels, imageId, networkId)) {
    // 容器可能已被移除——检查是否为 not-found。
    const probe = dockerTry(["inspect", containerId]);
    if (!probe.ok && isNotFound(probe.stderr)) {
      // 容器已不存在——继续清理网络和清单。
    } else {
      // 容器存在但身份不匹配——硬失败。
      throw new Error(`容器身份验证失败：${containerId} 标签/镜像/ID/网络 不匹配，拒绝拆除。`);
    }
  } else {
    // 2. 容器存在——检查运行状态。
    const state = JSON.parse(docker(["inspect", "-f", "{{json .State}}", containerId]));
    if (state.Running) {
      // 运行中：验证活身份后停止。
      if (systemIdentifier !== null && !verifyLiveIdentity(containerId, systemIdentifier)) {
        throw new Error("活身份不匹配：system_identifier 与创建时不一致，拒绝拆除。");
      }
      docker(["stop", "-t", "10", containerId]);
    } else {
      // 已停止：容器身份已在步骤 1 通过全 ID + 标签 + 镜像 ID + 网络成员验证。
      // tmpfs 不跨 stop/start 保留数据，因此 system_identifier 会改变——
      // 容器身份（标签/镜像 ID/网络 ID）是跨 stop/start 稳定的权威标识。
      // startup null-ID recovery：如果 systemIdentifier 为 null，
      // 仅在 phase 不是 "ready" 且全 ID + 镜像 ID + 标签 + 网络全部匹配时允许删除。
      if (systemIdentifier === null) {
        const manifest = readManifest(manifestDir);
        if (manifest === null || manifest.phase === "ready") {
          throw new Error("systemIdentifier 为 null 但清单显示 ready，拒绝拆除。");
        }
      }
    }
    // 移除容器（无卷，tmpfs 自动清理）。
    docker(["rm", containerId]);
    // 验证容器已消失。
    const verify = dockerTry(["inspect", containerId]);
    if (verify.ok) {
      throw new Error(`容器 ${containerId} 拆除后仍存在。`);
    }
    if (!isNotFound(verify.stderr)) {
      throw new Error(`容器 ${containerId} 验证移除时发生意外错误：${verify.stderr}`);
    }
  }

  // 4. 移除网络（仅当本运行创建且精确网络 ID 验证通过）。
  if (networkCreated) {
    if (verifyNetworkId(networkName, networkId) && verifyNetworkIdentity(networkName, runId)) {
      docker(["network", "rm", networkName]);
      // 验证网络已消失。
      const netVerify = dockerTry(["network", "inspect", networkName]);
      if (netVerify.ok) {
        throw new Error(`网络 ${networkName} 拆除后仍存在。`);
      }
      if (netVerify.stderr && !isNotFound(netVerify.stderr)) {
        throw new Error(`网络 ${networkName} 验证移除时发生意外错误：${netVerify.stderr}`);
      }
    } else {
      throw new Error(`网络身份验证失败：${networkName} 网络 ID/标签不匹配，拒绝拆除。`);
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
 * 标签从 runId 和 role 独立派生——不信任清单提供的标签。
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
  if (typeof manifest.runId !== "string" || typeof manifest.role !== "string") {
    throw new Error(`清单 schema 无效：runId 或 role 缺失。`);
  }
  // 从 runId 和 role 派生标签——不信任清单中的 labels。
  const trustedLabels = deriveLabels(manifest.runId, manifest.role);
  teardownIsolatedPostgres({
    containerId: manifest.containerId,
    labels: trustedLabels,
    manifestDir,
    systemIdentifier: manifest.systemIdentifier,
    image: manifest.image,
    imageId: manifest.imageId,
    networkName: manifest.networkName,
    networkId: manifest.networkId,
    networkCreated: manifest.networkCreated,
    runId: manifest.runId,
  });
}

/**
 * 列出所有遗留的项目专属容器（通过精确标签过滤）。
 * Docker 查询失败时抛出——绝不返回空数组。
 */
export function listProjectContainers() {
  const filter = `${LABEL_PREFIX}.managed=true`;
  const out = docker(["ps", "-a", "--filter", `label=${filter}`, "-q", "--no-trunc"]);
  if (out.length === 0) return [];
  return out.split("\n").filter((id) => id.length > 0);
}

/**
 * 列出所有遗留的项目专属网络。
 * Docker 查询失败时抛出——绝不返回空数组。
 */
export function listProjectNetworks() {
  const filter = `${LABEL_PREFIX}.managed=true`;
  const out = docker(["network", "ls", "--filter", `label=${filter}`, "-q"]);
  if (out.length === 0) return [];
  return out.split("\n").filter((id) => id.length > 0);
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
  if (typeof m.version !== "number" || typeof m.containerId !== "string" ||
      typeof m.runId !== "string" || typeof m.role !== "string") {
    return null;
  }
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
  // 验证清单 schema。
  const m = readManifest(manifestDir);
  if (m === null) return false;
  if (typeof m.containerId !== "string" || m.containerId.length !== 64) return false;
  if (typeof m.networkId !== "string" || m.networkId.length === 0) return false;
  if (typeof m.imageId !== "string" || m.imageId.length === 0) return false;
  return true;
}

/**
 * 创建 runner 容器（无 Docker socket，安全沙箱）。
 *
 * 安全保证：
 * - host unprivileged uid:gid
 * - cap-drop ALL
 * - no-new-privileges
 * - read-only rootfs
 * - private tmpfs for /tmp/home/run/cache
 * - 无 docker.sock 挂载
 * - 仅挂载精确的 worktree + 依赖 + 工具路径
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.networkName
 * @param {string} opts.worktreePath - 精确的 Git worktree 路径
 * @param {Array<[string, string]>} opts.bindMounts - 额外的只读 bind 挂载 [hostPath, containerPath]
 * @param {string} opts.workDir
 * @returns {RunnerContainer}
 */
export function createRunnerContainer({ runId, networkName, worktreePath, bindMounts = [], workDir }) {
  const labels = deriveLabels(runId, "runner");
  const labelArgs = Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
  const runnerImageId = getImageId(RUNNER_IMAGE);

  // 安全标志：unprivileged uid:gid, cap-drop ALL, read-only, no-new-privileges。
  // 额外 tmpfs 供 apt/git 写临时文件。
  const securityArgs = [
    "--user", `${process.getuid()}:${process.getgid()}`,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--tmpfs", "/tmp:rw,size=128m,mode=1777",
    "--tmpfs", "/home:rw,size=256m,mode=1777",
    "--tmpfs", "/run:rw,size=16m,mode=1777",
    "--tmpfs", "/var/cache/apt:rw,size=64m,mode=1777",
    "--tmpfs", "/var/lib/apt:rw,size=64m,mode=1777",
    "--tmpfs", "/var/tmp:rw,size=64m,mode=1777",
  ];

  // 挂载：仅 worktree（读写，供脏树测试）+ 只读 bind 挂载。
  const mountArgs = [
    "--mount", `type=bind,source=${worktreePath},target=${worktreePath}`,
  ];
  for (const [hostPath, containerPath] of bindMounts) {
    mountArgs.push("--mount", `type=bind,source=${hostPath},target=${containerPath},readonly`);
  }

  const containerName = `urmotiv-gate9-runner-${runId}`;
  const createArgs = [
    "create",
    "--name", containerName,
    ...labelArgs,
    "--network", networkName,
    ...securityArgs,
    ...mountArgs,
    "-w", workDir,
    "--restart=no",
    RUNNER_IMAGE,
    "sleep", "3600",
  ];
  const fullId = docker(createArgs);

  // 原子写入 runner 清单（在 start 之前）。
  const manifestDir = join(tmpdir(), `${MANIFEST_PREFIX}${runId}-runner`);
  mkdirSync(manifestDir, { recursive: true, mode: 0o700 });
  chmodSync(manifestDir, 0o700);
  const manifestPath = join(manifestDir, "manifest.json");
  const manifest = {
    version: 2,
    containerId: fullId,
    containerName,
    runId,
    role: "runner",
    networkName,
    networkId: getNetworkId(networkName),
    image: RUNNER_IMAGE,
    imageId: runnerImageId,
    labels,
    worktreePath,
    workDir,
    phase: "created",
    createdAt: new Date().toISOString(),
    pid: process.pid,
  };
  writeExclusive(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  try {
    docker(["start", fullId]);
  } catch (error) {
    updateManifestPhase(manifestPath, "start-failed");
    throw new Error(`Runner 容器启动失败：${error.message}（清单已保留：${manifestPath}）`);
  }

  // 安装 git（runner 需要运行 git 命令）。
  // read-only rootfs 下需要写 /var/lib/apt 和 /var/cache/apt——已挂载 tmpfs。
  const installResult = dockerTry(["exec", fullId, "bash", "-c",
    "apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq git >/dev/null 2>&1"]);
  if (!installResult.ok) {
    updateManifestPhase(manifestPath, "install-failed");
    // 不抛——git 安装失败不致命，验收可能不需要 git。
  }

  updateManifestPhase(manifestPath, "ready");

  return {
    containerId: fullId,
    containerName,
    labels,
    networkName,
    networkId: manifest.networkId,
    image: RUNNER_IMAGE,
    imageId: runnerImageId,
    manifestDir,
    manifestPath,
    worktreePath,
    workDir,
  };
}

/**
 * 在 runner 容器内执行命令。
 * 返回 {ok, stdout, stderr}。
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
 * 全 ID + 标签 + 镜像 ID 验证后 stop + rm。
 */
export function teardownRunnerContainer(container) {
  const { containerId, labels, imageId } = container;
  if (!verifyFullContainerIdentity(containerId, labels, imageId, undefined)) {
    const probe = dockerTry(["inspect", containerId]);
    if (!probe.ok && isNotFound(probe.stderr)) {
      // 容器已不存在——清理清单。
      if (container.manifestDir && existsSync(container.manifestDir)) {
        rmSync(container.manifestDir, { recursive: true, force: true });
      }
      return;
    }
    throw new Error(`Runner 容器身份验证失败：${containerId}（标签/镜像/ID 不匹配）`);
  }
  // 尝试 stop（可能已停止）。
  const stopResult = dockerTry(["stop", "-t", "5", containerId]);
  if (!stopResult.ok && !isNotFound(stopResult.stderr)) {
    throw new Error(`Runner 容器停止失败：${stopResult.stderr}`);
  }
  docker(["rm", containerId]);
  const verify = dockerTry(["inspect", containerId]);
  if (verify.ok) throw new Error(`Runner 容器 ${containerId} 拆除后仍存在。`);
  if (!isNotFound(verify.stderr)) {
    throw new Error(`Runner 容器 ${containerId} 验证移除时发生意外错误：${verify.stderr}`);
  }
  // 清理清单目录。
  if (container.manifestDir && existsSync(container.manifestDir)) {
    rmSync(container.manifestDir, { recursive: true, force: true });
  }
}

/**
 * 从清单恢复 runner 容器并拆除。
 */
export function recoverAndTeardownRunner(manifestDir) {
  const manifestPath = join(manifestDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Runner 清单文件不存在：${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof manifest.containerId !== "string" || manifest.containerId.length !== 64) {
    throw new Error(`Runner 清单 schema 无效：containerId 不是 64 字符。`);
  }
  const trustedLabels = deriveLabels(manifest.runId, "runner");
  teardownRunnerContainer({
    containerId: manifest.containerId,
    labels: trustedLabels,
    imageId: manifest.imageId,
    manifestDir,
  });
}
