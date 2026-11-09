/**
 * Import project memory from JSONL.
 *
 * Usage: bun run scripts/import.ts <file.jsonl>
 *
 * Each line is either a memory:
 *   {"id":"...","title":"...","category":"domain_rule","content":"...","related_files":["src/a.ts"],"source_ref":"..."}
 * or the project overview (at most 500 characters):
 *   {"type":"overview","content":"..."}
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRuntime } from "../src/runtime.js";
import { MemoryError } from "../src/memory-service.js";

interface LineRecord {
  type?: string;
  id?: string;
  title?: string;
  category?: string;
  content?: string;
  related_files?: string[];
  source_ref?: string;
  created_at?: number;
  updated_at?: number;
}

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) {
    console.error("用法: bun run scripts/import.ts <file.jsonl>");
    process.exitCode = 1;
    return;
  }

  const runtime = createRuntime(process.cwd());
  const lines = readFileSync(resolve(input), "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const rejectedPath = resolve("rejected.jsonl");
  rmSync(rejectedPath, { force: true });

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const rejected: Array<Record<string, unknown>> = [];
  try {
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      let record: LineRecord;
      try {
        record = JSON.parse(line) as LineRecord;
      } catch (error) {
        throw new Error(`第 ${index + 1} 行不是合法 JSON: ${String(error)}`);
      }

      if (record.type === "overview") {
        await runtime.service.setOverview(record.content ?? "");
        console.log(`第 ${index + 1} 行: 已更新项目概览`);
        continue;
      }

      try {
        const result = await runtime.service.importRecord({
          ...(record.id ? { id: record.id } : {}),
          title: record.title ?? "",
          category: record.category ?? "",
          content: record.content ?? "",
          ...(record.related_files ? { related_files: record.related_files } : {}),
          ...(record.source_ref ? { source_ref: record.source_ref } : {}),
          ...(record.created_at ? { created_at: record.created_at } : {}),
          ...(record.updated_at ? { updated_at: record.updated_at } : {}),
        });
        if (result.action === "inserted") inserted++;
        else if (result.action === "updated") updated++;
        else skipped++;
        console.log(`第 ${index + 1} 行: ${result.action} ${result.id}`);
      } catch (error) {
        if (error instanceof MemoryError && (error.code === "duplicate" || error.code === "duplicate_protected")) {
          skipped++;
          rejected.push({
            ...record,
            existing_id: error.details.id ?? null,
            similarity: error.details.similarity ?? null,
            reason: error.code,
          });
          console.log(`第 ${index + 1} 行: 跳过重复记忆 ${String(error.details.id ?? "")}`);
          continue;
        }
        throw new Error(`第 ${index + 1} 行导入失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await runtime.service.close();
  }

  if (rejected.length > 0) {
    writeFileSync(rejectedPath, `${rejected.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf-8");
    console.log(`被去重拒绝的条目已写入 ${rejectedPath}`);
  }
  console.log(`导入完成: 新增 ${inserted}，更新 ${updated}，跳过 ${skipped}`);
}

main().catch((error) => {
  console.error(`导入失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
