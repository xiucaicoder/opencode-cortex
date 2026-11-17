import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@tursodatabase/database";
import type { EncryptionOpts } from "@tursodatabase/database-common";
import { backupFileName, createDailyBackup, pruneBackups } from "../src/backup.js";
import { MemoryService } from "../src/memory-service.js";
import { MemoryStore } from "../src/store.js";
import { createSecondService, createTestRuntime, FakeEmbedder } from "./helpers.js";

const RESTORE_SCRIPT = join(import.meta.dir, "..", "scripts", "restore.ts");

const TABLES = {
  project_meta: "key",
  memories: "id",
  session_state: "session_id",
  memory_history: "memory_id, version",
  memory_conflicts: "memory_id, memory_version, content",
  memory_evidence_times: "memory_id",
} as const;

function normalize(value: unknown): unknown {
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return Buffer.from(value).toString("hex");
  return value;
}

/** Full row dump of every table, vectors normalized to hex for deep equality. */
async function dumpAll(dbPath: string, encryption?: EncryptionOpts | null): Promise<Record<string, unknown[]>> {
  const db = await connect(dbPath, {
    experimental: ["encryption"],
    ...(encryption ? { encryption } : {}),
  });
  try {
    const result: Record<string, unknown[]> = {};
    for (const [table, order] of Object.entries(TABLES)) {
      const rows = (await db.all(`SELECT * FROM ${table} ORDER BY ${order}`)) as Array<Record<string, unknown>>;
      result[table] = rows.map((row) =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalize(value)]))
      );
    }
    return result;
  } finally {
    await db.close();
  }
}

describe("daily backup", () => {
  it("round-trips a day's backup through the restore script losslessly", async () => {
    const runtime = createTestRuntime();
    try {
      runtime.embedder.set("手动规则\n旧结论", 0);
      runtime.embedder.set("手动规则\n新结论", 0.2);
      runtime.embedder.set("自动规则\n另一条事实", Math.PI / 2);
      const manual = await runtime.service.mutate({
        action: "add",
        title: "手动规则",
        category: "domain_rule",
        content: "旧结论",
        related_files: ["src/a.ts"],
        source_ref: "issue-1",
      });
      const auto = await runtime.service.mutate(
        { action: "add", title: "自动规则", category: "data_constraint", content: "另一条事实" },
        "auto"
      );
      const verified = await runtime.service.mutateVerified({
        action: "add",
        title: "核验规则",
        category: "pitfall",
        content: "核验后的结论",
        source_ref: "test:evidence",
        evidence_at: 12345,
      });
      await runtime.service.mutate({
        action: "update",
        id: manual.id,
        version: 1,
        title: "手动规则",
        category: "domain_rule",
        content: "新结论",
        related_files: ["src/a.ts", "src/b.ts"],
        source_ref: "issue-2",
      });
      await runtime.service.mutate({ action: "delete", id: auto.id, version: 1 });
      await runtime.service.setSessionState("sess-1", "m1", 1000);

      const now = new Date("2026-11-17T10:00:00.000Z");
      expect(await runtime.service.createDailyBackup(now)).toBe(true);
      const file = join(runtime.config.storagePath, "backups", backupFileName(runtime.dbPath, now));
      expect(existsSync(file)).toBe(true);
      // one backup per day, but a new day creates another
      expect(await runtime.service.createDailyBackup(now)).toBe(false);
      expect(await runtime.service.createDailyBackup(new Date("2026-11-18T10:00:00.000Z"))).toBe(true);

      const dir = mkdtempSync(join(tmpdir(), "cortex-restore-"));
      const target = join(dir, "restored.db");
      try {
        const proc = Bun.spawn(["bun", RESTORE_SCRIPT, file, "--to", target], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, output] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
        expect(code).toBe(0);
        expect(output).toContain("memories: 3");

        // Every field of every table, including vector blobs, must match.
        expect(await dumpAll(target)).toEqual(await dumpAll(runtime.dbPath));

        const second = await createSecondService(runtime.config, target);
        try {
          expect((await second.service.listActive()).map((hit) => hit.id).sort())
            .toEqual([manual.id, verified.id].sort());
          expect((await second.service.listArchived()).map((hit) => hit.id)).toEqual([auto.id]);
          const restored = await second.service.getActive(manual.id);
          expect(restored?.version).toBe(2);
          expect(restored?.related_files).toEqual(["src/a.ts", "src/b.ts"]);
          expect(restored?.source).toBe("import");
          const restoredAuto = (await second.service.listArchived())[0];
          expect(restoredAuto?.source).toBe("auto");
          expect((await second.service.getSessionState("sess-1")).last_extracted_message_id).toBe("m1");
        } finally {
          await second.service.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      await runtime.cleanup();
    }
  });

  it("keeps the seven newest backups per project", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-prune-"));
    try {
      const prefix = "abc123def-";
      for (let day = 1; day <= 9; day++) {
        writeFileSync(join(dir, `${prefix}2026-01-0${day}.db`), "");
      }
      writeFileSync(join(dir, `${prefix}not-a-date.db`), "");
      writeFileSync(join(dir, "other-2026-01-01.db"), "");

      expect(pruneBackups(dir, join(dir, "abc123def.db"))).toBe(2);
      const remaining = readdirSync(dir).sort();
      expect(remaining).toContain(`${prefix}not-a-date.db`);
      expect(remaining).toContain("other-2026-01-01.db");
      const dated = remaining.filter(
        (name) => name.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}\.db$/.test(name.slice(prefix.length))
      );
      expect(dated).toEqual([3, 4, 5, 6, 7, 8, 9].map((day) => `${prefix}2026-01-0${day}.db`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps encrypted backups encrypted and lossless", async () => {
    const base = createTestRuntime();
    const dir = mkdtempSync(join(tmpdir(), "cortex-enc-"));
    const encryption: EncryptionOpts = { cipher: "aes256gcm", hexkey: "c".repeat(64) };
    const dbPath = join(dir, "enc.db");
    const store = new MemoryStore({
      dbPath,
      dimensions: 768,
      model: "fake-embedder",
      dtype: "q8",
      pooling: "cls",
      encryption,
    });
    const service = new MemoryService(
      base.config,
      { root: dir, name: "enc", identity: "test-enc-backup", dbPath },
      store,
      new FakeEmbedder()
    );
    try {
      await service.mutate({ action: "add", title: "加密规则", category: "domain_rule", content: "结论" });
      await service.setSessionState("s1", "m1", 10);

      const now = new Date("2026-11-17T00:00:00.000Z");
      const backupsDir = join(dir, "backups");
      expect(await createDailyBackup(store, backupsDir, dbPath, now)).toBe(true);
      const file = join(backupsDir, backupFileName(dbPath, now));

      let rejected = false;
      try {
        const plain = await connect(file, { experimental: ["encryption"] });
        await plain.close();
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);

      expect(await dumpAll(file, encryption)).toEqual(await dumpAll(dbPath, encryption));
    } finally {
      await service.close();
      await base.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
