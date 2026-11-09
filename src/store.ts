import { connect, type Database } from "@tursodatabase/database";
import type { EncryptionOpts } from "@tursodatabase/database-common";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./logger.js";

export const CATEGORIES = [
  "domain_rule",
  "arch_decision",
  "data_constraint",
  "pitfall",
] as const;
export type MemoryCategory = (typeof CATEGORIES)[number];

export const SOURCES = ["auto", "manual", "import"] as const;
export type MemorySource = (typeof SOURCES)[number];

export type MemoryStatus = "active" | "archived";

export interface MemoryRecord {
  id: string;
  title: string;
  category: MemoryCategory;
  content: string;
  related_files: string[];
  source: MemorySource;
  source_ref: string | null;
  status: MemoryStatus;
  review_note: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface MemorySearchHit extends MemoryRecord {
  similarity: number;
}

export interface NearestMemory {
  id: string;
  title: string;
  content: string;
  source: MemorySource;
  similarity: number;
}

export interface StoreOptions {
  dbPath: string;
  dimensions: number;
  model: string;
  dtype: string;
  pooling: string;
  encryption?: EncryptionOpts | null;
}

const SCHEMA_VERSION = "1";

function parseRelatedFiles(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    category: String(row.category) as MemoryCategory,
    content: String(row.content),
    related_files: parseRelatedFiles(row.related_files),
    source: String(row.source) as MemorySource,
    source_ref: row.source_ref == null ? null : String(row.source_ref),
    status: String(row.status) as MemoryStatus,
    review_note: row.review_note == null ? null : String(row.review_note),
    version: Number(row.version),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function escapeLike(token: string): string {
  return token.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function tokenize(text: string): string[] {
  const normalized = text.toLowerCase().trim();
  if (!normalized) return [];
  try {
    const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
    const words = [...segmenter.segment(normalized)]
      .filter((part) => part.isWordLike)
      .map((part) => part.segment.trim())
      .filter((word) => word.length >= 2);
    return [...new Set(words)].slice(0, 16);
  } catch {
    // Older runtimes without Intl.Segmenter: Latin words + CJK bigrams.
    const tokens: string[] = [];
    for (const chunk of normalized.split(/[\s,，。；;:：、/\\|()（）\[\]{}<>《》"'`]+/)) {
      if (!chunk) continue;
      if (/[\u3400-\u9fff]/.test(chunk)) {
        if (chunk.length === 1) tokens.push(chunk);
        else for (let i = 0; i < chunk.length - 1; i++) tokens.push(chunk.slice(i, i + 2));
      } else if (chunk.length >= 2) {
        tokens.push(chunk);
      }
    }
    return [...new Set(tokens)].slice(0, 16);
  }
}

export function tokenizeQuery(text: string): string[] {
  return tokenize(text);
}

/**
 * One SQLite/Turso database per project. Schema v1 is created from scratch;
 * pre-existing databases with unknown schema are refused, never migrated.
 */
export class MemoryStore {
  private db: Database | null = null;
  private opening: Promise<Database> | null = null;

  constructor(private readonly options: StoreOptions) {}

  async open(): Promise<void> {
    await this.connection();
  }

  async close(): Promise<void> {
    const db = this.db;
    this.db = null;
    this.opening = null;
    await db?.close();
  }

  private async connection(): Promise<Database> {
    if (this.db) return this.db;
    if (this.opening) return this.opening;

    this.opening = (async () => {
      mkdirSync(dirname(this.options.dbPath), { recursive: true });
      const experimental: Array<"encryption" | "multiprocess_wal"> = ["encryption"];
      if (process.platform !== "win32") experimental.push("multiprocess_wal");
      const db = await connect(this.options.dbPath, {
        experimental,
        ...(this.options.encryption ? { encryption: this.options.encryption } : {}),
        timeout: 10_000,
      });
      await this.initialize(db);
      this.db = db;
      return db;
    })();

    try {
      return await this.opening;
    } finally {
      this.opening = null;
    }
  }

  private async initialize(db: Database): Promise<void> {
    const existing = (await db.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'"
    )) as { name?: string } | null;
    const hasMeta = (await db.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_meta'"
    )) as { name?: string } | null;
    const version = hasMeta ? await this.getMetaWith(db, "schema_version") : null;

    if (!existing && !hasMeta) {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS project_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          category TEXT NOT NULL CHECK (category IN ('domain_rule','arch_decision','data_constraint','pitfall')),
          content TEXT NOT NULL,
          related_files TEXT NOT NULL DEFAULT '[]',
          source TEXT NOT NULL CHECK (source IN ('auto','manual','import')),
          source_ref TEXT,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
          review_note TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          vector F32_BLOB(${this.options.dimensions}) NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memories_status_updated ON memories(status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
        CREATE TABLE IF NOT EXISTS session_state (
          session_id TEXT PRIMARY KEY,
          last_extracted_message_id TEXT,
          last_extracted_at INTEGER,
          attempt_target_id TEXT,
          failed_attempts INTEGER NOT NULL DEFAULT 0,
          failed_at INTEGER
        );
      `);
      await db.batch(
        [
          {
            sql: "INSERT OR IGNORE INTO project_meta (key, value) VALUES (?, ?)",
            args: ["schema_version", SCHEMA_VERSION],
          },
          {
            sql: "INSERT OR IGNORE INTO project_meta (key, value) VALUES (?, ?)",
            args: ["embedding_model", this.options.model],
          },
          {
            sql: "INSERT OR IGNORE INTO project_meta (key, value) VALUES (?, ?)",
            args: ["embedding_dimensions", String(this.options.dimensions)],
          },
          {
            sql: "INSERT OR IGNORE INTO project_meta (key, value) VALUES (?, ?)",
            args: ["embedding_dtype", this.options.dtype],
          },
          {
            sql: "INSERT OR IGNORE INTO project_meta (key, value) VALUES (?, ?)",
            args: ["embedding_pooling", this.options.pooling],
          },
        ],
        "immediate"
      );
      return;
    }

    if (!hasMeta || !existing) {
      throw new Error(
        `项目数据库 ${this.options.dbPath} 结构不完整（memories/project_meta 缺失）。新项目只支持全新 schema v1，请移走旧数据库。`
      );
    }
    if (version === null) {
      throw new Error(
        `项目数据库 ${this.options.dbPath} 缺少 schema_version。新项目只支持全新 schema v1，请移走旧数据库。`
      );
    }
    if (version !== SCHEMA_VERSION) {
      throw new Error(
        `项目数据库 schema 版本为 ${version}，当前插件只支持 v${SCHEMA_VERSION}。请使用旧版本导出后再重建。`
      );
    }

    const model = await this.getMetaWith(db, "embedding_model");
    const dimensions = await this.getMetaWith(db, "embedding_dimensions");
    const dtype = await this.getMetaWith(db, "embedding_dtype");
    const pooling = await this.getMetaWith(db, "embedding_pooling");
    if (model !== this.options.model) {
      throw new Error(
        `Embedding 模型不匹配：库由 ${model ?? "未知模型"} 建立，当前配置为 ${this.options.model}。请改回原模型或重建库。`
      );
    }
    if (dimensions !== String(this.options.dimensions)) {
      throw new Error(
        `Embedding 维度不匹配：库为 ${dimensions ?? "未知"} 维，当前配置为 ${this.options.dimensions} 维。请改回原维度或重建库。`
      );
    }
    if (dtype !== this.options.dtype) {
      throw new Error(
        `Embedding dtype 不匹配：库为 ${dtype ?? "未知"}，当前配置为 ${this.options.dtype}。请改回原 dtype 或重建库。`
      );
    }
    if (pooling !== this.options.pooling) {
      throw new Error(
        `Embedding pooling 不匹配：库为 ${pooling ?? "未知"}，当前为 ${this.options.pooling}。请恢复原 pooling 或重建库。`
      );
    }
    const shortened = await this.shortenLegacyUuidIds(db);
    if (shortened > 0) log("memory ids shortened", { count: shortened });
    await db.exec(`
      CREATE TABLE IF NOT EXISTS session_state (
        session_id TEXT PRIMARY KEY,
        last_extracted_message_id TEXT,
        last_extracted_at INTEGER,
        attempt_target_id TEXT,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        failed_at INTEGER
      )
    `);
    await this.ensureSessionStateColumns(db);
  }

  /** Stage 2 generated UUIDs; shorten them once while keeping ids unique. */
  private async shortenLegacyUuidIds(db: Database): Promise<number> {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const rows = (await db.all("SELECT id FROM memories")) as Array<{ id?: string }>;
    const used = new Set(rows.map((row) => String(row.id)));
    const legacy = [...used].filter((id) => uuid.test(id));
    let changed = 0;
    for (const oldId of legacy) {
      let candidate: string | null = null;
      for (const bytes of [4, 5, 6]) {
        for (let attempt = 0; attempt < 20; attempt++) {
          const value = randomBytes(bytes).toString("hex");
          if (!used.has(value)) {
            candidate = value;
            break;
          }
        }
        if (candidate) break;
      }
      if (!candidate) throw new Error(`无法为旧记忆 ${oldId} 生成唯一短 id`);
      await db.run("UPDATE memories SET id = ? WHERE id = ?", candidate, oldId);
      used.delete(oldId);
      used.add(candidate);
      changed++;
    }
    return changed;
  }

  /** Stage 2 shipped a three-column table; add attempt tracking in place. */
  private async ensureSessionStateColumns(db: Database): Promise<void> {
    const rows = (await db.all("PRAGMA table_info(session_state)")) as Array<{
      name?: string;
    }>;
    const existing = new Set(rows.map((row) => String(row.name)));
    const columns: Array<[string, string]> = [
      ["attempt_target_id", "TEXT"],
      ["failed_attempts", "INTEGER NOT NULL DEFAULT 0"],
      ["failed_at", "INTEGER"],
    ];
    for (const [name, definition] of columns) {
      if (!existing.has(name)) {
        await db.exec(`ALTER TABLE session_state ADD COLUMN ${name} ${definition}`);
      }
    }
  }

  private async getMetaWith(db: Database, key: string): Promise<string | null> {
    const row = (await db.get("SELECT value FROM project_meta WHERE key = ?", key)) as
      | { value?: string }
      | null;
    return row?.value ?? null;
  }

  async getMeta(key: string): Promise<string | null> {
    return this.getMetaWith(await this.connection(), key);
  }

  async setMeta(key: string, value: string): Promise<void> {
    const db = await this.connection();
    await db.run(
      "INSERT INTO project_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value
    );
  }

  async recordProject(info: { identity: string; root: string; name: string }): Promise<void> {
    await this.setMeta("project_identity", info.identity);
    await this.setMeta("project_path", info.root);
    await this.setMeta("project_name", info.name);
  }

  async getSessionState(sessionID: string): Promise<{
    last_extracted_message_id: string | null;
    last_extracted_at: number | null;
    attempt_target_id: string | null;
    failed_attempts: number;
    failed_at: number | null;
  }> {
    const db = await this.connection();
    const row = (await db.get(
      `SELECT last_extracted_message_id, last_extracted_at, attempt_target_id,
              failed_attempts, failed_at
       FROM session_state WHERE session_id = ?`,
      sessionID
    )) as {
      last_extracted_message_id?: string;
      last_extracted_at?: number;
      attempt_target_id?: string;
      failed_attempts?: number;
      failed_at?: number;
    } | null;
    return {
      last_extracted_message_id: row?.last_extracted_message_id ?? null,
      last_extracted_at: row?.last_extracted_at ?? null,
      attempt_target_id: row?.attempt_target_id ?? null,
      failed_attempts: row?.failed_attempts ?? 0,
      failed_at: row?.failed_at ?? null,
    };
  }

  /** Advance the watermark and clear all retry bookkeeping. */
  async setSessionState(sessionID: string, messageID: string, at: number): Promise<void> {
    const db = await this.connection();
    await db.run(
      `INSERT INTO session_state (
         session_id, last_extracted_message_id, last_extracted_at,
         attempt_target_id, failed_attempts, failed_at
       ) VALUES (?, ?, ?, NULL, 0, NULL)
       ON CONFLICT(session_id) DO UPDATE SET
         last_extracted_message_id = excluded.last_extracted_message_id,
         last_extracted_at = excluded.last_extracted_at,
         attempt_target_id = NULL,
         failed_attempts = 0,
         failed_at = NULL`,
      sessionID,
      messageID,
      at
    );
  }

  /**
   * Record a transient failure without moving the watermark. Attempts reset
   * when the target message changes, so the cap applies to one increment only.
   */
  async recordExtractionFailure(
    sessionID: string,
    targetMessageID: string,
    at: number
  ): Promise<number> {
    const state = await this.getSessionState(sessionID);
    const attempts =
      state.attempt_target_id === targetMessageID ? state.failed_attempts + 1 : 1;
    const db = await this.connection();
    await db.run(
      `INSERT INTO session_state (
         session_id, attempt_target_id, failed_attempts, failed_at
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         attempt_target_id = excluded.attempt_target_id,
         failed_attempts = excluded.failed_attempts,
         failed_at = excluded.failed_at`,
      sessionID,
      targetMessageID,
      attempts,
      at
    );
    return attempts;
  }

  async getOverview(): Promise<string> {
    return (await this.getMeta("overview")) ?? "";
  }

  async setOverview(content: string): Promise<void> {
    await this.setMeta("overview", content);
  }

  async insert(record: MemoryRecord, vector: Float32Array): Promise<void> {
    const db = await this.connection();
    await db.run(
      `INSERT INTO memories (
        id, title, category, content, related_files, source, source_ref,
        status, review_note, version, created_at, updated_at, vector
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, 1, ?, ?, vector32(?))`,
      record.id,
      record.title,
      record.category,
      record.content,
      JSON.stringify(record.related_files),
      record.source,
      record.source_ref,
      record.created_at,
      record.updated_at,
      JSON.stringify(Array.from(vector))
    );
  }

  async update(
    record: MemoryRecord,
    expectedVersion: number,
    vector: Float32Array
  ): Promise<number> {
    const db = await this.connection();
    const result = await db.run(
      `UPDATE memories
       SET title = ?, category = ?, content = ?, related_files = ?, source_ref = ?,
           version = version + 1, updated_at = ?, vector = vector32(?)
       WHERE id = ? AND status = 'active' AND version = ?`,
      record.title,
      record.category,
      record.content,
      JSON.stringify(record.related_files),
      record.source_ref,
      record.updated_at,
      JSON.stringify(Array.from(vector)),
      record.id,
      expectedVersion
    );
    return Number(result.changes);
  }

  async archive(id: string, expectedVersion: number, updatedAt: number): Promise<number> {
    const db = await this.connection();
    const result = await db.run(
      `UPDATE memories
       SET status = 'archived', version = version + 1, updated_at = ?
       WHERE id = ? AND status = 'active' AND version = ?`,
      updatedAt,
      id,
      expectedVersion
    );
    return Number(result.changes);
  }

  async getById(id: string): Promise<MemoryRecord | null> {
    const db = await this.connection();
    const row = await db.get("SELECT * FROM memories WHERE id = ?", id);
    return row ? rowToRecord(row as Record<string, unknown>) : null;
  }

  async findNearest(vector: Float32Array, limit = 1): Promise<NearestMemory[]> {
    const db = await this.connection();
    const json = JSON.stringify(Array.from(vector));
    const rows = (await db.all(
      `SELECT id, title, content, source,
              1 - vector_distance_cos(vector, vector32(?)) AS similarity
       FROM memories
       WHERE status = 'active'
       ORDER BY vector_distance_cos(vector, vector32(?)) ASC
       LIMIT ?`,
      json,
      json,
      limit
    )) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      content: String(row.content),
      source: String(row.source) as MemorySource,
      similarity: Math.max(0, Math.min(1, Number(row.similarity))),
    }));
  }

  /** Keyword + vector hybrid search over active memories. */
  async search(query: string, vector: Float32Array, limit: number): Promise<MemorySearchHit[]> {
    const db = await this.connection();
    const json = JSON.stringify(Array.from(vector));
    const candidateLimit = Math.max(limit * 3, 20);
    const candidates = new Map<string, { similarity: number; keyword: number }>();

    const vectorRows = (await db.all(
      `SELECT id, 1 - vector_distance_cos(vector, vector32(?)) AS similarity
       FROM memories
       WHERE status = 'active'
       ORDER BY vector_distance_cos(vector, vector32(?)) ASC
       LIMIT ?`,
      json,
      json,
      candidateLimit
    )) as Array<Record<string, unknown>>;
    for (const row of vectorRows) {
      candidates.set(String(row.id), {
        similarity: Math.max(0, Math.min(1, Number(row.similarity))),
        keyword: 0,
      });
    }

    const tokens = tokenize(query);
    if (tokens.length > 0) {
      const keywordCounts = new Map<string, number>();
      for (const token of tokens) {
        const pattern = `%${escapeLike(token)}%`;
        const rows = (await db.all(
          `SELECT id FROM memories
           WHERE status = 'active'
             AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR related_files LIKE ? ESCAPE '\\')
           LIMIT ?`,
          pattern,
          pattern,
          pattern,
          candidateLimit
        )) as Array<{ id?: string }>;
        for (const row of rows) {
          const id = String(row.id);
          keywordCounts.set(id, (keywordCounts.get(id) ?? 0) + 1);
        }
      }
      for (const [id, count] of keywordCounts) {
        const existing = candidates.get(id);
        const keyword = count / tokens.length;
        if (existing) existing.keyword = keyword;
        else candidates.set(id, { similarity: 0, keyword });
      }
    }

    const ids = [...candidates.keys()];
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = (await db.all(
      `SELECT *, 1 - vector_distance_cos(vector, vector32(?)) AS similarity
       FROM memories
       WHERE status = 'active' AND id IN (${placeholders})`,
      json,
      ...ids
    )) as Array<Record<string, unknown>>;

    const hasKeyword = tokens.length > 0;
    const hits = rows.map((row) => {
      const record = rowToRecord(row);
      const candidate = candidates.get(record.id) ?? { similarity: 0, keyword: 0 };
      const similarity = hasKeyword
        ? candidate.similarity * 0.7 + candidate.keyword * 0.3
        : candidate.similarity;
      return { ...record, similarity };
    });
    hits.sort((a, b) => b.similarity - a.similarity);
    return hits.slice(0, limit);
  }

  async listActiveTitles(limit: number): Promise<Array<Pick<MemoryRecord, "id" | "category" | "title">>> {
    const db = await this.connection();
    const rows = (await db.all(
      `SELECT id, category, title FROM memories
       WHERE status = 'active'
       ORDER BY updated_at DESC
       LIMIT ?`,
      limit
    )) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      category: String(row.category) as MemoryCategory,
      title: String(row.title),
    }));
  }

  async countActive(): Promise<number> {
    const db = await this.connection();
    const row = (await db.get("SELECT COUNT(*) AS count FROM memories WHERE status = 'active'")) as
      | { count?: number }
      | null;
    return Number(row?.count ?? 0);
  }

  async listActive(): Promise<MemoryRecord[]> {
    const db = await this.connection();
    const rows = (await db.all(
      "SELECT * FROM memories WHERE status = 'active' ORDER BY updated_at DESC"
    )) as Array<Record<string, unknown>>;
    return rows.map(rowToRecord);
  }

  async listArchived(): Promise<MemoryRecord[]> {
    const db = await this.connection();
    const rows = (await db.all(
      "SELECT * FROM memories WHERE status = 'archived' ORDER BY updated_at DESC"
    )) as Array<Record<string, unknown>>;
    return rows.map(rowToRecord);
  }
}
