import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CortexConfig } from "./config.js";
import type { AutoMutation, MemoryHit, MemoryService } from "./memory-service.js";
import { compatibleEvidence, sessionSourceRef, type EvidenceReview, type VerifyEvidence } from "./evidence.js";
import { parseModelArray } from "./model-json.js";
import { log } from "./logger.js";
import { redactSecrets } from "./secrets.js";
import type { ExtractionCursor } from "./store.js";

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
  evidence_index: number;
  evidence_quote: string;
}

interface Increment {
  messages: ExtractMessage[];
  next: ExtractionCursor;
  hasMore: boolean;
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
  conflicts?: number;
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

function prefixWithinBudget(text: string, chars: number, encode: (value: string) => string): string {
  if (encode(text).length <= chars) return text;
  let low = 0;
  let high = Math.min(text.length, chars);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encode(text.slice(0, middle)).length <= chars) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low).replace(/[\uD800-\uDBFF]$/, "");
}

function buildIncrement(
  messages: ExtractMessage[],
  cursor: ExtractionCursor,
  limits: Pick<CortexConfig["autoExtract"], "maxMessages" | "maxAssistantChars" | "maxInputChars">,
  redact: (text: string) => string
): Increment | null {
  const previous = messages.findIndex((message) => message.id === cursor.messageId);
  const start = previous < 0 ? 0 : previous + (cursor.offset === 0 ? 1 : 0);
  if (start === messages.length) return null;

  const fragments: ExtractMessage[] = [];
  const lines: string[] = [];
  let next = cursor;
  let inputChars = 0;
  let lastIndex = start;
  for (let i = start; i < messages.length && fragments.length < limits.maxMessages; i++) {
    const message = messages[i]!;
    // Redact the whole message before slicing so a boundary cannot split a credential.
    const redacted = redact(message.text);
    const offset = i === previous && cursor.offset < redacted.length ? cursor.offset : 0;
    const index = fragments.length + 1;
    const encode = (text: string) => JSON.stringify({ index, role: message.role, text });
    const budget = limits.maxInputChars - inputChars - (lines.length ? 1 : 0);
    const remaining = redacted.slice(offset);
    const available = message.role === "assistant" && remaining.length > limits.maxAssistantChars
      ? remaining.slice(0, limits.maxAssistantChars).replace(/[\uD800-\uDBFF]$/, "") ||
        String.fromCodePoint(remaining.codePointAt(0)!)
      : remaining;
    // Defer a complete message to the next batch if it fits there.
    if (fragments.length && (available.length < remaining.length || encode(available).length > budget)) break;
    const text = prefixWithinBudget(available, budget, encode);
    if (!text) throw new Error("提取字数上限不足以容纳消息");
    const line = encode(text);
    inputChars += line.length + (lines.length ? 1 : 0);
    lines.push(line);
    fragments.push({ ...message, text });
    lastIndex = i;
    const end = offset + text.length;
    next = { messageId: message.id, offset: end < redacted.length ? end : 0 };
    if (next.offset > 0) break;
  }

  return {
    messages: fragments,
    next,
    hasMore: next.offset > 0 || lastIndex < messages.length - 1,
    userCount: fragments.filter((message) => message.role === "user").length,
    totalChars: fragments.reduce((count, message) => count + message.text.length, 0),
    queryText: fragments.map((message) => message.text).join("\n").slice(0, 2000),
    inputText: lines.join("\n"),
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

/** Parse and shape-check the model output. Service still validates category/length/secrets. */
export function parseExtractionItems(
  text: string,
  maxItems: number
): { items: ExtractItem[]; skipped: number } {
  const parsed = parseModelArray(text);

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
    const evidenceIndex = value.evidence_index;
    const evidenceQuote = typeof value.evidence_quote === "string" ? value.evidence_quote.trim() : "";
    const relatedFiles = Array.isArray(value.related_files)
      ? value.related_files.filter((item): item is string => typeof item === "string")
      : [];

    if (!action || !title || !category || !content || (action === "update" && !id) ||
        typeof evidenceIndex !== "number" || !Number.isSafeInteger(evidenceIndex) ||
        evidenceIndex < 1 || !evidenceQuote) {
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
      evidence_index: evidenceIndex,
      evidence_quote: evidenceQuote,
    });
  }
  return { items, skipped };
}

async function groundItems(
  items: ExtractItem[],
  messages: ExtractMessage[],
  oldMemories: MemoryHit[],
  sessionID: string,
  verify: VerifyEvidence,
  blockedPatterns: string[]
): Promise<AutoMutation[]> {
  const existing = new Map(oldMemories.map((item) => [item.id, item]));
  const candidates: Array<{ item: AutoMutation; review: EvidenceReview }> = [];
  for (const { evidence_index, evidence_quote, ...item } of items) {
    const evidence = messages[evidence_index - 1];
    if (evidence?.role !== "user" || evidence_quote.includes("[REDACTED]") ||
        !evidence.text.includes(evidence_quote) ||
        !compatibleEvidence(item.content, evidence_quote)) continue;
    const containsBlockedText = [item.title, item.content, ...item.related_files]
      .some((text) => redactSecrets(text, blockedPatterns).hits > 0);
    if (containsBlockedText) continue;
    const previous = item.id ? existing.get(item.id) : undefined;
    if (item.action === "update" && !previous) continue;
    candidates.push({
      item: {
        ...item,
        version: previous?.version,
        source_ref: sessionSourceRef(sessionID, evidence.id),
        evidence_at: evidence.created || undefined,
      },
      review: {
        action: item.action,
        title: item.title,
        category: item.category,
        content: item.content,
        related_files: item.related_files,
        quote: evidence_quote,
        evidence: evidence.text,
        previous,
        neighbors: item.action === "add" ? oldMemories : undefined,
      },
    });
  }
  if (!candidates.length) return [];
  const decisions = await verify(candidates.map(({ review }) => review));
  if (decisions.length !== candidates.length) throw new Error("核验结果数量不符");
  const updates = new Set<string>();
  return candidates.flatMap(({ item }, index) => {
    const decision = decisions[index];
    if (!decision?.supported || (item.id && updates.has(item.id))) return [];
    if (item.id) updates.add(item.id);
    return [{
      ...item,
      comparisons: oldMemories.flatMap(({ id, version }) => {
        const relation = decision.conflicts_with?.includes(id) ? "conflict"
          : decision.same_as?.includes(id) ? "same"
          : decision.distinct_from?.includes(id) ? "distinct" : undefined;
        return relation ? [{ id, version, relation }] : [];
      }),
    }];
  });
}

export interface ExtractionDeps {
  service: MemoryService;
  generate: (prompt: string) => Promise<string>;
  verify: VerifyEvidence;
  readPrompt: () => string;
  getMessages: (sessionID: string) => Promise<RawSessionMessage[]>;
  now?: () => number;
}

/**
 * Runs one extraction and at most one verification call per idle. A failed batch stays at
 * its last committed checkpoint and can be retried on a later idle.
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
      log("auto extraction: read messages failed");
      return { status: "failed", reason: "read_messages" };
    }

    const cursor: ExtractionCursor = {
      messageId: state.last_extracted_message_id,
      offset: state.last_extracted_offset,
    };

    // Redact with the same rules used by the write path before any truncation,
    // so a secret split by a slice boundary cannot leak. Only counts and rule
    // names may be logged.
    let redactionHits = 0;
    const redactionRules = new Set<string>();
    const increment = buildIncrement(
      toExtractMessages(rawMessages),
      cursor,
      config.autoExtract,
      (text) => {
        const result = redactSecrets(text, config.blockedPatterns);
        redactionHits += result.hits;
        for (const rule of result.rules) redactionRules.add(rule);
        return result.text;
      }
    );
    if (!increment) return { status: "skipped", reason: "no_increment" };
    // A queued tail should be processed even when shorter than the usual
    // minimum. Skip the success cooldown until the backlog is drained.
    const hasBacklog = cursor.messageId !== null && state.last_extracted_at === null;
    const completedAt = increment.hasMore ? null : now;
    if (increment.userCount === 0) {
      // Assistant-only material cannot substantiate a new memory.
      const applied = await deps.service.applyExtractionBatch(
        sessionID, cursor, increment.next, increment.hasMore ? null : state.last_extracted_at, []
      );
      return { status: "skipped", reason: applied ? "no_user_text" : "progress_changed" };
    }
    if (!increment.hasMore && !hasBacklog && (
      increment.userCount < config.autoExtract.minNewMessages ||
      increment.totalChars < config.autoExtract.minInputChars
    )) {
      return { status: "skipped", reason: "too_short" };
    }
    if (redactionHits > 0) {
      log("auto extraction: input redacted", {
        hits: redactionHits,
        rules: [...redactionRules],
      });
    }

    const failBatch = async (reason: string): Promise<ExtractionOutcome> => {
      const attempts = await deps.service.recordExtractionFailure(
        sessionID,
        cursor,
        increment.next,
        now
      );
      if (attempts === undefined) return { status: "skipped", reason: "progress_changed" };
      log("auto extraction: batch retained", { reason, attempts });
      return { status: "failed", reason, attempts };
    };

    let oldMemories: MemoryHit[];
    try {
      oldMemories = await deps.service.search(increment.queryText, 5, true);
    } catch {
      return await failBatch("retrieval");
    }

    let basePrompt: string;
    try {
      basePrompt = deps.readPrompt();
    } catch {
      return await failBatch("prompt");
    }

    let output: string;
    try {
      output = await deps.generate(
        buildExtractionPrompt(basePrompt, oldMemories, increment.inputText)
      );
    } catch {
      return await failBatch("generate");
    }

    let parsed: { items: ExtractItem[]; skipped: number };
    try {
      parsed = parseExtractionItems(output, config.autoExtract.maxItems);
    } catch {
      return await failBatch("parse");
    }

    let items: AutoMutation[];
    try {
      items = await groundItems(parsed.items, increment.messages, oldMemories, sessionID, deps.verify, config.blockedPatterns);
    } catch {
      return await failBatch("verify");
    }
    const skipped = parsed.skipped + parsed.items.length - items.length;
    try {
      if (config.autoCaptureDryRun) {
        const captured = appendDryRun(config, sessionID, items, now);
        const applied = await deps.service.applyExtractionBatch(sessionID, cursor, increment.next, completedAt, []);
        if (!applied) return { status: "skipped", reason: "progress_changed" };
        log("auto extraction: dry run captured", { captured, skipped });
        return { status: "ok", added: 0, updated: 0, skippedItems: skipped, dryRun: true, captured };
      }
      const applied = await deps.service.applyExtractionBatch(sessionID, cursor, increment.next, completedAt, items);
      if (!applied) return { status: "skipped", reason: "progress_changed" };
      const { added, updated, conflicts } = applied;
      const skippedItems = skipped + applied.skipped;
      log("auto extraction: finished", { added, updated, conflicts, skipped: skippedItems });
      return { status: "ok", added, updated, conflicts, skippedItems };
    } catch {
      return await failBatch("write");
    }
  } catch {
    log("auto extraction: failed");
    return { status: "failed", reason: "unexpected" };
  }
}

/** Append redacted extraction candidates without touching the database. */
function appendDryRun(
  config: CortexConfig,
  sessionID: string,
  items: AutoMutation[],
  now: number
): number {
  const path = join(config.storagePath, "dry-run.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  const time = new Date(now).toISOString();
  const lines = items.map((item) => {
    const title = redactSecrets(item.title, config.blockedPatterns).text;
    const content = redactSecrets(item.content, config.blockedPatterns).text;
    const relatedFiles = (item.related_files ?? []).map(
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
      source_ref: item.source_ref,
    });
  });
  if (lines.length > 0) appendFileSync(path, `${lines.join("\n")}\n`, "utf-8");
  return lines.length;
}
