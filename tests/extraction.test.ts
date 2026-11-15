import { describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "@tursodatabase/database";
import { runAutoExtraction, parseExtractionItems, type RawSessionMessage } from "../src/extraction.js";
import { createEvidenceVerifier, type VerifyEvidence } from "../src/evidence.js";
import { MemoryStore } from "../src/store.js";
import { createSecondService, createTestRuntime } from "./helpers.js";

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

const refund = {
  action: "add",
  title: "退款审核",
  category: "domain_rule",
  content: "退款超过 500 元必须财务审核",
  evidence_index: 1,
  evidence_quote: "退款金额超过 500 元必须由财务审核",
};

const verify: VerifyEvidence = async (items) => items.map(() => ({ supported: true }));

describe("extraction output parsing", () => {
  it("returns an empty array for []", () => {
    expect(parseExtractionItems("[]", 10)).toEqual({ items: [], skipped: 0 });
  });

  it("parses fenced JSON and drops shape-invalid items", () => {
    const output = "```json\n" + JSON.stringify([
      refund,
      { ...refund, action: "delete" },
      { ...refund, action: "update" },
    ]) + "\n```";
    const parsed = parseExtractionItems(output, 10);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.action).toBe("add");
    expect(parsed.skipped).toBe(2);
  });

  it("reads an array with prose and unrelated bracketed words without accepting a truncated result", () => {
    const output = `参考 [旧记忆]，结果是 ${JSON.stringify([refund])}。已完成 [说明]`;
    expect(parseExtractionItems(output, 10).items).toHaveLength(1);
    expect(() => parseExtractionItems(`先给一个结果 []，最终结果 [{`, 10)).toThrow();
  });

  it("throws on non-array output", () => {
    expect(() => parseExtractionItems('{"action":"add"}', 10)).toThrow("JSON 数组");
  });
});

describe("auto extraction", () => {
  it("isolates a conflicting rule without blocking the batch", async () => {
    const runtime = createTestRuntime();
    try {
      runtime.embedder.set("售后时限\n售后期限为180天", 0);
      await runtime.service.mutate({ action: "add", title: "售后时限", category: "domain_rule", content: "售后期限为180天" }, "auto");
      runtime.embedder.setSimilarity("售后时限\n售后期限为90天", 0.97);
      const config = { ...runtime.config, autoExtract: { ...runtime.config.autoExtract, minInputChars: 1, cooldownMinutes: 0 } };
      const outcome = await runAutoExtraction("conflict-session", config, {
        service: runtime.service,
        verify,
        readPrompt: () => "PROMPT",
        getMessages: async () => [{ id: "m1", type: "user", text: "售后期限为90天" }],
        generate: async () => JSON.stringify([{ action: "add", title: "售后时限", category: "domain_rule", content: "售后期限为90天", evidence_index: 1, evidence_quote: "售后期限为90天" }]),
      });
      expect(outcome).toMatchObject({ status: "ok", conflicts: 1 });
      expect((await runtime.service.getSessionState("conflict-session")).last_extracted_message_id).toBe("m1");
      expect(await runtime.service.search("售后期限")).toEqual([]);
      expect(await runtime.service.listTitles(10)).toEqual([]);
      expect(await runtime.service.listConflicts()).toMatchObject([{ content: "售后期限为90天" }]);

      const unrelated = "支付回调以网关流水号幂等";
      runtime.embedder.set("支付回调\n" + unrelated, 1.4);
      const later = await runAutoExtraction("conflict-session", config, {
        service: runtime.service,
        readPrompt: () => "PROMPT",
        verify,
        getMessages: async () => [
          { id: "m1", type: "user", text: "售后期限为90天" },
          { id: "m2", type: "user", text: unrelated },
        ],
        generate: async () => JSON.stringify([{ ...refund, title: "支付回调", content: unrelated, evidence_quote: unrelated }]),
      });
      expect(later).toMatchObject({ status: "ok", added: 1 });

      runtime.embedder.set("售后期限", 0);
      const [uncertain] = await runtime.service.search("售后期限", 1, true);
      expect(uncertain?.content).toBe("售后期限为180天");
      const correction = "确认更正：售后期限为90天";
      const resolved = await runAutoExtraction("confirmed-change", config, {
        service: runtime.service,
        readPrompt: () => "PROMPT",
        verify,
        getMessages: async () => [{ id: "m1", type: "user", text: correction, time: { created: 100 } }],
        generate: async () => JSON.stringify([{ ...refund, action: "update", id: uncertain?.id,
          title: "售后时限", content: "售后期限为90天", evidence_quote: correction }]),
      });
      expect(resolved).toMatchObject({ status: "ok", updated: 1 });
      expect(await runtime.service.listConflicts()).toEqual([]);
      expect((await runtime.service.search("售后期限")).map(({ content }) => content))
        .not.toContain("售后期限为180天");
    } finally { await runtime.cleanup(); }
  });
  it("keeps the existing scope searchable when similar wording has no known contradiction", async () => {
    const runtime = createTestRuntime();
    const original = "普通商品售后期限为签收后90天";
    const reworded = "普通商品签收后的有效售后期为90天";
    const title = "普通商品售后期限";
    runtime.embedder.set(`${title}\n${original}`, 0);
    runtime.embedder.setSimilarity(`${title}\n${reworded}`, 0.97);
    try {
      await runtime.service.mutate({ action: "add", title, category: "domain_rule", content: original }, "auto");
      const config = { ...runtime.config, autoExtract: { ...runtime.config.autoExtract, minInputChars: 1 } };
      const result = await runAutoExtraction("rewording", config, {
        service: runtime.service, verify, readPrompt: () => "PROMPT",
        generate: async () => JSON.stringify([{ ...refund, title, content: reworded, evidence_quote: reworded }]),
        getMessages: async () => [{ id: "m1", type: "user", text: reworded }],
      });
      expect(result).toMatchObject({ status: "ok", conflicts: 1, added: 0 });
      expect((await runtime.service.search(title)).map(({ content }) => content)).toEqual([original]);
      expect(await runtime.service.listConflicts()).toMatchObject([{ blocks_recall: 0, content: reworded }]);
    } finally {
      await runtime.cleanup();
    }
  });

  it("keeps distinct scopes and updates only newer evidence for the same rule", async () => {
    const runtime = createTestRuntime();
    const config = { ...runtime.config, autoExtract: { ...runtime.config.autoExtract, minInputChars: 1 } };
    const oldText = "普通商品售后期限为180天";
    const otherText = "生鲜商品售后期限为7天";
    const newText = "普通商品售后期限为90天";
    const title = "售后时限";
    runtime.embedder.set(`${title}\n${oldText}`, 0);
    runtime.embedder.setSimilarity(`${title}\n${otherText}`, 0.97);
    async function capture(session: string, time: number, text: string, id?: string, distinct?: string) {
      return runAutoExtraction(session, config, {
        service: runtime.service,
        readPrompt: () => "PROMPT",
        verify: async (items) => items.map(() => ({ supported: true, distinct_from: distinct ? [distinct] : [] })),
        getMessages: async () => [{ id: "m1", type: "user", text, time: { created: time } }],
        generate: async () => JSON.stringify([{ ...refund, title,
          action: id ? "update" : "add", id, content: text, evidence_quote: text }]),
      });
    }
    try {
      expect((await capture("original", 100, oldText)).added).toBe(1);
      const original = (await runtime.service.listActive())[0]!;
      expect((await capture("other-scope", 120, otherText, undefined, original.id)).added).toBe(1);
      expect((await capture("correction", 140, newText, original.id)).updated).toBe(1);
      expect((await capture("replay", 110, oldText, original.id)).skippedItems).toBe(1);
      expect((await runtime.service.search("售后期限")).map(({ content }) => content).sort())
        .toEqual([newText, otherText].sort());
      expect(await runtime.service.listConflicts()).toEqual([]);
    } finally {
      await runtime.cleanup();
    }
  });

  it("keeps unsupported semantics out and retries when the verifier is unavailable", async () => {
    const runtime = createTestRuntime();
    const config = { ...runtime.config, autoExtract: { ...runtime.config.autoExtract,
      minInputChars: 1, failureCooldownMinutes: 0 } };
    const quote = "这次补偿的原因还没查清";
    const deps = {
      service: runtime.service,
      readPrompt: () => "PROMPT",
      getMessages: async () => [{ id: "m1", type: "user", text: quote }],
      generate: async () => JSON.stringify([{ ...refund, content: "补偿失败源于库存重复扣除", evidence_quote: quote }]),
    };
    try {
      const failed = await runAutoExtraction("unsupported", config, {
        ...deps, verify: async () => { throw new Error("unavailable"); },
      });
      expect(failed.reason).toBe("verify");
      expect((await runtime.service.getSessionState("unsupported")).last_extracted_message_id).toBeNull();
      const result = await runAutoExtraction("unsupported", config, {
        ...deps, verify: createEvidenceVerifier(async (prompt) => {
          expect(prompt).toContain(quote);
          return '[{"supported":false}]';
        }),
      });
      expect(result).toMatchObject({ status: "ok", added: 0, skippedItems: 1 });
      expect((await runtime.service.getSessionState("unsupported")).last_extracted_message_id).toBe("m1");
    } finally {
      await runtime.cleanup();
    }
  });

  it.each([
    ["部分退款不得关闭整单", "部分退款必须关闭整单"],
    ["退款超过500元需要财务审核", "退款超过1000元需要财务审核"],
  ])("rejects a candidate contradicting quoted evidence", async (quote, content) => {
    const runtime = createTestRuntime();
    try {
      const config = { ...runtime.config, autoExtract: { ...runtime.config.autoExtract, minInputChars: 1 } };
      const outcome = await runAutoExtraction("evidence-guard", config, {
        service: runtime.service,
        verify,
        readPrompt: () => "PROMPT",
        getMessages: async () => [{ id: "m1", type: "user", text: quote }],
        generate: async () => JSON.stringify([{ ...refund, content, evidence_quote: quote }]),
      });
      expect(outcome.added).toBe(0);
      expect(await runtime.service.listActive()).toHaveLength(0);
    } finally {
      await runtime.cleanup();
    }
  });
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
        verify,
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
          ...refund,
          related_files: ["src/refund.ts"],
        },
      ]);
      const outcome = await runAutoExtraction("s1", config, {
        service: runtime.service,
        generate: async () => output,
        verify,
        readPrompt: () => "PROMPT",
        getMessages: async () => messages,
      });
      expect(outcome.status).toBe("ok");
      expect(outcome.added).toBe(1);
      const rows = await runtime.service.listActive();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title).toBe("退款审核");
      expect(rows[0]?.source).toBe("auto");
      const hits = await runtime.service.search("退款需要谁审核");
      expect(hits[0]?.source_ref).toBe("opencode-session:s1/message:m1");
      expect(JSON.stringify(hits)).not.toContain(refund.evidence_quote);
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
          ...refund,
          action: "update",
          id: manual.id,
        },
      ]);
      const outcome = await runAutoExtraction("s1", config, {
        service: runtime.service,
        generate: async () => output,
        verify,
        readPrompt: () => "PROMPT",
        getMessages: async () => messages,
      });
      expect(outcome.status).toBe("ok");
      expect(outcome.updated).toBe(0);
      expect(outcome.conflicts).toBe(1);
      expect(await runtime.service.search("旧结论")).toEqual([]);
      expect(await runtime.service.listConflicts()).toMatchObject([{ current_content: "旧结论" }]);
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
        verify,
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
        verify,
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
        verify,
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
        verify,
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
        verify,
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

  it("retains the watermark after repeated failures and catches up on recovery", async () => {
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
        verify,
        readPrompt: () => "PROMPT",
        getMessages: async () => messages,
        now: () => 1_000_000,
      });
      expect(first.attempts).toBe(1);
      expect((await runtime.service.getSessionState("s1")).last_extracted_message_id).toBeNull();

      const second = await runAutoExtraction("s1", config, {
        service: runtime.service,
        generate: failing,
        verify,
        readPrompt: () => "PROMPT",
        getMessages: async () => messages,
        now: () => 1_000_001,
      });
      expect(second.attempts).toBe(2);
      expect((await runtime.service.getSessionState("s1")).last_extracted_message_id).toBeNull();

      const third = await runAutoExtraction("s1", config, {
        service: runtime.service,
        generate: async () => {
          calls++;
          return JSON.stringify([refund]);
        },
        verify,
        readPrompt: () => "PROMPT",
        getMessages: async () => messages,
        now: () => 1_000_002,
      });
      expect(third.added).toBe(1);
      expect((await runtime.service.getSessionState("s1")).last_extracted_message_id).toBe("m2");
      expect(calls).toBe(3);
    } finally {
      await runtime.cleanup();
    }
  });

  it("keeps an invalid JSON batch pending until a valid response arrives", async () => {
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
        verify,
        readPrompt: () => "PROMPT",
        getMessages: async () => messages,
        now: () => 1_000_000,
      });
      expect(first.status).toBe("failed");
      expect(first.reason).toBe("parse");
      expect((await runtime.service.getSessionState("s1")).last_extracted_message_id).toBeNull();

      const second = await runAutoExtraction("s1", config, {
        service: runtime.service,
        generate: async () => {
          calls++;
          return "[]";
        },
        verify,
        readPrompt: () => "PROMPT",
        getMessages: async () => messages,
        now: () => 1_000_000 + 30 * 60_000,
      });
      expect(second.status).toBe("ok");
      expect((await runtime.service.getSessionState("s1")).last_extracted_message_id).toBe("m2");
      expect(calls).toBe(2);
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
        verify,
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
          ...refund,
          related_files: ["src/refund.ts"],
        },
      ]);
      const outcome = await runAutoExtraction("dry-session", config, {
        service: runtime.service,
        generate: async () => output,
        verify,
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
      expect(line.source_ref).toBe("opencode-session:dry-session/message:m1");
      expect(line).not.toHaveProperty("evidence_quote");
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
        verify,
        readPrompt: () => "PROMPT",
        getMessages: async () => all,
      });
      expect(prompt).toContain("新的业务事实");
      expect(prompt).not.toContain("旧的已处理内容");
    } finally {
      await runtime.cleanup();
    }
  });

  it("resumes a long message after reopening the database and reaches a short tail", async () => {
    const runtime = createTestRuntime();
    const reopened = await createSecondService(runtime.config, runtime.dbPath);
    const rule = "部分退款后订单保持原状态";
    const tail = { ...refund, title: "部分退款状态", content: rule, evidence_quote: rule };
    const transcript = [
      { id: "long", type: "user", text: "🧾背景".repeat(41) },
      { id: "tail", type: "user", text: rule },
    ];
    const config = {
      ...runtime.config,
      autoExtract: { ...runtime.config.autoExtract, maxInputChars: 128, maxMessages: 1 },
    };
    const prompts: string[] = [];
    const deps = {
      generate: async (prompt: string) => {
        prompts.push(prompt);
        return prompt.includes(rule) ? JSON.stringify([tail]) : "[]";
      },
      verify,
      readPrompt: () => "PROMPT",
      getMessages: async () => transcript,
      now: () => 1_000_000,
    };
    try {
      await runAutoExtraction("long", config, { ...deps, service: runtime.service });
      const first = await runtime.service.getSessionState("long");
      expect(first.last_extracted_message_id).toBe("long");
      expect(first.last_extracted_offset).toBeGreaterThan(0);
      expect(prompts[0]).not.toContain(rule);
      await runtime.service.close();

      for (let i = 0; i < 5; i++) {
        const outcome = await runAutoExtraction("long", config, { ...deps, service: reopened.service });
        if (outcome.added) break;
      }
      expect((await reopened.service.listActive()).map((hit) => hit.source_ref))
        .toEqual(["opencode-session:long/message:tail"]);
      const fragments = prompts.flatMap((prompt) =>
        prompt.split("## 本次对话增量\n")[1]!.trim().split("\n\n")[0]!.split("\n")
          .map((line) => JSON.parse(line).text as string)
      );
      expect(fragments.join("")).toBe(transcript[0]!.text + rule);
      expect((await reopened.service.getSessionState("long")).last_extracted_offset).toBe(0);
    } finally {
      await reopened.service.close();
      await runtime.cleanup();
    }
  });

  it.each([
    ["助手推测", 2, "已记录，退款超过 500 元需要财务审核。"],
    ["不存在的消息", 9, refund.evidence_quote],
    ["伪造引文", 1, "退款超过 500 元由客服直接通过"],
    ["引用了输入中的脱敏标记", 1, "[REDACTED]"],
  ])("rejects unsupported evidence: %s", async (_label, evidence_index, evidence_quote) => {
    const runtime = createTestRuntime();
    const config = { ...runtime.config, autoExtract: { ...runtime.config.autoExtract, minInputChars: 1 } };
    try {
      const outcome = await runAutoExtraction("evidence", config, {
        service: runtime.service,
        generate: async () => JSON.stringify([{ ...refund, evidence_index, evidence_quote }]),
        verify,
        readPrompt: () => "PROMPT",
        getMessages: async () => messages,
      });
      expect(outcome.skippedItems).toBe(1);
      expect(await runtime.service.listActive()).toHaveLength(0);
    } finally {
      await runtime.cleanup();
    }
  });

  it("rolls back a partial database write and safely retries after reopening", async () => {
    const runtime = createTestRuntime();
    const reopened = await createSecondService(runtime.config, runtime.dbPath);
    const stock = {
      ...refund,
      title: "库存回补时机",
      content: "仅在取消成功后回补库存",
      evidence_index: 3,
      evidence_quote: "取消成功后回补库存",
    };
    for (const embedder of [runtime.embedder, reopened.embedder]) {
      embedder.set(`${refund.title}\n${refund.content}`, 0);
      embedder.set(`${stock.title}\n${stock.content}`, 1);
    }
    const config = {
      ...runtime.config,
      autoExtract: { ...runtime.config.autoExtract, minInputChars: 1, failureCooldownMinutes: 0 },
    };
    const deps = {
      generate: async () => JSON.stringify([refund, stock]),
      verify,
      readPrompt: () => "PROMPT",
      getMessages: async () => [...messages, { id: "stock", type: "user", text: stock.content }],
    };
    const insert = MemoryStore.prototype.insert;
    let writes = 0;
    const mock = spyOn(MemoryStore.prototype, "insert").mockImplementation(async function (
      this: MemoryStore,
      ...args: Parameters<MemoryStore["insert"]>
    ) {
      if (++writes === 2) throw new Error("simulated write failure");
      await insert.apply(this, args);
    });
    try {
      const failed = await runAutoExtraction("retry", config, { ...deps, service: runtime.service });
      mock.mockRestore();
      expect(failed.reason).toBe("write");
      expect(writes).toBe(2);
      expect(await runtime.service.listActive()).toHaveLength(0);
      expect((await runtime.service.getSessionState("retry")).last_extracted_message_id).toBeNull();
      await runtime.service.close();

      const recovered = await runAutoExtraction("retry", config, { ...deps, service: reopened.service });
      expect(recovered.added).toBe(2);
      expect(await reopened.service.listActive()).toHaveLength(2);
      expect((await reopened.service.getSessionState("retry")).last_extracted_message_id).toBe("stock");
    } finally {
      mock.mockRestore();
      await reopened.service.close();
      await runtime.cleanup();
    }
  });

  it("allows only one concurrent run to commit the same checkpoint", async () => {
    const runtime = createTestRuntime();
    const config = { ...runtime.config, autoExtract: { ...runtime.config.autoExtract, minInputChars: 1 } };
    let calls = 0;
    const barrier = Promise.withResolvers<void>();
    const deps = {
      service: runtime.service,
      generate: async () => {
        if (++calls === 2) barrier.resolve();
        await barrier.promise;
        return JSON.stringify([refund]);
      },
      verify,
      readPrompt: () => "PROMPT",
      getMessages: async () => messages,
    };
    try {
      const outcomes = await Promise.all([
        runAutoExtraction("overlap", config, deps),
        runAutoExtraction("overlap", config, deps),
      ]);
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["ok", "skipped"]);
      expect(await runtime.service.listActive()).toHaveLength(1);
    } finally {
      await runtime.cleanup();
    }
  });

  it("resumes an existing database with a pre-offset checkpoint", async () => {
    const runtime = createTestRuntime();
    const second = await createSecondService(runtime.config, runtime.dbPath);
    try {
      await runtime.service.setSessionState("legacy", "m2", 10);
      await runtime.service.close();
      const db = await connect(runtime.dbPath, { experimental: ["encryption"] });
      try {
        await db.exec("ALTER TABLE session_state DROP COLUMN last_extracted_offset");
      } finally {
        await db.close();
      }
      const state = await second.service.getSessionState("legacy");
      expect(state.last_extracted_message_id).toBe("m2");
      expect(state.last_extracted_offset).toBe(0);
    } finally {
      await second.service.close();
      await runtime.cleanup();
    }
  });
});
