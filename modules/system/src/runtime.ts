import type { ModuleRuntime } from "@feedeater/module-sdk";

async function fetchJson(url: string, token: string) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return res.json();
}

async function fetchJsonPost(url: string, token: string, body: Record<string, unknown>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return res.json();
}

export function createModuleRuntime(): ModuleRuntime {
  return {
    moduleName: "system",
    handlers: {
      mod_system: {
        async aiDebug() {
          const apiBaseUrl = (process.env.FEED_API_BASE_URL ?? "http://localhost:4000").replace(/\/+$/, "");
          const internalToken = process.env.FEED_INTERNAL_TOKEN ?? "";
          if (!internalToken) throw new Error("Missing FEED_INTERNAL_TOKEN");

          let tags: unknown = null;
          let tagsError: string | null = null;
          let summaryOk = false;
          let embedOk = false;
          let summaryError: string | null = null;
          let embedError: string | null = null;

          try {
            tags = await fetchJson(`${apiBaseUrl}/api/internal/ai/tags`, internalToken);
          } catch (err) {
            tagsError = err instanceof Error ? err.message : String(err);
          }

          try {
            await fetchJsonPost(`${apiBaseUrl}/api/internal/ai/summary`, internalToken, { prompt: "AI debug ping" });
            summaryOk = true;
          } catch (err) {
            summaryError = err instanceof Error ? err.message : String(err);
          }

          try {
            await fetchJsonPost(`${apiBaseUrl}/api/internal/ai/embedding`, internalToken, { text: "AI debug ping" });
            embedOk = true;
          } catch (err) {
            embedError = err instanceof Error ? err.message : String(err);
          }

          return {
            metrics: {
              tags,
              tags_error: tagsError,
              summary_ok: summaryOk,
              summary_error: summaryError,
              embed_ok: embedOk,
              embed_error: embedError,
            },
          };
        },
      },
    },
  };
}
