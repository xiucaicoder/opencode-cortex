#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "@tursodatabase/database";
import { loadConfig } from "../dist/config.js";
import { resolveProject } from "../dist/project.js";

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== "list" || args.length > 2 || (args[1] && !["--all", "--conflicts"].includes(args[1]))) {
    console.error("用法: cortex list [--all | --conflicts]");
    process.exitCode = 2;
    return;
  }
  const config = loadConfig(process.cwd());
  const project = resolveProject(process.cwd(), config.storagePath);
  if (!existsSync(project.dbPath)) {
    console.log(`项目 ${project.name} 暂无记忆库。`);
    return;
  }
  let encryption;
  if (config.databaseEncryptionEnabled) {
    const keyPath = join(config.storagePath, "db.key");
    const hexkey = config.databaseEncryptionKey?.trim() || (existsSync(keyPath) ? readFileSync(keyPath, "utf8").trim() : "");
    if (!/^[a-f0-9]{64}$/i.test(hexkey)) throw new Error("无法读取有效的数据库加密密钥");
    encryption = { cipher: config.databaseEncryptionCipher, hexkey };
  }
  const db = await connect(project.dbPath, {
    experimental: process.platform === "win32" ? ["encryption"] : ["encryption", "multiprocess_wal"],
    ...(encryption ? { encryption } : {}),
  });
  try {
    await db.exec("PRAGMA query_only = 1");
    const tables = await db.all("SELECT name FROM sqlite_master WHERE type = 'table'") ;
    const names = new Set(tables.map((row) => row.name));
    if (!names.has("memories")) throw new Error("项目数据库没有记忆表");
    const conflictFilter = names.has("memory_conflicts")
      ? "AND NOT EXISTS (SELECT 1 FROM memory_conflicts c WHERE c.memory_id=m.id AND c.memory_version=m.version AND c.blocks_recall=1)"
      : "";
    console.log(`项目: ${project.name}\n路径: ${project.root}\n`);
    if (args[1] === "--conflicts") {
      const rows = names.has("memory_conflicts") ? await db.all(`SELECT c.*, m.title AS current_title, m.content AS current_content FROM memory_conflicts c JOIN memories m ON m.id=c.memory_id AND m.version=c.memory_version WHERE m.status='active' ORDER BY c.created_at DESC`) : [];
      if (!rows.length) console.log("暂无待处理冲突。");
      for (const row of rows) {
        console.log(`[${row.memory_id}] v${row.memory_version} ${row.current_title}\n现有: ${row.current_content}\n候选: ${row.content}\n来源: ${row.source_ref}\n时间: ${new Date(Number(row.created_at)).toLocaleString()}\n`);
      }
      return;
    }
    const rows = await db.all(`SELECT m.* FROM memories m WHERE ${args[1] === "--all" ? "1=1" : "m.status='active' " + conflictFilter} ORDER BY m.updated_at DESC`);
    if (!rows.length) console.log("暂无记忆。");
    for (const row of rows) {
      console.log(`[${row.id}] v${row.version} ${row.title} (${row.category}, ${row.status})\n${row.content}\n来源: ${row.source}${row.source_ref ? " · " + row.source_ref : ""}\n更新时间: ${new Date(Number(row.updated_at)).toLocaleString()}\n`);
    }
  } finally {
    await db.close();
  }
}
main().catch((error) => {
  console.error("查看记忆失败:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
