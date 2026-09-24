import { prisma } from "@feedeater/db";
import type { Request, Response } from "express";

import { decryptSecret } from "./crypto.js";

type SlackConversationsListResponse = {
  ok: boolean;
  error?: string;
  needed?: string;
  provided?: string;
  channels?: Array<{
    id: string;
    name?: string;
    is_private?: boolean;
    is_member?: boolean;
    is_archived?: boolean;
    num_members?: number;
    purpose?: { value?: string };
    topic?: { value?: string };
  }>;
  response_metadata?: { next_cursor?: string };
};

export type SlackChannelSummary = {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
  isArchived: boolean;
  numMembers?: number | undefined;
  purpose?: string | undefined;
  topic?: string | undefined;
};

async function loadSlackBotToken(): Promise<string> {
  const row = await prisma.setting.findUnique({
    where: { module_key: { module: "slack", key: "botToken" } },
  });
  if (!row?.value) {
    const err = new Error('Slack setting "botToken" is required');
    (err as any).statusCode = 400;
    throw err;
  }
  if (!row.isSecret) return row.value;
  return decryptSecret(row.value);
}

async function slackGet<T>(token: string, url: URL): Promise<T> {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
  });
  const data = (await res.json().catch(() => null)) as T | null;
  if (!res.ok || !data) {
    const err = new Error(`Slack API request failed (${res.status})`);
    (err as any).statusCode = 502;
    throw err;
  }
  return data;
}

async function listSlackChannels(
  token: string,
  opts: { includeArchived: boolean; types: string[] },
) {
  const out: SlackChannelSummary[] = [];

  let cursor = "";
  let pages = 0;
  const maxPages = 30; // defensive

  while (pages < maxPages) {
    pages++;
    const url = new URL("https://slack.com/api/conversations.list");
    url.searchParams.set("limit", "200");
    url.searchParams.set("exclude_archived", opts.includeArchived ? "false" : "true");
    url.searchParams.set("types", opts.types.join(","));
    if (cursor) url.searchParams.set("cursor", cursor);

    const data = await slackGet<SlackConversationsListResponse>(token, url);
    if (!data.ok) {
      const bits: string[] = [];
      if (data.error) bits.push(`Slack error: ${data.error}`);
      else bits.push("Slack error");
      if (data.needed) bits.push(`needed: ${data.needed}`);
      if (data.provided) bits.push(`provided: ${data.provided}`);

      // Extra hint for the common case where we can infer the missing scopes by requested types.
      if (data.error === "missing_scope" && !data.needed) {
        const hints: string[] = [];
        if (opts.types.includes("public_channel")) hints.push("channels:read");
        if (opts.types.includes("private_channel")) hints.push("groups:read");
        if (hints.length)
          bits.push(`hint: add OAuth scope(s) ${hints.join(", ")} and reinstall the app`);
      }

      const err = new Error(bits.join(" · "));
      (err as any).statusCode = 502;
      throw err;
    }

    for (const c of data.channels ?? []) {
      if (!c?.id) continue;
      out.push({
        id: String(c.id),
        name: c.name ? String(c.name) : String(c.id),
        isPrivate: Boolean(c.is_private),
        isMember: Boolean(c.is_member),
        isArchived: Boolean(c.is_archived),
        numMembers: typeof c.num_members === "number" ? c.num_members : undefined,
        purpose: c.purpose?.value ? String(c.purpose.value) : undefined,
        topic: c.topic?.value ? String(c.topic.value) : undefined,
      });
    }

    cursor = String(data.response_metadata?.next_cursor ?? "").trim();
    if (!cursor) break;
  }

  // Stable-ish sorting: member channels first, then name.
  out.sort((a, b) => {
    if (a.isMember !== b.isMember) return a.isMember ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { channels: out, pages };
}

export async function getSlackChannels(req: Request, res: Response) {
  try {
    const token = await loadSlackBotToken();

    const includeArchived = String(req.query.includeArchived ?? "false") === "true";
    const typesParam = String(req.query.types ?? "public_channel,private_channel");
    const types = typesParam
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (types.length === 0) {
      res.status(400).json({ error: "types must be a comma-separated list" });
      return;
    }

    const data = await listSlackChannels(token, { includeArchived, types });
    res.json({ ok: true, ...data });
  } catch (e) {
    const status = typeof (e as any)?.statusCode === "number" ? Number((e as any).statusCode) : 500;
    res.status(status).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
