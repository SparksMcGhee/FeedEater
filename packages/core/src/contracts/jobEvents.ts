import { z } from "zod";

export const JobTriggerSchema = z.object({
  type: z.enum(["schedule", "manual", "event"]),
  subject: z.string().optional(),
  messageId: z.string().uuid().optional(),
});
export type JobTrigger = z.infer<typeof JobTriggerSchema>;

export const JobRunEventSchema = z.object({
  type: z.literal("JobRun"),
  module: z.string(),
  queue: z.string(),
  job: z.string(),
  requestedAt: z.string().datetime(),
  runId: z.string().uuid().optional(),
  trigger: JobTriggerSchema,
  data: z.unknown().optional(),
});
export type JobRunEvent = z.infer<typeof JobRunEventSchema>;
