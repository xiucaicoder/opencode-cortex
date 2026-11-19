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

  it("splits camelCase and snake_case code identifiers alongside Chinese terms", () => {
    const tokens = tokenizeQuery("OrderService 中 refund_status 怎么审核");
    expect(tokens).toContain("orderservice");
    expect(tokens).toContain("order");
    expect(tokens).toContain("service");
    expect(tokens).toContain("refund_status");
    expect(tokens).toContain("refund");
    expect(tokens).toContain("status");
    expect(tokens).toContain("审核");
  });

  it("filters out low-relevance noise using searchMinScore", async () => {
    const runtime = createTestRuntime({ searchMinScore: 0.35 });
    try {
      runtime.embedder.set("库存扣减\n库存在下单时扣减", Math.acos(0.1));
      await runtime.service.mutate({
        action: "add",
        title: "库存扣减",
        category: "domain_rule",
        content: "库存在下单时扣减",
      });

      runtime.embedder.set("前端主题色是什么", 0);
      const filtered = await runtime.service.search("前端主题色是什么", 5);
      expect(filtered).toHaveLength(0);

      // Internal includeConflicts lookup still bypasses minScore for dedup/conflict checks.
      const internal = await runtime.service.search("前端主题色是什么", 5, true);
      expect(internal).toHaveLength(1);
    } finally {
      await runtime.cleanup();
    }
  });

  it("boosts memories matching related_file above unrelated closer vectors and records recall stats", async () => {
    const runtime = createTestRuntime({ searchMinScore: 0.35 });
    try {
      runtime.embedder.set("通用日志\n日志按天轮转", Math.acos(0.85));
      runtime.embedder.set("下单校验\n优惠券不可与满减叠加", Math.acos(0.45));
      const logMem = await runtime.service.mutate({
        action: "add",
        title: "通用日志",
        category: "arch_decision",
        content: "日志按天轮转",
        related_files: ["src/logger.ts"],
      });
      const orderMem = await runtime.service.mutate({
        action: "add",
        title: "下单校验",
        category: "domain_rule",
        content: "优惠券不可与满减叠加",
        related_files: ["src/services/OrderService.ts"],
      });

      runtime.embedder.set("校验逻辑", 0);
      const hits = await runtime.service.search("校验逻辑", 5, false, "src/services/OrderService.ts");
      expect(hits[0]?.id).toBe(orderMem.id);
      expect(hits.some((h) => h.id === logMem.id)).toBe(true);

      const stats = await runtime.service.getRecallStats();
      expect(stats.get(orderMem.id)?.recallCount).toBe(1);
      expect(stats.get(orderMem.id)?.lastRecalledAt).toBeGreaterThan(0);

      // Internal conflict-aware search must not inflate recall count.
      await runtime.service.search("校验逻辑", 5, true);
      const statsAfterInternal = await runtime.service.getRecallStats();
      expect(statsAfterInternal.get(orderMem.id)?.recallCount).toBe(1);
    } finally {
      await runtime.cleanup();
    }
  });

  it("does not boost same-basename files from different directories", async () => {
    const { filePathMatches } = await import("../src/store.js");
    expect(filePathMatches(["admin/src/index.ts"], "checkout/src/index.ts")).toBe(false);
    expect(filePathMatches(["checkout/src/index.ts"], "checkout/src/index.ts")).toBe(true);
    expect(filePathMatches(["src/index.ts"], "checkout/src/index.ts")).toBe(true);
    expect(filePathMatches(["admin/src/index.ts"], "index.ts")).toBe(true);

    const runtime = createTestRuntime({ searchMinScore: 0.35 });
    try {
      runtime.embedder.set("管理后台权限\n管理后台仅允许管理员访问", Math.acos(0.8));
      runtime.embedder.set("结算幂等规则\n扣款接口必须使用渠道流水号幂等", -Math.acos(0.6));
      await runtime.service.mutate({
        action: "add",
        title: "管理后台权限",
        category: "domain_rule",
        content: "管理后台仅允许管理员访问",
        related_files: ["admin/src/index.ts"],
      });
      const checkoutMem = await runtime.service.mutate({
        action: "add",
        title: "结算幂等规则",
        category: "domain_rule",
        content: "扣款接口必须使用渠道流水号幂等",
        related_files: ["checkout/src/index.ts"],
      });

      runtime.embedder.set("扣款逻辑", 0);
      const hits = await runtime.service.search("扣款逻辑", 5, false, "checkout/src/index.ts");
      expect(hits[0]?.id).toBe(checkoutMem.id);
    } finally {
      await runtime.cleanup();
    }
  });
});
