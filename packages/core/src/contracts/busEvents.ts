import { z } from "zod";

import { MessageTagValueSchema, NormalizedMessageSchema } from "./message.js";

export const MessageCreatedEventSchema = z.object({
  type: z.literal("MessageCreated"),
  message: NormalizedMessageSchema,
});
export type MessageCreatedEvent = z.infer<typeof MessageCreatedEventSchema>;

export const NarrativeSummarySchema = z.object({
  ownerModule: z.string(),
  sourceKey: z.string().optional(),
  summaryShort: z.string().max(128),
  summaryLong: z.string(),
  keyPoints: z.array(z.string()).default([]),
  embedding: z.array(z.number()).optional(),
});
export type NarrativeSummary = z.infer<typeof NarrativeSummarySchema>;

export const NarrativeUpdatedEventSchema = z.object({
  type: z.literal("NarrativeUpdated"),
  createdAt: z.string().datetime(),
  messageId: z.string().uuid().optional(),
  narrative: NarrativeSummarySchema,
});
export type NarrativeUpdatedEvent = z.infer<typeof NarrativeUpdatedEventSchema>;

export const TagAppendedEventSchema = z.object({
  type: z.literal("TagAppended"),
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  createdByModule: z.string(),
  messageId: z.string().uuid(),
  key: z.string(),
  value: MessageTagValueSchema,
});
export type TagAppendedEvent = z.infer<typeof TagAppendedEventSchema>;

export const BusEventSchema = z.union([
  MessageCreatedEventSchema,
  NarrativeUpdatedEventSchema,
  TagAppendedEventSchema,
]);
export type BusEvent = z.infer<typeof BusEventSchema>;
