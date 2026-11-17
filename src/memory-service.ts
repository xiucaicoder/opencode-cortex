import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { CortexConfig } from "./config.js";
import type { ProjectInfo } from "./project.js";
import type { Embedder } from "./embedding.js";
import { backupFileName, createDailyBackup as writeDailyBackup } from "./backup.js";
import { MemoryError } from "./errors.js";
import { log } from "./logger.js";
import { findBlockedField } from "./secrets.js";
import {
  CATEGORIES,
  MemoryStore,
  type ExtractionCursor,
  type MemoryCategory,
  type MemoryRecord,
  type MemorySource,
  type SessionState,
} from "./store.js";

export type Actor = "tool" | "auto" | "import";
export interface VerifiedMutation extends MutateInput {
  source_ref: string;
  evidence_at?: number;
  comparisons?: Array<{ id: string; version: number; relation: "same" | "distinct" | "conflict" }>;
}

export interface MemoryHit {
  id: string;
  title: string;
  category: MemoryCategory;
  content: string;
  related_files: string[];
  source: MemorySource;
  source_ref?: string;
  updated_at: number;
  version: number;
}

export interface MutateInput {
  action: "add" | "update" | "delete";
  id?: string;
  version?: number;
  title?: string;
  category?: string;
  content?: string;
  related_files?: string[];
  source_ref?: string;
}

export interface RelatedMemory {
  id: string;
  title: string;
  content: string;
  similarity: number;
}

export interface MutateResult {
  success: true;
  id: string;
  version: number;
  related?: RelatedMemory[];
}

export interface ImportRecordInput {
  id?: string;
  title: string;
  category: string;
  content: string;
  related_files?: string[];
  source_ref?: string;
  created_at?: number;
  updated_at?: number;
}

export interface ImportRecordResult {
  id: string;
  action: "inserted" | "updated" | "skipped";
  version: number;
}

export interface TitleEntry {
  id: string;
  category: MemoryCategory;
  title: string;
}

export interface AutoMutation extends VerifiedMutation {
  action: "add" | "update";
  id?: string;
  version?: number;
  title: string;
  category: string;
  content: string;
  related_files?: string[];
  source_ref: string;
}

export { MemoryError };

const MAX_CONTENT_CHARS = 200;

const SKIPPABLE_AUTO_ERRORS = new Set([
  "archived", "blocked_secret", "stale_evidence", "content_too_long", "duplicate", "duplicate_protected",
  "invalid_category", "invalid_related_files", "missing_field", "not_found", "protected_source",
]);

function numericConflict(a: string, b: string): boolean {
  const numbers = (text: string) => [...new Set(text.match(/\d+(?:\.\d+)?/g) ?? [])].sort().join(",");
  const left = numbers(a);
  const right = numbers(b);
  return !!left && !!right && left !== right;
}

function isRejectedAutoItem(error: unknown): error is MemoryError {
  return error instanceof MemoryError && SKIPPABLE_AUTO_ERRORS.has(error.code);
}

function matchesCursor(state: SessionState, cursor: ExtractionCursor): boolean {
  return state.last_extracted_message_id === cursor.messageId &&
    state.last_extracted_offset === cursor.offset;
}

function charCount(value: string): number {
  return [...value].length;
}

function requiredString(value: string | undefined, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MemoryError("missing_field", `${field} 不能为空`, { field });
  }
  return value.trim();
}

function normalizeCategory(value: string | undefined): MemoryCategory {
  if (!value || !CATEGORIES.includes(value as MemoryCategory)) {
    throw new MemoryError(
      "invalid_category",
      `category 非法：${value ?? "(缺失)"}。必须是 ${CATEGORIES.join(" / ")} 之一`,
      { allowed: [...CATEGORIES] }
    );
  }
  return value as MemoryCategory;
}

function normalizeRelatedFiles(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new MemoryError("invalid_related_files", "related_files 必须是字符串数组");
  }
  const files: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new MemoryError("invalid_related_files", "related_files 必须是字符串数组");
    }
    const trimmed = item.trim();
    if (trimmed) files.push(trimmed);
  }
  return files;
}

function roundSimilarity(value: number): number {
  return Number(value.toFixed(4));
}

function toHit(record: MemoryRecord): MemoryHit {
  return {
    id: record.id,
    title: record.title,
    category: record.category,
    content: record.content,
    related_files: record.related_files,
    source: record.source,
    ...(record.source_ref ? { source_ref: record.source_ref } : {}),
    updated_at: record.updated_at,
    version: record.version,
  };
}

export class MemoryService {
  private readyPromise: Promise<void> | null = null;

  constructor(
    private readonly config: CortexConfig,
    private readonly project: ProjectInfo,
    private readonly store: MemoryStore,
    private readonly embedder: Embedder
  ) {}

  async ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        if (this.embedder.dimensions !== this.config.embeddingDimensions) {
          throw new MemoryError(
            "embedding_mismatch",
            `Embedding 维度不匹配：embedder 返回 ${this.embedder.dimensions} 维，配置为 ${this.config.embeddingDimensions} 维`
          );
        }
        try {
          await this.store.open();
          await this.store.recordProject({
            identity: this.project.identity,
            root: this.project.root,
            name: this.project.name,
          });
        } catch (error) {
          if (error instanceof MemoryError) throw error;
          throw new MemoryError(
            "storage_error",
            error instanceof Error ? error.message : String(error)
          );
        }
      })();
      try {
        await this.readyPromise;
      } catch (error) {
        this.readyPromise = null;
        throw error;
      }
    } else {
      await this.readyPromise;
    }
  }

  async close(): Promise<void> {
    await this.store.close();
    await this.embedder.dispose();
  }

  async search(query: string, limit = 5, includeConflicts = false): Promise<MemoryHit[]> {
    await this.ready();
    if (typeof query !== "string" || !query.trim()) {
      throw new MemoryError("missing_field", "query 不能为空");
    }
    const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit || 5)));
    const vector = await this.embed(`${query.trim()}`);
    const hits = await this.store.search(query.trim(), vector, safeLimit, includeConflicts);
    return hits.map(toHit);
  }

  async listConflicts(): Promise<unknown[]> {
    await this.ready();
    return this.store.listConflicts();
  }

  /**
   * Best-effort daily snapshot into `<storagePath>/backups`. Returns true when
   * a new backup file was created; failures propagate and are logged upstream.
   */
  async createDailyBackup(now = new Date()): Promise<boolean> {
    await this.ready();
    const backupsDir = join(this.config.storagePath, "backups");
    const created = await writeDailyBackup(this.store, backupsDir, this.project.dbPath, now);
    if (created) log("memory backup created", { file: backupFileName(this.project.dbPath, now) });
    return created;
  }

  async getActive(id: string): Promise<MemoryHit | undefined> {
    await this.ready();
    const record = await this.store.getById(id);
    return record?.status === "active" ? toHit(record) : undefined;
  }

  async mutateVerified(input: VerifiedMutation): Promise<MutateResult> {
    await this.ready();
    this.assertNoSecrets({ title: input.title ?? "", content: input.content ?? "",
      related_files: normalizeRelatedFiles(input.related_files), source_ref: input.source_ref });
    const vector = input.action === "delete" ? undefined
      : await this.embed(`${requiredString(input.title, "title")}
${requiredString(input.content, "content")}`);
    const result = await this.store.inTransaction(async (store) => {
      const service = new MemoryService(this.config, this.project, store, this.embedder);
      try {
        if (input.action === "add") return await service.add(input, "tool", vector, input);
        if (input.action === "update") return await service.update(input, "tool", vector, input);
        await service.checkEvidenceTime(requiredString(input.id, "id"), input.evidence_at);
        return await service.archive(input, "tool");
      } catch (error) {
        if (!(error instanceof MemoryError) || error.code !== "possible_conflict") throw error;
        return error;
      }
    });
    if (result instanceof MemoryError) throw result;
    return result;
  }

  async mutate(input: MutateInput, actor: Actor = "tool"): Promise<MutateResult> {
    await this.ready();
    if (input.action === "add") return this.add(input, actor);
    if (input.action === "update") return this.update(input, actor);
    if (input.action === "delete") return this.archive(input, actor);
    throw new MemoryError(
      "invalid_action",
      `action 非法：${String(input.action)}。必须是 add / update / delete`
    );
  }

  async getOverview(): Promise<string> {
    await this.ready();
    return this.store.getOverview();
  }

  async setOverview(content: string): Promise<void> {
    await this.ready();
    const trimmed = content.trim();
    if (charCount(trimmed) > 500) {
      throw new MemoryError("overview_too_long", `项目概览超过 500 字（当前 ${charCount(trimmed)} 字）`);
    }
    await this.store.setOverview(trimmed);
  }

  async listActive(): Promise<MemoryHit[]> {
    await this.ready();
    return (await this.store.listActive()).map(toHit);
  }

  async listArchived(): Promise<MemoryHit[]> {
    await this.ready();
    return (await this.store.listArchived()).map(toHit);
  }

  async listTitles(limit: number): Promise<TitleEntry[]> {
    await this.ready();
    return this.store.listActiveTitles(limit);
  }

  async getSessionState(sessionID: string): Promise<SessionState> {
    await this.ready();
    return this.store.getSessionState(sessionID);
  }

  async setSessionState(sessionID: string, messageID: string, at: number): Promise<void> {
    await this.ready();
    await this.store.setSessionState(sessionID, { messageId: messageID, offset: 0 }, at);
  }

  async recordExtractionFailure(
    sessionID: string,
    cursor: ExtractionCursor,
    target: ExtractionCursor,
    at: number
  ): Promise<number | undefined> {
    await this.ready();
    return this.store.inTransaction(async (store) => {
      if (!matchesCursor(await store.getSessionState(sessionID), cursor)) return;
      const targetID = target.offset === 0 ? target.messageId! : JSON.stringify(target);
      return store.recordExtractionFailure(sessionID, targetID, at);
    });
  }

  /** Commit accepted memories and their checkpoint together. */
  async applyExtractionBatch(
    sessionID: string,
    cursor: ExtractionCursor,
    next: ExtractionCursor,
    at: number | null,
    items: AutoMutation[]
  ): Promise<{ added: number; updated: number; skipped: number; conflicts: number } | null> {
    await this.ready();
    const result = { added: 0, updated: 0, skipped: 0, conflicts: 0 };
    const prepared: Array<{ input: AutoMutation; vector: Float32Array }> = [];
    for (const input of items) {
      try {
        const title = requiredString(input.title, "title");
        const content = requiredString(input.content, "content");
        normalizeCategory(input.category);
        assertContentLength(content);
        this.assertNoSecrets({
          title,
          content,
          related_files: normalizeRelatedFiles(input.related_files),
          source_ref: requiredString(input.source_ref, "source_ref"),
        });
        // The embedder may be slow. Keep it outside the database transaction.
        const vector = await this.embed(`${title}\n${content}`);
        prepared.push({ input, vector });
      } catch (error) {
        if (!isRejectedAutoItem(error)) throw error;
        result.skipped++;
        log("auto extraction: item skipped", { code: error.code, action: input.action });
      }
    }

    return this.store.inTransaction(async (store) => {
      if (!matchesCursor(await store.getSessionState(sessionID), cursor)) return null;
      const service = new MemoryService(this.config, this.project, store, this.embedder);
      for (const { input, vector } of prepared) {
        try {
          if (input.action === "add") {
            await service.add(input, "auto", vector, input);
            result.added++;
          } else {
            await service.update(input, "auto", vector, input);
            result.updated++;
          }
        } catch (error) {
          if (error instanceof MemoryError && error.code === "possible_conflict") {
            result.conflicts++;
            continue;
          }
          if (!isRejectedAutoItem(error)) throw error;
          result.skipped++;
          log("auto extraction: item skipped", { code: error.code, action: input.action });
        }
      }
      await store.setSessionState(sessionID, next, at);
      return result;
    });
  }

  /**
   * Import path used by scripts/import.ts. Preserves ids for round-trips and
   * validates content, category and secrets exactly like the tool path.
   */
  async importRecord(input: ImportRecordInput): Promise<ImportRecordResult> {
    await this.ready();
    const title = requiredString(input.title, "title");
    const category = normalizeCategory(input.category);
    const content = requiredString(input.content, "content");
    assertContentLength(content);

    const existing = input.id ? await this.store.getById(input.id) : null;
    const relatedFiles =
      input.related_files === undefined
        ? existing?.related_files ?? []
        : normalizeRelatedFiles(input.related_files);
    const sourceRef =
      input.source_ref === undefined
        ? existing?.source_ref ?? null
        : input.source_ref.trim() || null;
    this.assertNoSecrets({ title, content, related_files: relatedFiles, source_ref: sourceRef ?? undefined });

    if (existing) {
      if (existing.status !== "active") {
        throw new MemoryError("archived", `记忆 ${existing.id} 已归档，导入不会恢复`, { id: existing.id });
      }
      const unchanged =
        existing.title === title &&
        existing.category === category &&
        existing.content === content &&
        JSON.stringify(existing.related_files) === JSON.stringify(relatedFiles) &&
        existing.source_ref === sourceRef;
      if (unchanged) return { id: existing.id, action: "skipped", version: existing.version };

      const vector = await this.embed(`${title}\n${content}`);
      const changes = await this.store.update(
        {
          ...existing,
          title,
          category,
          content,
          related_files: relatedFiles,
          source_ref: sourceRef,
          updated_at: input.updated_at ?? Date.now(),
        },
        existing.version,
        vector
      );
      if (changes === 0) throw await this.versionConflict(existing.id, existing.version);
      return { id: existing.id, action: "updated", version: existing.version + 1 };
    }

    if (!input.id) {
      const result = await this.add(
        { action: "add", title, category, content, related_files: relatedFiles, source_ref: sourceRef ?? undefined },
        "import"
      );
      return { id: result.id, action: "inserted", version: result.version };
    }

    const id = requiredString(input.id, "id");
    const now = Date.now();
    const vector = await this.embed(`${title}\n${content}`);
    await this.store.insert(
      {
        id,
        title,
        category,
        content,
        related_files: relatedFiles,
        source: "import",
        source_ref: sourceRef,
        status: "active",
        review_note: null,
        version: 1,
        created_at: input.created_at ?? now,
        updated_at: input.updated_at ?? now,
      },
      vector
    );
    return { id, action: "inserted", version: 1 };
  }

  /** 8-hex-char id; lengthen only if the tiny namespace keeps colliding. */
  private async newMemoryId(): Promise<string> {
    for (const bytes of [4, 5, 6]) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const id = randomBytes(bytes).toString("hex");
        if (!(await this.store.getById(id))) return id;
      }
    }
    throw new MemoryError("id_collision", "无法生成唯一的记忆 id，请重试");
  }

  private async add(input: MutateInput, actor: Actor, embedded?: Float32Array, verified?: VerifiedMutation): Promise<MutateResult> {
    const title = requiredString(input.title, "title");
    const category = normalizeCategory(input.category);
    const content = requiredString(input.content, "content");
    const relatedFiles = normalizeRelatedFiles(input.related_files);
    const sourceRef = input.source_ref?.trim() || null;
    assertContentLength(content);
    this.assertNoSecrets({ title, content, related_files: relatedFiles, source_ref: sourceRef ?? undefined });

    const source: MemorySource =
      actor === "auto" ? "auto" : actor === "import" || (!verified && sourceRef) ? "import" : "manual";
    const vector = embedded ?? await this.embed(`${title}\n${content}`);

    const nearest = await this.store.findNearest(vector, this.config.dedupRelatedLimit);
    const close = nearest.filter((item) => item.similarity >= this.config.dedupRejectThreshold);
    const duplicate = close.find((existing) => {
      if (!verified) return !numericConflict(content, existing.content);
      if (title === existing.title && content === existing.content) return true;
      return !numericConflict(content, existing.content) &&
        verified.comparisons?.some(({ id, version, relation }) =>
          id === existing.id && version === existing.version && relation === "same");
    });
    if (duplicate) {
      const protectedSource = actor === "auto" && duplicate.source !== "auto";
      throw new MemoryError(protectedSource ? "duplicate_protected" : "duplicate",
        `已存在等价记忆 ${duplicate.id}`, {
          id: duplicate.id, similarity: roundSimilarity(duplicate.similarity),
        });
    }
    const uncertain = close.filter((existing) => verified
      ? !verified.comparisons?.some(({ id, version, relation }) =>
          id === existing.id && version === existing.version && relation === "distinct")
      : numericConflict(content, existing.content));
    if (uncertain.length) {
      if (verified) {
        for (const existing of uncertain) {
          await this.checkEvidenceTime(existing.id, verified.evidence_at);
        }
        for (const existing of uncertain) {
          await this.store.recordConflict(existing.id, existing.version, {
            title, category, content, source_ref: verified.source_ref,
            blocksRecall: (title === existing.title && numericConflict(content, existing.content)) ||
              Boolean(verified.comparisons?.some(({ id, version, relation }) =>
                id === existing.id && version === existing.version && relation === "conflict")),
          });
        }
      }
      throw new MemoryError("possible_conflict", "发现相似但无法确认可并存的规则，请核对范围及当前版本", {
        ids: uncertain.map(({ id }) => id),
      });
    }
    const now = Date.now();
    const record: MemoryRecord = {
      id: await this.newMemoryId(),
      title,
      category,
      content,
      related_files: relatedFiles,
      source,
      source_ref: sourceRef,
      status: "active",
      review_note: null,
      version: 1,
      created_at: now,
      updated_at: now,
    };
    await this.store.insert(record, vector);
    await this.store.recordEvidenceTime(record.id, verified?.evidence_at);

    const related = nearest
      .filter((item) => item.available && item.similarity >= this.config.dedupRelatedThreshold)
      .map((item) => ({
        id: item.id,
        title: item.title,
        content: item.content,
        similarity: roundSimilarity(item.similarity),
      }));
    if (actor !== "auto") log("memory added", { id: record.id, category, source, related_count: related.length });
    return { success: true, id: record.id, version: 1, related };
  }

  private async update(input: MutateInput, actor: Actor, embedded?: Float32Array, verified?: VerifiedMutation): Promise<MutateResult> {
    const id = requiredString(input.id, "id");
    const expectedVersion = requireVersion(input.version);
    const title = requiredString(input.title, "title");
    const category = normalizeCategory(input.category);
    const content = requiredString(input.content, "content");
    assertContentLength(content);

    const current = await this.store.getById(id);
    if (!current) throw new MemoryError("not_found", `记忆 ${id} 不存在`, { id });
    if (current.status !== "active") {
      throw new MemoryError("archived", `记忆 ${id} 已归档，不能更新`, { id });
    }
    if (actor === "auto" && current.source !== "auto") {
      if (verified && current.category === category && content !== current.content) {
        await this.checkEvidenceTime(id, verified.evidence_at);
        await this.store.recordConflict(id, current.version, {
          title, content, category, source_ref: verified.source_ref, blocksRecall: true,
        });
        throw new MemoryError("possible_conflict", "现有规则来自人工或导入，已暂缓检索，等待确认", { id });
      }
      throw new MemoryError(
        "protected_source",
        `记忆 ${id} 来源为 ${current.source}，自动提取不能修改`,
        { id, source: current.source }
      );
    }

    if (verified) await this.checkEvidenceTime(id, verified.evidence_at);
    if (actor === "auto" && verified && current.category !== category) {
      throw new MemoryError("invalid_category", "自动更新不能改变已有规则的分类");
    }

    const relatedFiles =
      input.related_files === undefined
        ? current.related_files
        : normalizeRelatedFiles(input.related_files);
    const sourceRef =
      input.source_ref === undefined ? current.source_ref : input.source_ref.trim() || null;
    this.assertNoSecrets({ title, content, related_files: relatedFiles, source_ref: sourceRef ?? undefined });

    const vector = embedded ?? await this.embed(`${title}\n${content}`);
    const changes = await this.store.update(
      {
        ...current,
        title,
        category,
        content,
        related_files: relatedFiles,
        source_ref: sourceRef,
        updated_at: Date.now(),
      },
      expectedVersion,
      vector
    );
    if (changes === 0) throw await this.versionConflict(id, expectedVersion);

    await this.store.recordEvidenceTime(id, verified?.evidence_at);
    if (actor !== "auto") log("memory updated", { id, version: expectedVersion + 1, actor });
    return { success: true, id, version: expectedVersion + 1 };
  }

  private async checkEvidenceTime(id: string, at: number | undefined): Promise<void> {
    const previous = await this.store.getEvidenceTime(id);
    if (previous !== undefined && (at === undefined || at <= previous)) {
      throw new MemoryError("stale_evidence", "该证据不能证明这条规则在当前版本之后又有变化", { id });
    }
  }

  private async archive(input: MutateInput, actor: Actor): Promise<MutateResult> {
    if (actor === "auto") {
      throw new MemoryError("protected_source", "自动提取不能删除或归档记忆");
    }
    const id = requiredString(input.id, "id");
    const expectedVersion = requireVersion(input.version);
    const current = await this.store.getById(id);
    if (!current) throw new MemoryError("not_found", `记忆 ${id} 不存在`, { id });
    if (current.status !== "active") {
      throw new MemoryError("archived", `记忆 ${id} 已归档`, { id });
    }
    const nextVersion = expectedVersion + 1;
    const changes = await this.store.archive(id, expectedVersion, Date.now());
    if (changes === 0) throw await this.versionConflict(id, expectedVersion);

    log("memory archived", { id, version: nextVersion });
    return { success: true, id, version: nextVersion };
  }

  private async versionConflict(id: string, expectedVersion: number): Promise<MemoryError> {
    const current = await this.store.getById(id);
    if (!current) return new MemoryError("not_found", `记忆 ${id} 不存在`, { id });
    if (current.status !== "active") {
      return new MemoryError("archived", `记忆 ${id} 已归档`, { id });
    }
    return new MemoryError(
      "version_conflict",
      `版本冲突：当前 version 为 ${current.version}，提交的是 ${expectedVersion}。请重新检索后再试`,
      { id, current_version: current.version }
    );
  }

  private assertNoSecrets(fields: {
    title: string;
    content: string;
    related_files: string[];
    source_ref?: string;
  }): void {
    const blocked = findBlockedField(fields, this.config.blockedPatterns);
    if (!blocked) return;
    log("memory blocked by secret pattern", { field: blocked.field, rule: blocked.rule });
    throw new MemoryError(
      "blocked_secret",
      `拒绝写入：${blocked.field} 命中敏感信息规则 ${blocked.rule}。请移除密钥、令牌、密码、内网地址或证件号后重试`,
      { field: blocked.field, rule: blocked.rule }
    );
  }

  private async embed(text: string): Promise<Float32Array> {
    try {
      return await this.embedder.embed(text);
    } catch (error) {
      if (error instanceof MemoryError) throw error;
      throw new MemoryError(
        "embedding_error",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

function assertContentLength(content: string): void {
  const length = charCount(content);
  if (length > MAX_CONTENT_CHARS) {
    throw new MemoryError(
      "content_too_long",
      `content 超过 ${MAX_CONTENT_CHARS} 字（当前 ${length} 字）。请压缩为只写结论和原因`,
      { length, max: MAX_CONTENT_CHARS }
    );
  }
}

function requireVersion(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new MemoryError(
      "missing_field",
      "update/delete 必须提供 version（从 memory_search 返回结果中获取）",
      { field: "version" }
    );
  }
  return value;
}
