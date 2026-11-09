# AGENTS.md

Guidance for coding agents working on **opencode-cortex**, a project-scoped business/architecture memory plugin for OpenCode v2.

## Stack & layout

- Runtime / package manager: **Bun**
- Language: TypeScript (`src/`), tests in `tests/` via `bun test`
- Entry: `src/plugin.ts` → `dist/plugin.js`
- Core files:
  - `src/store.ts` — Turso schema v1, vector/keyword search, versioned writes
  - `src/memory-service.ts` — validation, dedup, secrets, optimistic locking
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
- Dedup uses **raw cosine similarity**; search may use hybrid keyword ranking.
- The database stores embedding model + dimensions. Mismatch must fail loudly; never re-embed or migrate silently.
- No legacy schema, shard, DiskANN or opencode-mem migration code.
- Never log memory content, secret matches or full request bodies. Logs may include ids, counts and similarity values only.
- One database per project identity; do not add a global cross-project store.
- No timers for background work; stage 2/3 run off session events.

## Commits

Conventional Commits only. One logical change per commit. Do not push.

## Security

Do not commit secrets, local databases, model caches or logs. New write paths (auto extraction, import, dreaming) must reuse the same validation and secret checks as `memory_mutate`.
