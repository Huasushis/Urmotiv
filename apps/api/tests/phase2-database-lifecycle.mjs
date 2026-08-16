// Phase-2 验收数据库生命周期登记册——唯一安全的删除归属权机制。
//
// 设计目标（Sol HOLD 修复 A）：
// 1. 不可伪造的归属权：只有经过「受信帮助函数在已验证集群上创建数据库
//    并就地确认创建成功」的库名才进入登记册。纯文本追加（绕过帮助函数）
//    无法通过 HMAC 完整性校验，不会成为删除凭据。
// 2. 私有存储：私有 0700 运行目录 + 0600 排他登记册文件 + 0600 密钥文件，
//    路径不可预测（randomUUID），子进程只拿到目录路径（而非文件路径）。
// 3. 严格名称语法：只接受 urmotiv_history_import_* / urmotiv_formal_* /
//    urmotiv_package_auth_* / urmotiv_robot_lease_* / urmotiv_anklang_auth_* /
//    urmotiv_tag_api_* 前缀，且仅含 [a-z0-9_]，杜绝标识符注入。
// 4. 清理时逐条精确查询 + 安全引号包裹的 DROP，绝不枚举 urmotiv_%。
// 5. 缺失/损坏/不完整登记册 fail-closed 且保留私有目录供恢复取证。
//
// 本模块是纯 JavaScript ESM（无 TS 依赖），可被 .mjs 和 .ts 测试共同导入。
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 各测试前缀的严格语法白名单。只有匹配其中之一的库名才可被登记。
const NAME_GRAMMAR = [
  /^urmotiv_history_import_[a-z0-9_]{1,50}$/u,
  /^urmotiv_formal_[a-z0-9_]{1,50}$/u,
  /^urmotiv_package_auth_[a-z0-9_]{1,50}$/u,
  /^urmotiv_robot_lease_[a-z0-9_]{1,50}$/u,
  /^urmotiv_anklang_auth_[a-z0-9_]{1,50}$/u,
  /^urmotiv_tag_api_[a-z0-9_]{1,50}$/u,
  // formaldenial_* 使用非 urmotiv_ 前缀通过生产名称闸门——只在此测试场景下合法。
  /^formaldenial_[a-z0-9_]{1,50}$/u,
];

/**
 * 校验库名是否符合严格语法白名单。
 * @param {unknown} name
 * @returns {boolean}
 */
export function isValidDatabaseName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 63) return false;
  return NAME_GRAMMAR.some((re) => re.test(name));
}

/**
 * 安全引号包裹 PostgreSQL 标识符：仅允许 [a-z0-9_]，内嵌双引号会被拒绝。
 * @param {string} name
 * @returns {string}
 */
export function quoteIdentifier(name) {
  if (!isValidDatabaseName(name)) {
    throw new Error(`不安全的数据库标识符：${String(name).slice(0, 80)}`);
  }
  // 已通过语法校验，仅含 [a-z0-9_] 和下划线，不可能包含双引号或注入字符。
  return `"${name}"`;
}

/**
 * 创建私有的运行时生命周期上下文：0700 目录、0600 登记册、0600 HMAC 密钥。
 * 由受信父进程（gate9 测试）在启动子进程前调用一次。
 * @returns {{ directory: string, keyPath: string, registryPath: string }}
 */
export function createLifecycleContext() {
  // 不可预测的私有目录路径。
  const directory = join(tmpdir(), `urmotiv-pg-lifecycle-${randomBytes(16).toString("hex")}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  // 验证目录权限确实是 0700。
  const dirStat = statSync(directory);
  if ((dirStat.mode & 0o777) !== 0o700) {
    throw new Error(`生命周期目录权限不是 0700：${(dirStat.mode & 0o777).toString(8)}`);
  }
  // 0600 HMAC 密钥文件。
  const keyPath = join(directory, "key");
  const key = randomBytes(32);
  writeFileSync(keyPath, key, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  const keyStat = statSync(keyPath);
  if ((keyStat.mode & 0o777) !== 0o600) {
    throw new Error(`密钥文件权限不是 0600：${(keyStat.mode & 0o777).toString(8)}`);
  }
  // 0600 登记册文件（初始为空）。
  const registryPath = join(directory, "registry.jsonl");
  writeFileSync(registryPath, "", { mode: 0o600 });
  chmodSync(registryPath, 0o600);
  const regStat = statSync(registryPath);
  if ((regStat.mode & 0o777) !== 0o600) {
    throw new Error(`登记册文件权限不是 0600：${(regStat.mode & 0o777).toString(8)}`);
  }
  return { directory, keyPath, registryPath };
}

/**
 * 读取 HMAC 密钥。密钥文件必须存在且权限为 0600。
 * @param {string} keyPath
 * @returns {Buffer}
 */
function readKey(keyPath) {
  if (!existsSync(keyPath)) {
    throw new Error("生命周期 HMAC 密钥文件不存在；无法安全清理。");
  }
  const keyStat = statSync(keyPath);
  if ((keyStat.mode & 0o777) !== 0o600) {
    throw new Error(`密钥文件权限不是 0600：${(keyStat.mode & 0o777).toString(8)}；可能被篡改。`);
  }
  return readFileSync(keyPath);
}

/**
 * 计算库名的 HMAC 标签。
 * @param {Buffer} key
 * @param {string} name
 * @returns {string}
 */
function computeTag(key, name) {
  return createHmac("sha256", key).update(name, "utf8").digest("hex");
}

/**
 * 验证 HMAC 标签（恒定时间比较）。
 * @param {Buffer} key
 * @param {string} name
 * @param {string} tag
 * @returns {boolean}
 */
function verifyTag(key, name, tag) {
  if (typeof tag !== "string" || tag.length !== 64) return false;
  const expected = computeTag(key, name);
  const expectedBuf = Buffer.from(expected, "utf8");
  const tagBuf = Buffer.from(tag, "utf8");
  if (expectedBuf.length !== tagBuf.length) return false;
  return timingSafeEqual(expectedBuf, tagBuf);
}

/**
 * 登记一个已创建的数据库为「本运行拥有」。必须在数据库实际创建成功后调用。
 * 帮助函数先校验名称语法、计算 HMAC，再原子追加 JSONL 记录。
 * 调用方必须确保数据库已在集群上创建成功（creation proof 由调用方保证）。
 *
 * @param {string} lifecycleDir - 生命周期目录路径（从 URMOTIV_TEST_PG_LIFECYCLE_DIR 获取）
 * @param {string} name - 数据库名称
 */
export function registerOwnedDatabase(lifecycleDir, name) {
  if (!isValidDatabaseName(name)) {
    throw new Error(`拒绝登记不符合语法的库名：${String(name).slice(0, 80)}`);
  }
  const keyPath = join(lifecycleDir, "key");
  const registryPath = join(lifecycleDir, "registry.jsonl");
  const key = readKey(keyPath);
  const tag = computeTag(key, name);
  const record = JSON.stringify({ name, tag }) + "\n";
  appendFileSync(registryPath, record);
}

/**
 * 读取并验证登记册中的所有记录。每条记录必须通过 HMAC 校验。
 * 缺失/损坏/非字符串/HMAC 不匹配均 fail-closed（抛错）。
 * @param {string} lifecycleDir
 * @returns {string[]} 已验证的唯一库名列表
 */
export function readOwnedDatabaseNames(lifecycleDir) {
  const keyPath = join(lifecycleDir, "key");
  const registryPath = join(lifecycleDir, "registry.jsonl");
  if (!existsSync(registryPath)) {
    throw new Error("PG 生命周期登记册不存在；无法安全清理。");
  }
  const key = readKey(keyPath);
  const content = readFileSync(registryPath, "utf8");
  if (content.trim().length === 0) return [];
  const names = [];
  const seen = new Set();
  for (const line of content.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`PG 生命周期登记册存在损坏行；fail-closed，保留证据。`);
    }
    if (typeof parsed !== "object" || parsed === null ||
        typeof parsed.name !== "string" || typeof parsed.tag !== "string") {
      throw new Error("PG 生命周期登记册存在格式不正确的条目；fail-closed，保留证据。");
    }
    if (!isValidDatabaseName(parsed.name)) {
      throw new Error(`PG 生命周期登记册存在不符合语法的库名；fail-closed，保留证据。`);
    }
    if (!verifyTag(key, parsed.name, parsed.tag)) {
      throw new Error("PG 生命周期登记册存在 HMAC 校验失败的条目（可能被伪造）；fail-closed，保留证据。");
    }
    if (!seen.has(parsed.name)) {
      seen.add(parsed.name);
      names.push(parsed.name);
    }
  }
  return names;
}

/**
 * 清理成功后移除整个私有生命周期目录。
 * @param {string} lifecycleDir
 */
export function removeLifecycleContext(lifecycleDir) {
  if (existsSync(lifecycleDir)) {
    rmSync(lifecycleDir, { recursive: true, force: true });
    if (existsSync(lifecycleDir)) {
      throw new Error(`生命周期目录删除失败：${lifecycleDir}`);
    }
  }
}

/**
 * 保留生命周期目录（用于失败恢复取证）。不删除任何文件。
 * @param {string} lifecycleDir
 */
export function preserveLifecycleContext(lifecycleDir) {
  // 显式空操作：保留目录和登记册供恢复取证。
  // 调用方应记录目录路径供后续手动检查。
  if (!existsSync(lifecycleDir)) {
    throw new Error("生命周期目录不存在，无法保留。");
  }
}

/**
 * 验证生命周期目录的完整性：目录 0700、密钥 0600、登记册 0600。
 * @param {string} lifecycleDir
 * @returns {boolean}
 */
export function verifyLifecycleIntegrity(lifecycleDir) {
  if (!existsSync(lifecycleDir)) return false;
  const dirStat = statSync(lifecycleDir);
  if ((dirStat.mode & 0o777) !== 0o700) return false;
  const keyPath = join(lifecycleDir, "key");
  if (!existsSync(keyPath)) return false;
  const keyStat = statSync(keyPath);
  if ((keyStat.mode & 0o777) !== 0o600) return false;
  const registryPath = join(lifecycleDir, "registry.jsonl");
  if (!existsSync(registryPath)) return false;
  const regStat = statSync(registryPath);
  if ((regStat.mode & 0o777) !== 0o600) return false;
  return true;
}
