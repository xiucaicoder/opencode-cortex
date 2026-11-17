import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
      await registerMemoryTools(ctx, runtime.service, {
        getMessages: async () => [
          { id: "user-message", type: "user", text: "工具写入走同一服务，但是否启用自动归档还没定" },
        ],
        verify: async (reviews) => reviews.map((review) => ({ supported: review.content === "工具写入走同一服务" })),
        blockedPatterns: [],
        onWrite: () => {},
      });
      const toolContext = { sessionID: "s1", messageID: "assistant-message" };
      expect(added.map((tool) => tool.name)).toEqual(["memory_search", "memory_mutate"]);

      const mutate = added.find((tool) => tool.name === "memory_mutate")!;
      expect(String((mutate as unknown as { description: string }).description))
        .toContain("立即调用本工具并附其原话");
      const addResult = JSON.parse(
        (
          await mutate.execute(
            {
              action: "add",
              title: "工具测试",
              category: "arch_decision",
              content: "工具写入走同一服务",
              evidence_quote: "工具写入走同一服务",
            },
            toolContext
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

      const rejected = await mutate.execute({
        action: "add", title: "自动归档", category: "arch_decision", content: "启用自动归档",
        evidence_quote: "是否启用自动归档还没定",
      }, toolContext);
      expect(JSON.parse(rejected.content)).toMatchObject({ code: "unverified_evidence" });
      expect((await runtime.service.listActive())[0]).toMatchObject({
        source: "manual", source_ref: "opencode-session:s1/message:user-message",
      });

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

      const logText = readFileSync(
        join(dirname(runtime.config.storagePath), "test.log"),
        "utf-8"
      );
      expect(logText).toContain("memory search");
      expect(logText).toMatch(/"hits":1/);
      expect(logText).toContain("memory tool error");
      expect(logText).toContain("unverified_evidence");
    } finally {
      await runtime.cleanup();
    }
  });
});
