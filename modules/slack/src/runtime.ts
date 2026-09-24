import type { ModuleRuntime } from "@feedeater/module-sdk";

import { parseSlackSettingsFromInternal, SlackIngestor } from "./ingest.js";

function parseSystemNarrativeSettings(raw: Record<string, unknown>) {
  const rawTop = raw.narrative_top_k ?? raw.context_top_k;
  const narrativeTopK = rawTop ? Number(rawTop) : 20;
  const embedDimRaw = raw.ai_embed_dim ?? raw.ollama_embed_dim;
  const embedDim = embedDimRaw ? Number(embedDimRaw) : 4096;
  return {
    narrativeTopK: Number.isFinite(narrativeTopK) && narrativeTopK > 0 ? narrativeTopK : 20,
    embedDim: Number.isFinite(embedDim) && embedDim > 0 ? embedDim : 4096,
  };
}

export function createModuleRuntime(): ModuleRuntime {
  return {
    moduleName: "slack",
    handlers: {
      mod_slack: {
        async collect({ ctx }) {
          const raw = await ctx.fetchInternalSettings("slack");
          const settings = parseSlackSettingsFromInternal(raw);
          if (!settings.enabled) return;

          const sysRaw = await ctx.fetchInternalSettings("system");
          const sys = parseSystemNarrativeSettings(sysRaw);
          const apiBaseUrl = process.env.FEED_API_BASE_URL ?? "http://localhost:4000";
          const internalToken = process.env.FEED_INTERNAL_TOKEN ?? "";
          const ingestor = new SlackIngestor(settings, ctx.db, ctx.nats, ctx.sc, {
            apiBaseUrl,
            internalToken,
            narrativeTopK: sys.narrativeTopK,
            embedDim: sys.embedDim,
          });
          await ingestor.ensureSchema();
          const result = await ingestor.collectAndPersist();
          return {
            metrics: {
              messages_seen: result.insertedOrUpdated,
              messages_published: result.publishedNew,
            },
          };
        },
        async updateNarratives({ ctx }) {
          const raw = await ctx.fetchInternalSettings("slack");
          const settings = parseSlackSettingsFromInternal(raw);
          if (!settings.enabled) return;

          const sysRaw = await ctx.fetchInternalSettings("system");
          const sys = parseSystemNarrativeSettings(sysRaw);
          const apiBaseUrl = process.env.FEED_API_BASE_URL ?? "http://localhost:4000";
          const internalToken = process.env.FEED_INTERNAL_TOKEN ?? "";
          const ingestor = new SlackIngestor(settings, ctx.db, ctx.nats, ctx.sc, {
            apiBaseUrl,
            internalToken,
            narrativeTopK: sys.narrativeTopK,
            embedDim: sys.embedDim,
          });
          await ingestor.ensureSchema();
          const result = await ingestor.refreshNarratives({
            lookbackHours: settings.lookbackHours,
          });
          return {
            metrics: {
              narratives_updated: result.updated,
              narratives_ai: result.aiSummaries,
              narratives_fallback: result.fallbackSummaries,
              embeddings_inserted: result.embeddingsInserted,
              avg_token_rate: result.avgTokenRate ?? null,
            },
          };
        },
      },
    },
  };
}
