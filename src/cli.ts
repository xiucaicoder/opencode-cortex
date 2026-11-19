import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { auditMemories } from "./audit.js";
import { GLOBAL_CONFIG_PATH, loadConfig } from "./config.js";
import { createReadOnlyRuntime, createRuntime } from "./runtime.js";
import type { MemoryConflict } from "./store.js";

const USAGE = [
  "用法:",
  "  cortex list [--all | --conflicts]              查看项目记忆或待处理冲突",
  "  cortex resolve [id] [--keep | --accept <n> | --content <text> [--title <text>]]",
  "                                                 交互式或一键解决记忆冲突",
  "  cortex history <id>                            查看记忆的历史版本记录",
  "  cortex doctor                                  检查数据库、模型缓存与提取健康状态",
  "  cortex audit [--days 30] [--min-commits 3] [--json]",
  "                                                 巡检失效文件、代码漂移与长期零召回记忆",
].join("\n");

function parseFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

function groupConflicts(rows: MemoryConflict[]): Array<{
  memoryId: string;
  version: number;
  currentTitle: string;
  currentContent: string;
  candidates: MemoryConflict[];
}> {
  const map = new Map<
    string,
    {
      memoryId: string;
      version: number;
      currentTitle: string;
      currentContent: string;
      candidates: MemoryConflict[];
    }
  >();
  for (const row of rows) {
    const existing = map.get(row.memory_id);
    if (existing) {
      existing.candidates.push(row);
    } else {
      map.set(row.memory_id, {
        memoryId: row.memory_id,
        version: row.memory_version,
        currentTitle: row.current_title,
        currentContent: row.current_content,
        candidates: [row],
      });
    }
  }
  return [...map.values()];
}

async function cmdList(cwd: string, args: string[]): Promise<number> {
  if (args.length > 1 || (args[0] && !["--all", "--conflicts"].includes(args[0]))) {
    console.error("用法: cortex list [--all | --conflicts]");
    return 2;
  }
  const { project, store } = createReadOnlyRuntime(cwd);
  if (!store) {
    console.log(`项目 ${project.name} 暂无记忆库。`);
    return 0;
  }
  try {
    await store.open();
    console.log(`项目: ${project.name}\n路径: ${project.root}\n`);
    if (args[0] === "--conflicts") {
      const rows = await store.listConflicts();
      if (!rows.length) console.log("暂无待处理冲突。");
      for (const row of rows) {
        console.log(
          `[${row.memory_id}] v${row.memory_version} ${row.current_title}\n` +
            `现有: ${row.current_content}\n` +
            `候选: ${row.content}\n` +
            `来源: ${row.source_ref}\n` +
            `时间: ${new Date(Number(row.created_at)).toLocaleString()}\n`
        );
      }
      return 0;
    }
    const rows = args[0] === "--all" ? await store.listAll() : await store.listActive();
    if (!rows.length) console.log("暂无记忆。");
    for (const row of rows) {
      console.log(
        `[${row.id}] v${row.version} ${row.title} (${row.category}, ${row.status})\n` +
          `${row.content}\n` +
          `来源: ${row.source}${row.source_ref ? " · " + row.source_ref : ""}\n` +
          `更新时间: ${new Date(Number(row.updated_at)).toLocaleString()}\n`
      );
    }
    return 0;
  } finally {
    await store.close();
  }
}

async function cmdHistory(cwd: string, args: string[]): Promise<number> {
  const id = args[0]?.trim();
  if (!id) {
    console.error("用法: cortex history <id>");
    return 2;
  }
  const { project, store } = createReadOnlyRuntime(cwd);
  if (!store) {
    console.log(`项目 ${project.name} 暂无记忆库。`);
    return 0;
  }
  try {
    await store.open();
    const current = await store.getById(id);
    if (!current) {
      console.error(`未找到记忆 ${id}。`);
      return 1;
    }
    console.log(
      `当前版本 [${current.id}] v${current.version} ${current.title} (${current.category}, ${current.status})\n` +
        `${current.content}\n` +
        `更新时间: ${new Date(current.updated_at).toLocaleString()}\n`
    );
    const history = await store.listHistory(id);
    if (!history.length) {
      console.log("暂无更早历史版本。");
      return 0;
    }
    console.log("历史版本:");
    for (const entry of history) {
      console.log(
        `  v${entry.version} ${entry.title} (${entry.status}) · ${new Date(entry.updated_at).toLocaleString()}\n` +
          `  ${entry.content}\n`
      );
    }
    return 0;
  } finally {
    await store.close();
  }
}

async function cmdResolve(cwd: string, args: string[]): Promise<number> {
  const keep = args.includes("--keep");
  const acceptRaw = parseFlagValue(args, "--accept");
  const customContent = parseFlagValue(args, "--content");
  const customTitle = parseFlagValue(args, "--title");
  const positionalId = args[0] && !args[0].startsWith("--") ? args[0] : undefined;

  const runtime = createRuntime(cwd);
  try {
    const conflicts = await runtime.service.listConflicts();
    const groups = groupConflicts(conflicts);
    if (groups.length === 0) {
      console.log("当前没有待处理的冲突。");
      return 0;
    }

    if (keep || acceptRaw !== undefined || customContent !== undefined) {
      const target = positionalId
        ? groups.find((group) => group.memoryId === positionalId)
        : groups[0];
      if (!target) {
        console.error(`未找到记忆 ${positionalId} 的待处理冲突。`);
        return 1;
      }
      if (keep) {
        const res = await runtime.service.resolveConflict(target.memoryId, {
          action: "keep",
          expectedVersion: target.version,
        });
        console.log(`已保留 [${res.id}] v${res.version}，清除了 ${res.cleared} 条冲突并恢复召回。`);
        return 0;
      }
      if (acceptRaw !== undefined) {
        const candidateIndex = Number(acceptRaw);
        if (!Number.isInteger(candidateIndex) || candidateIndex < 1) {
          console.error("--accept 需要正整数序号（例如 --accept 1）");
          return 2;
        }
        const chosen = target.candidates[candidateIndex - 1];
        if (!chosen) {
          console.error(`候选序号超出范围（共 ${target.candidates.length} 条）`);
          return 2;
        }
        const res = await runtime.service.resolveConflict(target.memoryId, {
          action: "accept",
          candidate: { content: chosen.content, source_ref: chosen.source_ref },
          expectedVersion: target.version,
        });
        console.log(`已采用候选 #${candidateIndex}，更新 [${res.id}] 至 v${res.version} 并恢复召回。`);
        return 0;
      }
      const res = await runtime.service.resolveConflict(target.memoryId, {
        action: "custom",
        title: customTitle,
        content: customContent!,
        expectedVersion: target.version,
      });
      console.log(`已使用自定义内容更新 [${res.id}] 至 v${res.version} 并恢复召回。`);
      return 0;
    }

    const targets = positionalId
      ? groups.filter((group) => group.memoryId === positionalId)
      : groups;
    if (targets.length === 0) {
      console.error(`未找到记忆 ${positionalId} 的待处理冲突。`);
      return 1;
    }

    const rl = createInterface({ input: stdin, output: stdout });
    try {
      for (const group of targets) {
        console.log(`\n[${group.memoryId}] v${group.version} ${group.currentTitle}`);
        console.log(`  现有: ${group.currentContent}`);
        group.candidates.forEach((candidate, idx) => {
          console.log(`  候选 ${idx + 1}: ${candidate.content}  (${candidate.source_ref})`);
        });
        const answer = (
          await rl.question(
            `选择操作: [k] 保留现有 / [1-${group.candidates.length}] 采用候选 / [s] 跳过 / [q] 退出: `
          )
        )
          .trim()
          .toLowerCase();
        if (answer === "q") break;
        if (!answer || answer === "s") continue;
        if (answer === "k") {
          const res = await runtime.service.resolveConflict(group.memoryId, {
            action: "keep",
            expectedVersion: group.version,
          });
          console.log(`→ 已保留 [${res.id}] v${res.version} 并恢复召回。`);
          continue;
        }
        const num = Number(answer);
        if (Number.isInteger(num) && num >= 1 && num <= group.candidates.length) {
          const chosen = group.candidates[num - 1]!;
          const res = await runtime.service.resolveConflict(group.memoryId, {
            action: "accept",
            candidate: { content: chosen.content, source_ref: chosen.source_ref },
            expectedVersion: group.version,
          });
          console.log(`→ 已采用候选 ${num}，更新 [${res.id}] 至 v${res.version}。`);
          continue;
        }
        console.log("→ 未识别的输入，已跳过。");
      }
    } finally {
      rl.close();
    }
    return 0;
  } finally {
    await runtime.service.close();
  }
}

async function cmdDoctor(cwd: string): Promise<number> {
  const config = loadConfig(cwd);
  const { project, store } = createReadOnlyRuntime(cwd);
  const cacheDir = join(config.storagePath, ".cache");
  const hasModelCache = existsSync(cacheDir) && readdirSync(cacheDir).length > 0;
  const projectConfigPath = join(project.root, ".opencode", "opencode-cortex.jsonc");

  console.log(`项目: ${project.name}`);
  console.log(`根目录: ${project.root}`);
  console.log(`数据库: ${project.dbPath} (${store ? "已初始化" : "尚未创建"})`);
  console.log(
    `配置: 全局=${existsSync(GLOBAL_CONFIG_PATH) ? "存在" : "默认"}, 项目=${existsSync(projectConfigPath) ? "存在" : "无"}`
  );
  console.log(
    `Embedding: ${config.embeddingModel} (${config.embeddingDtype}, ${config.embeddingDimensions}d) · 本地缓存=${hasModelCache ? "已就绪" : "未下载（首次检索会自动下载）"}`
  );
  console.log(
    `检索阈值: searchMinScore=${config.searchMinScore} · 注入模式=${config.injectOn} (上限 ${config.injectMaxTitles})`
  );
  console.log(
    `自动提取: ${config.autoExtract.enabled ? "开启" : "关闭"} · 模型=${config.opencodeModel}${config.opencodeVariant ? ` (${config.opencodeVariant})` : ""}`
  );

  if (!store) return 0;
  try {
    await store.open();
    const active = await store.listActive();
    const archived = await store.listArchived();
    const conflicts = await store.listConflictSummaries();
    const blockedCount = conflicts.filter((c) => c.blocksRecall).length;
    const sessions = await store.listSessionStates();
    const failedSessions = sessions.filter((s) => s.failed_attempts > 0);
    const overview = await store.getOverview();

    console.log(
      `记忆统计: 可用=${active.length}, 归档=${archived.length}, 待处理冲突=${conflicts.length}（暂停召回=${blockedCount}）, 项目概览=${overview ? `${[...overview].length}字` : "未设置"}`
    );
    if (conflicts.length > 0) {
      console.log(
        `⚠ 有 ${conflicts.length} 条记忆存在待确认冲突（其中 ${blockedCount} 条已暂停召回），请运行: cortex resolve`
      );
    }
    if (failedSessions.length > 0) {
      console.log(
        `⚠ 最近有 ${failedSessions.length} 个会话的自动提取发生失败（请检查 opencodeModel=${config.opencodeModel} 配置或网络）。`
      );
    }
    return 0;
  } finally {
    await store.close();
  }
}

async function cmdAudit(cwd: string, args: string[]): Promise<number> {
  const daysRaw = parseFlagValue(args, "--days");
  const commitsRaw = parseFlagValue(args, "--min-commits");
  const asJson = args.includes("--json");
  const staleDays = daysRaw !== undefined ? Number(daysRaw) : 30;
  const minDriftCommits = commitsRaw !== undefined ? Number(commitsRaw) : 3;
  if (!Number.isFinite(staleDays) || staleDays < 0 || !Number.isFinite(minDriftCommits) || minDriftCommits < 0) {
    console.error("用法: cortex audit [--days 30] [--min-commits 3] [--json]");
    return 2;
  }

  const { project, store } = createReadOnlyRuntime(cwd);
  if (!store) {
    if (asJson) console.log(JSON.stringify({ project: project.name, issues: [] }, null, 2));
    else console.log(`项目 ${project.name} 暂无记忆库。`);
    return 0;
  }
  try {
    await store.open();
    const memories = await store.listActive();
    const stats = await store.getRecallStats();
    const issues = auditMemories(project.root, memories, stats, {
      staleDays,
      minDriftCommits,
    });
    if (asJson) {
      console.log(JSON.stringify({ project: project.name, totalActive: memories.length, issues }, null, 2));
      return 0;
    }
    console.log(`项目: ${project.name} · 活跃记忆: ${memories.length} · 需复核: ${issues.length}\n`);
    if (issues.length === 0) {
      console.log("所有活跃记忆均健康，未发现文件失效、代码漂移或长期零召回条目。");
      return 0;
    }
    for (const issue of issues) {
      console.log(`[${issue.id}] v${issue.version} ${issue.title} (${issue.category}, 召回 ${issue.recallCount} 次)`);
      for (const reason of issue.reasons) {
        if (reason.kind === "missing_file") {
          console.log(`  - 关联文件不存在: ${reason.file}`);
        } else if (reason.kind === "git_drift") {
          console.log(`  - 代码漂移: 关联文件自上次更新以来有 ${reason.commits} 次提交 (${reason.files.join(", ")})`);
        } else {
          console.log(`  - 长期未召回: 已更新 ${reason.ageDays} 天且召回次数为 0`);
        }
      }
      console.log("");
    }
    return 0;
  } finally {
    await store.close();
  }
}

export async function runCli(argv: string[], cwd = process.cwd()): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help" || command === "help") {
    console.log(USAGE);
    return 0;
  }
  if (command === "list") return cmdList(cwd, rest);
  if (command === "resolve") return cmdResolve(cwd, rest);
  if (command === "history") return cmdHistory(cwd, rest);
  if (command === "doctor") return cmdDoctor(cwd);
  if (command === "audit") return cmdAudit(cwd, rest);
  console.error(`未知命令: ${command}\n\n${USAGE}`);
  return 2;
}
