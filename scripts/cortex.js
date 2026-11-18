#!/usr/bin/env bun
import { createReadOnlyRuntime } from "../dist/runtime.js";

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== "list" || args.length > 2 || (args[1] && !["--all", "--conflicts"].includes(args[1]))) {
    console.error("用法: cortex list [--all | --conflicts]");
    process.exitCode = 2;
    return;
  }
  const { project, store } = createReadOnlyRuntime(process.cwd());
  if (!store) {
    console.log(`项目 ${project.name} 暂无记忆库。`);
    return;
  }
  try {
    await store.open();
    console.log(`项目: ${project.name}\n路径: ${project.root}\n`);
    if (args[1] === "--conflicts") {
      const rows = await store.listConflicts();
      if (!rows.length) console.log("暂无待处理冲突。");
      for (const row of rows) {
        console.log(`[${row.memory_id}] v${row.memory_version} ${row.current_title}\n现有: ${row.current_content}\n候选: ${row.content}\n来源: ${row.source_ref}\n时间: ${new Date(Number(row.created_at)).toLocaleString()}\n`);
      }
      return;
    }
    const rows = args[1] === "--all" ? await store.listAll() : await store.listActive();
    if (!rows.length) console.log("暂无记忆。");
    for (const row of rows) {
      console.log(`[${row.id}] v${row.version} ${row.title} (${row.category}, ${row.status})\n${row.content}\n来源: ${row.source}${row.source_ref ? " · " + row.source_ref : ""}\n更新时间: ${new Date(Number(row.updated_at)).toLocaleString()}\n`);
    }
  } finally {
    await store.close();
  }
}
main().catch((error) => {
  console.error("查看记忆失败:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
