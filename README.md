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
  - 相似度 ≥ `dedupRejectThreshold`（默认 0.92）：拒绝，返回已有条目 id，提示改用 `update`。
  - 相似度在 `dedupHintThreshold`（默认 0.85）与拒绝阈值之间：允许写入，同时返回相似提示。
- 标题、正文、`related_files`、`source_ref` 命中内置或自定义敏感信息规则时拒绝写入。
- 带 `source_ref` 记为 `import`，否则记为 `manual`；自动提取记为 `auto`。
- `delete` 只归档。

工具错误统一返回：

```json
{ "success": false, "code": "duplicate", "error": "…", "id": "…", "similarity": 0.93 }
```

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
| `dedupHintThreshold` | `0.85` | 达到即提示相似 |
| `blockedPatterns` | `[]` | 额外敏感信息正则 |
| `databaseEncryptionEnabled` | `false` | 可选 Turso 加密 |
| `databaseEncryptionKey` | 自动生成 | 64 位十六进制 AES-256 密钥，仅限全局配置 |
| `opencodeProvider` / `opencodeModel` | 未设置 | 后续自动提取使用的 provider/model，`inherit` 跟随宿主 |

项目身份规则：从工作目录向上查找 `.opencode-cortex-project`；找到则整个子树共用该根目录的库。否则使用 git common dir，再否则使用目录路径。

数据库记录 embedding 模型与维度。模型或维度不一致时拒绝读写，并给出明确错误；不做自动重嵌入或迁移。

## 导入与导出

导入和导出不占用 tool，避免 AI 误用：

```bash
# JSONL 导入（支持 {"type":"overview","content":"…"} 设置项目概览）
bun run scripts/import.ts memories.jsonl

# Markdown 导出，供人工审阅并提交进 git
bun run scripts/export.ts memories.md
bun run scripts/export.ts memories.md --all   # 包含已归档条目
```

导入沿用同一套长度、分类、密钥拦截和去重校验；相同内容重复导入会跳过。

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
