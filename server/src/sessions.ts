import type { SyncDb } from "./db.js";
import { now } from "./db.js";
import type { MergedSession, SessionChange, SessionSnapshot } from "@pi-cloud-sync/shared";

export interface SessionMergeResult {
  merged: MergedSession;
  accepted: number;
  conflicts: number;
}

/**
 * 合并会话增量：
 * - 会话按 uuid 识别；条目按 (uuid, entryId) 去重。
 * - 相同 entryId 内容不同：保留 received_at 较新者，记录冲突（kind=session-entry）。
 * - 软删除：deleted 标记，可由客户端 restore。
 */
export function mergeSession(
  dbs: SyncDb,
  change: SessionChange,
  device: { deviceId: string; name: string },
): SessionMergeResult {
  const db = dbs.db;
  const nowMs = now();
  const deviceName = device.name;

  let header = db
    .prepare("SELECT * FROM session_headers WHERE uuid = ?")
    .get(change.uuid) as SessionHeaderRow | undefined;

  // 快速前进判定：客户端 baseVersion == 服务器版本
  const fastForward = header !== undefined && change.baseVersion === header.version;

  let accepted = 0;
  let conflicts = 0;

  if (!header) {
    db.prepare(
      `INSERT INTO session_headers (uuid, cwd, name, header, created_at, version, deleted, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    ).run(
      change.uuid,
      change.cwd,
      change.name ?? null,
      change.headerJson ?? null,
      change.createdAt ?? nowMs,
      deviceName,
      nowMs,
    );
    header = db
      .prepare("SELECT * FROM session_headers WHERE uuid = ?")
      .get(change.uuid) as typeof header;
  } else if (change.headerJson && !header.header) {
    // 补全 header 信息
    db.prepare(`UPDATE session_headers SET header = ?, created_at = COALESCE(created_at, ?) WHERE uuid = ?`).run(
      change.headerJson,
      change.createdAt ?? nowMs,
      change.uuid,
    );
  }

  if (fastForward) {
    // 追加新条目
    const insert = db.prepare(
      `INSERT OR IGNORE INTO session_entries (session_uuid, entry_id, line, source_device, received_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const e of change.entries) {
      const res = insert.run(change.uuid, e.id, e.lineJson, deviceName, nowMs);
      if (res.changes > 0) accepted++;
    }
  } else if (header) {
    // 并发：按 entryId 去重 + 内容比较
    const select = db.prepare(
      `SELECT line, source_device, received_at FROM session_entries WHERE session_uuid = ? AND entry_id = ?`,
    );
    const insert = db.prepare(
      `INSERT OR IGNORE INTO session_entries (session_uuid, entry_id, line, source_device, received_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const update = db.prepare(
      `UPDATE session_entries SET line = ?, source_device = ?, received_at = ? WHERE session_uuid = ? AND entry_id = ?`,
    );
    for (const e of change.entries) {
      const existing = select.get(change.uuid, e.id) as
        | { line: string; source_device: string; received_at: number }
        | undefined;
      if (!existing) {
        const res = insert.run(change.uuid, e.id, e.lineJson, deviceName, nowMs);
        if (res.changes > 0) accepted++;
      } else if (existing.line !== e.lineJson) {
        // 相同 entryId 内容不同 → 时间新者胜
        const existingTs = parseEntryTimestamp(existing.line, existing.received_at);
        const newTs = parseEntryTimestamp(e.lineJson, nowMs);
        if (newTs >= existingTs) {
          update.run(e.lineJson, deviceName, nowMs, change.uuid, e.id);
          accepted++;
        } else {
          conflicts++;
          recordEntryConflict(dbs, change.uuid, e.id, deviceName, existing.source_device, e.lineJson, existing.line);
        }
      } else {
        // 内容一致，忽略
      }
    }
  }

  // 删除标记
  let deleted = header?.deleted ?? 0;
  if (change.deleted) {
    deleted = 1;
    db.prepare(`UPDATE session_headers SET deleted = 1, updated_by = ?, updated_at = ? WHERE uuid = ?`).run(
      deviceName,
      nowMs,
      change.uuid,
    );
  }

  const version = (header?.version ?? 0) + (accepted > 0 || change.deleted ? 1 : 0);
  db.prepare(
    `UPDATE session_headers SET cwd = ?, name = COALESCE(?, name), version = ?, updated_by = ?, updated_at = ?
     WHERE uuid = ?`,
  ).run(change.cwd, change.name ?? null, version, deviceName, nowMs, change.uuid);

  const entryIds = (
    db
      .prepare(`SELECT entry_id FROM session_entries WHERE session_uuid = ?`)
      .all(change.uuid) as Array<{ entry_id: string }>
  ).map((r) => r.entry_id);

  const merged: MergedSession = {
    uuid: change.uuid,
    cwd: change.cwd,
    name: change.name ?? header?.name ?? null,
    version,
    deleted: deleted === 1,
    updatedBy: deviceName,
    updatedAt: nowMs,
    entryIds,
    acceptedEntries: accepted,
    conflicts,
  };
  return { merged, accepted, conflicts };
}

/** 解析 JSONL 条目中的 timestamp（ISO），失败时用 received_at 兜底 */
function parseEntryTimestamp(lineJson: string, fallback: number): number {
  try {
    const obj = JSON.parse(lineJson) as { timestamp?: string | number };
    if (typeof obj.timestamp === "number") return obj.timestamp;
    if (typeof obj.timestamp === "string") {
      const t = Date.parse(obj.timestamp);
      if (!Number.isNaN(t)) return t;
    }
  } catch {
    // ignore
  }
  return fallback;
}

function recordEntryConflict(
  dbs: SyncDb,
  sessionUuid: string,
  entryId: string,
  deviceA: string,
  deviceB: string,
  contentA: string,
  contentB: string,
) {
  dbs.db
    .prepare(
      `INSERT INTO conflicts (object_key, path, kind, device_a, device_b, content_a, content_b, created_at)
       VALUES (?, ?, 'session-entry', ?, ?, ?, ?, ?)`,
    )
    .run(`session/${sessionUuid}`, entryId, deviceA, deviceB, contentA, contentB, now());
}

/** 拉取会话快照：返回自 since 之后更新的会话（含全部条目） */
export function pullSessions(dbs: SyncDb, since: number | null): SessionSnapshot[] {
  const db = dbs.db;
  const rows = since
    ? (db
        .prepare(`SELECT * FROM session_headers WHERE updated_at > ? ORDER BY updated_at`)
        .all(since) as SessionHeaderRow[])
    : (db.prepare(`SELECT * FROM session_headers ORDER BY updated_at`).all() as SessionHeaderRow[]);

  const stmt = db.prepare(
    `SELECT line FROM session_entries WHERE session_uuid = ? ORDER BY received_at`,
  );
  return rows.map((h) => ({
    uuid: h.uuid,
    cwd: h.cwd,
    name: h.name,
    headerJson: h.header ?? null,
    createdAt: h.created_at ?? null,
    version: h.version,
    deleted: h.deleted === 1,
    updatedBy: h.updated_by,
    updatedAt: h.updated_at,
    lines: (stmt.all(h.uuid) as Array<{ line: string }>).map((r) => r.line),
  }));
}

interface SessionHeaderRow {
  uuid: string;
  cwd: string;
  name: string | null;
  header: string | null;
  created_at: number | null;
  version: number;
  deleted: number;
  updated_by: string;
  updated_at: number;
}

/** 恢复已删除会话（清除 tombstone） */
export function restoreSession(dbs: SyncDb, uuid: string, deviceName: string): boolean {
  const res = dbs.db
    .prepare(`UPDATE session_headers SET deleted = 0, updated_by = ?, updated_at = ? WHERE uuid = ?`)
    .run(deviceName, now(), uuid);
  return res.changes > 0;
}
