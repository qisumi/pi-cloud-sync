import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseUsageHit } from "./usage.js";
import { usageCostUsd, deepseekCostUsd, DEEPSEEK_PEAK_PRICING_SINCE_MS } from "./pricing.js";

/** SQLite 数据库封装：schema 初始化 + 通用访问 */
export class SyncDb {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("temp_store = MEMORY");
    this.db.pragma("cache_size = -32768");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        device_id  TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        platform   TEXT NOT NULL DEFAULT '',
        pi_version TEXT NOT NULL DEFAULT '',
        ext_version TEXT NOT NULL DEFAULT '',
        last_seen  INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        status     TEXT NOT NULL DEFAULT 'active',
        merged_into TEXT,
        merged_at  INTEGER,
        is_legacy  INTEGER NOT NULL DEFAULT 0,
        name_locked INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS objects (
        key        TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        version    INTEGER NOT NULL DEFAULT 0,
        sha256     TEXT NOT NULL DEFAULT '',
        data       TEXT NOT NULL DEFAULT '',   -- JSON 合并结果或原文件内容（base64）
        updated_by TEXT NOT NULL DEFAULT '',
        updated_by_device_id TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL DEFAULT 0,
        deleted    INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS config_field_versions (
        object_key TEXT NOT NULL,
        path       TEXT NOT NULL,
        version    INTEGER NOT NULL DEFAULT 0,
        value      TEXT NOT NULL DEFAULT '',
        updated_by TEXT NOT NULL DEFAULT '',
        updated_by_device_id TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (object_key, path)
      );

      CREATE TABLE IF NOT EXISTS session_headers (
        uuid        TEXT PRIMARY KEY,
        cwd         TEXT NOT NULL DEFAULT '',
        name        TEXT,
        header      TEXT,
        created_at  INTEGER,
        version     INTEGER NOT NULL DEFAULT 0,
        deleted     INTEGER NOT NULL DEFAULT 0,
        content_pruned INTEGER NOT NULL DEFAULT 0,
        updated_by  TEXT NOT NULL DEFAULT '',
        updated_by_device_id TEXT NOT NULL DEFAULT '',
        updated_at  INTEGER NOT NULL DEFAULT 0,
        entry_count INTEGER NOT NULL DEFAULT 0,
        readable_count INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        total_cost REAL NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS session_entries (
        session_uuid TEXT NOT NULL,
        entry_id     TEXT NOT NULL,
        line         TEXT NOT NULL,
        source_device TEXT NOT NULL DEFAULT '',
        source_device_id TEXT NOT NULL DEFAULT '',
        received_at  INTEGER NOT NULL,
        role          TEXT NOT NULL DEFAULT '',
        readable      INTEGER NOT NULL DEFAULT 0,
        occurred_at   INTEGER NOT NULL DEFAULT 0,
        sort_seq      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_uuid, entry_id)
      );
      CREATE INDEX IF NOT EXISTS idx_entries_uuid ON session_entries(session_uuid);

      CREATE TABLE IF NOT EXISTS session_usage (
        session_uuid  TEXT NOT NULL,
        entry_id      TEXT NOT NULL,
        occurred_at   INTEGER NOT NULL,
        provider      TEXT NOT NULL DEFAULT '',
        model         TEXT NOT NULL DEFAULT '',
        source_device TEXT NOT NULL DEFAULT '',
        source_device_id TEXT NOT NULL DEFAULT '',
        requests      INTEGER NOT NULL DEFAULT 1,
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read    INTEGER NOT NULL DEFAULT 0,
        cache_write   INTEGER NOT NULL DEFAULT 0,
        total_tokens  INTEGER NOT NULL DEFAULT 0,
        cost          REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (session_uuid, entry_id)
      );
      CREATE INDEX IF NOT EXISTS idx_session_usage_occurred_at ON session_usage(occurred_at);
      CREATE INDEX IF NOT EXISTS idx_session_usage_model_time ON session_usage(model, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_session_headers_deleted_updated ON session_headers(deleted, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_session_headers_updated ON session_headers(updated_at);

      CREATE TABLE IF NOT EXISTS session_change_index (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_uuid TEXT NOT NULL,
        entry_id     TEXT NOT NULL DEFAULT '',
        kind         TEXT NOT NULL,
        op           TEXT NOT NULL,
        UNIQUE(session_uuid, entry_id, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_session_change_seq ON session_change_index(seq);

      CREATE TABLE IF NOT EXISTS conflicts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        object_key  TEXT NOT NULL DEFAULT '',
        path        TEXT NOT NULL DEFAULT 'file',
        kind        TEXT NOT NULL DEFAULT 'config',
        device_a    TEXT NOT NULL DEFAULT '',
        device_b    TEXT NOT NULL DEFAULT '',
        device_a_id TEXT NOT NULL DEFAULT '',
        device_b_id TEXT NOT NULL DEFAULT '',
        content_a   TEXT NOT NULL DEFAULT '',
        content_b   TEXT NOT NULL DEFAULT '',
        resolution  TEXT,
        resolved_at INTEGER,
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tokens (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        token      TEXT NOT NULL UNIQUE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS device_merge_history (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        source_device_id TEXT NOT NULL,
        source_name      TEXT NOT NULL,
        target_device_id TEXT NOT NULL,
        target_name      TEXT NOT NULL,
        affected_json    TEXT NOT NULL,
        merged_at        INTEGER NOT NULL
      );
    `);

    // 轻量迁移：旧库补列
    const tokenCols = this.db
      .prepare(`PRAGMA table_info(tokens)`)
      .all() as Array<{ name: string }>;
    if (!tokenCols.some((c) => c.name === "token_hash")) {
      this.db.exec(`ALTER TABLE tokens ADD COLUMN token_hash TEXT`);
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_hash ON tokens(token_hash)`);
      // 旧行没有哈希：用 token 列回填
      this.db.exec(`UPDATE tokens SET token_hash = token WHERE token_hash IS NULL`);
    }
    const objCols = this.db.prepare(`PRAGMA table_info(objects)`).all() as Array<{ name: string }>;
    if (!objCols.some((c) => c.name === "deleted")) {
      this.db.exec(`ALTER TABLE objects ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`);
    }
    const shCols = this.db.prepare(`PRAGMA table_info(session_headers)`).all() as Array<{ name: string }>;
    if (!shCols.some((c) => c.name === "header")) {
      this.db.exec(`ALTER TABLE session_headers ADD COLUMN header TEXT`);
    }
    if (!shCols.some((c) => c.name === "created_at")) {
      this.db.exec(`ALTER TABLE session_headers ADD COLUMN created_at INTEGER`);
    }
    if (!shCols.some((c) => c.name === "content_pruned")) {
      this.db.exec(`ALTER TABLE session_headers ADD COLUMN content_pruned INTEGER NOT NULL DEFAULT 0`);
    }
    this.ensureColumns();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_entries_readable ON session_entries(session_uuid, readable, sort_seq);
      CREATE INDEX IF NOT EXISTS idx_session_usage_device_time ON session_usage(source_device_id, occurred_at);
    `);
    this.backfillV2();
    this.backfillEstimatedCosts();
    this.db.pragma("optimize");
  }

  private ensureColumns() {
    const ensure = (table: string, column: string, definition: string) => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    };
    ensure("devices", "status", "TEXT NOT NULL DEFAULT 'active'");
    ensure("devices", "merged_into", "TEXT");
    ensure("devices", "merged_at", "INTEGER");
    ensure("devices", "is_legacy", "INTEGER NOT NULL DEFAULT 0");
    ensure("devices", "name_locked", "INTEGER NOT NULL DEFAULT 0");
    ensure("objects", "updated_by_device_id", "TEXT NOT NULL DEFAULT ''");
    ensure("config_field_versions", "updated_by_device_id", "TEXT NOT NULL DEFAULT ''");
    ensure("session_headers", "updated_by_device_id", "TEXT NOT NULL DEFAULT ''");
    ensure("session_headers", "entry_count", "INTEGER NOT NULL DEFAULT 0");
    ensure("session_headers", "readable_count", "INTEGER NOT NULL DEFAULT 0");
    ensure("session_headers", "total_tokens", "INTEGER NOT NULL DEFAULT 0");
    ensure("session_headers", "total_cost", "REAL NOT NULL DEFAULT 0");
    ensure("session_entries", "source_device_id", "TEXT NOT NULL DEFAULT ''");
    ensure("session_entries", "role", "TEXT NOT NULL DEFAULT ''");
    ensure("session_entries", "readable", "INTEGER NOT NULL DEFAULT 0");
    ensure("session_entries", "occurred_at", "INTEGER NOT NULL DEFAULT 0");
    ensure("session_entries", "sort_seq", "INTEGER NOT NULL DEFAULT 0");
    ensure("session_usage", "source_device_id", "TEXT NOT NULL DEFAULT ''");
    ensure("conflicts", "device_a_id", "TEXT NOT NULL DEFAULT ''");
    ensure("conflicts", "device_b_id", "TEXT NOT NULL DEFAULT ''");
  }

  private backfillV2() {
    const done = this.db.prepare(`SELECT value FROM meta WHERE key = 'schema_v2_backfilled'`).get() as
      | { value: string }
      | undefined;
    if (done?.value === "1") return;

    const tx = this.db.transaction(() => {
      const names = this.db
        .prepare(
          `SELECT name FROM devices
           UNION SELECT updated_by FROM objects WHERE updated_by <> ''
           UNION SELECT updated_by FROM config_field_versions WHERE updated_by <> ''
           UNION SELECT updated_by FROM session_headers WHERE updated_by <> ''
           UNION SELECT source_device FROM session_entries WHERE source_device <> ''
           UNION SELECT source_device FROM session_usage WHERE source_device <> ''
           UNION SELECT device_a FROM conflicts WHERE device_a <> ''
           UNION SELECT device_b FROM conflicts WHERE device_b <> ''`,
        )
        .all() as Array<{ name: string }>;
      const insertLegacy = this.db.prepare(
        `INSERT OR IGNORE INTO devices
           (device_id, name, platform, pi_version, ext_version, last_seen, created_at, status, is_legacy)
         VALUES (?, ?, '', '', '', 0, ?, 'legacy', 1)`,
      );
      for (const { name } of names) {
        const matches = this.db.prepare(`SELECT device_id FROM devices WHERE name = ? AND is_legacy = 0`).all(name) as Array<{
          device_id: string;
        }>;
        const id =
          matches.length === 1
            ? matches[0].device_id
            : `legacy-${createHash("sha256").update(name).digest("hex").slice(0, 20)}`;
        if (matches.length !== 1) insertLegacy.run(id, name, Date.now());
        this.db.prepare(`UPDATE objects SET updated_by_device_id = ? WHERE updated_by = ? AND updated_by_device_id = ''`).run(id, name);
        this.db.prepare(`UPDATE config_field_versions SET updated_by_device_id = ? WHERE updated_by = ? AND updated_by_device_id = ''`).run(id, name);
        this.db.prepare(`UPDATE session_headers SET updated_by_device_id = ? WHERE updated_by = ? AND updated_by_device_id = ''`).run(id, name);
        this.db.prepare(`UPDATE session_entries SET source_device_id = ? WHERE source_device = ? AND source_device_id = ''`).run(id, name);
        this.db.prepare(`UPDATE session_usage SET source_device_id = ? WHERE source_device = ? AND source_device_id = ''`).run(id, name);
        this.db.prepare(`UPDATE conflicts SET device_a_id = ? WHERE device_a = ? AND device_a_id = ''`).run(id, name);
        this.db.prepare(`UPDATE conflicts SET device_b_id = ? WHERE device_b = ? AND device_b_id = ''`).run(id, name);
      }

      const entries = this.db
        .prepare(`SELECT rowid, session_uuid, entry_id, line, source_device, source_device_id, received_at FROM session_entries`)
        .all() as Array<{
        rowid: number;
        session_uuid: string;
        entry_id: string;
        line: string;
        source_device: string;
        source_device_id: string;
        received_at: number;
      }>;
      const updateEntry = this.db.prepare(
        `UPDATE session_entries SET role = ?, readable = ?, occurred_at = ?, sort_seq = ?
         WHERE session_uuid = ? AND entry_id = ?`,
      );
      const insertUsage = this.db.prepare(
        `INSERT OR REPLACE INTO session_usage
           (session_uuid, entry_id, occurred_at, provider, model, source_device, source_device_id, requests,
            input_tokens, output_tokens, cache_read, cache_write, total_tokens, cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const entry of entries) {
        const meta = entryMeta(entry.line, entry.received_at);
        updateEntry.run(meta.role, meta.readable ? 1 : 0, meta.ts, entry.rowid, entry.session_uuid, entry.entry_id);
        const hit = parseUsageHit(entry.line, entry.source_device, entry.session_uuid);
        if (hit) {
          insertUsage.run(
            entry.session_uuid,
            entry.entry_id,
            hit.ts,
            hit.provider,
            hit.model,
            hit.device,
            entry.source_device_id,
            hit.requests,
            hit.input,
            hit.output,
            hit.cacheRead,
            hit.cacheWrite,
            hit.total,
            hit.cost,
          );
        }
      }
      this.db.exec(
        `UPDATE session_headers SET
           entry_count = (SELECT COUNT(*) FROM session_entries e WHERE e.session_uuid = session_headers.uuid),
           readable_count = (SELECT COUNT(*) FROM session_entries e WHERE e.session_uuid = session_headers.uuid AND e.readable = 1),
           total_tokens = (SELECT COALESCE(SUM(total_tokens), 0) FROM session_usage u WHERE u.session_uuid = session_headers.uuid),
           total_cost = (SELECT COALESCE(SUM(cost), 0) FROM session_usage u WHERE u.session_uuid = session_headers.uuid)`,
      );
      const changeCount = (this.db.prepare(`SELECT COUNT(*) AS c FROM session_change_index`).get() as { c: number }).c;
      if (changeCount === 0) {
        const touch = this.db.prepare(
          `INSERT OR REPLACE INTO session_change_index(session_uuid, entry_id, kind, op) VALUES (?, ?, ?, ?)`,
        );
        const headers = this.db.prepare(`SELECT uuid, deleted FROM session_headers`).all() as Array<{ uuid: string; deleted: number }>;
        for (const header of headers) touch.run(header.uuid, "", "header", header.deleted ? "tombstone" : "upsert");
        for (const entry of entries) touch.run(entry.session_uuid, entry.entry_id, "entry", "insert");
      }
      this.db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_v2_backfilled', '1')`).run();
    });
    tx();
  }

  /** 为历史零费用记录（GLM-5.x / MiMo / GPT-5.6 / GPT-6）补上按量估算；
   *  并为 DeepSeek V4 峰谷计价（2026-08-17 起）重算 pi 静态平价留下的过期费用。 */
  private backfillEstimatedCosts() {
    const rows = this.db
      .prepare(
        `SELECT rowid, session_uuid, provider, model, occurred_at, cost, input_tokens, output_tokens, cache_read, cache_write
         FROM session_usage
         WHERE (cost = 0 AND (lower(model) LIKE '%glm%' OR lower(model) LIKE '%mimo%' OR lower(model) LIKE '%gpt-5.6%' OR lower(model) LIKE '%gpt-6%'))
            OR (occurred_at >= ? AND (lower(model) LIKE '%deepseek%' OR lower(provider) LIKE '%deepseek%'))`,
      )
      .all(DEEPSEEK_PEAK_PRICING_SINCE_MS) as Array<{
      rowid: number;
      session_uuid: string;
      provider: string;
      model: string;
      occurred_at: number;
      cost: number;
      input_tokens: number;
      output_tokens: number;
      cache_read: number;
      cache_write: number;
    }>;
    if (rows.length === 0) return;
    const update = this.db.prepare(`UPDATE session_usage SET cost = ? WHERE rowid = ?`);
    const touched = new Set<string>();
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const usage = {
          provider: row.provider,
          model: row.model,
          input: row.input_tokens,
          output: row.output_tokens,
          cacheRead: row.cache_read,
          cacheWrite: row.cache_write,
        };
        // DeepSeek V4 峰谷价优先（覆盖过期非零平价）；其余仅补零费用
        const cost = deepseekCostUsd(usage, row.occurred_at) ?? usageCostUsd(usage, 0, row.occurred_at);
        if (cost <= 0 || Math.abs(cost - row.cost) < 1e-12) continue;
        update.run(cost, row.rowid);
        touched.add(row.session_uuid);
      }
      const refresh = this.db.prepare(
        `UPDATE session_headers SET total_cost =
           (SELECT COALESCE(SUM(cost), 0) FROM session_usage WHERE session_uuid = ?)
         WHERE uuid = ?`,
      );
      for (const uuid of touched) refresh.run(uuid, uuid);
    });
    tx();
  }

  close() {
    this.db.close();
  }
}

function entryMeta(line: string, fallback: number): { role: string; readable: boolean; ts: number } {
  try {
    const obj = JSON.parse(line) as {
      type?: string;
      timestamp?: string | number;
      message?: { role?: string; content?: unknown };
    };
    const rawTs = obj.timestamp;
    const ts = typeof rawTs === "number" ? rawTs : typeof rawTs === "string" ? Date.parse(rawTs) : fallback;
    const role = obj.type === "message" ? String(obj.message?.role ?? "") : "";
    const content = obj.message?.content;
    const hasReadableContent = typeof content === "string"
      ? content.trim().length > 0
      : Array.isArray(content)
        ? content.some((block) => {
            if (!block || typeof block !== "object") return false;
            const item = block as { type?: string; text?: string };
            return item.type === "image" || (item.type === "text" && String(item.text ?? "").trim().length > 0);
          })
        : false;
    return {
      role,
      readable: (role === "user" || role === "assistant") && hasReadableContent,
      ts: Number.isFinite(ts) ? ts : fallback,
    };
  } catch {
    return { role: "", readable: false, ts: fallback };
  }
}

export function newDeviceId(): string {
  return randomUUID();
}

export function now(): number {
  return Date.now();
}

export function sessionDir(dataDir: string): string {
  return join(dataDir, "sync.db");
}
