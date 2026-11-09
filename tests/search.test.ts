import { describe, expect, it } from "bun:test";
import { tokenizeQuery } from "../src/store.js";
import { createTestRuntime } from "./helpers.js";

describe("Chinese keyword segmentation", () => {
  it("segments a Chinese query into real words", () => {
    const tokens = tokenizeQuery("退款需要财务审核吗");
    expect(tokens).toContain("退款");
    expect(tokens).toContain("财务");
    expect(tokens).toContain("审核");
    expect(tokens).not.toContain("退款需要财务审核吗");
  });

  it("lets keyword matches reorder hybrid results above a closer vector", async () => {
    const runtime = createTestRuntime();
    try {
      runtime.embedder.set("退款规则\n退款需要财务审核", Math.acos(0.5));
      runtime.embedder.set("日志规则\n日志按天轮转", Math.acos(0.9));
      await runtime.service.mutate({
        action: "add",
        title: "退款规则",
        category: "domain_rule",
        content: "退款需要财务审核",
      });
      await runtime.service.mutate({
        action: "add",
        title: "日志规则",
        category: "arch_decision",
        content: "日志按天轮转",
      });

      runtime.embedder.set("退款需要财务审核吗", 0);
      const hits = await runtime.service.search("退款需要财务审核吗", 2);
      expect(hits[0]?.title).toBe("退款规则");
    } finally {
      await runtime.cleanup();
    }
  });
});
