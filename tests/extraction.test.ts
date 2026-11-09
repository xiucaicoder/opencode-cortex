import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runAutoExtraction, parseExtractionItems, type RawSessionMessage } from "../src/extraction.js";
import { createTestRuntime } from "./helpers.js";

const messages: RawSessionMessage[] = [
  {
    id: "m1",
    type: "user",
    text: "我们确认：退款金额超过 500 元必须由财务审核，客服不能直接通过。",
    time: { created: 1 },
  },
  {
    id: "m2",
    type: "assistant",
    text: "已记录，退款超过 500 元需要财务审核。",
    time: { created: 2 },
  },
];

describe("extraction output parsing", () => {
  it("returns an empty array for []", () => {
    expect(parseExtractionItems("[]", 10)).toEqual({ items: [], skipped: 0 });
  });

  it("parses fenced JSON and drops shape-invalid items", () => {
    const output = '```json\n[{"action":"add","title":"规则","category":"domain_rule","content":"结论"},{"action":"delete"},{"action":"update","title":"无 id","category":"pitfall","content":"x"}]\n```';
    const parsed = parseExtractionItems(output, 10);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.action).toBe("add");
    expect(parsed.skipped).toBe(2);
  });

  it("throws on non-array output", () => {
    expect(() => parseExtractionItems('{"action":"add"}', 10)).toThrow("JSON 数组");
  });
});

describe("auto extraction", () => {
  it("returns [] without writing when the model finds nothing", async () => {
    const runtime = createTestRuntime();
    try {
      const config = {
        ...runtime.config,
        autoExtract: { ...runtime.config.autoExtract, minInputChars: 10 },
      };
      const outcome = await runAutoExtraction("s1", config, {
        service: runtime.service,
        generate: async () => "[]",
        readPrompt: () => "PROMPT",
        getMessages: async () => messages,
      });
      expect(outcome.status).toBe("ok");
      expect(outcome.added).toBe(0);
      expect(await runtime.service.listActive()).toHaveLength(0);
    } finally {
      await runtime.cleanup();
    }
  });

  it("writes auto entries through the shared validation path", async () => {
    const runtime = createTestRuntime();
    try {
      const config = {
        ...runtime.config,
        autoExtract: { ...runtime.config.autoExtract, minInputChars: 10, cooldownMinutes: 0 },
      };
      const output = JSON.stringify([
        {
          action: "add",
          title: "退款审核",
          category: "domain_rule",
          content: "退款超过 500 元必须财务审核",
          related_files: ["src/refund.ts"],
        },
      ]);
      const outcome = await runAutoExtraction("s1", config, {
        service: runtime.service,
        generate: async () => output,
        readPrompt: () => "PROMPT",
        getMessages: async () => messages,
      });
      expect(outcome.status).toBe("ok");
      expect(outcome.added).toBe(1);
      const rows = await runtime.service.listActive();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title).toBe("退款审核");
      expect((await runtime.service.getSessionState("s1")).last_extracted_message_id).toBe("m2");
    } finally {
      await runtime.cleanup();
    }
  });

  it("never updates a manual entry and reports the skipped item", async () => {
    const runtime = createTestRuntime();
    try {
      runtime.embedder.set("退款审核\n旧结论", 0);
      const manual = await runtime.service.mutate({
        action: "add",
        title: "退款审核",
        category: "domain_rule",
        content: "旧结论",
      });
      const config = {
        ...runtime.config,
        autoExtract: { ...runtime.config.autoExtract, minInputChars: 10, cooldownMinutes: 0 },
      };
      const output = JSON.stringify([
        {
          action: "update",
          id: manual.id,
          title: "退款审核",
          category: "domain_rule",
          content: "自动提取试图改写",
        },
      ]);
      const outcome = await runAutoExtraction("s1", config, {
        service: runtime.service,
        generate: async () => output,
        readPrompt: () => "PROMPT",
        getMessages: async () => messages,
      });
      expect(outcome.status).toBe("ok");
      expect(outcome.updated).toBe(0);
      expect(outcome.skippedItems).toBe(1);
      const rows = await runtime.service.listActive();
      expect(rows[0]?.content).toBe("旧结论");
    } finally {
      await runtime.cleanup();
    }
  });

  it("skips short increments and respects cooldown", async () => {
    const runtime = createTestRuntime();
    try {
      const config = {
        ...runtime.config,
        autoExtract: {
          ...runtime.config.autoExtract,
          minInputChars: 80,
          cooldownMinutes: 10,
        },
      };
      let calls = 0;
      const short = await runAutoExtraction("short", config, {
        service: runtime.service,
        generate: async () => {
          calls++;
          return "[]";
        },
        readPrompt: () => "PROMPT",
        getMessages: async () => [{ id: "s1", type: "user", text: "ok", time: { created: 1 } }],
      });
      expect(short.reason).toBe("too_short");
      expect(calls).toBe(0);

      const longMessages = messages;
      const longConfig = {
        ...config,
        autoExtract: { ...config.autoExtract, minInputChars: 10 },
      };
      const first = await runAutoExtraction("cooldown", longConfig, {
        service: runtime.service,
        generate: async () => {
          calls++;
          return "[]";
        },
        readPrompt: () => "PROMPT",
        getMessages: async () => longMessages,
        now: () => 1_000_000,
      });
      expect(first.status).toBe("ok");
      const second = await runAutoExtraction("cooldown", longConfig, {
        service: runtime.service,
        generate: async () => {
          calls++;
          return "[]";
        },
        readPrompt: () => "PROMPT",
        getMessages: async () => longMessages,
        now: () => 1_000_000 + 60_000,
      });
      expect(second.reason).toBe("cooldown");
      expect(calls).toBe(1);
    } finally {
      await runtime.cleanup();
    }
  });

  it("keeps the watermark on transient failure and applies failure cooldown", async () => {
    const runtime = createTestRuntime();
    try {
      const config = {
        ...runtime.config,
        autoExtract: {
          ...runtime.config.autoExtract,
          minInputChars: 10,
          cooldownMinutes: 0,
          failureCooldownMinutes: 30,
        },
      };
      let calls = 0;
      const first = await runAutoExtraction("s1", config, {
        service: runtime.service,
        generate: async () => {
          calls++;
          throw new Error("request timed out");
        },
        readPrompt: () => "PROMPT",
        getMessages: async () => messages,
        now: () => 1_000_000,
      });
      expect(first.status).toBe("failed");
      expect(first.reason).toBe("generate");
      expect(first.attempts).toBe(1);
      expect(calls).toBe(1);
      expect((await runtime.service.getSessionState("s1")).last_extracted_message_id).toBeNull();

      const second = await runAutoExtraction("s1", config, {
        service: runtime.service,
        generate: async () => {
          calls++;
          return "[]";
        },
        readPrompt: () => "PROMPT",
        getMessages: async () => messages,
        now: () => 1_060_000,
      });
      expect(second.status).toBe("skipped");
      expect(second.reason).toBe("failure_cooldown");
      expect(calls).toBe(1);
    } finally {
      await runtime.cleanup();
    }
  });

  it("advances the watermark after two transient attempts", async () => {
    const runtime = createTestRuntime();
    try {
      const config = {
        ...runtime.config,
        autoExtract: {
          ...runtime.config.autoExtract,
          minInputChars: 10,
          cooldownMinutes: 0,
          failureCooldownMinutes: 0,
        },
      };
      let calls = 0;
      const failing = async (): Promise<string> => {
        calls++;
        throw new Error("429 rate limit exceeded");
      };
      const first = await runAutoExtraction("s1", config, {
        service: runtime.service,
        generate: failing,
        readPrompt: () => "PROMPT",
        getMessages: async () => messages,
        now: () => 1_000_000,
      });
      expect(first.attempts).toBe(1);
      expect((await runtime.service.getSessionState("s1")).last_extracted_message_id).toBeNull();

      const second = await runAutoExtraction("s1", config, {
        service: runtime.service,
        generate: failing,
        readPrompt: () => "PROMPT",
        getMessages: async () => messages,
        now: () => 1_000_001,
      });
      expect(second.attempts).toBe(2);
      expect((await runtime.service.getSessionState("s1")).last_extracted_message_id).toBe("m2");

      const third = await runAutoExtraction("s1", config, {
        service: runtime.service,
        generate: failing,
        readPrompt: () => "PROMPT",
        getMessages: async () => messages,
        now: () => 1_000_002,
      });
      expect(third.reason).toBe("no_increment");
      expect(calls).toBe(2);
    } finally {
      await runtime.cleanup();
    }
  });

  it("advances the watermark after a non-retryable parse failure", async () => {
    const runtime = createTestRuntime();
    try {
      const config = {
        ...runtime.config,
        autoExtract: {
          ...runtime.config.autoExtract,
          minInputChars: 10,
          cooldownMinutes: 0,
          failureCooldownMinutes: 30,
        },
      };
      let calls = 0;
      const first = await runAutoExtraction("s1", config, {
        service: runtime.service,
        generate: async () => {
          calls++;
          return "not json";
        },
        readPrompt: () => "PROMPT",
        getMessages: async () => messages,
      });
      expect(first.status).toBe("failed");
      expect(first.reason).toBe("parse");
      expect((await runtime.service.getSessionState("s1")).last_extracted_message_id).toBe("m2");

      const second = await runAutoExtraction("s1", config, {
        service: runtime.service,
        generate: async () => {
          calls++;
          return "[]";
        },
        readPrompt: () => "PROMPT",
        getMessages: async () => messages,
      });
      expect(second.reason).toBe("no_increment");
      expect(calls).toBe(1);
    } finally {
      await runtime.cleanup();
    }
  });

  it("redacts conversation secrets before sending the prompt", async () => {
    const runtime = createTestRuntime();
    try {
      const secret = "AKIAIOSFODNN7EXAMPLE";
      let prompt = "";
      const config = {
        ...runtime.config,
        autoExtract: { ...runtime.config.autoExtract, minInputChars: 1 },
      };
      const outcome = await runAutoExtraction("s1", config, {
        service: runtime.service,
        generate: async (value) => {
          prompt = value;
          return "[]";
        },
        readPrompt: () => "PROMPT",
        getMessages: async () => [
          {
            id: "m1",
            type: "user",
            text: `我们确认退款规则时会用到密钥 ${secret}，这条不要记进去。`,
            time: { created: 1 },
          },
        ],
      });
      expect(outcome.status).toBe("ok");
      expect(prompt).toContain("[REDACTED]");
      expect(prompt).not.toContain(secret);
    } finally {
      await runtime.cleanup();
    }
  });

  it("captures dry-run candidates without writing memories", async () => {
    const runtime = createTestRuntime();
    try {
      const config = {
        ...runtime.config,
        autoCaptureDryRun: true,
        autoExtract: {
          ...runtime.config.autoExtract,
          minInputChars: 10,
          cooldownMinutes: 0,
        },
      };
      const output = JSON.stringify([
        {
          action: "add",
          title: "退款审核",
          category: "domain_rule",
          content: "退款超过 500 元必须财务审核",
          related_files: ["src/refund.ts"],
        },
      ]);
      const outcome = await runAutoExtraction("dry-session", config, {
        service: runtime.service,
        generate: async () => output,
        readPrompt: () => "PROMPT",
        getMessages: async () => messages,
      });
      expect(outcome.status).toBe("ok");
      expect(outcome.dryRun).toBe(true);
      expect(outcome.captured).toBe(1);
      expect(await runtime.service.listActive()).toHaveLength(0);

      const file = join(runtime.config.storagePath, "dry-run.jsonl");
      const line = JSON.parse(readFileSync(file, "utf-8").trim()) as Record<string, unknown>;
      expect(line.session_id).toBe("dry-session");
      expect(line.title).toBe("退款审核");
      expect(typeof line.time).toBe("string");
    } finally {
      await runtime.cleanup();
    }
  });

  it("only sends messages after the stored watermark", async () => {
    const runtime = createTestRuntime();
    try {
      await runtime.service.setSessionState("s1", "m2", 0);
      const config = {
        ...runtime.config,
        autoExtract: { ...runtime.config.autoExtract, minInputChars: 1, cooldownMinutes: 0 },
      };
      let prompt = "";
      const all: RawSessionMessage[] = [
        { id: "m1", type: "user", text: "旧的已处理内容", time: { created: 1 } },
        { id: "m2", type: "assistant", text: "旧的回复", time: { created: 2 } },
        { id: "m3", type: "user", text: "新的业务事实：库存按仓库隔离", time: { created: 3 } },
        { id: "m4", type: "assistant", text: "已确认", time: { created: 4 } },
      ];
      await runAutoExtraction("s1", config, {
        service: runtime.service,
        generate: async (value) => {
          prompt = value;
          return "[]";
        },
        readPrompt: () => "PROMPT",
        getMessages: async () => all,
      });
      expect(prompt).toContain("新的业务事实");
      expect(prompt).not.toContain("旧的已处理内容");
    } finally {
      await runtime.cleanup();
    }
  });
});
