import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rootUrl = new URL("../../../", import.meta.url);

function readRoot(relativePath: string): string {
  return readFileSync(new URL(relativePath, rootUrl), "utf8");
}

/** 解析 Dockerfile.api 安装阶段显式复制的 workspace 包目录。 */
function copiedWorkspaceDirectories(dockerfile: string): Set<string> {
  const copied = new Set<string>();
  for (const line of dockerfile.split("\n")) {
    const match = /^COPY (packages|plugins|apps)\/([\w.-]+)\/package\.json \1\/[\w.-]+\/package\.json$/u.exec(
      line.trim()
    );
    if (match !== null) {
      copied.add(`${match[1]}/${match[2]}`);
    }
  }
  return copied;
}

function workspacePackageName(relativePath: string): string {
  const [group, dir] = relativePath.split("/", 2);
  return `@urmotiv/${group === "plugins" ? "plugin-" : ""}${dir}`;
}

/** 精简的 Docker .dockerignore 判定：无斜杠模式按任意深度 basename 匹配。 */
function isExcludedByDockerignore(path: string, rules: readonly string[]): boolean {
  let excluded = false;
  for (const raw of rules) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const negate = line.startsWith("!");
    const pattern = (negate ? line.slice(1) : line).replace(/\/+$/u, "");
    const segments = path.split("/");
    const basename = segments[segments.length - 1] ?? "";
    const matches =
      pattern.includes("/")
        ? path === pattern || (pattern.startsWith("**/") && path.endsWith(pattern.slice(3)))
        : basename === pattern;
    if (matches) {
      excluded = !negate;
    }
  }
  return excluded;
}

const apiWorkspaceDependencies = (() => {
  const raw = JSON.parse(readRoot("apps/api/package.json")) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(raw.dependencies ?? {}).filter((name) => name.startsWith("@urmotiv/"));
})();

// 与 apps/api/src/builtin-plugins.ts 的运行时导入一一对应。
const builtinPlugins = [
  "plugins/anklang",
  "plugins/fermata-control",
  "plugins/hydro-format",
  "plugins/fps-format",
  "plugins/review-default"
];

describe("API 镜像部署契约", () => {
  it("API 及全部内置插件的 workspace 依赖都在安装阶段显式复制", () => {
    const dockerfile = readRoot("Dockerfile.api");
    const copied = copiedWorkspaceDirectories(dockerfile);
    const copiedNames = new Set([...copied].map(workspacePackageName));
    for (const dependency of apiWorkspaceDependencies) {
      expect(copiedNames, dependency).toContain(dependency);
    }
    for (const plugin of builtinPlugins) {
      expect(copied, plugin).toContain(plugin);
    }
    // fps-format/hydro-format 在运行时以源码入口导入 @urmotiv/problem-package。
    expect(copied).toContain("packages/problem-package");
    expect(copied).toContain("packages/plugin-sdk");
  });

  it("清理上下文排除所有层级的宿主 node_modules", () => {
    const rules = readRoot(".dockerignore").split("\n");
    for (const nested of [
      "plugins/fps-format/node_modules",
      "plugins/anklang/node_modules",
      "packages/database/node_modules",
      "apps/api/node_modules"
    ]) {
      expect(isExcludedByDockerignore(nested, rules), nested).toBe(true);
    }
  });
});
