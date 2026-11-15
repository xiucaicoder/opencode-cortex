/** Replay synthetic commerce conversations through extraction, verification and a fresh reader. */
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEvidenceVerifier } from "../src/evidence.js";
import { runAutoExtraction } from "../src/extraction.js";
import { createRuntime } from "../src/runtime.js";

const scenarios = [
  {
    id: "partial-refund",
    history: ["确认生效：商城部分退款成功后不得关闭整单，订单应保留原状态，因为它可能还有未退款商品。"],
    task: "我准备在部分退款成功回调里更新订单状态。按项目规则，应该写入哪个结果？只回答 保留原状态 或 关闭整单。",
    expected: "保留原状态",
  },
  {
    id: "payment-idempotency",
    history: ["确认：支付回调幂等键固定用渠道流水号，不用支付单号。原因是一次支付单可收到多条不同渠道流水。"],
    task: "为支付网关回调加唯一索引，项目约定选哪个键？只回答 渠道流水号 或 支付单号。",
    expected: "渠道流水号",
  },
  {
    id: "stock",
    history: ["确认现行规则：仅在取消订单事务提交后回补库存，回滚时不得回补，避免出现可售库存大于实物库存。"],
    task: "取消订单事务还没提交，库存服务现在应不应该回补？只回答 等事务提交 或 立即回补。",
    expected: "等事务提交",
  },
  {
    id: "coupon",
    history: ["确认：已支付订单取消后，只有全额退款结算成功时才归还优惠券，部分退款不归还，以免重复使用。"],
    task: "已付款订单关闭了，退款只是部分退款。应否归还优惠券？只回答 不归还 或 归还。",
    expected: "不归还",
  },
  {
    id: "settlement",
    history: ["确认：结算对账按商品行分摊后的实付金额，不能用商品原价。优惠可能跨行分摊，所以订单级总额也不能代替行级金额。"],
    task: "结算对账 SQL 应该使用哪一列的口径？只回答 行级分摊实付 或 商品原价。",
    expected: "行级分摊实付",
  },
  {
    id: "terms-update",
    history: [
      "确认当时的现行规则：普通商品售后申请期限为签收后180天，其他商品另有规定。",
      "确认变更且立即生效：普通商品售后申请期限改为签收后90天，替代原来普通商品的180天。适用范围没变。",
    ],
    task: "实现当前普通商品售后申请截止时间，从签收开始算几天？只回答数字。",
    expected: "90",
    reject: "180",
  },
  {
    id: "distinct-scope",
    history: [
      "确认生效：生鲜商品的售后申请期限为签收后7天。",
      "确认补充一条并行规则：耐用品的售后申请期限为签收后15天。生鲜商品的7天期限仍然适用。",
    ],
    task: "现在分别为生鲜商品和耐用品配置售后期限。按顺序用 生鲜天数/耐用品天数 回答，只写数字和斜杠。",
    expected: "7/15",
  },
  {
    id: "unconfirmed",
    history: ["讨论一下要不要把优惠券退款等待时间改成48小时？先别定，等财务评估，旧规则也没找到。"],
    task: "优惠券退款等待时间是多少？如项目依据不足，请回答 不确定。",
    expected: "不确定",
    empty: true,
  },
] as const;

const model = process.env.CORTEX_EVAL_MODEL;
const endpoint = process.env.CORTEX_EVAL_URL;
if (!model || !endpoint) {
  console.error("请设置 CORTEX_EVAL_URL（以 /v1 结尾）和 CORTEX_EVAL_MODEL，可选 CORTEX_EVAL_KEY。");
  process.exit(2);
}
const key = process.env.CORTEX_EVAL_KEY;
const url = new URL(endpoint.replace(/\/$/, "") + "/chat/completions");
const selected = new Set(process.argv.slice(2));
if ([...selected].some((id) => !scenarios.some((scenario) => scenario.id === id))) {
  throw new Error("存在未知的评测用例 id");
}
const prompt = readFileSync(join(import.meta.dir, "..", "prompts", "extract.md"), "utf-8");
type Phase = "extract" | "verify" | "answer";

const string = { type: "string" };
const schemas = {
  extract: { type: "array", items: {
    type: "object", additionalProperties: false,
    properties: {
      action: { enum: ["add", "update"] }, id: string, title: string, category: string, content: string,
      related_files: { type: "array", items: string }, evidence_index: { type: "integer" }, evidence_quote: string,
    },
    required: ["action", "title", "category", "content", "evidence_index", "evidence_quote"],
  } },
  verify: { type: "array", items: {
    type: "object", additionalProperties: false,
    properties: { supported: { type: "boolean" }, distinct_from: { type: "array", items: string },
      same_as: { type: "array", items: string }, conflicts_with: { type: "array", items: string } },
    required: ["supported", "distinct_from", "same_as", "conflicts_with"],
  } },
  answer: string,
};

async function generate(prompt: string, phase: Phase): Promise<string> {
  const structured = process.env.CORTEX_EVAL_JSON_SCHEMA === "1";
  const instruction = structured ? `${prompt}\n把最终结果放进 JSON 对象的 result 字段。` : prompt;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      model, messages: [{ role: "user", content: instruction }], temperature: 0, max_tokens: 850,
      ...(structured ? { response_format: { type: "json_schema", json_schema: {
        name: `cortex_${phase}`, strict: true,
        schema: { type: "object", additionalProperties: false, properties: { result: schemas[phase] }, required: ["result"] },
      } } } : {}),
      ...(process.env.CORTEX_EVAL_NO_THINK === "1" ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    }),
  });
  if (!response.ok) throw new Error(`模型请求失败 HTTP ${response.status}`);
  const data = await response.json() as { choices?: Array<{ message: { content?: string } }> };
  const content = data.choices?.[0]?.message.content;
  if (!content?.trim()) throw new Error("模型没有返回正文");
  if (!structured) return content.trim();
  const { result } = JSON.parse(content) as { result: unknown };
  return phase === "answer" && typeof result === "string" ? result.trim() : JSON.stringify(result);
}

const dir = mkdtempSync(join(tmpdir(), "cortex-eval-"));
const embeddingCache = process.env.CORTEX_EVAL_EMBEDDING_CACHE;
if (embeddingCache) symlinkSync(resolve(embeddingCache), join(dir, ".cache"), "dir");
const verify = createEvidenceVerifier((prompt) => generate(prompt, "verify"));
let count = 0;
let noMemoryPass = 0;
let memoryPass = 0;
const run = (task: string, memories: unknown[]) => generate(
  "请仅依据已查到的项目记忆执行以下任务。没有证据时，回答 不确定。严格使用要求的输出格式。\n" +
  JSON.stringify({ memories, task }), "answer"
);
const normalize = (value: string) => value.trim().replace(/[\s`。]/g, "");
try {
  for (const scenario of scenarios) {
    if (selected.size && !selected.has(scenario.id)) continue;
    const start = performance.now();
    const options = { storagePath: dir, blockedPatterns: [], databaseEncryptionEnabled: false,
      embeddingModel: "Xenova/bge-base-zh-v1.5", embeddingDimensions: 768, embeddingDtype: "q8" as const };
    const location = join(dir, scenario.id);
    const writer = createRuntime(location, options);
    const outcomes = [];
    try {
      for (const [i, text] of scenario.history.entries()) {
        const config = {
          ...writer.config,
          autoExtract: { ...writer.config.autoExtract, minInputChars: 1, cooldownMinutes: 0 },
        };
        outcomes.push(await runAutoExtraction(`${scenario.id}-source-${i}`, config, {
          service: writer.service, readPrompt: () => prompt, generate: (prompt) => generate(prompt, "extract"), verify,
          getMessages: async () => [{ id: "m1", type: "user", text, time: { created: 1000 + i } }],
        }));
      }
    } finally {
      await writer.service.close();
    }
    const reader = createRuntime(location, options);
    try {
      const hits = await reader.service.search(scenario.task, 5);
      const noMemory = await run(scenario.task, []);
      const withMemory = await run(scenario.task, hits);
      const noMemoryCorrect = normalize(noMemory) === scenario.expected;
      const extractionOK = outcomes.every(({ status }) => status === "ok") &&
        ("empty" in scenario ? hits.length === 0 : hits.length > 0);
      const noStaleRule = !("reject" in scenario) || hits.every(({ content }) => !content.includes(scenario.reject));
      const memoryCorrect = normalize(withMemory) === scenario.expected && extractionOK && noStaleRule;
      noMemoryPass += Number(noMemoryCorrect);
      memoryPass += Number(memoryCorrect);
      count++;
      console.log(JSON.stringify({
        case: scenario.id, noMemory, withMemory, expected: scenario.expected, extraction: outcomes,
        recalled: hits.length, noStaleRule, noMemoryCorrect, memoryCorrect,
        elapsedMs: Math.round(performance.now() - start),
      }));
    } finally {
      await reader.service.close();
    }
  }
  console.log(JSON.stringify({ count, noMemoryPass, memoryPass }));
  if (memoryPass !== count) process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
