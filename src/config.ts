import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { stripJsoncComments } from "./services/jsonc.js";
import type { EncryptionCipher } from "@tursodatabase/database-common";

export const GLOBAL_CONFIG_PATH = join(
  homedir(),
  ".config",
  "opencode",
  "opencode-cortex.jsonc"
);
export const DEFAULT_STORAGE_PATH = join(homedir(), ".opencode-cortex");
export const DEFAULT_EMBEDDING_MODEL = "Xenova/bge-base-zh-v1.5";
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;
export const PROJECT_MARKER = ".opencode-cortex-project";

export interface CortexConfig {
  /** Directory holding the per-project databases, logs and model cache. */
  storagePath: string;
  embeddingModel: string;
  /** transformers.js ONNX dtype. The quantized weights are the default. */
  embeddingDtype: "fp32" | "fp16" | "q8" | "int8" | "uint8" | "q4" | "q4f16" | "bnb4";
  embeddingDimensions: number;
  /** Optional Turso database encryption. Disabled by default. */
  databaseEncryptionEnabled: boolean;
  /** 64-hex-character AES-256 key. Generated under storagePath when omitted. */
  databaseEncryptionKey?: string;
  databaseEncryptionCipher: EncryptionCipher;
  /** Cosine similarity at or above this value rejects an add as a duplicate. */
  dedupRejectThreshold: number;
  /** Cosine similarity at or above this value adds the entry with a hint. */
  dedupHintThreshold: number;
  /** Extra regular expressions rejected in title/content/related_files/source_ref. */
  blockedPatterns: string[];
  /** Provider id used by stage 2 extraction, e.g. "anthropic". */
  opencodeProvider?: string;
  /** Model id used by stage 2 extraction. "inherit" follows the host default. */
  opencodeModel?: string;
}

const DEFAULTS: CortexConfig = {
  storagePath: DEFAULT_STORAGE_PATH,
  embeddingModel: DEFAULT_EMBEDDING_MODEL,
  embeddingDtype: "q8",
  embeddingDimensions: DEFAULT_EMBEDDING_DIMENSIONS,
  databaseEncryptionEnabled: false,
  databaseEncryptionCipher: "aes256gcm",
  dedupRejectThreshold: 0.92,
  dedupHintThreshold: 0.85,
  blockedPatterns: [],
};

const DTYPES = new Set(["fp32", "fp16", "q8", "int8", "uint8", "q4", "q4f16", "bnb4"]);
const CIPHERS = new Set([
  "aes128gcm",
  "aes256gcm",
  "aegis256",
  "aegis256x2",
  "aegis128l",
  "aegis128x2",
  "aegis128x4",
]);

function readJsonc(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(stripJsoncComments(readFileSync(path, "utf-8")));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("顶层必须是 JSON 对象");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `无法读取配置 ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function stringField(raw: Record<string, unknown>, key: string, fallback: string): string {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`配置项 ${key} 必须是非空字符串`);
  }
  return value.trim();
}

function booleanField(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`配置项 ${key} 必须是布尔值`);
  return value;
}

function numberField(raw: Record<string, unknown>, key: string, fallback: number): number {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`配置项 ${key} 必须是数字`);
  }
  return value;
}

function thresholdField(raw: Record<string, unknown>, key: string, fallback: number): number {
  const value = numberField(raw, key, fallback);
  if (value < 0 || value > 1) throw new Error(`配置项 ${key} 必须在 0 到 1 之间`);
  return value;
}

/** Load global config, then apply the project config as overrides. */
export function loadConfig(directory: string): CortexConfig {
  const globalRaw = existsSync(GLOBAL_CONFIG_PATH) ? readJsonc(GLOBAL_CONFIG_PATH) : {};
  const projectPath = join(resolve(directory), ".opencode", "opencode-cortex.jsonc");
  const projectRaw = existsSync(projectPath) ? readJsonc(projectPath) : {};

  if (Object.prototype.hasOwnProperty.call(projectRaw, "databaseEncryptionKey")) {
    throw new Error(
      `项目配置 ${projectPath} 不能设置 databaseEncryptionKey，请放到全局配置 ${GLOBAL_CONFIG_PATH}`
    );
  }

  const raw = { ...globalRaw, ...projectRaw };
  const config: CortexConfig = {
    storagePath: expandHome(stringField(raw, "storagePath", DEFAULTS.storagePath)),
    embeddingModel: stringField(raw, "embeddingModel", DEFAULTS.embeddingModel),
    embeddingDtype: stringField(raw, "embeddingDtype", DEFAULTS.embeddingDtype) as CortexConfig["embeddingDtype"],
    embeddingDimensions: numberField(
      raw,
      "embeddingDimensions",
      DEFAULTS.embeddingDimensions
    ),
    databaseEncryptionEnabled: booleanField(
      raw,
      "databaseEncryptionEnabled",
      DEFAULTS.databaseEncryptionEnabled
    ),
    databaseEncryptionCipher: stringField(
      raw,
      "databaseEncryptionCipher",
      DEFAULTS.databaseEncryptionCipher
    ) as CortexConfig["databaseEncryptionCipher"],
    dedupRejectThreshold: thresholdField(raw, "dedupRejectThreshold", DEFAULTS.dedupRejectThreshold),
    dedupHintThreshold: thresholdField(raw, "dedupHintThreshold", DEFAULTS.dedupHintThreshold),
    blockedPatterns: Array.isArray(raw.blockedPatterns)
      ? raw.blockedPatterns.map((value, index) => {
          if (typeof value !== "string" || !value) {
            throw new Error(`配置项 blockedPatterns[${index}] 必须是非空字符串`);
          }
          return value;
        })
      : [],
    ...(typeof raw.opencodeProvider === "string" && raw.opencodeProvider.trim()
      ? { opencodeProvider: raw.opencodeProvider.trim() }
      : {}),
    ...(typeof raw.opencodeModel === "string" && raw.opencodeModel.trim()
      ? { opencodeModel: raw.opencodeModel.trim() }
      : {}),
    ...(typeof raw.databaseEncryptionKey === "string" && raw.databaseEncryptionKey.trim()
      ? { databaseEncryptionKey: raw.databaseEncryptionKey.trim() }
      : {}),
  };

  if (!DTYPES.has(config.embeddingDtype)) {
    throw new Error(
      `配置项 embeddingDtype 非法：${config.embeddingDtype}。可选 ${[...DTYPES].join(", ")}`
    );
  }
  if (!CIPHERS.has(config.databaseEncryptionCipher)) {
    throw new Error(`配置项 databaseEncryptionCipher 非法：${config.databaseEncryptionCipher}`);
  }
  if (!Number.isInteger(config.embeddingDimensions) || config.embeddingDimensions <= 0) {
    throw new Error("配置项 embeddingDimensions 必须是正整数");
  }
  if (config.dedupHintThreshold >= config.dedupRejectThreshold) {
    throw new Error("dedupHintThreshold 必须小于 dedupRejectThreshold");
  }
  return config;
}
