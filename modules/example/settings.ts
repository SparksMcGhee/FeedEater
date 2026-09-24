import { z } from "zod";

export const ExampleSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  // Stored encrypted at rest by the platform settings registry.
  demoSecret: z.string().optional(),
});

export type ExampleSettings = z.infer<typeof ExampleSettingsSchema>;
