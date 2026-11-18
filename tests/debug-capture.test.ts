import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureModelOutput, sweepDebugCapture } from "../src/debug-capture.js";
import { createTestRuntime } from "./helpers.js";

describe("debug capture", () => {
  it("stays off by default and writes redacted 0600 entries when enabled", async () => {
    const runtime = createTestRuntime();
    try {
      const path = join(runtime.config.storagePath, "debug-capture.jsonl");
      const secret = "sk-abcdefghijklmnopqrst1234";
      captureModelOutput(runtime.config, "extract", `模型输出包含 ${secret}`);
      expect(existsSync(path)).toBe(false);

      const config = { ...runtime.config, debugCapture: true };
      captureModelOutput(config, "verify", `模型输出包含 ${secret}`);
      const raw = readFileSync(path, "utf-8");
      expect(raw).toContain("[REDACTED]");
      expect(raw).not.toContain(secret);
      if (process.platform !== "win32") {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
      const entry = JSON.parse(raw.trim()) as { kind: string; chars: number };
      expect(entry.kind).toBe("verify");
      expect(entry.chars).toBeGreaterThan(0);
    } finally {
      await runtime.cleanup();
    }
  });

  it("drops entries older than three days and keeps fresh ones", async () => {
    const runtime = createTestRuntime();
    mkdirSync(runtime.config.storagePath, { recursive: true });
    const config = { ...runtime.config, debugCapture: true };
    const path = join(config.storagePath, "debug-capture.jsonl");
    try {
      const old = JSON.stringify({
        time: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
        kind: "extract",
        output: "old",
      });
      writeFileSync(path, `${old}\n`, "utf-8");
      chmodSync(path, 0o600);
      sweepDebugCapture(config);
      expect(readFileSync(path, "utf-8").trim()).toBe("");

      captureModelOutput(config, "extract", "fresh output");
      sweepDebugCapture(config);
      const kept = readFileSync(path, "utf-8");
      expect(kept).toContain("fresh output");
      if (process.platform !== "win32") {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    } finally {
      await runtime.cleanup();
    }
  });
});
