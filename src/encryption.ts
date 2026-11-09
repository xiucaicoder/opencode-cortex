import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { EncryptionOpts } from "@tursodatabase/database-common";
import type { CortexConfig } from "./config.js";

const HEX_KEY = /^[0-9a-fA-F]{64}$/;

function hasExistingDatabase(storagePath: string): boolean {
  try {
    return readdirSync(join(storagePath, "projects")).some((name) => name.endsWith(".db"));
  } catch {
    return false;
  }
}

function ensureKeyFile(storagePath: string): string {
  const keyPath = join(storagePath, "db.key");
  if (existsSync(keyPath)) {
    const value = readFileSync(keyPath, "utf-8").trim();
    if (!HEX_KEY.test(value)) {
      throw new Error(`加密密钥文件 ${keyPath} 无效：需要 64 个十六进制字符`);
    }
    return value;
  }

  if (hasExistingDatabase(storagePath)) {
    throw new Error(
      `已存在项目数据库但找不到加密密钥 ${keyPath}。请恢复原密钥，或在确认数据可弃用后删除旧数据库。`
    );
  }

  mkdirSync(storagePath, { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString("hex");
  writeFileSync(keyPath, `${key}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // best-effort on filesystems without POSIX modes
  }
  return key;
}

/** Resolve Turso encryption options, generating a key only for a new store. */
export function resolveEncryption(config: CortexConfig): EncryptionOpts | null {
  if (!config.databaseEncryptionEnabled) return null;

  const configured = config.databaseEncryptionKey?.trim();
  if (configured) {
    if (!HEX_KEY.test(configured)) {
      throw new Error("配置项 databaseEncryptionKey 必须是 64 个十六进制字符（AES-256）");
    }
    return { cipher: config.databaseEncryptionCipher, hexkey: configured };
  }

  if (!config.databaseEncryptionCipher.startsWith("aes256")) {
    throw new Error("未显式提供 databaseEncryptionKey 时，只支持 aes256 系列 cipher");
  }
  return { cipher: config.databaseEncryptionCipher, hexkey: ensureKeyFile(config.storagePath) };
}
