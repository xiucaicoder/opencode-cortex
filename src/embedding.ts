import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CortexConfig } from "./config.js";

export const EMBEDDING_POOLING = "cls" as const;

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(text: string): Promise<Float32Array>;
  dispose(): Promise<void>;
}

type FeatureExtractor = (
  text: string,
  options: { pooling: "cls"; normalize: boolean }
) => Promise<{ data: Float32Array }>;

/**
 * Local BGE embedding through transformers.js.
 *
 * The model is loaded on the first call, not during plugin setup, so a broken
 * model download never blocks OpenCode startup.
 */
export class LocalEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  private pipeline: FeatureExtractor | null = null;
  private loading: Promise<FeatureExtractor> | null = null;

  constructor(private readonly config: CortexConfig) {
    this.model = config.embeddingModel;
    this.dimensions = config.embeddingDimensions;
  }

  private async load(): Promise<FeatureExtractor> {
    if (this.pipeline) return this.pipeline;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const cacheDir = join(this.config.storagePath, ".cache");
      mkdirSync(cacheDir, { recursive: true });
      const { pipeline, env } = await import("@huggingface/transformers");
      env.allowLocalModels = true;
      env.allowRemoteModels = true;
      env.cacheDir = cacheDir;
      try {
        const backends = (env as unknown as { backends: { onnx: { wasm: { numThreads: number } } } })
          .backends;
        backends.onnx.wasm.numThreads = 1;
      } catch {
        // native onnxruntime backend has no wasm thread knob
      }
      try {
        return (await pipeline("feature-extraction", this.model, {
          dtype: this.config.embeddingDtype,
        })) as unknown as FeatureExtractor;
      } catch (error) {
        throw new Error(
          `加载 embedding 模型 ${this.model} 失败（缓存目录 ${cacheDir}）：${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    })();

    try {
      this.pipeline = await this.loading;
      return this.pipeline;
    } finally {
      this.loading = null;
    }
  }

  async embed(text: string): Promise<Float32Array> {
    const extractor = await this.load();
    const output = await extractor(text, { pooling: EMBEDDING_POOLING, normalize: true });
    const vector = new Float32Array(output.data);
    if (vector.length !== this.dimensions) {
      throw new Error(
        `Embedding 维度不匹配：模型 ${this.model} 返回 ${vector.length} 维，配置为 ${this.dimensions} 维`
      );
    }
    return vector;
  }

  async dispose(): Promise<void> {
    const current = this.pipeline as unknown as { dispose?: () => Promise<void> } | null;
    this.pipeline = null;
    await current?.dispose?.();
  }
}
