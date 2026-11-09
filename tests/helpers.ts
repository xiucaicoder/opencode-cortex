import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CortexConfig } from "../src/config.js";
import type { Embedder } from "../src/embedding.js";
import { setLogFile } from "../src/logger.js";
import { MemoryService } from "../src/memory-service.js";
import { resolveProject } from "../src/project.js";
import { MemoryStore } from "../src/store.js";

export const DIMS = 768;

function unit(angle: number): Float32Array {
  const vector = new Float32Array(DIMS);
  vector[0] = Math.cos(angle);
  vector[1] = Math.sin(angle);
  return vector;
}

/** Deterministic embedder for tests; unmapped text gets an unrelated vector. */
export class FakeEmbedder implements Embedder {
  readonly model = "fake-embedder";
  readonly dimensions = DIMS;
  private readonly vectors = new Map<string, Float32Array>();

  set(text: string, angle: number): void {
    this.vectors.set(text, unit(angle));
  }

  setSimilarity(text: string, similarity: number): void {
    this.set(text, Math.acos(Math.max(-1, Math.min(1, similarity))));
  }

  async embed(text: string): Promise<Float32Array> {
    const vector = this.vectors.get(text);
    if (vector) return vector;
    const fallback = new Float32Array(DIMS);
    fallback[2] = 1;
    return fallback;
  }

  async dispose(): Promise<void> {}
}

export interface TestRuntime {
  service: MemoryService;
  embedder: FakeEmbedder;
  config: CortexConfig;
  dbPath: string;
  cleanup: () => Promise<void>;
}

export function createTestRuntime(overrides: Partial<CortexConfig> = {}): TestRuntime {
  const dir = mkdtempSync(join(tmpdir(), "opencode-cortex-test-"));
  const storagePath = join(dir, "store");
  const config: CortexConfig = {
    storagePath,
    embeddingModel: "fake-embedder",
    embeddingDtype: "q8",
    embeddingDimensions: DIMS,
    databaseEncryptionEnabled: false,
    databaseEncryptionCipher: "aes256gcm",
    dedupRejectThreshold: 0.92,
    dedupRelatedThreshold: 0.75,
    dedupRelatedLimit: 3,
    blockedPatterns: [],
    ...overrides,
  };
  setLogFile(join(dir, "test.log"));
  const project = resolveProject(dir, storagePath);
  const store = new MemoryStore({
    dbPath: project.dbPath,
    dimensions: config.embeddingDimensions,
    model: config.embeddingModel,
    dtype: config.embeddingDtype,
    pooling: "cls",
    encryption: null,
  });
  const embedder = new FakeEmbedder();
  const service = new MemoryService(config, project, store, embedder);
  return {
    service,
    embedder,
    config,
    dbPath: project.dbPath,
    cleanup: async () => {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function createSecondService(
  config: CortexConfig,
  dbPath: string,
  pooling = "cls"
): Promise<{ service: MemoryService; embedder: FakeEmbedder }> {
  const embedder = new FakeEmbedder();
  const project = {
    root: "/tmp/second",
    name: "second",
    identity: "test-second",
    dbPath,
  };
  const store = new MemoryStore({
    dbPath,
    dimensions: config.embeddingDimensions,
    model: config.embeddingModel,
    dtype: config.embeddingDtype,
    pooling,
    encryption: null,
  });
  return { service: new MemoryService(config, project, store, embedder), embedder };
}
