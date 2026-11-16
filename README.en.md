# opencode-cortex

English | [简体中文](./README.md)

A project-scoped memory plugin for OpenCode that preserves business knowledge and architectural decisions, so new developers and AI sessions can understand why a project works the way it does without rereading past conversations.

- `domain_rule`: business rules
- `arch_decision`: architectural decisions and their rationale
- `data_constraint`: data and state constraints
- `pitfall`: pitfalls and their root causes

## Design boundaries

- Each project has its own Turso/libSQL database, selected by project identity.
- Default embedding: `Xenova/bge-base-zh-v1.5`, running locally with transformers.js (768 dimensions, CLS pooling, normalized).
- User profiles, conversation timelines, debugging sessions, general technical knowledge, temporary state, and secrets are not intended to be stored as memories.
- Deletion archives entries (`status=archived`); it does not physically remove them.
- New projects use schema v1 and are not compatible with legacy opencode-mem data.

## Tools

The plugin exposes two tools:

### `memory_search(query, limit = 5)`

Searches `active` entries only and returns:

```json
[
  {
    "id": "…",
    "title": "…",
    "category": "domain_rule",
    "content": "…",
    "related_files": [],
    "source": "manual",
    "updated_at": 1760000000000,
    "version": 1
  }
]
```

Results with a source reference also include `source_ref`.

### `memory_mutate(action, evidence_quote, id?, version?, title?, category?, content?, related_files?)`

- `content` is limited to 200 Unicode code points.
- New entries use an eight-character hexadecimal `id`; collisions are retried with longer IDs. When an older stage 2 database is opened, existing UUIDs are shortened in place, with collision retries and a migration count logged.
- `update` and `delete` require `id` and `version`. A version conflict is rejected and requires a fresh search.
- Before `add`, the plugin searches for similar entries:
  - At or above `dedupRejectThreshold` (default `0.92`), the plugin checks whether the rules are equivalent, apply to distinct scopes, or may conflict.
  - After a successful write, up to `dedupRelatedLimit` (default `3`) closest active entries at or above `dedupRelatedThreshold` (default `0.75`) are returned with `id`, `title`, `content`, and `similarity`, allowing the host AI to decide whether to merge them.
- Writes are rejected when the title, content, `related_files`, or `source_ref` matches a built-in or configured sensitive-information rule.
- Tool writes require a quote from the current developer message and pass a separate evidence review. The plugin records the session reference. Tool writes, imports, and automatic extraction use `manual`, `import`, and `auto` respectively.
- `delete` archives the entry.

Tool responses include:

```json
{ "success": false, "code": "duplicate", "error": "…", "id": "…", "similarity": 0.93 }
```

```json
{ "success": true, "id": "…", "version": 1, "related": [{ "id": "…", "title": "…", "content": "…", "similarity": 0.88 }] }
```

## Context injection

The plugin injects historical memory into the system prompt with a fixed Chinese prefix explaining that memories are reference material, not instructions, and that `memory_search` should be used for details. The injected block contains:

- A project overview of up to 500 characters, maintained through `{"type":"overview","content":"…"}` records in `scripts/import.ts`.
- Up to 150 active entry titles, one `[id] [category] title` per line, ordered by `updated_at` descending.
- Titles only, not memory bodies; the AI calls `memory_search` when it needs details.

`injectOn` defaults to `first`, injecting only on the first model request of a session. Set it to `always` to inject the latest directory on every request. Context compaction clears the cache, so the directory is reloaded on the next request. Injection failures are logged and do not interrupt the host session.

## Automatic extraction

When a session becomes idle, the plugin reads new conversation content and attempts to extract the four memory categories:

- Each session processes messages in order in bounded batches. Oversized messages resume from the saved offset.
- Child sessions with a non-empty `parentID` are skipped.
- A new increment below `minNewMessages` or `minInputChars` is deferred. Pending messages from a previous batch continue on later idle events without waiting for the minimum length or success cooldown.
- Each idle event makes one extraction call and, when candidates exist, one batched evidence review using `opencodeModel` (default `opencode-go/glm-5.3-flash`) and `opencodeVariant` (default `low`).
- Before sending, conversation text is redacted using the same rules as write interception; matches become `[REDACTED]`. Logs record only counts and rule names.
- The extraction model must quote a developer message in the current batch. The plugin checks the exact quote, then reviews whether the statement supports the proposed rule. It stores the session and message reference and evidence time.
- Accepted memories and processing progress commit together. Generation, parsing, review, and storage failures keep the checkpoint in place and can be retried at the next idle event after the failure cooldown.
- Automatic extraction can only `add` or `update` its own entries; it cannot `delete` or modify `manual` / `import` entries.
- Unresolved candidates are saved separately. Confirmed contradictions hide the affected version from search and the title list. Uncertain relationships alone leave the existing version available. The batch advances and subsequent messages can still be processed. Explicit replacements can update automatic entries. Manual and imported entries require an evidence-backed tool update.
- Updates and archives retain the previous version and source in the database. History begins with changes made after this feature is enabled. Run `bun run /path/to/opencode-cortex/scripts/export.ts --conflicts` from the project directory to find the affected IDs and versions. An explicit developer statement can resolve the conflict through a versioned `memory_mutate` update.
- The extraction prompt requires Chinese output, with `category` using the four English enum values.
- With `autoCaptureDryRun: true`, candidates are appended to `<storagePath>/dry-run.jsonl` (default `~/.opencode-cortex/dry-run.jsonl`) instead of being written as memories. The file contains session IDs, timestamps, actions, and redacted fields. The session watermark still advances to avoid recapturing the same increment.

## List memories

Run `cortex list` in the target project to inspect available memories, `cortex list --conflicts` for pending conflicts, or `cortex list --all` to include archived and conflict-blocked entries. The installed command requires Bun.

## Configuration

Global configuration: `~/.config/opencode/opencode-cortex.jsonc`  
Project configuration: `<project>/.opencode/opencode-cortex.jsonc` (overrides global configuration; encryption keys are not allowed here).

See [`opencode-cortex.example.jsonc`](./opencode-cortex.example.jsonc) for an example.

| Setting | Default | Description |
| --- | --- | --- |
| `storagePath` | `~/.opencode-cortex` | Database, log, and model cache directory |
| `embeddingModel` | `Xenova/bge-base-zh-v1.5` | Local ONNX model |
| `embeddingDtype` | `q8` | ONNX weight precision |
| `embeddingDimensions` | `768` | Must match the model |
| `dedupRejectThreshold` | `0.92` | Reject an add at or above this similarity |
| `dedupRelatedThreshold` | `0.75` | Minimum similarity for related entries returned after a write |
| `dedupRelatedLimit` | `3` | Maximum related entries returned after a write |
| `blockedPatterns` | `[]` | Additional sensitive-information regular expressions |
| `autoCaptureDryRun` | `false` | Write candidates to `dry-run.jsonl` instead of memories |
| `databaseEncryptionEnabled` | `false` | Enable optional Turso encryption |
| `databaseEncryptionKey` | Auto-generated | 64-character hexadecimal AES-256 key; global configuration only |
| `opencodeProvider` | `opencode-go` | Extraction model provider; parsed from `opencodeModel` when it contains `/` |
| `opencodeModel` | `opencode-go/glm-5.3-flash` | Extraction model; `inherit` uses the host default |
| `opencodeVariant` | `low` | Extraction model reasoning variant; `default` leaves it unspecified |
| `injectOn` | `first` | `first` injects on the first request; `always` injects on every request |
| `injectMaxTitles` | `150` | Maximum number of titles in the injected directory |
| `autoExtract.enabled` | `true` | Enable automatic extraction on idle |
| `autoExtract.minNewMessages` | `1` | Minimum number of new user messages |
| `autoExtract.minInputChars` | `80` | Minimum length of the increment |
| `autoExtract.cooldownMinutes` | `10` | Minimum interval between successful extractions in a session; `0` disables the limit |
| `autoExtract.failureCooldownMinutes` | `30` | Retry cooldown after a batch fails |
| `autoExtract.maxInputChars` | `12000` | Maximum conversation input characters per batch |
| `autoExtract.maxAssistantChars` | `4000` | Per-batch character limit for each assistant message |
| `autoExtract.maxMessages` | `40` | Maximum incremental messages read per extraction |
| `autoExtract.maxItems` | `10` | Maximum extracted entries accepted per call |
| `autoExtract.timeoutMs` | `60000` | Model-call timeout |

Project identity is determined by searching upward from the working directory for `.opencode-cortex-project`. If found, the whole subtree shares that root's database. Otherwise, the Git common directory is used, falling back to the directory path.

The database records the embedding model, dimensions, dtype, and pooling. If any of these differ, reads and writes are rejected with an error; there is no automatic re-embedding or migration.

## Import and export

Import and export are scripts rather than model-facing tools:

```bash
# Import JSONL; {"type":"overview","content":"…"} sets the project overview
bun run scripts/import.ts memories.jsonl

# Export Markdown for human review and optional Git check-in
bun run scripts/export.ts memories.md
bun run scripts/export.ts memories.md --all             # include archived entries
bun run scripts/export.ts memories.md --source auto     # automatic entries only
bun run scripts/export.ts memories.md --since 2026-01-01 --source manual
```

`--source` accepts `auto`, `manual`, or `import`. `--since` filters by `updated_at` and accepts `YYYY-MM-DD`, an ISO timestamp, or milliseconds since the epoch. Both can be combined with `--all`.

Imports use the same length, category, secret-detection, and deduplication checks. Repeated identical imports are skipped. Entries rejected as duplicates are written to `rejected.jsonl` in the current directory with the existing `existing_id` and similarity for manual review.

## Installation

```bash
bun install
bun run build
```

Load this package in your OpenCode plugin configuration; `dist/plugin.js` is the entry point. The plugin uses the OpenCode v2 plugin API and declares `"opencode": { "type": "plugin" }` in `package.json`.

## Development

```bash
bun run typecheck
bun run build
bun test
bun run scripts/smoke.ts   # real model + Turso + similarity calibration; downloads ONNX weights
```

## License

MIT. This project is a fork of [`tickernelz/opencode-mem`](https://github.com/tickernelz/opencode-mem) and retains the original copyright notice; see [`LICENSE`](./LICENSE).


## Commerce session replay

Run `CORTEX_EVAL_URL=http://127.0.0.1:1234/v1 CORTEX_EVAL_MODEL=your-model bun run evaluate` from this repository. The synthetic cases use isolated databases and compare fresh model answers with and without retrieved memories. Set `CORTEX_EVAL_KEY` in the environment if needed. Use `CORTEX_EVAL_JSON_SCHEMA=1` if the endpoint supports JSON Schema.
