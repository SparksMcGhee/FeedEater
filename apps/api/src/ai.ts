import type { Request, Response } from "express";
import { prisma } from "@feedeater/db";

function requireInternalAuth(req: Request): void {
  const expected = process.env.FEED_INTERNAL_TOKEN;
  if (!expected) throw new Error("Missing required env var: FEED_INTERNAL_TOKEN");

  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!token || token !== expected) {
    const err = new Error("Unauthorized");
    (err as any).statusCode = 401;
    throw err;
  }
}

async function getSystemSettings(): Promise<Record<string, string | null>> {
  const rows = await prisma.setting.findMany({ where: { module: "system" } });
  const out: Record<string, string | null> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function str(val: string | null | undefined): string {
  return String(val ?? "").trim();
}

function getAiConfig(settings: Record<string, string | null>) {
  // Primary summary endpoint (local vLLM)
  const baseUrl = (str(settings.ai_base_url) || str(settings.ollama_base_url) || str(process.env.AI_BASE_URL) || str(process.env.OLLAMA_BASE_URL)).replace(/\/+$/, "");
  const summaryModel = str(settings.ai_summary_model) || str(settings.ollama_summary_model) || str(process.env.AI_SUMMARY_MODEL) || str(process.env.OLLAMA_SUMMARY_MODEL) || "Qwen/Qwen3-Coder-Next-FP8";
  const apiKey = str(settings.ai_api_key) || str(process.env.AI_API_KEY);

  // Dedicated embed endpoint (second vLLM container)
  const embedBaseUrl = (str(settings.ai_embed_base_url) || str(process.env.AI_EMBED_BASE_URL)).replace(/\/+$/, "");
  const embedModel = str(settings.ai_embed_model) || str(settings.ollama_embed_model) || str(process.env.AI_EMBED_MODEL) || str(process.env.OLLAMA_EMBED_MODEL) || "BAAI/bge-base-en-v1.5";
  const embedDimRaw = str(settings.ai_embed_dim) || str(settings.ollama_embed_dim) || str(process.env.AI_EMBED_DIM) || str(process.env.OLLAMA_EMBED_DIM) || "768";
  const embedDim = Number.isFinite(Number(embedDimRaw)) ? Number(embedDimRaw) : 768;

  // Cloud burst (routes summary requests to an external provider when enabled)
  const burstEnabled = (str(settings.ai_burst_enabled) || str(process.env.AI_BURST_ENABLED)).toLowerCase() === "true";
  const burstBaseUrl = (str(settings.ai_burst_base_url) || str(process.env.AI_BURST_BASE_URL) || "https://api.together.xyz/v1").replace(/\/+$/, "");
  const burstApiKey = str(settings.ai_burst_api_key) || str(process.env.AI_BURST_API_KEY);
  const burstSummaryModel = str(settings.ai_burst_summary_model) || str(process.env.AI_BURST_SUMMARY_MODEL) || summaryModel;

  return { baseUrl, summaryModel, apiKey, embedBaseUrl, embedModel, embedDim, burstEnabled, burstBaseUrl, burstApiKey, burstSummaryModel };
}

function authHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
  return headers;
}

export function postAiSummary() {
  return async (req: Request, res: Response) => {
    try {
      requireInternalAuth(req);
      const body = (req.body ?? {}) as { prompt?: unknown; system?: unknown; format?: unknown };
      if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
        res.status(400).json({ error: "prompt must be a non-empty string" });
        return;
      }

      const settings = await getSystemSettings();
      const cfg = getAiConfig(settings);

      // Resolve which endpoint to use — burst takes priority when enabled
      const useBase = cfg.burstEnabled && cfg.burstBaseUrl ? cfg.burstBaseUrl : cfg.baseUrl;
      const useKey = cfg.burstEnabled && cfg.burstBaseUrl ? cfg.burstApiKey : cfg.apiKey;
      const useModel = cfg.burstEnabled && cfg.burstBaseUrl ? cfg.burstSummaryModel : cfg.summaryModel;

      if (!useBase) {
        res.status(400).json({ error: "ai_base_url is not configured" });
        return;
      }

      const system = typeof body.system === "string" && body.system.trim().length > 0 ? body.system.trim() : undefined;
      const wantJson = typeof body.format === "string" && body.format.trim() === "json";

      const messages: Array<{ role: string; content: string }> = [];
      if (system) messages.push({ role: "system", content: system });
      messages.push({ role: "user", content: body.prompt });

      const startMs = Date.now();
      const vllmRes = await fetch(`${useBase}/chat/completions`, {
        method: "POST",
        headers: authHeaders(useKey),
        body: JSON.stringify({
          model: useModel,
          messages,
          stream: false,
          ...(wantJson ? { response_format: { type: "json_object" } } : {}),
        }),
      });
      if (!vllmRes.ok) throw new Error(`AI summary failed (${vllmRes.status})`);
      const data = (await vllmRes.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { completion_tokens?: number };
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("missing AI response content");

      const elapsedSec = (Date.now() - startMs) / 1000;
      const completionTokens = data.usage?.completion_tokens;
      const tokenRate = typeof completionTokens === "number" && elapsedSec > 0 ? completionTokens / elapsedSec : null;

      res.json({ response: content, token_rate: tokenRate });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  };
}

export function postAiEmbedding() {
  return async (req: Request, res: Response) => {
    try {
      requireInternalAuth(req);
      const body = (req.body ?? {}) as { text?: unknown };
      if (typeof body.text !== "string" || body.text.trim().length === 0) {
        res.status(400).json({ error: "text must be a non-empty string" });
        return;
      }

      const settings = await getSystemSettings();
      const cfg = getAiConfig(settings);
      if (!cfg.embedBaseUrl) {
        res.status(400).json({ error: "ai_embed_base_url is not configured" });
        return;
      }

      const vllmRes = await fetch(`${cfg.embedBaseUrl}/embeddings`, {
        method: "POST",
        headers: authHeaders(cfg.apiKey),
        body: JSON.stringify({ model: cfg.embedModel, input: body.text }),
      });
      if (!vllmRes.ok) throw new Error(`AI embeddings failed (${vllmRes.status})`);
      const data = (await vllmRes.json()) as { data?: Array<{ embedding?: number[] }> };
      const embedding = data.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new Error("empty embedding");
      }

      res.json({ embedding, dim: cfg.embedDim });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  };
}

export function getAiTags() {
  return async (req: Request, res: Response) => {
    try {
      requireInternalAuth(req);
      const settings = await getSystemSettings();
      const cfg = getAiConfig(settings);

      const results: Record<string, unknown> = {};

      if (cfg.baseUrl) {
        try {
          const r = await fetch(`${cfg.baseUrl}/models`, { headers: authHeaders(cfg.apiKey) });
          if (!r.ok) throw new Error(`status ${r.status}`);
          results.summary = await r.json();
        } catch (e) {
          results.summary_error = e instanceof Error ? e.message : String(e);
        }
      } else {
        results.summary_error = "ai_base_url not configured";
      }

      if (cfg.embedBaseUrl) {
        try {
          const r = await fetch(`${cfg.embedBaseUrl}/models`, { headers: authHeaders(cfg.apiKey) });
          if (!r.ok) throw new Error(`status ${r.status}`);
          results.embed = await r.json();
        } catch (e) {
          results.embed_error = e instanceof Error ? e.message : String(e);
        }
      } else {
        results.embed_error = "ai_embed_base_url not configured";
      }

      res.json({ ok: true, ...results });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  };
}
