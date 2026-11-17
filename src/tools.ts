import type { Context } from "@opencode/plugin/promise/plugin";
import type { MemoryService, MutateInput, MutateResult } from "./memory-service.js";
import { MemoryError } from "./memory-service.js";
import { compatibleEvidence, sessionSourceRef, type VerifyEvidence } from "./evidence.js";
import { toExtractMessages, type RawSessionMessage } from "./extraction.js";
import { log } from "./logger.js";
import { redactSecrets } from "./secrets.js";

interface ToolWriteDeps {
  getMessages: (sessionID: string) => Promise<RawSessionMessage[]>;
  verify: VerifyEvidence;
  blockedPatterns: string[];
  onWrite: () => void;
}

const SEARCH_INPUT = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "按业务含义描述要查找的规则、决策、约束或踩坑；不要只写文件名。",
    },
    limit: {
      type: "number",
      description: "返回条数，默认 5，最大 50。",
      minimum: 1,
      maximum: 50,
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const MUTATE_INPUT = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["add", "update", "delete"],
      description: "add 新增；update 修改既有条目；delete 归档（不物理删除）。",
    },
    id: { type: "string", description: "update/delete 必填，来自 memory_search。" },
    version: {
      type: "number",
      description: "update/delete 必填，来自 memory_search 的 version；版本冲突时会被拒绝。",
    },
    title: { type: "string", description: "一句话标题。" },
    category: {
      type: "string",
      enum: ["domain_rule", "arch_decision", "data_constraint", "pitfall"],
      description:
        "domain_rule 业务规则；arch_decision 架构决策及原因；data_constraint 数据与状态约束；pitfall 踩坑及根因。",
    },
    content: {
      type: "string",
      description: "只写结论和原因，最多 200 字。不要写调试过程、命令或通用技术知识。",
    },
    related_files: {
      type: "array",
      items: { type: "string" },
      description: "相关文件路径，可选。",
    },
    evidence_quote: {
      type: "string",
      description: "当前开发者消息中明确支持本操作的连续原话。",
    },
  },
  required: ["action", "evidence_quote"],
  additionalProperties: false,
} as const;

function errorContent(error: unknown): string {
  if (error instanceof MemoryError) {
    return JSON.stringify({
      success: false,
      code: error.code,
      error: error.message,
      ...error.details,
    });
  }
  return JSON.stringify({
    success: false,
    code: "internal_error",
    error: "操作未完成，请重试。",
  });
}

/** Log the error class of a tool failure. Codes only, never content. */
function logToolError(tool: string, error: unknown): void {
  log("memory tool error", {
    tool,
    code: error instanceof MemoryError ? error.code : "internal_error",
  });
}

export async function registerMemoryTools(ctx: Context, service: MemoryService, deps: ToolWriteDeps): Promise<void> {
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "memory_search",
      options: { codemode: true, pinned: true },
      description:
        "检索本项目已沉淀的业务规则、架构决策、数据约束和踩坑记录。在修改业务逻辑、数据结构或状态流转之前，必须先调用本工具确认既有约束，避免只按代码字面实现而违反业务规则。仅返回可用的 active 条目；需要修改或归档时，使用返回的 id 和 version。",
      input: SEARCH_INPUT as unknown as never,
      execute: async (args: { query?: string; limit?: number }, context) => {
        const started = Date.now();
        try {
          const hits = await service.search(args.query ?? "", args.limit ?? 5);
          log("memory search", {
            session_id: context.sessionID,
            query_chars: (args.query ?? "").length,
            limit: args.limit ?? 5,
            hits: hits.length,
            ms: Date.now() - started,
          });
          return { content: JSON.stringify(hits) };
        } catch (error) {
          logToolError("memory_search", error);
          return { content: errorContent(error) };
        }
      },
    });

    editor.add({
      name: "memory_mutate",
      options: { codemode: true, pinned: true },
      description:
        "写入项目记忆。仅在开发者明确确认了新的业务规则、架构决策、数据约束或踩坑结论后调用；AI 自己的推测、未验证方案和调试过程不要写入。开发者明确陈述新业务规则或纠正你时，立即调用本工具并附其原话。修改已有条目之前先调用 memory_search 获取 id 和 version，update/delete 必须带 id 和 version。content 最多 200 字，category 必须是四类之一；必须提供当前开发者消息中的证据。仅在证据明确替代原规则时用 update。",
      input: MUTATE_INPUT as unknown as never,
      execute: async (args: MutateInput & { evidence_quote?: string }, context) => {
        try {
          const { action, id, version, title, category, content, related_files } = args;
          if (action !== "add" && action !== "update" && action !== "delete") {
            throw new MemoryError("invalid_action", "未知记忆操作");
          }
          if (typeof content === "string" && [...content.trim()].length > 200) {
            throw new MemoryError("content_too_long", "记忆正文最多 200 字");
          }
          const messages = toExtractMessages(await deps.getMessages(context.sessionID));
          const callIndex = messages.findIndex((message) => message.id === context.messageID);
          const user = messages.slice(0, callIndex < 0 ? undefined : callIndex + 1)
            .findLast((message) => message.role === "user");
          const quote = typeof args.evidence_quote === "string" ? args.evidence_quote.trim() : "";
          const evidence = user ? redactSecrets(user.text, deps.blockedPatterns).text : "";
          if (!user || !quote || quote.includes("[REDACTED]") || !evidence.includes(quote) ||
              !compatibleEvidence(content ?? "", quote)) {
            throw new MemoryError("unverified_evidence", "当前开发者消息没有可核实的证据");
          }
          const previous = action !== "add" && id ? await service.getActive(id) : undefined;
          if (action !== "add" && (!previous || previous.version !== version)) {
            throw new MemoryError("version_conflict", "请提供当前记忆的 id 和版本");
          }
          const neighbors = action === "add" && content ? await service.search(content, 5, true) : [];
          const redact = (value: string | undefined) => value === undefined ? undefined
            : redactSecrets(value, deps.blockedPatterns).text;
          const safeTitle = redact(title);
          const safeContent = redact(content);
          const safeFiles = related_files?.map((file) => redact(file)!);
          if (safeTitle !== title || safeContent !== content ||
              safeFiles?.some((file, index) => file !== related_files?.[index])) {
            throw new MemoryError("blocked_secret", "候选含敏感信息");
          }
          const quoteStart = evidence.indexOf(quote);
          if (quote.length > 2000) throw new MemoryError("unverified_evidence", "请提供短引文");
          const excerpt = evidence.slice(Math.max(0, quoteStart - 5000), quoteStart + quote.length + 5000);
          const [decision] = await deps.verify([{
            action, title, category, content, related_files, evidence: excerpt, quote, previous, neighbors,
          }]);
          if (!decision?.supported) {
            throw new MemoryError("unverified_evidence", "证据不足以支持此操作");
          }
          const result: MutateResult = await service.mutateVerified({
            action, id, version, title, category, content, related_files,
            source_ref: sessionSourceRef(context.sessionID, user.id),
            evidence_at: user.created || undefined,
            comparisons: neighbors.flatMap(({ id, version }) => {
              const relation = decision.conflicts_with?.includes(id) ? "conflict"
                : decision.same_as?.includes(id) ? "same"
                : decision.distinct_from?.includes(id) ? "distinct" : undefined;
              return relation ? [{ id, version, relation }] : [];
            }),
          });
          deps.onWrite();
          return { content: JSON.stringify(result) };
        } catch (error) {
          logToolError("memory_mutate", error);
          if (error instanceof MemoryError && error.code === "possible_conflict") deps.onWrite();
          return { content: errorContent(error) };
        }
      },
    });
  });
}
