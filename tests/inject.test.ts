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
});
