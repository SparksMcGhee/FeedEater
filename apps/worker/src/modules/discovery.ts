import fs from "node:fs/promises";
import path from "node:path";

import type { ModuleManifest } from "./types.js";

export async function discoverModules(modulesDir: string): Promise<ModuleManifest[]> {
  const entries = await fs.readdir(modulesDir, { withFileTypes: true });
  const modules: ModuleManifest[] = [];

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const moduleJsonPath = path.join(modulesDir, ent.name, "module.json");
    try {
      const raw = await fs.readFile(moduleJsonPath, "utf8");
      const parsed = JSON.parse(raw) as ModuleManifest;
      if (parsed?.name) modules.push(parsed);
    } catch {
      // ignore
    }
  }

  modules.sort((a, b) => a.name.localeCompare(b.name));
  return modules;
}
