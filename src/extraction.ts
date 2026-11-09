import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CortexConfig } from "./config.js";
import type { MemoryHit, MemoryService } from "./memory-service.js";
import { MemoryError } from "./memory-service.js";
import { log } from "./logger.js";
import { redactSecrets } from "./secrets.js";

/** One increment is attempted at most twice before the watermark moves on. */
export const MAX_EXTRACTION_ATTEMPTS = 2;

export interface RawSessionMessage {
  id: string;
  type?: string;
  text?: string;
  content?: Array<{ type?: string; text?: string }>;
  time?: { created?: number };
}

export interface ExtractMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  created: number;
}

export interface ExtractItem {
  action: "add" | "update";
  id?: string;
  title: string;
  category: string;
  content: string;
  related_files: string[];
}

export interface Increment {
  messages: ExtractMessage[];
  nextLastId: string;
  userCount: number;
  totalChars: number;
  queryText: string;
  inputText: string;
}

export type ExtractionOutcome = {
  status: "ok" | "skipped" | "failed";
  reason?: string;
  added?: number;
  updated?: number;
  skippedItems?: number;
  attempts?: number;
  dryRun?: boolean;
  captured?: number;
};

export function toExtractMessages(messages: RawSessionMessage[]): ExtractMessage[] {
  const result: ExtractMessage[] = [];
  for (const message of messages) {
    if (message.type === "user" && typeof message.text === "string") {
      const text = message.text.trim();
      if (text) {
        result.push({
          id: message.id,
          role: "user",
          text,
          created: message.time?.created ?? 0,
        });
      }
      continue;
    }
    if (message.type === "assistant") {
      const text = Array.isArray(message.content)
        ? message.content
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text?.trim() ?? "")
            .filter(Boolean)
            .join("\n")
        : (message.text?.trim() ?? "");
      if (text) {
        result.push({
          id: message.id,
          role: "assistant",
          text,
          created: message.time?.created ?? 0,
        });
      }
    }
  }
  return result;
}

/** Take messages after the stored watermark, or the last N when it is gone. */
export function selectIncrement(
  messages: ExtractMessage[],
  lastMessageID: string | null,
  maxMessages: number
): ExtractMessage[] | null {
  if (messages.length === 0) return null;
  let start = Math.max(0, messages.length - maxMessages);
  if (lastMessageID) {
    const index = messages.findIndex((message) => message.id === lastMessageID);
    if (index >= 0) start = index + 1;
  }
  const slice = messages.slice(start);
  return slice.length > 0 ? slice : null;
}

export function buildIncrement(
  messages: ExtractMessage[],
  limits: { maxAssistantChars: number; maxInputChars: number },
  redact: (text: string) => string = (text) => text
): Increment | null {
  const users = messages.filter((message) => message.role === "user");
  if (users.length === 0) return null;

  const assistants = messages.filter((message) => message.role === "assistant");
  const finalAssistant = redact(assistants.at(-1)?.text ?? "");
  const userText = users.map((message) => redact(message.text)).join("\n---\n");
  const assistantText = finalAssistant.slice(0, limits.maxAssistantChars);
  const inputText = (
    assistantText ? `用户:\n${userText}\n\n助手:\n${assistantText}` : `用户:\n${userText}`
  ).slice(0, limits.maxInputChars);
  const queryText = `${userText}\n${assistantText}`.trim().slice(0, 2000);

  return {
    messages,
    nextLastId: messages[messages.length - 1]!.id,
    userCount: users.length,
    totalChars: inputText.length,
    queryText,
    inputText,
  };
}

export function buildExtractionPrompt(
  basePrompt: string,
  oldMemories: Array<Pick<MemoryHit, "id" | "title" | "content">>,
  inputText: string
): string {
  const memories =
    oldMemories.length === 0
      ? "（无）"
      : oldMemories.map((item) => `- [${item.id}] ${item.title}: ${item.content}`).join("\n");
  return [
    basePrompt.trim(),
    "",
    "## 旧记忆",
    memories,
    "",
    "## 本次对话增量",
    inputText,
    "",
    "只输出 JSON 数组，不要 Markdown 代码块，不要解释。",
  ].join("\n");
}

function parseJsonArray(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // try a fenced block, then the first bracketed array
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  if (fenced) {
    try {
      return JSON.parse(fenced);
    } catch {
      // fall through
    }
  }

  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error("提取结果不是 JSON 数组");
}

/** Parse and shape-check the model output. Service still validates category/length/secrets. */
export function parseExtractionItems(
  text: string,
  maxItems: number
): { items: ExtractItem[]; skipped: number } {
  const parsed = parseJsonArray(text);
  if (!Array.isArray(parsed)) throw new Error("提取结果不是 JSON 数组");

  const items: ExtractItem[] = [];
  let skipped = 0;
  for (const raw of parsed) {
    if (items.length >= maxItems) {
      skipped++;
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      skipped++;
      continue;
    }
    const value = raw as Record<string, unknown>;
    const action = value.action === "add" || value.action === "update" ? value.action : null;
    const title = typeof value.title === "string" ? value.title.trim() : "";
    const category = typeof value.category === "string" ? value.category.trim() : "";
    const content = typeof value.content === "string" ? value.content.trim() : "";
    const id = typeof value.id === "string" ? value.id.trim() : "";
    const relatedFiles = Array.isArray(value.related_files)
      ? value.related_files.filter((item): item is string => typeof item === "string")
      : [];

    if (!action || !title || !category || !content || (action === "update" && !id)) {
      skipped++;
      continue;
    }
    items.push({
      action,
      ...(action === "update" ? { id } : {}),
      title,
      category,
      content,
      related_files: relatedFiles,
    });
  }
  return { items, skipped };
}

export interface ExtractionDeps {
  service: MemoryService;
  generate: (prompt: string) => Promise<string>;
  readPrompt: () => string;
  getMessages: (sessionID: string) => Promise<RawSessionMessage[]>;
  now?: () => number;
}

/**
 * Runs at most one extraction model call per idle. A successful call or a
 * non-retryable failure advances the watermark. Transient failures keep it in
 * place, use a failure cooldown, and give up after two attempts.
 */
export async function runAutoExtraction(
  sessionID: string,
  config: CortexConfig,
  deps: ExtractionDeps
): Promise<ExtractionOutcome> {
  const now = deps.now?.() ?? Date.now();
  try {
    const state = await deps.service.getSessionState(sessionID);
    if (
      state.failed_at !== null &&
      now - state.failed_at < config.autoExtract.failureCooldownMinutes * 60_000
    ) {
      return { status: "skipped", reason: "failure_cooldown" };
    }
    if (
      state.last_extracted_at !== null &&
      now - state.last_extracted_at < config.autoExtract.cooldownMinutes * 60_000
    ) {
      return { status: "skipped", reason: "cooldown" };
    }

    let rawMessages: RawSessionMessage[];
    try {
      rawMessages = await deps.getMessages(sessionID);
    } catch (error) {
      log("auto extraction: read messages failed", { error: errorMessage(error) });
      return { status: "failed", reason: "read_messages" };
    }

    const all = toExtractMessages(rawMessages);
    const incrementMessages = selectIncrement(
      all,
      state.last_extracted_message_id,
      config.autoExtract.maxMessages
    );
    if (!incrementMessages) return { status: "skipped", reason: "no_increment" };

    // Redact with the same rules used by the write path before any truncation,
    // so a secret split by a slice boundary cannot leak. Only counts and rule
    // names may be logged.
    let redactionHits = 0;
    const redactionRules = new Set<string>();
    const increment = buildIncrement(
      incrementMessages,
      config.autoExtract,
      (text) => {
        const result = redactSecrets(text, config.blockedPatterns);
        redactionHits += result.hits;
        for (const rule of result.rules) redactionRules.add(rule);
        return result.text;
      }
    );
    if (!increment) return { status: "skipped", reason: "no_user_text" };
    if (
      increment.userCount < config.autoExtract.minNewMessages ||
      increment.totalChars < config.autoExtract.minInputChars
    ) {
      return { status: "skipped", reason: "too_short" };
    }
    if (redactionHits > 0) {
      log("auto extraction: input redacted", {
        hits: redactionHits,
        rules: [...redactionRules],
      });
    }

    const failTransient = async (reason: string): Promise<ExtractionOutcome> => {
      const attempts = await deps.service.recordExtractionFailure(
        sessionID,
        increment.nextLastId,
        now
      );
      log("auto extraction: transient failure", {
        reason,
        attempts,
        max_attempts: MAX_EXTRACTION_ATTEMPTS,
      });
      if (attempts >= MAX_EXTRACTION_ATTEMPTS) {
        await deps.service.setSessionState(sessionID, increment.nextLastId, now);
        log("auto extraction: attempt limit reached, watermark advanced", {
          reason,
          attempts,
        });
      }
      return { status: "failed", reason, attempts };
    };

    let oldMemories: MemoryHit[];
    try {
      oldMemories = await deps.service.search(increment.queryText, 3);
    } catch (error) {
      log("auto extraction: retrieval failed", { error: errorMessage(error) });
      return failTransient("retrieval");
    }

    let basePrompt: string;
    try {
      basePrompt = deps.readPrompt();
    } catch (error) {
      log("auto extraction: prompt missing", { error: errorMessage(error) });
      await deps.service.setSessionState(sessionID, increment.nextLastId, now);
      return { status: "failed", reason: "prompt" };
    }

    let output: string;
    try {
      output = await deps.generate(
        buildExtractionPrompt(basePrompt, oldMemories, increment.inputText)
      );
    } catch (error) {
      log("auto extraction: generate failed", { error: errorMessage(error) });
      if (isTransientFailure(error)) return failTransient("generate");
      await deps.service.setSessionState(sessionID, increment.nextLastId, now);
      log("auto extraction: non-retryable generate error, watermark advanced", {});
      return { status: "failed", reason: "generate" };
    }

    // The model answered: consume the increment even if its JSON is invalid.
    await deps.service.setSessionState(sessionID, increment.nextLastId, now);

    let parsed: { items: ExtractItem[]; skipped: number };
    try {
      parsed = parseExtractionItems(output, config.autoExtract.maxItems);
    } catch (error) {
      log("auto extraction: invalid output", { error: errorMessage(error) });
      return { status: "failed", reason: "parse" };
    }

    if (config.autoCaptureDryRun) {
      const captured = appendDryRun(config, sessionID, parsed.items, now);
      log("auto extraction: dry run captured", {
        captured,
        skipped: parsed.skipped,
      });
      return {
        status: "ok",
        added: 0,
        updated: 0,
        skippedItems: parsed.skipped,
        dryRun: true,
        captured,
      };
    }

    let added = 0;
    let updated = 0;
    let skippedItems = parsed.skipped;
    for (const item of parsed.items) {
      try {
        await deps.service.autoMutate(item);
        if (item.action === "add") added++;
        else updated++;
      } catch (error) {
        skippedItems++;
        log("auto extraction: item skipped", {
          code: error instanceof MemoryError ? error.code : "error",
          action: item.action,
        });
      }
    }

    log("auto extraction: finished", { added, updated, skipped: skippedItems });
    return { status: "ok", added, updated, skippedItems };
  } catch (error) {
    log("auto extraction: failed", { error: errorMessage(error) });
    return { status: "failed", reason: "unexpected" };
  }
}

function isTransientFailure(error: unknown): boolean {
  const name =
    error && typeof error === "object" && "name" in error ? String(error.name) : "";
  if (name === "AbortError" || name === "TimeoutError") return true;
  const message = errorMessage(error).toLowerCase();
  return /timeout|timed out|aborted|rate.?limit|too many requests|429|econnreset|econnrefused|enotfound|eai_again|network|fetch failed|socket hang up|connection (?:reset|closed|refused)|temporar|overloaded|unavailable|\b50[0234]\b/.test(
    message
  );
}

/** Append redacted extraction candidates without touching the database. */
function appendDryRun(
  config: CortexConfig,
  sessionID: string,
  items: ExtractItem[],
  now: number
): number {
  const path = join(config.storagePath, "dry-run.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  const time = new Date(now).toISOString();
  const lines = items.map((item) => {
    const title = redactSecrets(item.title, config.blockedPatterns).text;
    const content = redactSecrets(item.content, config.blockedPatterns).text;
    const relatedFiles = item.related_files.map(
      (file) => redactSecrets(file, config.blockedPatterns).text
    );
    return JSON.stringify({
      time,
      session_id: sessionID,
      action: item.action,
      ...(item.id ? { id: item.id } : {}),
      title,
      category: item.category,
      content,
      related_files: relatedFiles,
    });
  });
  if (lines.length > 0) appendFileSync(path, `${lines.join("\n")}\n`, "utf-8");
  return lines.length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
