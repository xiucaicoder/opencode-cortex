import type { Plugin } from "@opencode/plugin/promise/plugin";
import { createRuntime } from "./runtime.js";
import { registerMemoryTools } from "./tools.js";

const OpenCodeCortexPlugin: Plugin = {
  id: "opencode-cortex",
  async setup(ctx) {
    const runtime = createRuntime(ctx.location.directory);
    await registerMemoryTools(ctx, runtime.service);
    return async () => {
      await runtime.service.close();
    };
  },
};

export default OpenCodeCortexPlugin;
