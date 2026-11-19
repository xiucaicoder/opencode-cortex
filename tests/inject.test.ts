import { describe, expect, it } from "bun:test";
import { buildInjectionText, InjectionCache, INJECTION_PREFIX } from "../src/inject.js";

const titles = Array.from({ length: 160 }, (_, index) => ({
  id: `id-${index}`,
  category: "domain_rule" as const,
  title: `规则 ${index}`,
}));

describe("memory context injection", () => {
  it("includes the prefix, overview and title directory without bodies", () => {
    const text = buildInjectionText("系统边界说明", titles.slice(0, 2));
    expect(text.startsWith(INJECTION_PREFIX)).toBe(true);
    expect(INJECTION_PREFIX).toContain("立即调用 memory_mutate 并附其原话");
    expect(text).toContain("## 项目概览\n系统边界说明");
    expect(text).toContain("[id-0] [domain_rule] 规则 0");
    expect(text).toContain("[id-1] [domain_rule] 规则 1");
    expect(text).not.toContain("content");
  });

  it("caps the directory at 150 entries and the overview at 500 characters", () => {
    const text = buildInjectionText("概".repeat(600), titles);
    const titleLines = text.split("\n").filter((line) => line.startsWith("[id-"));
    expect(titleLines).toHaveLength(150);
    expect(text).toContain("概".repeat(500));
    expect(text).not.toContain("概".repeat(501));
  });

  it("returns an empty string when there is nothing to inject", () => {
    expect(buildInjectionText("", [])).toBe("");
  });

  it("caches once per session and reloads after clear", async () => {
    let loads = 0;
    const cache = new InjectionCache(async () => {
      loads++;
      return `block-${loads}`;
    });
    expect(await cache.get("s1")).toBe("block-1");
    expect(await cache.get("s1")).toBe("block-1");
    expect(loads).toBe(1);
    cache.clear("s1");
    expect(await cache.get("s1")).toBe("block-2");
  });

  it("surfaces pending conflict headings with accurate recall status and no bodies", () => {
    const text = buildInjectionText("", [], 150, [
      { id: "a1b2c3d4", version: 2, title: "普通商品售后期限", candidateCount: 1, blocksRecall: true },
      { id: "e5f6a7b8", version: 1, title: "退款渠道说明", candidateCount: 2, blocksRecall: false },
    ]);
    expect(text).toContain("## 待确认冲突\n");
    expect(text).toContain("[a1b2c3d4] v2 普通商品售后期限（已暂停召回，1 条候选）");
    expect(text).toContain("[e5f6a7b8] v1 退款渠道说明（仍可召回，存在待确认候选，2 条候选）");
    expect(text).toContain("cortex resolve");
  });
});
