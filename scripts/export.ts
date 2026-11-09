/**
 * Export project memory as Markdown for human review and version control.
 *
 * Usage: bun run scripts/export.ts <output.md> [--all] [--source auto|manual|import] [--since YYYY-MM-DD]
 * Without --all only active memories are exported. --since compares updated_at.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRuntime } from "../src/runtime.js";
import { CATEGORIES, SOURCES, type MemorySource } from "../src/store.js";

function formatDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function parseSince(value: string): number {
  const numeric = /^\d+$/.test(value) ? Number(value) : NaN;
  const parsed = Number.isFinite(numeric) ? numeric : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--since 不是合法日期：${value}。支持 YYYY-MM-DD、ISO 时间或毫秒时间戳`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let output: string | undefined;
  let includeArchived = false;
  let source: MemorySource | undefined;
  let since: number | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--all") {
      includeArchived = true;
      continue;
    }
    if (arg === "--source" || arg.startsWith("--source=")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++index];
      if (!value || !SOURCES.includes(value as MemorySource)) {
        throw new Error(`--source 必须是 ${SOURCES.join(" / ")} 之一`);
      }
      source = value as MemorySource;
      continue;
    }
    if (arg === "--since" || arg.startsWith("--since=")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++index];
      if (!value) throw new Error("--since 缺少日期");
      since = parseSince(value);
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`未知参数：${arg}`);
    if (output) throw new Error(`只能指定一个输出文件，收到：${output} 和 ${arg}`);
    output = arg;
  }

  if (!output) {
    console.error(
      "用法: bun run scripts/export.ts <output.md> [--all] [--source auto|manual|import] [--since YYYY-MM-DD]"
    );
    process.exitCode = 1;
    return;
  }

  const runtime = createRuntime(process.cwd());
  try {
    const overview = await runtime.service.getOverview();
    const keep = (item: { source: MemorySource; updated_at: number }): boolean =>
      (!source || item.source === source) && (since === undefined || item.updated_at >= since);
    const active = (await runtime.service.listActive()).filter(keep);
    const archived = includeArchived
      ? (await runtime.service.listArchived()).filter(keep)
      : [];

    const lines: string[] = [
      "# 项目记忆导出",
      "",
      `- 项目: ${runtime.project.name}`,
      `- 路径: ${runtime.project.root}`,
      `- 导出时间: ${new Date().toISOString()}`,
      "",
      "## 项目概览",
      "",
      overview || "（未设置）",
      "",
    ];

    for (const category of CATEGORIES) {
      const items = active.filter((item) => item.category === category);
      if (items.length === 0) continue;
      lines.push(`## ${category}`, "");
      for (const item of items) {
        lines.push(`### [${item.id}] ${item.title}`, "");
        lines.push(item.content, "");
        if (item.related_files.length > 0) {
          lines.push(`相关文件: ${item.related_files.map((file) => `\`${file}\``).join(", ")}`, "");
        }
        lines.push(`- 版本: ${item.version}`, `- 更新时间: ${formatDate(item.updated_at)}`, "");
      }
    }

    if (archived.length > 0) {
      lines.push("## archived", "");
      for (const item of archived) {
        lines.push(`### [${item.id}] ${item.title}`, "");
        lines.push(item.content, "", `- 分类: ${item.category}`, `- 更新时间: ${formatDate(item.updated_at)}`, "");
      }
    }

    const path = resolve(output);
    writeFileSync(path, `${lines.join("\n")}\n`, "utf-8");
    console.log(`已导出 ${active.length} 条 active 记忆到 ${path}`);
  } finally {
    await runtime.service.close();
  }
}

main().catch((error) => {
  console.error(`导出失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
