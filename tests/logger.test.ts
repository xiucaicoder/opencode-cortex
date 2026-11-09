import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log, setLogFile } from "../src/logger.js";

describe("log rotation", () => {
  it("keeps two archived files after exceeding 5 MB", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-log-"));
    const path = join(dir, "cortex.log");
    setLogFile(path);
    try {
      const big = "x".repeat(5 * 1024 * 1024 + 1);
      log(big);
      log("second file");
      log(big);
      log("third file");
      log(big);
      log("fourth file");

      expect(existsSync(`${path}.1`)).toBe(true);
      expect(existsSync(`${path}.2`)).toBe(true);
      expect(readdirSync(dir).filter((name) => name.startsWith("cortex.log")).sort()).toEqual([
        "cortex.log",
        "cortex.log.1",
        "cortex.log.2",
      ]);
      expect(statSync(path).size).toBeLessThan(5 * 1024 * 1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
