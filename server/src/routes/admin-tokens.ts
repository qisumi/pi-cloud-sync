import type { SyncDb } from "../db.js";
import type { TokenRecord } from "../auth.js";

export function listTokens(dbs: SyncDb): TokenRecord[] {
  return dbs.db
    .prepare(`SELECT id, name, token_hash, created_at FROM tokens`)
    .all() as unknown as TokenRecord[];
}
