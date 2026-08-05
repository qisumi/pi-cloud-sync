import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateToken } from "./auth.js";

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  /** 访问令牌（静态，可多个，逗号分隔）；为空则首次启动生成并保存 */
  tokens: string[];
  /** 管理令牌（可选） */
  adminToken: string | null;
  /** 允许的最大单次条目数（防滥用） */
  maxBatchEntries: number;
  /** 允许的最大单对象字节数 */
  maxObjectBytes: number;
  publicUrl: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = resolve(env.SYNC_DATA_DIR ?? join(process.cwd(), "data"));
  mkdirSync(dataDir, { recursive: true });

  const tokenFile = join(dataDir, "token.txt");
  let tokens: string[] = [];
  const envTokens = (env.SYNC_TOKEN ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  tokens.push(...envTokens);

  if (tokens.length === 0) {
    if (existsSync(tokenFile)) {
      const saved = readFileSync(tokenFile, "utf8").trim();
      if (saved) tokens.push(saved);
    } else {
      const fresh = generateToken();
      writeFileSync(tokenFile, fresh, { mode: 0o600 });
      tokens.push(fresh);
      console.log(`[pi-cloud-sync] Generated access token, saved to ${tokenFile}`);
    }
  }

  const adminToken = env.SYNC_ADMIN_TOKEN?.trim() || null;

  return {
    host: env.SYNC_HOST ?? "0.0.0.0",
    port: parseInt(env.SYNC_PORT ?? "8787", 10),
    dataDir,
    dbPath: join(dataDir, "sync.db"),
    tokens,
    adminToken,
    maxBatchEntries: parseInt(env.SYNC_MAX_BATCH ?? "5000", 10),
    maxObjectBytes: parseInt(env.SYNC_MAX_OBJECT_BYTES ?? String(10 * 1024 * 1024), 10),
    publicUrl: env.SYNC_PUBLIC_URL?.trim() || null,
  };
}
