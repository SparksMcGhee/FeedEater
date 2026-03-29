import { WebClient } from "@slack/web-api";
import type { Pool } from "pg";
import type { NatsConnection, StringCodec } from "nats";

import { MessageCreatedEventSchema, NarrativeUpdatedEventSchema, NormalizedMessageSchema, subjectFor } from "@feedeater/core";

import { slackSourceIdToBusMessageId } from "./slackMessageIds.js";

export type SlackSettings = {
  enabled: boolean;
  botToken: string;
  channelIds: string[];
  lookbackHours: number;
  includeThreads: boolean;
  excludeBots: boolean;
  nonThreadNarrativeTemplate: string;
  channelNameMap: Record<string, string>;
  narrativePrompt: string;
  narrativePromptFallback: string;
};

type SlackMessage = {
  text: string;
  user: string;
  username?: string;
  timestamp: string; // Slack ts
  channel: string;
  threadTs?: string;
  isThreadReply?: boolean;
  replyCount?: number;
};

export function parseSlackSettingsFromInternal(raw: Record<string, unknown>): SlackSettings {
  // Internal settings endpoint returns strings (and decrypted secret strings) or nulls.
  // Normalize into the strongly-typed settings object.
  const enabled = String(raw.enabled ?? "true") !== "false";
  const botToken = String(raw.botToken ?? "");
  const channelIds = String(raw.channelIds ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const lookbackHours = raw.lookbackHours ? Number(raw.lookbackHours) : 24;
  const includeThreads = String(raw.includeThreads ?? "true") !== "false";
  const excludeBots = String(raw.excludeBots ?? "true") !== "false";
  const nonThreadNarrativeTemplate = String(
    raw.nonThreadNarrativeTemplate ?? raw.nonThreadContextTemplate ?? "Message in channel {channel}"
  );
  const channelNameMapRaw = String(raw.channelNameMap ?? "{}");
  const defaultNarrativePrompt =
    "You are summarizing the provided Slack messages. Summarize ONLY the messages provided. Do not make suggestions, ask questions, or add commentary. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings.";
  const defaultNarrativePromptFallback =
    "Summarize ONLY the provided messages in plain text. 1-3 short sentences. Do not return JSON. Do not make suggestions or ask questions.";
  const narrativePrompt =
    String(raw.narrativePrompt ?? raw.contextPrompt ?? "").trim() || defaultNarrativePrompt;
  const narrativePromptFallback =
    String(raw.narrativePromptFallback ?? raw.contextPromptFallback ?? "").trim() || defaultNarrativePromptFallback;
  let channelNameMap: Record<string, string> = {};
  try {
    const parsed = JSON.parse(channelNameMapRaw) as Record<string, unknown>;
    channelNameMap = Object.fromEntries(
      Object.entries(parsed ?? {}).map(([k, v]) => [String(k), String(v)])
    );
  } catch {
    throw new Error('Slack setting "channelNameMap" must be valid JSON');
  }

  if (!botToken) throw new Error('Slack setting "botToken" is required');
  if (channelIds.length === 0) throw new Error('Slack setting "channelIds" is required');
  if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) {
    throw new Error('Slack setting "lookbackHours" must be a positive number');
  }

  return {
    enabled,
    botToken,
    channelIds,
    lookbackHours,
    includeThreads,
    excludeBots,
    nonThreadNarrativeTemplate,
    channelNameMap,
    narrativePrompt,
    narrativePromptFallback,
  };
}

export class SlackIngestor {
  private slack: WebClient;
  private userCache = new Map<string, string>();
  private apiBaseUrl: string;
  private internalToken: string;
  private narrativeTopK: number;
  private embedDim: number;

  private log(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) {
    try {
      this.nats.publish(
        "feedeater.slack.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "slack",
            source: "collector",
            at: new Date().toISOString(),
            message,
            meta,
          })
        )
      );
    } catch {
      // ignore
    }
  }

  constructor(
    private readonly settings: SlackSettings,
    private readonly db: Pool,
    private readonly nats: NatsConnection,
    private readonly sc: StringCodec,
    opts: { apiBaseUrl: string; internalToken: string; narrativeTopK: number; embedDim: number }
  ) {
    this.slack = new WebClient(settings.botToken);
    this.apiBaseUrl = opts.apiBaseUrl.replace(/\/+$/, "");
    this.internalToken = opts.internalToken;
    this.narrativeTopK = opts.narrativeTopK;
    this.embedDim = opts.embedDim;
  }

  private async resolveUsername(userId: string): Promise<string> {
    const cached = this.userCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.slack.users.info({ user: userId });
      const username =
        (result.user?.real_name as string | undefined) ??
        (result.user?.name as string | undefined) ??
        userId;
      this.userCache.set(userId, username);
      return username;
    } catch {
      return userId;
    }
  }

  private async fetchThreadReplies(channelId: string, threadTs: string): Promise<SlackMessage[]> {
    try {
      const result = await this.slack.conversations.replies({ channel: channelId, ts: threadTs, limit: 100 });
      if (!result.messages || result.messages.length <= 1) return [];

      const replies: SlackMessage[] = [];
      for (let i = 1; i < result.messages.length; i++) {
        const m = result.messages[i];
        if (!m || !m.ts || !m.user) continue;
        const textRaw = m.text != null && String(m.text).trim() !== "" ? String(m.text) : "(no text)";
        const username = await this.resolveUsername(String(m.user));
        replies.push({
          text: this.normalizeSlackText(textRaw),
          user: String(m.user),
          username,
          timestamp: String(m.ts),
          channel: channelId,
          threadTs,
          isThreadReply: true,
        });
      }
      return replies;
    } catch (err) {
      this.log(
        "warn",
        "failed to fetch thread replies (continuing)",
        err instanceof Error ? { channelId, threadTs, name: err.name, message: err.message } : { channelId, threadTs, err }
      );
      return [];
    }
  }

  private async aiGenerate(prompt: string): Promise<{
    summaryShort: string;
    summaryLong: string;
    tokenRate?: number;
    rawResponse?: string;
  }> {
    if (!this.apiBaseUrl || !this.internalToken) {
      throw new Error("AI summary unavailable: missing API base URL or internal token");
    }
    try {
      this.log("info", "ai summary prompt", { prompt });
      const res = await fetch(`${this.apiBaseUrl}/api/internal/ai/summary`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.internalToken}` },
        body: JSON.stringify({ prompt, system: this.settings.narrativePrompt, format: "json" }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`ai summary failed (${res.status}) ${body}`.trim());
      }
      const data = (await res.json()) as { response?: string; token_rate?: number | null };
      const rawResponse = String(data.response ?? "").trim();
      if (!rawResponse) throw new Error("invalid summary payload");
      const parsed = this.parseSummaryJson(rawResponse);
      if (!parsed) return await this.aiGenerateFallback(prompt);
      const summaryShort = parsed.summaryShort.slice(0, 128);
      const summaryLong = parsed.summaryLong;
      if (!summaryShort || !summaryLong) throw new Error("invalid summary payload");
      return {
        summaryShort,
        summaryLong,
        ...(typeof data.token_rate === "number" ? { tokenRate: data.token_rate } : {}),
        rawResponse,
      };
    } catch (err) {
      this.log("error", "ai summary failed", err instanceof Error ? { message: err.message } : { err });
      throw err;
    }
  }

  private async aiGenerateFallback(prompt: string): Promise<{
    summaryShort: string;
    summaryLong: string;
    tokenRate?: number;
    rawResponse?: string;
  }> {
    const res = await fetch(`${this.apiBaseUrl}/api/internal/ai/summary`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.internalToken}` },
      body: JSON.stringify({ prompt, system: this.settings.narrativePromptFallback }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ai summary fallback failed (${res.status}) ${body}`.trim());
    }
    const data = (await res.json()) as { response?: string; token_rate?: number | null };
    const rawResponse = String(data.response ?? "").trim();
    if (!rawResponse) throw new Error("invalid fallback summary payload");
    return {
      summaryShort: rawResponse.slice(0, 128),
      summaryLong: rawResponse,
      ...(typeof data.token_rate === "number" ? { tokenRate: data.token_rate } : {}),
      rawResponse,
    };
  }

  private parseSummaryJson(rawResponse: string): { summaryShort: string; summaryLong: string } | null {
    const trimmed = rawResponse.trim();
    const candidate = trimmed.startsWith("```")
      ? trimmed.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim()
      : trimmed;
    try {
      const parsed = JSON.parse(candidate) as { summary_short?: string; summary_long?: string };
      const summaryShort = String(parsed.summary_short ?? "").trim();
      const summaryLong = String(parsed.summary_long ?? "").trim();
      if (!summaryShort && !summaryLong) return null;
      return {
        summaryShort: summaryShort || summaryLong.slice(0, 128),
        summaryLong: summaryLong || summaryShort,
      };
    } catch {
      return null;
    }
  }

  private normalizeSlackText(text: string): string {
    if (!text) return text;
    return text.replace(/<([^>|]+)(\|([^>]+))?>/g, (_full, link: string, _sep: string, label?: string) => {
      const url = String(link ?? "");
      const display = label ? String(label) : "";
      if (/^(https?:\/\/|mailto:)/i.test(url)) {
        return display ? `[${display}](${url})` : url;
      }
      if (display) return display;
      return url;
    });
  }

  private async aiEmbed(text: string): Promise<number[]> {
    if (!this.apiBaseUrl || !this.internalToken) {
      throw new Error("AI embedding unavailable: missing API base URL or internal token");
    }
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/internal/ai/embedding`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.internalToken}` },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`ai embeddings failed (${res.status})`);
      const data = (await res.json()) as { embedding?: number[] };
      if (!Array.isArray(data.embedding) || data.embedding.length === 0) throw new Error("empty embedding");
      return data.embedding;
    } catch (err) {
      this.log("error", "ai embeddings failed", err instanceof Error ? { message: err.message } : { err });
      throw err;
    }
  }

  private async publishNarrativeUpdate(params: {
    narrativeKey: string;
    messageId?: string;
    summaryShort: string;
    summaryLong: string;
    keyPoints?: string[];
    embedding?: number[];
  }) {
    const summaryShort = params.summaryShort.slice(0, 128);
    const narrativeEvent = NarrativeUpdatedEventSchema.parse({
      type: "NarrativeUpdated",
      createdAt: new Date().toISOString(),
      messageId: params.messageId,
      narrative: {
        ownerModule: "slack",
        sourceKey: params.narrativeKey,
        summaryShort,
        summaryLong: params.summaryLong,
        keyPoints: params.keyPoints ?? [],
        embedding: params.embedding,
      },
    });
    this.nats.publish(subjectFor("slack", "narrativeUpdated"), this.sc.encode(JSON.stringify(narrativeEvent)));
  }

  private async fetchChannelMessages(channelIds: string[], lookbackHours: number): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    const lookbackTime = Date.now() / 1000 - lookbackHours * 3600;

    for (const channelId of channelIds) {
      this.log("info", "scraping channel history", { channelId, lookbackHours });

      let result: any;
      try {
        result = await this.slack.conversations.history({
          channel: channelId,
          oldest: String(lookbackTime),
          limit: 1000,
        });
      } catch (err) {
        // Keep going: one bad channel should not block other channels.
        // Still report prominently (and with channelId) to the logs UI.
        this.log(
          "error",
          "failed to fetch channel history (continuing)",
          err instanceof Error ? { channelId, name: err.name, message: err.message, stack: err.stack } : { channelId, err }
        );
        continue;
      }

      for (const m of result.messages ?? []) {
        if (!m || !m.ts || !m.user) continue;
        if (this.settings.excludeBots && (m.subtype === "bot_message" || (m as any).bot_id)) continue;

        const textRaw = m.text != null && String(m.text).trim() !== "" ? String(m.text) : "(no text)";
        const username = await this.resolveUsername(String(m.user));
        const msg: SlackMessage = {
          text: this.normalizeSlackText(textRaw),
          user: String(m.user),
          username,
          timestamp: String(m.ts),
          channel: channelId,
          isThreadReply: false,
          replyCount: typeof m.reply_count === "number" ? m.reply_count : 0,
          ...(m.thread_ts ? { threadTs: String(m.thread_ts) } : {}),
        };
        messages.push(msg);

        if (
          this.settings.includeThreads &&
          msg.replyCount &&
          msg.replyCount > 0 &&
          msg.timestamp &&
          !msg.isThreadReply
        ) {
          const replies = await this.fetchThreadReplies(channelId, msg.timestamp);
          messages.push(...replies);
        }
      }
    }

    messages.sort((a, b) => parseFloat(a.timestamp) - parseFloat(b.timestamp));
    return messages;
  }

  async ensureSchema(): Promise<void> {
    await this.db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_slack");
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_slack.slack_messages (
        id text PRIMARY KEY,
        channel_id text NOT NULL,
        slack_ts text NOT NULL,
        slack_ts_num double precision NOT NULL,
        ts timestamptz NOT NULL,
        author_id text,
        author_name text,
        text text,
        thread_ts text,
        is_thread_reply boolean NOT NULL DEFAULT false,
        reply_count int,
        payload jsonb NOT NULL,
        collected_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS slack_messages_ts_idx ON mod_slack.slack_messages (ts)`);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS slack_messages_channel_ts_idx ON mod_slack.slack_messages (channel_id, ts)`
    );

    const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_slack.slack_message_embeddings (
        id text PRIMARY KEY,
        channel_id text NOT NULL,
        narrative_key text NOT NULL,
        ts timestamptz NOT NULL,
        embedding vector(${embedDim})
      )
    `);
    await this.db.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'mod_slack' AND table_name = 'slack_message_embeddings' AND column_name = 'context_key'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'mod_slack' AND table_name = 'slack_message_embeddings' AND column_name = 'narrative_key'
        ) THEN
          ALTER TABLE mod_slack.slack_message_embeddings RENAME COLUMN context_key TO narrative_key;
        END IF;
      END $$
    `);
    // CREATE TABLE IF NOT EXISTS does not add columns to an existing table; e.g. after
    // ALTER TABLE ... DROP COLUMN embedding (dimension migration in docs).
    if (Number.isFinite(embedDim) && embedDim > 0) {
      await this.db.query(`
        ALTER TABLE mod_slack.slack_message_embeddings
        ADD COLUMN IF NOT EXISTS embedding vector(${embedDim})
      `);
      await this.db.query(
        `ALTER TABLE mod_slack.slack_message_embeddings ALTER COLUMN embedding TYPE vector(${embedDim}) USING embedding::vector`
      );
    }
    await this.db.query(`DROP INDEX IF EXISTS slack_message_embeddings_context_idx`);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS slack_message_embeddings_narrative_idx ON mod_slack.slack_message_embeddings (narrative_key, ts)`
    );
    if (Number.isFinite(embedDim) && embedDim <= 2000) {
      await this.db.query(
        `CREATE INDEX IF NOT EXISTS slack_message_embeddings_vec_idx ON mod_slack.slack_message_embeddings USING ivfflat (embedding vector_cosine_ops)`
      );
    } else {
      await this.db.query(`DROP INDEX IF EXISTS slack_message_embeddings_vec_idx`);
      this.log("warn", "skipping ivfflat index (embedding dim > 2000)", { embedDim });
    }
  }

  async collectAndPersist(): Promise<{ insertedOrUpdated: number; publishedNew: number }> {
    this.log("info", "slack collect starting", { channelIds: this.settings.channelIds, lookbackHours: this.settings.lookbackHours });
    const msgs = await this.fetchChannelMessages(this.settings.channelIds, this.settings.lookbackHours);
    if (msgs.length === 0) return { insertedOrUpdated: 0, publishedNew: 0 };

    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      let count = 0;
      let published = 0;

      for (const m of msgs) {
        const tsNum = parseFloat(m.timestamp);
        const sourceId = `slack-${m.channel}-${m.timestamp}`;

        // De-duplication: only publish to the unified bus when we insert a previously unseen Slack message.
        // We still upsert the DB row (so payload/text changes can be updated), but avoid re-emitting duplicates.
        const upsert = (await client.query(
          `
          INSERT INTO mod_slack.slack_messages (
            id, channel_id, slack_ts, slack_ts_num, ts,
            author_id, author_name, text,
            thread_ts, is_thread_reply, reply_count, payload
          ) VALUES (
            $1, $2, $3, $4, to_timestamp($4),
            $5, $6, $7,
            $8, $9, $10, $11
          )
          ON CONFLICT (id) DO UPDATE SET
            text = EXCLUDED.text,
            author_name = EXCLUDED.author_name,
            payload = EXCLUDED.payload,
            collected_at = now()
          RETURNING (xmax = 0) AS inserted
          `,
          [
            sourceId,
            m.channel,
            m.timestamp,
            tsNum,
            m.user,
            m.username ?? m.user,
            m.text,
            m.threadTs ?? null,
            Boolean(m.isThreadReply),
            m.replyCount ?? null,
            m as any,
          ]
        )) as unknown as { rows: Array<{ inserted: boolean }> };
        count++;

        const inserted = Boolean(upsert.rows?.[0]?.inserted);
        if (inserted) {
          const msgId = slackSourceIdToBusMessageId(sourceId);
          const narrativeKey = `${m.channel}:${m.threadTs ?? m.timestamp}`;
          const slackLink = `https://slack.com/app_redirect?channel=${encodeURIComponent(m.channel)}&message_ts=${encodeURIComponent(
            m.threadTs ?? m.timestamp
          )}`;
          const normalized = NormalizedMessageSchema.parse({
            id: msgId,
            createdAt: new Date(tsNum * 1000).toISOString(),
            source: { module: "slack", stream: m.channel },
            realtime: false,
            Message: m.text,
            narrativeRef: { ownerModule: "slack", sourceKey: narrativeKey },
            followMePanel: {
              module: "slack",
              panelId: "thread",
              href: slackLink,
              label: "Open in Slack",
            },
            From: m.username ?? m.user,
            isDirectMention: false,
            isDigest: false,
            isSystemMessage: false,
            tags: {
              source: "slack",
              channelId: m.channel,
              author: m.username ?? m.user,
              isThreadReply: Boolean(m.isThreadReply),
            },
          });
          const event = MessageCreatedEventSchema.parse({ type: "MessageCreated", message: normalized });
          this.nats.publish(subjectFor("slack", "messageCreated"), this.sc.encode(JSON.stringify(event)));

          const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
          const embedding = m.text ? await this.aiEmbed(String(m.text)) : [];
          if (embedding.length && (!Number.isFinite(embedDim) || embedding.length === embedDim)) {
            await client.query(
              `
              INSERT INTO mod_slack.slack_message_embeddings (
                id, channel_id, narrative_key, ts, embedding
              ) VALUES ($1, $2, $3, to_timestamp($4), $5::vector)
              ON CONFLICT (id) DO NOTHING
              `,
              [sourceId, m.channel, narrativeKey, tsNum, `[${embedding.join(",")}]`]
            );
          } else if (embedding.length) {
            this.log("warn", "embedding dimension mismatch", {
              expected: embedDim,
              got: embedding.length,
            });
          }
          published++;
        }
      }

      await client.query("COMMIT");
      this.log("info", "slack collect finished", { insertedOrUpdated: count, publishedNew: published });
      return { insertedOrUpdated: count, publishedNew: published };
    } catch (e) {
      await client.query("ROLLBACK");
      this.log(
        "error",
        "slack collect failed (job will fail)",
        e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : e
      );
      throw e;
    } finally {
      client.release();
    }
  }

  async refreshNarratives(params: { lookbackHours: number }): Promise<{
    updated: number;
    aiSummaries: number;
    fallbackSummaries: number;
    embeddingsInserted: number;
    avgTokenRate?: number;
  }> {
    const cutoff = new Date(Date.now() - params.lookbackHours * 3600_000);
    const res = await this.db.query(
      `
      SELECT DISTINCT ON (channel_id, COALESCE(thread_ts, slack_ts))
        channel_id,
        slack_ts,
        thread_ts,
        text,
        ts
      FROM mod_slack.slack_messages
      WHERE ts >= $1
      ORDER BY channel_id, COALESCE(thread_ts, slack_ts), ts DESC
      `,
      [cutoff]
    );

    let updated = 0;
    let aiSummaries = 0;
    let fallbackSummaries = 0;
    let embeddingsInserted = 0;
    let tokenRateSum = 0;
    let tokenRateCount = 0;
    for (const row of res.rows as Array<{
      channel_id: string;
      slack_ts: string;
      thread_ts: string | null;
      text: string | null;
    }>) {
      const narrativeKey = `${row.channel_id}:${row.thread_ts ?? row.slack_ts}`;
      const sourceId = `slack-${row.channel_id}-${row.slack_ts}`;
      const msgId = slackSourceIdToBusMessageId(sourceId);
      if (!row.thread_ts) {
        const channelName = this.settings.channelNameMap[row.channel_id] ?? row.channel_id;
        const summaryShort = this.settings.nonThreadNarrativeTemplate.replace("{channel}", channelName).slice(0, 128);
        await this.publishNarrativeUpdate({
          narrativeKey,
          messageId: msgId,
          summaryShort,
          summaryLong: summaryShort,
          keyPoints: [],
        });
        fallbackSummaries++;
        updated++;
        continue;
      }

      const prior = await this.db.query(
        `SELECT "summaryLong" FROM bus_narratives WHERE "ownerModule" = $1 AND "sourceKey" = $2 LIMIT 1`,
        ["slack", narrativeKey]
      );
      const priorSummary = String(prior.rows?.[0]?.summaryLong ?? "");
      const threadRootTs = row.thread_ts ?? row.slack_ts;
      const topK = Number.isFinite(this.narrativeTopK) ? this.narrativeTopK : 20;

      const countRes = await this.db.query(
        `
        SELECT COUNT(*)::int AS c FROM mod_slack.slack_messages
        WHERE channel_id = $1 AND (
          (thread_ts IS NULL AND slack_ts = $2)
          OR (thread_ts = $2)
        )
        `,
        [row.channel_id, threadRootTs]
      );
      const threadMsgCount = Number(countRes.rows?.[0]?.c ?? 0);

      let messages: Array<string> = [];

      if (threadMsgCount > 0 && threadMsgCount <= topK) {
        const chron = await this.db.query(
          `
          SELECT text FROM mod_slack.slack_messages
          WHERE channel_id = $1 AND (
            (thread_ts IS NULL AND slack_ts = $2)
            OR (thread_ts = $2)
          )
          ORDER BY ts ASC
          LIMIT $3
          `,
          [row.channel_id, threadRootTs, topK]
        );
        messages = (chron.rows ?? []).map((r: { text: string | null }) => String(r.text ?? "")).filter(Boolean);
      }

      if (messages.length === 0 && threadMsgCount > topK) {
        const queryText = priorSummary || String(row.text ?? "");
        const queryEmbedding = await this.aiEmbed(queryText);
        if (queryEmbedding) {
          const embRows = await this.db.query(
            `
            SELECT m.text
            FROM mod_slack.slack_message_embeddings e
            JOIN mod_slack.slack_messages m ON m.id = e.id
            WHERE e.narrative_key = $1
            ORDER BY e.embedding <-> $2::vector
            LIMIT $3
            `,
            [narrativeKey, `[${queryEmbedding.join(",")}]`, topK]
          );
          messages = (embRows.rows ?? []).map((r: { text: string | null }) => String(r.text ?? "")).filter(Boolean);
        }
      }

      if (messages.length === 0) {
        const fallback = await this.db.query(
          `
          SELECT text FROM mod_slack.slack_messages
          WHERE channel_id = $1 AND (
            (thread_ts IS NULL AND slack_ts = $2)
            OR (thread_ts = $2)
          )
          ORDER BY ts DESC
          LIMIT $3
          `,
          [row.channel_id, threadRootTs, topK]
        );
        messages = (fallback.rows ?? []).map((r: { text: string | null }) => String(r.text ?? "")).filter(Boolean);
        if (messages.length === 0) {
          this.log("warn", "no thread messages found for narrative", { narrativeKey, channelId: row.channel_id });
        }
      }

      const prompt = [
        priorSummary ? `Prior summary:\n${priorSummary}` : "",
        "Summarize ONLY the messages listed below. Do not make suggestions or ask questions.",
        "Recent messages:",
        ...messages.map((m, i) => `(${i + 1}) ${m}`),
      ]
        .filter(Boolean)
        .join("\n");
      const maxPromptChars = 8000;
      const promptText = prompt.length > maxPromptChars ? prompt.slice(0, maxPromptChars) : prompt;

      const aiSummary = await this.aiGenerate(promptText);

      const narrativeEmbedding = await this.aiEmbed(aiSummary.summaryLong);
      if (narrativeEmbedding.length) embeddingsInserted++;
      if (typeof aiSummary.tokenRate === "number") {
        tokenRateSum += aiSummary.tokenRate;
        tokenRateCount += 1;
      }
      await this.publishNarrativeUpdate({
        narrativeKey,
        messageId: msgId,
        summaryShort: aiSummary.summaryShort,
        summaryLong: aiSummary.summaryLong,
        keyPoints: [],
        ...(narrativeEmbedding.length ? { embedding: narrativeEmbedding } : {}),
      });
      aiSummaries++;
      updated++;
    }

    return {
      updated,
      aiSummaries,
      fallbackSummaries,
      embeddingsInserted,
      ...(tokenRateCount ? { avgTokenRate: tokenRateSum / tokenRateCount } : {}),
    };
  }
}


