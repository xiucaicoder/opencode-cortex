import { describe, expect, it } from "bun:test";
import { auditMemories } from "../src/audit.js";
import { createTestRuntime } from "./helpers.js";

describe("conflict visibility and resolution", () => {
  it("lists conflict summaries and resolves via keep, accept, and custom", async () => {
    const runtime = createTestRuntime();
    try {
      const original = await runtime.service.mutate(
        {
          action: "add",
          title: "普通商品售后期限",
          category: "domain_rule",
          content: "普通商品售后申请期限为签收后180天。",
          related_files: ["src/after-sale.ts"],
        },
        "tool"
      );

      // Simulate an auto extraction conflicting update against a manual entry.
      const batch = await runtime.service.applyExtractionBatch(
        "s1",
        { messageId: null, offset: 0 },
        { messageId: "m1", offset: 0 },
        Date.now(),
        [
          {
            action: "update",
            id: original.id,
            version: original.version,
            title: "普通商品售后期限",
            category: "domain_rule",
            content: "普通商品售后申请期限改为签收后90天。",
            source_ref: "opencode-session:s1/message:m1",
            evidence_at: Date.now(),
          },
        ]
      );
      expect(batch?.conflicts).toBe(1);

      // Conflicted memory is hidden from active recall but visible in summaries.
      expect(await runtime.service.listActive()).toHaveLength(0);
      const summaries = await runtime.service.listConflictSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({
        id: original.id,
        version: 1,
        title: "普通商品售后期限",
        candidateCount: 1,
        blocksRecall: true,
      });

      // 1) Resolve via keep -> restores recallability without bumping version.
      const kept = await runtime.service.resolveConflict(original.id, { action: "keep" });
      expect(kept).toMatchObject({ id: original.id, version: 1, action: "kept", cleared: 1 });
      expect(await runtime.service.listConflictSummaries()).toHaveLength(0);
      expect(await runtime.service.listActive()).toHaveLength(1);

      // Trigger another conflict and resolve via accept.
      await runtime.service.applyExtractionBatch(
        "s2",
        { messageId: null, offset: 0 },
        { messageId: "m2", offset: 0 },
        Date.now(),
        [
          {
            action: "update",
            id: original.id,
            version: 1,
            title: "普通商品售后期限",
            category: "domain_rule",
            content: "普通商品售后申请期限改为签收后90天。",
            source_ref: "opencode-session:s2/message:m2",
            evidence_at: Date.now() + 1000,
          },
        ]
      );
      const accepted = await runtime.service.resolveConflict(original.id, {
        action: "accept",
        candidateIndex: 1,
      });
      expect(accepted).toMatchObject({ id: original.id, version: 2, action: "updated" });
      expect((await runtime.service.getActive(original.id))?.content).toBe(
        "普通商品售后申请期限改为签收后90天。"
      );

      // Previous version is preserved in memory_history.
      const history = await runtime.service.listHistory(original.id);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        version: 1,
        content: "普通商品售后申请期限为签收后180天。",
      });
    } finally {
      await runtime.cleanup();
    }
  });

  it("commits the selected candidate by stable identity even if a newer conflict arrives before confirmation", async () => {
    const runtime = createTestRuntime();
    try {
      const original = await runtime.service.mutate(
        {
          action: "add",
          title: "普通商品售后期限",
          category: "domain_rule",
          content: "普通商品售后申请期限为签收后180天。",
        },
        "tool"
      );

      // User initially sees candidate #1 = 90天.
      await runtime.service.applyExtractionBatch(
        "s1",
        { messageId: null, offset: 0 },
        { messageId: "m1", offset: 0 },
        Date.now(),
        [
          {
            action: "update",
            id: original.id,
            version: original.version,
            title: "普通商品售后期限",
            category: "domain_rule",
            content: "普通商品售后申请期限改为签收后90天。",
            source_ref: "opencode-session:s1/message:m1",
            evidence_at: Date.now(),
          },
        ]
      );
      const displayed = await runtime.service.listConflicts();
      const chosen = displayed[0]!;
      expect(chosen.content).toContain("90天");

      // Background extraction inserts a newer candidate (30天) before user confirms.
      await new Promise((resolve) => setTimeout(resolve, 10));
      await runtime.service.applyExtractionBatch(
        "s2",
        { messageId: null, offset: 0 },
        { messageId: "m2", offset: 0 },
        Date.now(),
        [
          {
            action: "update",
            id: original.id,
            version: original.version,
            title: "普通商品售后期限",
            category: "domain_rule",
            content: "普通商品售后申请期限改为签收后30天。",
            source_ref: "opencode-session:s2/message:m2",
            evidence_at: Date.now() + 1000,
          },
        ]
      );

      // Confirming with stable candidate identity + expectedVersion writes 90天, not 30天.
      const resolved = await runtime.service.resolveConflict(original.id, {
        action: "accept",
        candidate: { content: chosen.content, source_ref: chosen.source_ref },
        expectedVersion: chosen.memory_version,
      });
      expect(resolved.version).toBe(2);
      expect((await runtime.service.getActive(original.id))?.content).toBe(
        "普通商品售后申请期限改为签收后90天。"
      );

      // Stale expectedVersion is rejected.
      await runtime.service.applyExtractionBatch(
        "s3",
        { messageId: null, offset: 0 },
        { messageId: "m3", offset: 0 },
        Date.now(),
        [
          {
            action: "update",
            id: original.id,
            version: 2,
            title: "普通商品售后期限",
            category: "domain_rule",
            content: "普通商品售后申请期限改为签收后60天。",
            source_ref: "opencode-session:s3/message:m3",
            evidence_at: Date.now() + 2000,
          },
        ]
      );
      await expect(
        runtime.service.resolveConflict(original.id, {
          action: "keep",
          expectedVersion: 1,
        })
      ).rejects.toThrow("版本冲突");
    } finally {
      await runtime.cleanup();
    }
  });
});

describe("memory staleness and code drift audit", () => {
  it("flags missing files, git drift, and long-term zero-recall entries", () => {
    const now = Date.UTC(2026, 10, 19);
    const oldTs = now - 45 * 86_400_000;
    const recentTs = now - 5 * 86_400_000;

    const memories = [
      {
        id: "m-deleted",
        version: 1,
        title: "已删除文件规则",
        category: "pitfall" as const,
        related_files: ["src/legacy/deleted.ts", "OrderService"],
        updated_at: recentTs,
      },
      {
        id: "m-drift",
        version: 2,
        title: "高频变动模块规则",
        category: "arch_decision" as const,
        related_files: ["src/core/payment.ts"],
        updated_at: oldTs,
      },
      {
        id: "m-healthy",
        version: 1,
        title: "常被召回的健康规则",
        category: "domain_rule" as const,
        related_files: ["src/core/stable.ts"],
        updated_at: oldTs,
      },
    ];

    const stats = new Map([
      ["m-healthy", { recallCount: 6, lastRecalledAt: recentTs }],
    ]);

    const issues = auditMemories("/repo", memories, stats, {
      staleDays: 30,
      minDriftCommits: 3,
      now,
      fileExists: (absPath) => !absPath.endsWith("deleted.ts"),
      countGitCommits: (_root, files) => (files.includes("src/core/payment.ts") ? 5 : 1),
    });

    expect(issues.map((i) => i.id)).toEqual(["m-deleted", "m-drift"]);
    expect(issues[0]?.reasons).toEqual([{ kind: "missing_file", file: "src/legacy/deleted.ts" }]);
    expect(issues[1]?.reasons).toEqual([
      { kind: "git_drift", files: ["src/core/payment.ts"], commits: 5 },
      { kind: "stale_unused", ageDays: 45 },
    ]);
  });
});
