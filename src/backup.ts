import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { MemoryStore } from "./store.js";

const KEEP = 7;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One backup file per project per day, named `<project hash>-YYYY-MM-DD.db`. */
export function backupFileName(dbPath: string, now: Date): string {
  return `${basename(dbPath, ".db")}-${now.toISOString().slice(0, 10)}.db`;
}

function backupFiles(backupsDir: string, prefix: string): string[] {
  if (!existsSync(backupsDir)) return [];
  return readdirSync(backupsDir)
    .filter((name) => {
      if (!name.startsWith(prefix)) return false;
      const rest = name.slice(prefix.length);
      return DATE.test(rest.slice(0, 10)) && rest.endsWith(".db");
    })
    .sort();
}

/** Keep the newest `keep` backups for one project; returns the removed count. */
export function pruneBackups(backupsDir: string, dbPath: string, keep = KEEP): number {
  const files = backupFiles(backupsDir, `${basename(dbPath, ".db")}-`);
  const excess = files.slice(0, Math.max(0, files.length - keep));
  for (const name of excess) rmSync(join(backupsDir, name), { force: true });
  return excess.length;
}

/**
 * Snapshot the project database into backupsDir once per day. Returns true
 * when a new backup file was created, false when today's backup already
 * exists. Failures propagate to the caller (the plugin logs them); a partial
 * temporary file is always removed so the next attempt starts clean.
 */
export async function createDailyBackup(
  store: MemoryStore,
  backupsDir: string,
  dbPath: string,
  now = new Date()
): Promise<boolean> {
  const file = join(backupsDir, backupFileName(dbPath, now));
  if (existsSync(file)) return false;
  mkdirSync(backupsDir, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  rmSync(temp, { force: true });
  try {
    await store.snapshotTo(temp);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  pruneBackups(backupsDir, dbPath);
  return true;
}
