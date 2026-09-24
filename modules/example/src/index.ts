import { MessageCreatedEventSchema, NormalizedMessageSchema, subjectFor } from "@feedeater/core";
import type { NatsConnection, StringCodec } from "nats";
import { v4 as uuidv4 } from "uuid";

export async function runExampleTick(params: { nats: NatsConnection; sc: StringCodec }) {
  const msg = NormalizedMessageSchema.parse({
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    source: { module: "example", stream: "scheduler" },
    realtime: true,
    Message: "Hello from FeedEater example module",
    isDirectMention: false,
    isDigest: false,
    isSystemMessage: true,
    tags: { example: true },
  });

  const event = MessageCreatedEventSchema.parse({ type: "MessageCreated", message: msg });
  params.nats.publish(
    subjectFor("example", "messageCreated"),
    params.sc.encode(JSON.stringify(event)),
  );
}

export { createModuleRuntime } from "./runtime.js";
