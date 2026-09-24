export type ModuleSettings = Record<string, string | null>;

export type SettingsClient = {
  getModuleSettings(moduleName: string): Promise<ModuleSettings>;
};

export function createSettingsClient(opts: { apiBaseUrl: string }): SettingsClient {
  const base = opts.apiBaseUrl.replace(/\/+$/, "");

  return {
    async getModuleSettings(moduleName: string) {
      const res = await fetch(`${base}/api/settings/${encodeURIComponent(moduleName)}`);
      if (!res.ok) throw new Error(`settings fetch failed (${res.status})`);

      const data = (await res.json()) as {
        module: string;
        settings: Array<{ key: string; isSecret: boolean; value: string | null }>;
      };

      const out: ModuleSettings = {};
      for (const s of data.settings) out[s.key] = s.value;
      return out;
    },
  };
}
