import type { Context } from "@opencode/plugin/promise/plugin";
import type { MemoryService, MutateInput, MutateResult } from "./memory-service.js";
import { MemoryError } from "./memory-service.js";

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
    source_ref: {
      type: "string",
      description: "来源引用（如 issue、文档或会话 id），可选；提供时按 import 来源记录。",
    },
  },
  required: ["action"],
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
    error: error instanceof Error ? error.message : String(error),
  });
}

export async function registerMemoryTools(ctx: Context, service: MemoryService): Promise<void> {
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "memory_search",
      description:
        "检索本项目已沉淀的业务规则、架构决策、数据约束和踩坑记录。仅返回 active 条目。需要更新或归档时，使用返回的 id 和 version。",
      input: SEARCH_INPUT as unknown as never,
      execute: async (args: { query?: string; limit?: number }) => {
        try {
          const hits = await service.search(args.query ?? "", args.limit ?? 5);
          return { content: JSON.stringify(hits) };
        } catch (error) {
          return { content: errorContent(error) };
        }
      },
    });

    editor.add({
      name: "memory_mutate",
      description:
        "写入项目记忆。content 最多 200 字；category 必须是四类之一；update/delete 必须带 id 和 version。add 前会做相似去重；命中重复时请用 update 合并。add 成功后会在 related 中返回最相近的已有条目，请据此判断是否应改为 update。",
      input: MUTATE_INPUT as unknown as never,
      execute: async (args: MutateInput) => {
        try {
          const result: MutateResult = await service.mutate(args, "tool");
          return { content: JSON.stringify(result) };
        } catch (error) {
          return { content: errorContent(error) };
        }
      },
    });
  });
}
