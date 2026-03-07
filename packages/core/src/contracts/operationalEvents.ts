import { z } from "zod";

export const IngestRejectedEventSchema = z.object({
  type: z.literal("IngestRejected"),
  module: z.string(),
  timestamp: z.string().datetime(),
  reason: z.string(),
  source_subject: z.string().optional(),
  source_symbol: z.string().optional(),
  symbol: z.string().optional(),
  ticker: z.string().optional(),
  pair: z.string().optional(),
  error_code: z.string().optional(),
  stage: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});
export type IngestRejectedEvent = z.infer<typeof IngestRejectedEventSchema>;

export const HealthStatusEventSchema = z.object({
  type: z.literal("HealthStatus"),
  module: z.string(),
  status: z.string().min(1),
  timestamp: z.string().datetime(),
  details: z.record(z.unknown()).optional(),
});
export type HealthStatusEvent = z.infer<typeof HealthStatusEventSchema>;
