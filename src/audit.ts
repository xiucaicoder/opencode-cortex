import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { MemoryCategory, MemoryRecord, RecallStats } from "./store.js";

export type AuditReason =
  | { kind: "missing_file"; file: string }
  | { kind: "git_drift"; files: string[]; commits: number }
  | { kind: "stale_unused"; ageDays: number };

export interface AuditIssue {
  id: string;
  version: number;
  title: string;
  category: MemoryCategory;
  updated_at: number;
  recallCount: number;
  lastRecalledAt: number | null;
  reasons: AuditReason[];
}

export interface AuditOptions {
  /** Flag memories older than this many days with zero recalls. Default 30. */
  staleDays?: number;
  /** Flag memories whose related_files changed in at least this many commits since updated_at. Default 3. */
  minDriftCommits?: number;
  now?: number;
  fileExists?: (absPath: string) => boolean;
  countGitCommits?: (projectRoot: string, files: string[], sinceMs: number) => number;
}

/** Heuristic: decide whether a related_files entry looks like a real path vs bare module name. */
export function looksLikeFilePath(entry: string): boolean {
  const trimmed = entry.trim();
  if (!trimmed) return false;
  return trimmed.includes("/") || trimmed.includes("\\") || /\.[a-z0-9]{1,8}$/i.test(trimmed);
}

function defaultCountGitCommits(projectRoot: string, files: string[], sinceMs: number): number {
  if (files.length === 0) return 0;
  try {
    const sinceIso = new Date(sinceMs).toISOString();
    const output = execFileSync(
      "git",
      ["log", `--since=${sinceIso}`, "--oneline", "--", ...files],
      {
        cwd: projectRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
        windowsHide: true,
      }
    ).trim();
    if (!output) return 0;
    return output.split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * Inspect active memories for file deletion, git drift on related_files,
 * and long-term zero-recall staleness.
 */
export function auditMemories(
  projectRoot: string,
  memories: Array<Pick<MemoryRecord, "id" | "version" | "title" | "category" | "related_files" | "updated_at">>,
  stats: ReadonlyMap<string, RecallStats>,
  options: AuditOptions = {}
): AuditIssue[] {
  const staleDays = options.staleDays ?? 30;
  const minDriftCommits = options.minDriftCommits ?? 3;
  const now = options.now ?? Date.now();
  const fileExists = options.fileExists ?? existsSync;
  const countGitCommits = options.countGitCommits ?? defaultCountGitCommits;

  const issues: AuditIssue[] = [];

  for (const memory of memories) {
    const reasons: AuditReason[] = [];
    const existingFiles: string[] = [];

    for (const rawFile of memory.related_files) {
      const file = rawFile.trim();
      if (!file || !looksLikeFilePath(file)) continue;
      const absPath = isAbsolute(file) ? file : resolve(join(projectRoot, file));
      if (!fileExists(absPath)) {
        reasons.push({ kind: "missing_file", file });
      } else {
        existingFiles.push(file);
      }
    }

    if (existingFiles.length > 0 && minDriftCommits > 0) {
      const commits = countGitCommits(projectRoot, existingFiles, memory.updated_at);
      if (commits >= minDriftCommits) {
        reasons.push({ kind: "git_drift", files: existingFiles, commits });
      }
    }

    const stat = stats.get(memory.id);
    const recallCount = stat?.recallCount ?? 0;
    const lastRecalledAt = stat?.lastRecalledAt ?? null;
    const ageDays = Math.floor(Math.max(0, now - memory.updated_at) / 86_400_000);
    if (staleDays > 0 && recallCount === 0 && ageDays >= staleDays) {
      reasons.push({ kind: "stale_unused", ageDays });
    }

    if (reasons.length > 0) {
      issues.push({
        id: memory.id,
        version: memory.version,
        title: memory.title,
        category: memory.category,
        updated_at: memory.updated_at,
        recallCount,
        lastRecalledAt,
        reasons,
      });
    }
  }

  return issues;
}
