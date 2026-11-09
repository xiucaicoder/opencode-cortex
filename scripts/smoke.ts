/**
 * Stage 0 smoke test for opencode-cortex.
 *
 * Verifies, before any upstream code is removed:
 *   1. Xenova/bge-base-zh-v1.5 loads locally through transformers.js
 *   2. CLS pooling + normalization produce 768-dim vectors
 *   3. Turso accepts F32_BLOB(768), vector32(?) writes and vector_distance_cos queries
 *   4. Prints cosine similarities for a calibration set of Chinese business sentences
 *
 * Run: bun run scripts/smoke.ts
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { connect } from "@tursodatabase/database";

const MODEL = "Xenova/bge-base-zh-v1.5";
const DIMS = 768;
const ROOT = join(import.meta.dir, "..");
const CACHE_DIR = join(ROOT, ".cache", "smoke-model");
const DB_PATH = join(ROOT, ".cache", "smoke.db");

type Pipeline = (
  text: string,
  options: { pooling: "cls"; normalize: boolean }
) => Promise<{ data: Float32Array }>;

async function loadEmbedder(): Promise<Pipeline> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const { pipeline, env } = await import("@huggingface/transformers");
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.cacheDir = CACHE_DIR;
  try {
    (
      env as unknown as { backends: { onnx: { wasm: { numThreads: number } } } }
    ).backends.onnx.wasm.numThreads = 1;
  } catch {
    // native onnxruntime backend may not expose wasm knobs
  }
  console.log(`[smoke] loading ${MODEL} (dtype=q8) ...`);
  const started = Date.now();
  const pipe = (await pipeline("feature-extraction", MODEL, {
    dtype: "q8",
  })) as unknown as Pipeline;
  console.log(`[smoke] model loaded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return pipe;
}

async function embed(pipe: Pipeline, text: string): Promise<Float32Array> {
  const output = await pipe(text, { pooling: "cls", normalize: true });
  return new Float32Array(output.data);
}

function assertDims(vector: Float32Array, label: string): void {
  if (vector.length !== DIMS) {
    throw new Error(`${label}: expected ${DIMS} dims, got ${vector.length}`);
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (Math.abs(norm - 1) > 0.01) {
    throw new Error(`${label}: expected unit norm, got ${norm.toFixed(6)}`);
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

const PAIRS: Array<{ label: string; kind: string; a: string; b: string }> = [
  {
    kind: "同义改写",
    label: "收货地址-改写",
    a: "订单支付成功后不允许修改收货地址",
    b: "付款完成后，收货地址不能改",
  },
  {
    kind: "同义改写",
    label: "库存扣减-改写",
    a: "库存扣减发生在订单提交时，而不是发货时",
    b: "下单时即扣库存，发货不再扣减",
  },
  {
    kind: "同义改写",
    label: "积分结算-改写",
    a: "会员积分按月结算",
    b: "每月结算一次会员积分",
  },
  {
    kind: "同主题不同事实",
    label: "改地址时点",
    a: "订单支付成功后不允许修改收货地址",
    b: "订单发货后不允许修改收货地址",
  },
  {
    kind: "同主题不同事实",
    label: "扣库存时点",
    a: "库存扣减发生在订单提交时",
    b: "库存扣减发生在发货时",
  },
  {
    kind: "同主题不同事实",
    label: "退款审核人",
    a: "退款需要财务审核",
    b: "退款需要客服主管审核",
  },
  {
    kind: "同主题不同事实",
    label: "鉴权方案",
    a: "v1 接口使用 JWT 鉴权",
    b: "v2 接口使用 OAuth2 鉴权",
  },
  {
    kind: "同主题不同事实",
    label: "数据保留期",
    a: "用户注销后保留订单数据 180 天",
    b: "用户注销后保留订单数据 90 天",
  },
  {
    kind: "同主题不同事实",
    label: "租户隔离字段",
    a: "租户数据按 tenant_id 隔离",
    b: "租户数据按 org_id 隔离",
  },
  {
    kind: "同主题不同事实",
    label: "价格含税",
    a: "商品价格含税",
    b: "商品价格不含税",
  },
  {
    kind: "完全无关",
    label: "改地址-vs-备份",
    a: "订单支付成功后不允许修改收货地址",
    b: "数据库迁移前必须备份生产库",
  },
  {
    kind: "完全无关",
    label: "积分-vs-表单校验",
    a: "会员积分按月结算",
    b: "前端表单使用 zod 校验",
  },
  {
    kind: "完全无关",
    label: "库存-vs-日志",
    a: "库存扣减发生在订单提交时",
    b: "日志文件按天轮转",
  },
  {
    kind: "完全无关",
    label: "回调幂等-vs-时区",
    a: "支付回调必须幂等处理，失败重试三次",
    b: "所有时间字段以 UTC 存储",
  },
  {
    kind: "完全无关",
    label: "时区-vs-主题色",
    a: "定时任务使用 Asia/Shanghai 时区",
    b: "移动端主题色随系统切换",
  },
];

async function main(): Promise<void> {
  const pipe = await loadEmbedder();

  const probe = await embed(pipe, "opencode-cortex 冒烟测试");
  assertDims(probe, "probe");
  console.log(`[smoke] embedding dims=${probe.length} unit-norm=ok`);

  rmSync(DB_PATH, { force: true });
  const db = await connect(DB_PATH);
  try {
    await db.run(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        vector F32_BLOB(${DIMS}) NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    const seed = [
      {
        id: "m1",
        title: "收货地址修改限制",
        content: "订单支付成功后不允许修改收货地址",
      },
      {
        id: "m2",
        title: "库存扣减时点",
        content: "库存扣减发生在订单提交时，而不是发货时",
      },
      {
        id: "m3",
        title: "租户数据隔离",
        content: "租户数据按 tenant_id 隔离，跨租户查询必须显式授权",
      },
    ];

    for (const row of seed) {
      const vector = await embed(pipe, `${row.title}\n${row.content}`);
      assertDims(vector, row.id);
      await db.run(
        `INSERT INTO memories (id, title, content, vector, updated_at)
         VALUES (?, ?, ?, vector32(?), ?)`,
        row.id,
        row.title,
        row.content,
        JSON.stringify(Array.from(vector)),
        Date.now()
      );
    }

    const queryVector = await embed(pipe, "付款后还能改收货地址吗");
    const rows = (await db.all(
      `SELECT id, title, vector_distance_cos(vector, vector32(?)) AS dist
       FROM memories
       ORDER BY dist ASC`,
      JSON.stringify(Array.from(queryVector))
    )) as Array<{ id: string; title: string; dist: number }>;

    if (rows.length !== seed.length) {
      throw new Error(`Turso retrieval returned ${rows.length}/${seed.length} rows`);
    }
    if (rows[0]?.id !== "m1") {
      throw new Error(`Turso retrieval top-1 expected m1, got ${rows[0]?.id}`);
    }
    console.log("[smoke] Turso write + vector_distance_cos retrieval: ok");
    for (const row of rows) {
      console.log(
        `[smoke]   ${row.id} similarity=${(1 - Number(row.dist)).toFixed(4)} ${row.title}`
      );
    }
  } finally {
    await db.close();
  }

  console.log("\n[calibration] pair cosine similarities (bge-base-zh-v1.5, cls, normalized)");
  let index = 0;
  for (const pair of PAIRS) {
    index++;
    const [va, vb] = await Promise.all([embed(pipe, pair.a), embed(pipe, pair.b)]);
    const score = cosine(va, vb);
    console.log(
      `${String(index).padStart(2, "0")}. ${score.toFixed(4)}  [${pair.kind}] ${pair.label}\n    A: ${pair.a}\n    B: ${pair.b}`
    );
  }
}

main().catch((error) => {
  console.error("[smoke] FAILED:", error instanceof Error ? error.message : error);
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exitCode = 1;
});
