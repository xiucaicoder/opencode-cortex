# AGENTS.md

Guidance for coding agents working on **opencode-cortex**, a project-scoped business/architecture memory plugin for OpenCode v2.

## Stack & layout

- Runtime / package manager: **Bun**
- Language: TypeScript (`src/`), tests in `tests/` via `bun test`
- Entry: `src/plugin.ts` → `dist/plugin.js`
- Core files:
  - `src/store.ts` — Turso schema v1, vector/keyword search, versioned writes
  - `src/memory-service.ts` — validation, dedup, secrets, optimistic locking
  - `src/inject.ts` — injection text and per-session cache
  - `src/extraction.ts` — incremental selection, prompt shaping, idle extraction
  - `prompts/extract.md` — extraction prompt (Chinese JSON output)
  - `src/tools.ts` — `memory_search` / `memory_mutate`
  - `src/embedding.ts` — local `Xenova/bge-base-zh-v1.5`
  - `src/project.ts` — project marker and per-project DB identity
- Scripts: `scripts/import.ts`, `scripts/export.ts`, `scripts/smoke.ts`

## Commands

```bash
bun install
bun run typecheck
bun run build
bun test
bun run scripts/smoke.ts
```

## Invariants

- Exactly four categories: `domain_rule`, `arch_decision`, `data_constraint`, `pitfall`.
- `content` ≤ 200 characters (code points, not bytes).
- Only two model-facing tools; import/export stay as scripts.
- `delete` archives (`status=archived`); never hard-delete rows.
- `update`/`delete` require `version`; stale versions are rejected.
- Writes and their vectors live in one row, so a single INSERT/UPDATE is atomic.
- Cosine similarity selects candidates. Evidence review distinguishes equivalent and distinct rules. Store unresolved candidates atomically with progress. Hide affected versions from normal retrieval only when there is evidence of a contradiction.
- The database stores embedding model, dimensions, dtype and pooling. Mismatch must fail loudly; never re-embed or migrate silently.
- No legacy schema, shard, DiskANN or opencode-mem migration code.
- Never log memory content, secret matches or full request bodies. Logs may include ids, counts, stage timings and similarity values only. `debugCapture: true` (off by default) is the single sanctioned exception: it appends redacted raw model output to `<storagePath>/debug-capture.jsonl` with 0600 permissions and three-day retention.
- One database per project identity; do not add a global cross-project store.
- No timers for background work; stage 2/3 run off session events.
- Injection sends only the ≤500-char overview plus `[id] [category] title` lines (max 150, newest first). Never inject memory bodies.
- `injectOn: "first"` caches one block per session; compaction must clear the cache so the next request reloads it.
- Auto extraction reads only the increment after `session_state.last_extracted_message_id`, runs one extraction plus a batched evidence review when needed per idle, and skips sub-sessions (`parentID` set).
- Bound increments by message count and text budget, resuming oversized messages at their saved offset. Commit accepted automatic memories and their extraction checkpoint together. On generation, parsing or storage failure, retain the batch and apply `failureCooldownMinutes`.
- Automatic extraction and model tool writes require a real user quote and a separate evidence review. Store only the source reference and evidence time, and reject older evidence for later updates.
- Conversation text is redacted with the same rules as writes before it is sent to the model; never log matched content.
- `autoCaptureDryRun` appends candidates to `dry-run.jsonl` instead of writing memories.
- New memory ids are 8 hex characters; collision retries may lengthen them.
- Auto extraction may only add/update its own `auto` entries. It cannot delete, and it cannot modify `manual` / `import` entries.
- Automatic extraction can mark a possible conflict on a manual or imported entry without overwriting it. Store previous versions when modifying or archiving entries.
- Extraction model is fixed (`opencodeModel`, default `opencode-go/glm-5.3-flash`) with optional `opencodeVariant`; do not default to inherit. Output must be Chinese JSON only.

## Commits

Conventional Commits only. One logical change per commit. Do not push.

## Security

Do not commit secrets, local databases, model caches or logs. New write paths (auto extraction, import, dreaming) must reuse the same validation and secret checks as `memory_mutate`.
