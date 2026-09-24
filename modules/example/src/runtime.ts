import type { ModuleRuntime } from "@feedeater/module-sdk";

import { runExampleTick } from "./index.js";

export function createModuleRuntime(): ModuleRuntime {
  return {
    moduleName: "example",
    handlers: {
      mod_example: {
        async tick({ ctx }) {
          await runExampleTick({ nats: ctx.nats as any, sc: ctx.sc as any });
        },
        async processMessage() {
          // no-op placeholder
        },
      },
    },
  };
}
