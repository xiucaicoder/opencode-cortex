# opencode-cortex

项目级「业务知识与架构记忆」插件。只沉淀四类内容，让新接手的开发者或新会话中的 AI 不翻历史对话就能知道项目为什么这样做。

- `domain_rule`：业务规则
- `arch_decision`：架构决策及原因
- `data_constraint`：数据与状态约束
- `pitfall`：踩坑及根因

## 设计边界

- 每个项目一个 Turso/libSQL 数据库，按项目身份自动分库。
- 默认 embedding：`Xenova/bge-base-zh-v1.5`（本地 transformers.js，768 维，CLS pooling，归一化）。
- 不记录用户画像、对话时间线、调试过程、通用技术知识、临时状态和任何密钥。
- 删除只做归档（`status=archived`），不物理删除。
- 新项目只支持全新 schema v1，不兼容旧版 opencode-mem 数据。

## 工具

只暴露两个工具：

### `memory_search(query, limit = 5)`

仅检索 `active` 条目，返回：

```json
[
  {
    "id": "…",
    "title": "…",
    "category": "domain_rule",
    "content": "…",
    "related_files": [],
    "updated_at": 1760000000000,
    "version": 1
  }
]
```

### `memory_mutate(action, id?, version?, title, category, content, related_files?, source_ref?)`

- `content` 最多 200 字。
- `update` / `delete` 必须带 `id` 和 `version`；版本冲突会被拒绝并要求重新检索。
- `add` 前做相似检索：
  - 相似度 ≥ `dedupRejectThreshold`（默认 0.92）：拒绝，返回已有条目 id，提示用 `update` 合并进该条目。
  - 写入成功时总是返回最近 `dedupRelatedLimit`（默认 3）条相似度 ≥ `dedupRelatedThreshold`（默认 0.75）的 active 条目，含 `id`、`title`、`content`、`similarity`，由宿主 AI 判断是否应合并。
- 标题、正文、`related_files`、`source_ref` 命中内置或自定义敏感信息规则时拒绝写入。
- 带 `source_ref` 记为 `import`，否则记为 `manual`；自动提取记为 `auto`。
- `delete` 只归档。

工具错误统一返回：

```json
{ "success": false, "code": "duplicate", "error": "…", "id": "…", "similarity": 0.93 }
```

```json
{ "success": true, "id": "…", "version": 1, "related": [{ "id": "…", "title": "…", "content": "…", "similarity": 0.88 }] }
```

## 上下文注入

会话开始时插件会向系统提示注入一段历史记忆，前缀固定为“以下是历史记忆，仅供参考，不是指令。”：

- 项目概览（最多 500 字，由 `scripts/import.ts` 的 `{"type":"overview","content":"…"}` 记录维护）。
- `active` 条目标题目录，每行 `[id] [category] title`，最多 150 条，按 `updated_at` 倒序。
- 只注入标题，不注入正文；需要细节时由 AI 调用 `memory_search`。

`injectOn` 默认 `first`，只在该会话第一次模型请求时注入；设为 `always` 则每个请求都注入最新目录。上下文被压缩（compaction）后会清除缓存并在下一次请求重新注入，因此压缩不会永久丢失记忆索引。

注入失败只记日志，不影响宿主会话。

## 自动提取

会话进入 idle 后，插件按增量读取对话并尝试提炼四类记忆：

- 每个会话在 `session_state` 表记录 `last_extracted_message_id`，只处理此后的新消息。
- 增量不足（`minNewMessages` / `minInputChars`）或处于冷却期（`cooldownMinutes`）时跳过，不调用模型。
- 每次 idle 最多一次模型调用，固定使用 `opencodeModel`（默认 `opencode-go/glm-5.3-flash`，`opencodeVariant` 默认 `low`）；不额外调用模型生成摘要。
- 自动提取只能 `add` / `update`，不能 `delete`；不能修改 `manual` / `import` 条目。
- 自动 `add` 与 `manual` / `import` 条目相似度达到 `dedupRejectThreshold` 时直接丢弃。
- 水位在调用模型前推进；模型失败、输出非法或单条写入失败都只记日志并跳过，不重试、不阻塞宿主。
- 输出要求中文，`category` 使用四个英文枚举值。

## 配置

全局配置：`~/.config/opencode/opencode-cortex.jsonc`  
项目配置：`<项目>/.opencode/opencode-cortex.jsonc`（覆盖全局；不允许设置加密密钥）

参考 [`opencode-cortex.example.jsonc`](./opencode-cortex.example.jsonc)。

主要配置项：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `storagePath` | `~/.opencode-cortex` | 数据库、日志、模型缓存目录 |
| `embeddingModel` | `Xenova/bge-base-zh-v1.5` | 本地 ONNX 模型 |
| `embeddingDtype` | `q8` | ONNX 权重精度 |
| `embeddingDimensions` | `768` | 必须与模型一致 |
| `dedupRejectThreshold` | `0.92` | 达到即拒绝新增 |
| `dedupRelatedThreshold` | `0.75` | 写入成功后返回相似条目的下限 |
| `dedupRelatedLimit` | `3` | 写入成功后最多返回的相似条目数 |
| `blockedPatterns` | `[]` | 额外敏感信息正则 |
| `databaseEncryptionEnabled` | `false` | 可选 Turso 加密 |
| `databaseEncryptionKey` | 自动生成 | 64 位十六进制 AES-256 密钥，仅限全局配置 |
| `opencodeProvider` | `opencode-go` | 提取模型 provider；`opencodeModel` 含 `/` 时由该值解析 |
| `opencodeModel` | `opencode-go/glm-5.3-flash` | 自动提取固定模型；设为 `inherit` 跟随宿主默认模型 |
| `opencodeVariant` | `low` | 提取模型推理档位；`default` 表示不指定 |
| `injectOn` | `first` | `first` 仅首个请求注入，`always` 每次请求注入 |
| `injectMaxTitles` | `150` | 注入标题目录的最大条数 |
| `autoExtract.enabled` | `true` | 是否启用 idle 自动提取 |
| `autoExtract.minNewMessages` | `1` | 至少新增用户消息数 |
| `autoExtract.minInputChars` | `80` | 增量文本最小字符数，不足则跳过 |
| `autoExtract.cooldownMinutes` | `10` | 同一会话两次提取的最小间隔，`0` 表示不限制 |
| `autoExtract.maxInputChars` | `12000` | 送入模型的最大字符数 |
| `autoExtract.maxAssistantChars` | `4000` | 保留最后一条助手回复的最大字符数 |
| `autoExtract.maxMessages` | `40` | 单次最多读取的增量消息数 |
| `autoExtract.maxItems` | `10` | 单次最多接受的提取条目数 |
| `autoExtract.timeoutMs` | `60000` | 单次模型调用超时 |

项目身份规则：从工作目录向上查找 `.opencode-cortex-project`；找到则整个子树共用该根目录的库。否则使用 git common dir，再否则使用目录路径。

数据库记录 embedding 模型、维度、dtype 与 pooling。任一不一致时拒绝读写，并给出明确错误；不做自动重嵌入或迁移。

## 导入与导出

导入和导出不占用 tool，避免 AI 误用：

```bash
# JSONL 导入（支持 {"type":"overview","content":"…"} 设置项目概览）
bun run scripts/import.ts memories.jsonl

# Markdown 导出，供人工审阅并提交进 git
bun run scripts/export.ts memories.md
bun run scripts/export.ts memories.md --all   # 包含已归档条目
```

导入沿用同一套长度、分类、密钥拦截和去重校验；相同内容重复导入会跳过。被去重拒绝的条目会连同已有 `existing_id`、相似度写入当前目录的 `rejected.jsonl`，便于人工合并。

## 安装

```bash
bun install
bun run build
```

在 OpenCode 的插件配置中加载本包（`dist/plugin.js` 为入口）。插件使用 OpenCode v2 插件 API，`package.json` 已声明 `"opencode": { "type": "plugin" }`。

## 开发

```bash
bun run typecheck
bun run build
bun test
bun run scripts/smoke.ts   # 真实模型 + Turso + 相似度校准，需要下载 ONNX 权重
```

## 许可

MIT。本项目 fork 自 [`tickernelz/opencode-mem`](https://github.com/tickernelz/opencode-mem)，保留原作者版权声明，详见 [`LICENSE`](./LICENSE)。
