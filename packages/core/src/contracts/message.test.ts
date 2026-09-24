import { describe, expect, it } from "vitest";
import { NormalizedMessageSchema } from "./message";

const base = {
  id: "3f0cbb4a-3f2a-4b46-b98d-59e0a1b2c3d4",
  createdAt: "2026-09-24T00:00:00.000Z",
  source: { module: "slack", stream: "general" },
};

describe("NormalizedMessage contract", () => {
  it("applies documented defaults", () => {
    const parsed = NormalizedMessageSchema.parse(base);
    expect(parsed.tags).toEqual({});
    expect(parsed.isDirectMention).toBe(false);
    expect(parsed.isDigest).toBe(false);
    expect(parsed.isSystemMessage).toBe(false);
    expect(parsed.narrativeRef).toBeUndefined();
  });

  it("round-trips a fully populated message", () => {
    const msg = {
      ...base,
      realtime: true,
      Message: "hello",
      From: "alice",
      isDirectMention: true,
      likes: 3,
      tags: { channel: "general", mentions: 1, bot: false },
      narrativeRef: { ownerModule: "slack", sourceKey: "C1:t1" },
      followMePanel: {
        module: "slack",
        panelId: "thread",
        href: "https://example.com/t",
        label: "Open",
      },
    };
    const parsed = NormalizedMessageSchema.parse(msg);
    expect(NormalizedMessageSchema.parse(parsed)).toEqual(parsed);
    expect(parsed.narrativeRef).toEqual({ ownerModule: "slack", sourceKey: "C1:t1" });
  });

  it("promotes legacy contextRef payloads to narrativeRef", () => {
    const parsed = NormalizedMessageSchema.parse({
      ...base,
      contextRef: { ownerModule: "slack", sourceKey: "C2:t2" },
    });
    expect(parsed.narrativeRef).toEqual({ ownerModule: "slack", sourceKey: "C2:t2" });
    expect("contextRef" in parsed).toBe(false);
  });

  it("rejects malformed payloads", () => {
    expect(() => NormalizedMessageSchema.parse({ ...base, id: "not-a-uuid" })).toThrow();
    expect(() => NormalizedMessageSchema.parse({ ...base, createdAt: "yesterday" })).toThrow();
    expect(() => NormalizedMessageSchema.parse({ ...base, likes: -1 })).toThrow();
  });
});
