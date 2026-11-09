import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { PROJECT_MARKER } from "./config.js";

export interface ProjectInfo {
  /** Project root used for display and marker-based identity. */
  root: string;
  name: string;
  /** Stable identity used to derive the database file name. */
  identity: string;
  dbPath: string;
}

function canonical(path: string): string {
  try {
    return normalize(realpathSync(path));
  } catch {
    return normalize(resolve(path));
  }
}

function runGit(args: string[], directory: string): string | null {
  try {
    const output = execFileSync("git", args, {
      cwd: directory,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true,
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

export function findMarkerRoot(directory: string): string | null {
  let current = canonical(directory);
  while (true) {
    if (existsSync(join(current, PROJECT_MARKER))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function gitCommonDir(directory: string): string | null {
  const value = runGit(["rev-parse", "--git-common-dir"], directory);
  if (!value) return null;
  const resolved = isAbsolute(value) ? normalize(value) : normalize(resolve(directory, value));
  return existsSync(resolved) ? canonical(resolved) : resolved;
}

function gitTopLevel(directory: string): string | null {
  const value = runGit(["rev-parse", "--show-toplevel"], directory);
  return value ? canonical(value) : null;
}

function gitRemote(directory: string): string | null {
  return runGit(["config", "--get", "remote.origin.url"], directory);
}

function resolveIdentity(directory: string): { root: string; identity: string } {
  const marker = findMarkerRoot(directory);
  if (marker) return { root: marker, identity: `path:${marker}` };

  const common = gitCommonDir(directory);
  if (common) {
    const root = basename(common) === ".git" ? dirname(common) : (gitTopLevel(directory) ?? directory);
    return { root: canonical(root), identity: `git-common:${common}` };
  }

  const topLevel = gitTopLevel(directory);
  if (topLevel) {
    const remote = gitRemote(directory);
    return { root: topLevel, identity: remote ? `remote:${remote}` : `path:${topLevel}` };
  }

  const root = canonical(directory);
  return { root, identity: `path:${root}` };
}

export function resolveProject(directory: string, storagePath: string): ProjectInfo {
  const { root, identity } = resolveIdentity(directory);
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return {
    root,
    name: basename(root) || root,
    identity,
    dbPath: join(storagePath, "projects", `${hash}.db`),
  };
}
