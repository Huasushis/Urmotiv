import type { PluginRegistry } from "@urmotiv/plugin-sdk";
import { fpsProblemFormatAdapter } from "./adapter";

export * from "./adapter";
export * from "./parser";
export * from "./schema";

export function registerFpsFormatPlugin(registry: PluginRegistry): void {
  registry.registerProblemFormatAdapter(fpsProblemFormatAdapter);
}
