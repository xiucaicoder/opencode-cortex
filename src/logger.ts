import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

let logFile = join(homedir(), ".opencode-cortex", "opencode-cortex.log");

export function setLogFile(path: string): void {
  logFile = path;
}

function rotateIfNeeded(): void {
  try {
    if (existsSync(logFile) && statSync(logFile).size >= MAX_LOG_BYTES) {
      renameSync(logFile, `${logFile}.1`);
    }
  } catch {
    // Logging must never break memory operations.
  }
}

/**
 * Append one diagnostic line. Callers must pass identifiers, counts and error
 * messages only — never memory content or matched secret values.
 */
export function log(message: string, data?: Record<string, unknown>): void {
  const line = `${new Date().toISOString()} ${message}${
    data === undefined ? "" : ` ${JSON.stringify(data)}`
  }\n`;
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    rotateIfNeeded();
    appendFileSync(logFile, line, "utf-8");
  } catch {
    try {
      console.error(`[opencode-cortex] ${message}`);
    } catch {
      // give up silently
    }
  }
}
