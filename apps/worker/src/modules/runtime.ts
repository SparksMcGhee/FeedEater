import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ModuleRuntime } from "@feedeater/module-sdk";

export async function loadModuleRuntime(params: {
  modulesDir: string;
  moduleName: string;
  runtimeEntry: string;
}): Promise<ModuleRuntime> {
  const fullPath = path.join(params.modulesDir, params.moduleName, params.runtimeEntry);
  const url = pathToFileURL(fullPath).toString();
  const mod = (await import(url)) as { createModuleRuntime?: () => ModuleRuntime };
  if (!mod.createModuleRuntime) {
    throw new Error(`Module ${params.moduleName} runtime must export createModuleRuntime()`);
  }
  const runtime = mod.createModuleRuntime();
  if (!runtime || runtime.moduleName !== params.moduleName) {
    throw new Error(`Module ${params.moduleName} runtime returned invalid moduleName`);
  }
  return runtime;
}
