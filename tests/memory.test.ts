import { describe, expect, it } from "bun:test";
import { MemoryError } from "../src/memory-service.js";
import { createSecondService, createTestRuntime } from "./helpers.js";

async function catchError(promise: Promise<unknown>): Promise<MemoryError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MemoryError) return error;
    throw error;
  }
  throw new Error("expected MemoryError");
}

describe("memory_mutate validation", () => {
  it("rejects content longer than 200 characters", async () => {
    const runtime = createTestRuntime();
    try {
      const error = await catchError(
        runtime.service.mutate({
          action: "add",
          title: "超长规则",
          category: "domain_rule",
          content: "字".repeat(201),
        })
      );
      expect(error.code).toBe("content_too_long");
      expect(error.details).toMatchObject({ length: 201, max: 200 });
    } finally {
      await runtime.cleanup();
    }
  });

  it("accepts exactly 200 characters", async () => {
    const runtime = createTestRuntime();
    try {
      const result = await runtime.service.mutate({
        action: "add",
        title: "边界规则",
        category: "domain_rule",
        content: "字".repeat(200),
      });
      expect(result.success).toBe(true);
    } finally {
      await runtime.cleanup();
    }
  });

  it("rejects an invalid category", async () => {
    const runtime = createTestRuntime();
    try {
      const error = await catchError(
        runtime.service.mutate({
          action: "add",
          title: "非法分类",
          category: "misc",
          content: "结论",
        })
      );
      expect(error.code).toBe("invalid_category");
    } finally {
      await runtime.cleanup();
    }
  });

  it("requires id and version for update and delete", async () => {
    const runtime = createTestRuntime();
    try {
      const updateError = await catchError(
        runtime.service.mutate({
          action: "update",
          title: "标题",
          category: "pitfall",
          content: "内容",
        })
      );
      expect(updateError.code).toBe("missing_field");

      const deleteError = await catchError(
        runtime.service.mutate({ action: "delete", id: "missing", version: undefined })
      );
      expect(deleteError.code).toBe("missing_field");
    } finally {
      await runtime.cleanup();
    }
  });
});

describe("secret blocking", () => {
  it("blocks credentials in content", async () => {
    const runtime = createTestRuntime();
    try {
      const error = await catchError(
        runtime.service.mutate({
          action: "add",
          title: "数据库口令",
          category: "data_constraint",
          content: "生产库 password: abc12345",
        })
      );
      expect(error.code).toBe("blocked_secret");
      expect(error.details).toMatchObject({ field: "content" });
      expect(JSON.stringify(error.details)).not.toContain("abc12345");
    } finally {
      await runtime.cleanup();
    }
  });

  it("blocks internal addresses in related_files and tokens in titles", async () => {
    const runtime = createTestRuntime();
    try {
      const ipError = await catchError(
        runtime.service.mutate({
          action: "add",
          title: "内网部署",
          category: "arch_decision",
          content: "服务部署在 192.168.10.20",
          related_files: ["http://192.168.10.20/admin"],
        })
      );
      expect(ipError.code).toBe("blocked_secret");
      expect(ipError.details).toMatchObject({ field: "content" });

      const tokenError = await catchError(
        runtime.service.mutate({
          action: "add",
          title: "token: sk-abcdefghijklmnopqrstuvwxyz123456",
          category: "pitfall",
          content: "泄漏过一次",
        })
      );
      expect(tokenError.code).toBe("blocked_secret");
    } finally {
      await runtime.cleanup();
    }
  });

  it("applies configured blockedPatterns to source_ref", async () => {
    const runtime = createTestRuntime({ blockedPatterns: ["客户[-_]?编号"] });
    try {
      const error = await catchError(
        runtime.service.mutate({
          action: "add",
          title: "客户配置",
          category: "domain_rule",
          content: "规则结论",
          source_ref: "客户编号 A-1024",
        })
      );
      expect(error.code).toBe("blocked_secret");
      expect(error.details).toMatchObject({ field: "source_ref", rule: "blockedPatterns[0]" });
    } finally {
      await runtime.cleanup();
    }
  });
});

describe("dedup thresholds", () => {
  it("rejects at or above 0.92 and returns the existing id", async () => {
    const runtime = createTestRuntime();
    try {
      runtime.embedder.set("地址规则\n支付后不能改地址", 0);
      const first = await runtime.service.mutate({
        action: "add",
        title: "地址规则",
        category: "domain_rule",
        content: "支付后不能改地址",
      });

      runtime.embedder.setSimilarity("地址规则\n付款后不能改地址", 0.95);
      const error = await catchError(
        runtime.service.mutate({
          action: "add",
          title: "地址规则",
          category: "domain_rule",
          content: "付款后不能改地址",
        })
      );
      expect(error.code).toBe("duplicate");
      expect(error.details.id).toBe(first.id);
      expect(Number(error.details.similarity)).toBeCloseTo(0.95, 3);
    } finally {
      await runtime.cleanup();
    }
  });

  it("allows 0.85-0.92 but returns a similarity warning", async () => {
    const runtime = createTestRuntime();
    try {
      runtime.embedder.set("退款规则\n退款需要财务审核", 0);
      const first = await runtime.service.mutate({
        action: "add",
        title: "退款规则",
        category: "domain_rule",
        content: "退款需要财务审核",
      });

      runtime.embedder.setSimilarity("退款规则\n退款由财务复核", 0.88);
      const second = await runtime.service.mutate({
        action: "add",
        title: "退款规则",
        category: "domain_rule",
        content: "退款由财务复核",
      });
      expect(second.success).toBe(true);
      expect(second.warning?.nearest_id).toBe(first.id);
      expect(second.warning?.similarity).toBeCloseTo(0.88, 3);
    } finally {
      await runtime.cleanup();
    }
  });

  it("drops auto adds that are similar to manual entries", async () => {
    const runtime = createTestRuntime();
    try {
      runtime.embedder.set("库存规则\n提交订单时扣库存", 0);
      await runtime.service.mutate({
        action: "add",
        title: "库存规则",
        category: "data_constraint",
        content: "提交订单时扣库存",
      });

      runtime.embedder.setSimilarity("库存规则\n下单时扣库存", 0.95);
      const error = await catchError(
        runtime.service.mutate(
          {
            action: "add",
            title: "库存规则",
            category: "data_constraint",
            content: "下单时扣库存",
          },
          "auto"
        )
      );
      expect(error.code).toBe("duplicate_protected");
    } finally {
      await runtime.cleanup();
    }
  });
});

describe("versioned updates", () => {
  it("increments version and rejects stale writes", async () => {
    const runtime = createTestRuntime();
    try {
      runtime.embedder.set("初版规则\n旧结论", 0);
      const created = await runtime.service.mutate({
        action: "add",
        title: "初版规则",
        category: "domain_rule",
        content: "旧结论",
      });

      const updated = await runtime.service.mutate({
        action: "update",
        id: created.id,
        version: created.version,
        title: "新版规则",
        category: "domain_rule",
        content: "新结论",
      });
      expect(updated.version).toBe(2);

      const stale = await catchError(
        runtime.service.mutate({
          action: "update",
          id: created.id,
          version: 1,
          title: "再次修改",
          category: "domain_rule",
          content: "另一个结论",
        })
      );
      expect(stale.code).toBe("version_conflict");
      expect(stale.details).toMatchObject({ current_version: 2 });
    } finally {
      await runtime.cleanup();
    }
  });

  it("archives instead of deleting and hides archived rows from search", async () => {
    const runtime = createTestRuntime();
    try {
      runtime.embedder.set("归档测试\n唯一结论", 0);
      const created = await runtime.service.mutate({
        action: "add",
        title: "归档测试",
        category: "pitfall",
        content: "唯一结论",
      });

      runtime.embedder.set("归档测试", 0);
      expect(await runtime.service.search("归档测试")).toHaveLength(1);

      const archived = await runtime.service.mutate({
        action: "delete",
        id: created.id,
        version: created.version,
      });
      expect(archived.version).toBe(2);
      expect(await runtime.service.search("归档测试")).toHaveLength(0);

      const updateError = await catchError(
        runtime.service.mutate({
          action: "update",
          id: created.id,
          version: 2,
          title: "复活",
          category: "pitfall",
          content: "不应成功",
        })
      );
      expect(updateError.code).toBe("archived");
    } finally {
      await runtime.cleanup();
    }
  });
});

describe("embedding and storage guards", () => {
  it("rejects a dimension mismatch before writing", async () => {
    const runtime = createTestRuntime({ embeddingDimensions: 512 });
    try {
      const error = await catchError(
        runtime.service.mutate({
          action: "add",
          title: "维度测试",
          category: "pitfall",
          content: "内容",
        })
      );
      expect(error.message).toContain("512");
      expect(error.message).toContain("768");
    } finally {
      await runtime.cleanup();
    }
  });

  it("rejects opening a store built with another model", async () => {
    const runtime = createTestRuntime();
    try {
      await runtime.service.mutate({
        action: "add",
        title: "模型标记",
        category: "domain_rule",
        content: "结论",
      });

      const { service } = await createSecondService(
        { ...runtime.config, embeddingModel: "another-model" },
        runtime.dbPath
      );
      const error = await catchError(service.search("模型标记"));
      expect(error.message).toContain("Embedding 模型不匹配");
    } finally {
      await runtime.cleanup();
    }
  });

  it("allows two sessions to write the same project database concurrently", async () => {
    const first = createTestRuntime();
    const second = await createSecondService(first.config, first.dbPath);
    try {
      first.embedder.set("会话 A\n结论 A", 0);
      second.embedder.set("会话 B\n结论 B", Math.PI / 2);

      const [a, b] = await Promise.all([
        first.service.mutate({
          action: "add",
          title: "会话 A",
          category: "arch_decision",
          content: "结论 A",
        }),
        second.service.mutate({
          action: "add",
          title: "会话 B",
          category: "arch_decision",
          content: "结论 B",
        }),
      ]);
      expect(a.success).toBe(true);
      expect(b.success).toBe(true);
      expect(await first.service.listActive()).toHaveLength(2);
    } finally {
      await second.service.close();
      await first.cleanup();
    }
  });

  it("preserves related_files when an update omits them", async () => {
    const runtime = createTestRuntime();
    try {
      runtime.embedder.set("来源规则\n旧内容", 0);
      const created = await runtime.service.mutate({
        action: "add",
        title: "来源规则",
        category: "arch_decision",
        content: "旧内容",
        related_files: ["src/a.ts"],
        source_ref: "issue-1",
      });

      runtime.embedder.set("来源规则\n新内容", 0.1);
      const updated = await runtime.service.mutate({
        action: "update",
        id: created.id,
        version: created.version,
        title: "来源规则",
        category: "arch_decision",
        content: "新内容",
      });
      expect(updated.version).toBe(2);
      const rows = await runtime.service.listActive();
      expect(rows[0]?.related_files).toEqual(["src/a.ts"]);
    } finally {
      await runtime.cleanup();
    }
  });

  it("prevents auto extraction from updating manual entries", async () => {
    const runtime = createTestRuntime();
    try {
      runtime.embedder.set("人工规则\n结论", 0);
      const manual = await runtime.service.mutate({
        action: "add",
        title: "人工规则",
        category: "domain_rule",
        content: "结论",
      });
      const error = await catchError(
        runtime.service.mutate(
          {
            action: "update",
            id: manual.id,
            version: manual.version,
            title: "人工规则",
            category: "domain_rule",
            content: "改结论",
          },
          "auto"
        )
      );
      expect(error.code).toBe("protected_source");
    } finally {
      await runtime.cleanup();
    }
  });
});
