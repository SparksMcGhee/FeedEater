import { TagAppendedEventSchema } from "../contracts/busEvents.js";

export const TAGS_APPENDED_SUBJECT = "feedeater.tags.appended";

export function createTagAppended(params: {
  createdByModule: string;
  messageId: string;
  key: string;
  value: string | number | boolean;
  createdAt?: string;
  id?: string;
}) {
  const id = params.id ?? crypto.randomUUID();
  const createdAt = params.createdAt ?? new Date().toISOString();
  return TagAppendedEventSchema.parse({
    type: "TagAppended",
    id,
    createdAt,
    createdByModule: params.createdByModule,
    messageId: params.messageId,
    key: params.key,
    value: params.value,
  });
}
