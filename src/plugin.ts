import type { Plugin } from "@opencode/plugin/promise/plugin";
import pkg from "../package.json" with { type: "json" };

/**
 * Placeholder entry while the legacy subsystems are removed.
 * Stage 1 replaces this with the project-scoped memory tools.
 */
const OpenCodeCortexPlugin: Plugin = {
  id: typeof pkg.name === "string" && pkg.name.trim() ? pkg.name.trim() : "opencode-cortex",
  async setup() {},
};

export default OpenCodeCortexPlugin;
