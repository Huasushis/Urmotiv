import type { PluginRegistry } from "@urmotiv/plugin-sdk";
import { hydroProblemFormatAdapter } from "./adapter";

export * from "./adapter";
export * from "./schema";
export * from "./statement";

export function registerHydroFormatPlugin(registry: PluginRegistry): void {
  registry.registerProblemFormatAdapter(hydroProblemFormatAdapter);
}
