import { z } from "zod";

export const MessageTagValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export type MessageTagValue = z.infer<typeof MessageTagValueSchema>;

export const MessageTagsSchema = z.record(MessageTagValueSchema);
export type MessageTags = z.infer<typeof MessageTagsSchema>;

export const FollowMePanelSchema = z.object({
  module: z.string(),
  panelId: z.string(),
  href: z.string().url().optional(),
  label: z.string().optional(),
});
export type FollowMePanel = z.infer<typeof FollowMePanelSchema>;

export const MessageNarrativeRefSchema = z.object({
  ownerModule: z.string(),
  sourceKey: z.string(),
});
export type MessageNarrativeRef = z.infer<typeof MessageNarrativeRefSchema>;

/** @deprecated Prefer MessageNarrativeRef — alias for legacy archived payloads */
export const MessageContextRefSchema = MessageNarrativeRefSchema;
/** @deprecated Prefer MessageNarrativeRef */
export type MessageContextRef = MessageNarrativeRef;

const NormalizedMessageInputSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  source: z.object({
    module: z.string(),
    stream: z.string().optional(),
  }),
  // True only for first-time, live emissions (not bulk replay).
  realtime: z.boolean().optional(),
  // Human-readable body.
  Message: z.string().optional(),
  // Narrative linkage (summaries live on narratives, not messages). Legacy key: contextRef.
  narrativeRef: MessageNarrativeRefSchema.optional(),
  contextRef: MessageNarrativeRefSchema.optional(),
  // Module-provided drill-down panel association.
  followMePanel: FollowMePanelSchema.optional(),
  From: z.string().optional(),
  isDirectMention: z.boolean().default(false),
  isDigest: z.boolean().default(false),
  isSystemMessage: z.boolean().default(false),
  likes: z.number().int().nonnegative().optional(),
  tags: MessageTagsSchema.default({}),
});

export const NormalizedMessageSchema = NormalizedMessageInputSchema.transform((data) => {
  const { contextRef, narrativeRef, ...rest } = data;
  const ref = narrativeRef ?? contextRef;
  return ref !== undefined ? { ...rest, narrativeRef: ref } : { ...rest };
});

export type NormalizedMessage = z.output<typeof NormalizedMessageSchema>;
