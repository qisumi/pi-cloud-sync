import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** SQLite 数据库封装：schema 初始化 + 通用访问 */
export class SyncDb {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
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
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS objects (
        key        TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        version    INTEGER NOT NULL DEFAULT 0,
        sha256     TEXT NOT NULL DEFAULT '',
        data       TEXT NOT NULL DEFAULT '',   -- JSON 合并结果或原文件内容（base64）
        updated_by TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL DEFAULT 0,
        deleted    INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS config_field_versions (
        object_key TEXT NOT NULL,
        path       TEXT NOT NULL,
        version    INTEGER NOT NULL DEFAULT 0,
        value      TEXT NOT NULL DEFAULT '',
        updated_by TEXT NOT NULL DEFAULT '',
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
        updated_by  TEXT NOT NULL DEFAULT '',
        updated_at  INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS session_entries (
        session_uuid TEXT NOT NULL,
        entry_id     TEXT NOT NULL,
        line         TEXT NOT NULL,
        source_device TEXT NOT NULL DEFAULT '',
        received_at  INTEGER NOT NULL,
        PRIMARY KEY (session_uuid, entry_id)
      );
      CREATE INDEX IF NOT EXISTS idx_entries_uuid ON session_entries(session_uuid);

      CREATE TABLE IF NOT EXISTS conflicts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        object_key  TEXT NOT NULL DEFAULT '',
        path        TEXT NOT NULL DEFAULT 'file',
        kind        TEXT NOT NULL DEFAULT 'config',
        device_a    TEXT NOT NULL DEFAULT '',
        device_b    TEXT NOT NULL DEFAULT '',
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
  }

  close() {
    this.db.close();
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
