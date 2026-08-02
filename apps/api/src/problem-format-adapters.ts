import {
  createStaticProblemFormatAdapterCatalog,
  urmotivNativeAdapter,
  type ProblemFormatAdapter,
  type ProblemFormatAdapterCatalog
} from "@urmotiv/problem-package";
import type { TrustedPluginHost } from "./plugin-host";

const coreAdapters: ReadonlyMap<string, ProblemFormatAdapter> = new Map([
  [urmotivNativeAdapter.id, urmotivNativeAdapter]
]);
const coreCatalog = createStaticProblemFormatAdapterCatalog(coreAdapters);

/**
 * Combines the always-available native format with adapters owned by enabled,
 * unchanged bundled plugins. Plugin adapters can never replace a core id.
 */
export class TrustedProblemFormatAdapterCatalog implements ProblemFormatAdapterCatalog {
  public constructor(private readonly pluginHost: TrustedPluginHost) {}

  public async listEnabled(): Promise<readonly ProblemFormatAdapter[]> {
    const core = await coreCatalog.listEnabled();
    const byId = new Map(core.map((adapter) => [adapter.id, adapter]));
    for (const adapter of await this.pluginHost.listEnabledProblemFormatAdapters()) {
      if (byId.has(adapter.id)) {
        throw new Error("插件题目包格式不能替换核心格式。");
      }
      byId.set(adapter.id, adapter);
    }
    return [...byId.values()];
  }

  public async getEnabled(formatId: string): Promise<ProblemFormatAdapter | undefined> {
    const core = await coreCatalog.getEnabled(formatId);
    if (core !== undefined) return core;
    const adapter = await this.pluginHost.getEnabledProblemFormatAdapter(formatId);
    if (adapter?.id === urmotivNativeAdapter.id) {
      throw new Error("插件题目包格式不能替换核心格式。");
    }
    return adapter;
  }
}
