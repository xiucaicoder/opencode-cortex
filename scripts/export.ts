/**
 * Export project memory as Markdown for human review and version control.
 *
 * Usage: bun run scripts/export.ts <output.md> [--all]
 * Without --all only active memories are exported.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRuntime } from "../src/runtime.js";
import { CATEGORIES } from "../src/store.js";

function formatDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const output = process.argv[2];
  if (!output || output.startsWith("--")) {
    console.error("用法: bun run scripts/export.ts <output.md> [--all]");
    process.exitCode = 1;
    return;
  }
  const includeArchived = process.argv.includes("--all");

  const runtime = createRuntime(process.cwd());
  try {
    const overview = await runtime.service.getOverview();
    const active = await runtime.service.listActive();
    const archived = includeArchived ? await runtime.service.listArchived() : [];

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
