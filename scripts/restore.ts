/**
 * Restore a project database from a daily backup file.
 *
 * Usage:
 *   bun run scripts/restore.ts <backup.db>              # restore into the current project
 *   bun run scripts/restore.ts <backup.db> --to <path>  # restore into an explicit database path
 *
 * An existing target requires --force; it is kept as <target>.pre-restore.bak.
 * The restore is whole-database: every field (status, version, source,
 * related_files) and every stored vector is preserved.
 */
import { copyFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { connect } from "@tursodatabase/database";
import { loadConfig } from "../src/config.js";
import { resolveEncryption } from "../src/encryption.js";
import { resolveProject } from "../src/project.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const toIndex = args.indexOf("--to");
  const target = toIndex >= 0 ? args[toIndex + 1] : undefined;
  const backup = args.find((arg, index) => arg && !arg.startsWith("--") && index !== toIndex + 1);
  const force = args.includes("--force");

  if (!backup || (toIndex >= 0 && !target)) {
    console.error("用法: bun run scripts/restore.ts <backup.db> [--to <目标库路径>] [--force]");
    process.exitCode = 1;
    return;
  }

  const source = resolve(backup);
  if (!existsSync(source)) {
    console.error(`备份文件不存在: ${source}`);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig(process.cwd());
  const encryption = config.databaseEncryptionEnabled ? resolveEncryption(config) : undefined;
  const dbPath = target ? resolve(target) : resolveProject(process.cwd(), config.storagePath).dbPath;
  if (dbPath === source) {
    console.error("备份文件与目标库是同一个文件");
    process.exitCode = 1;
    return;
  }

  if (existsSync(dbPath)) {
    if (!force) {
      console.error(`目标库已存在: ${dbPath}。确认覆盖请加 --force（原库保留为 .pre-restore.bak）`);
      process.exitCode = 1;
      return;
    }
    renameSync(dbPath, `${dbPath}.pre-restore.bak`);
  }
  // Stale WAL/SHM files of the old database would corrupt the restored one.
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  copyFileSync(source, dbPath);

  const db = await connect(dbPath, {
    experimental: process.platform === "win32" ? ["encryption"] : ["encryption", "multiprocess_wal"],
    ...(encryption ? { encryption } : {}),
  });
  try {
    await db.exec("PRAGMA query_only = 1");
    const memories = await db.get("SELECT COUNT(*) AS n FROM memories");
    const meta = await db.get("SELECT value FROM project_meta WHERE key = 'schema_version'");
    console.log(`已恢复到 ${dbPath}\nmemories: ${memories?.n}，schema_version: ${meta?.value}`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error("恢复失败:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
