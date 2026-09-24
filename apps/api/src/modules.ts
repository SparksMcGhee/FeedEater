import fs from "node:fs/promises";
import path from "node:path";

export type ModuleManifest = {
  name: string;
  version: string;
  namespace: string;
  queues?: string[];
  jobs?: Array<{
    name: string;
    queue: string;
    schedule?: string;
    triggeredBy?: string;
    description?: string;
  }>;
  settings?: Array<{
    key: string;
    type: "string" | "number" | "boolean" | "secret";
    default?: unknown;
    required?: boolean;
  }>;
  cards?: Array<{ id: string; title: string }>;
};

export async function discoverModules(modulesDir: string): Promise<ModuleManifest[]> {
  const entries = await fs.readdir(modulesDir, { withFileTypes: true });
  const modules: ModuleManifest[] = [];

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const moduleJsonPath = path.join(modulesDir, ent.name, "module.json");

    try {
      const raw = await fs.readFile(moduleJsonPath, "utf8");
      const parsed = JSON.parse(raw) as ModuleManifest;
      if (!parsed?.name) continue;
      modules.push(parsed);
    } catch {
      // ignore non-modules
    }
  }

  modules.sort((a, b) => a.name.localeCompare(b.name));
  return modules;
}
