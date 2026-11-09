import { describe, expect, it } from "bun:test";
import type { Context } from "@opencode/plugin/promise/plugin";
import { registerMemoryTools } from "../src/tools.js";
import { createTestRuntime } from "./helpers.js";

describe("tool registration", () => {
  it("registers exactly memory_search and memory_mutate", async () => {
    const runtime = createTestRuntime();
    const added: Array<{ name: string; execute: (args: unknown, ctx: unknown) => Promise<{ content: string }> }> = [];
    const ctx = {
      tool: {
        transform: async (callback: (editor: unknown) => void) => {
          callback({
            add: (tool: { name: string }) => added.push(tool as never),
            get: () => undefined,
            list: () => [],
            namespace: () => {},
            update: () => {},
            remove: () => {},
          });
        },
      },
    } as unknown as Context;

    try {
      await registerMemoryTools(ctx, runtime.service);
      expect(added.map((tool) => tool.name)).toEqual(["memory_search", "memory_mutate"]);

      const mutate = added.find((tool) => tool.name === "memory_mutate")!;
      const addResult = JSON.parse(
        (
          await mutate.execute(
            {
              action: "add",
              title: "工具测试",
              category: "arch_decision",
              content: "工具写入走同一服务",
            },
            {}
          )
        ).content
      ) as { success: boolean; id: string; version: number };
      expect(addResult.success).toBe(true);
      expect(addResult.version).toBe(1);

      const search = added.find((tool) => tool.name === "memory_search")!;
      const hits = JSON.parse(
        (await search.execute({ query: "工具写入", limit: 5 }, {})).content
      ) as Array<{ id: string; version: number; title: string }>;
      expect(hits).toHaveLength(1);
      expect(hits[0]?.id).toBe(addResult.id);
      expect(hits[0]?.version).toBe(1);

      const invalid = JSON.parse(
        (
          await mutate.execute(
            { action: "add", title: "过长", category: "domain_rule", content: "字".repeat(201) },
            {}
          )
        ).content
      ) as { success: boolean; code: string };
      expect(invalid.success).toBe(false);
      expect(invalid.code).toBe("content_too_long");
    } finally {
      await runtime.cleanup();
    }
  });
});
