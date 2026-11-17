import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { CortexConfig } from "./config.js";
import { redactSecrets } from "./secrets.js";

const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let lastSweep = 0;

function capturePath(config: CortexConfig): string {
  return join(config.storagePath, "debug-capture.jsonl");
}

/** Drop entries older than the three-day retention window. Never throws. */
export function sweepDebugCapture(config: CortexConfig, now = Date.now()): void {
  try {
    const path = capturePath(config);
    if (!existsSync(path)) return;
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    const cutoff = now - RETENTION_MS;
    const kept = lines.filter((line) => {
      try {
        return Date.parse(String(JSON.parse(line).time)) > cutoff;
      } catch {
        return true;
      }
    });
    if (kept.length === lines.length) return;
    writeFileSync(path, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf-8");
    chmodSync(path, 0o600);
  } catch {
    // Capture maintenance must never break memory operations.
  }
}

/**
 * Append one redacted raw model output when `debugCapture` is enabled. The
 * file is created with 0600 permissions and swept at most hourly; entries
 * older than three days are dropped. Never throws.
 */
export function captureModelOutput(
  config: CortexConfig,
  kind: "extract" | "verify",
  text: string,
  now = Date.now()
): void {
  if (!config.debugCapture) return;
  try {
    const path = capturePath(config);
    mkdirSync(dirname(path), { recursive: true });
    const output = redactSecrets(text, config.blockedPatterns).text;
    appendFileSync(
      path,
      `${JSON.stringify({ time: new Date(now).toISOString(), kind, chars: text.length, output })}\n`,
      "utf-8"
    );
    chmodSync(path, 0o600);
    if (now - lastSweep >= SWEEP_INTERVAL_MS) {
      lastSweep = now;
      sweepDebugCapture(config, now);
    }
  } catch {
    // Capture must never break memory operations.
  }
}
