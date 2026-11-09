import { join } from "node:path";
import { loadConfig, type CortexConfig } from "./config.js";
import { resolveProject, type ProjectInfo } from "./project.js";
import { resolveEncryption } from "./encryption.js";
import { EMBEDDING_POOLING, LocalEmbedder } from "./embedding.js";
import { MemoryStore } from "./store.js";
import { MemoryService } from "./memory-service.js";
import { setLogFile } from "./logger.js";

export interface Runtime {
  config: CortexConfig;
  project: ProjectInfo;
  service: MemoryService;
}

export function createRuntime(
  directory: string,
  overrides?: Partial<CortexConfig>
): Runtime {
  const config: CortexConfig = { ...loadConfig(directory), ...overrides };
  const project = resolveProject(directory, config.storagePath);
  setLogFile(join(config.storagePath, "opencode-cortex.log"));

  const store = new MemoryStore({
    dbPath: project.dbPath,
    dimensions: config.embeddingDimensions,
    model: config.embeddingModel,
    dtype: config.embeddingDtype,
    pooling: EMBEDDING_POOLING,
    encryption: resolveEncryption(config),
  });
  const service = new MemoryService(config, project, store, new LocalEmbedder(config));
  return { config, project, service };
}
