import type { SyncDb } from "./db.js";
import { now } from "./db.js";
import type {
  MergedSession,
  SessionChange,
  SessionDelta,
  SessionPullResponseV2,
  SessionSnapshot,
  UsageEventChange,
} from "@pi-cloud-sync/shared";
import { parseUsageHit } from "./usage.js";
import { usageCostUsd } from "./pricing.js";

export interface SessionMergeResult {
  merged: MergedSession;
  accepted: number;
  conflicts: number;
}

function entryMetadata(line: string, fallback: number): { role: string; readable: boolean; occurredAt: number; parentId: string | null } {
  try {
    const value = JSON.parse(line) as {
      parentId?: string | null;
      timestamp?: string | number;
      type?: string;
      message?: { role?: string; content?: unknown };
    };
    const parsed =
      typeof value.timestamp === "number"
        ? value.timestamp
        : typeof value.timestamp === "string"
          ? Date.parse(value.timestamp)
          : fallback;
    const role = value.type === "message" ? String(value.message?.role ?? "") : "";
    const content = value.message?.content;
    const readableContent =
      typeof content === "string"
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
      readable: (role === "user" || role === "assistant") && readableContent,
      occurredAt: Number.isFinite(parsed) ? parsed : fallback,
      parentId: value.parentId ?? null,
    };
  } catch {
    return { role: "", readable: false, occurredAt: fallback, parentId: null };
  }
}

function touchChange(dbs: SyncDb, uuid: string, entryId: string, kind: "header" | "entry", op: string): number {
  const result = dbs.db
    .prepare(`INSERT OR REPLACE INTO session_change_index(session_uuid, entry_id, kind, op) VALUES (?, ?, ?, ?)`)
    .run(uuid, entryId, kind, op);
  return Number(result.lastInsertRowid);
}

function upsertUsageFromLine(
  dbs: SyncDb,
  uuid: string,
  entryId: string,
  line: string,
  deviceName: string,
  deviceId: string,
): void {
  dbs.db.prepare(`DELETE FROM session_usage WHERE session_uuid = ? AND entry_id = ?`).run(uuid, entryId);
  const hit = parseUsageHit(line, deviceName, uuid);
  if (!hit) return;
  dbs.db
    .prepare(
      `INSERT INTO session_usage
         (session_uuid, entry_id, occurred_at, provider, model, source_device, source_device_id, requests,
          input_tokens, output_tokens, cache_read, cache_write, total_tokens, cost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      uuid,
      entryId,
      hit.ts,
      hit.provider,
      hit.model,
      deviceName,
      deviceId,
      hit.requests,
      hit.input,
      hit.output,
      hit.cacheRead,
      hit.cacheWrite,
      hit.total,
      hit.cost,
    );
}

function refreshHeaderSummary(dbs: SyncDb, uuid: string): void {
  dbs.db
    .prepare(
      `UPDATE session_headers SET
         entry_count = (SELECT COUNT(*) FROM session_entries WHERE session_uuid = ?),
         readable_count = (SELECT COUNT(*) FROM session_entries WHERE session_uuid = ? AND readable = 1),
         total_tokens = (SELECT COALESCE(SUM(total_tokens), 0) FROM session_usage WHERE session_uuid = ?),
         total_cost = (SELECT COALESCE(SUM(cost), 0) FROM session_usage WHERE session_uuid = ?)
       WHERE uuid = ?`,
    )
    .run(uuid, uuid, uuid, uuid, uuid);
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
  const existedBefore = header !== undefined;

  // 服务器 tombstone 优先：网页端裁剪后，尚未拉取 tombstone 的客户端不能把正文重新上传回来。
  if (header?.deleted === 1) {
    return {
      merged: {
        uuid: change.uuid,
        cwd: header.cwd,
        name: header.name,
        version: header.version,
        deleted: true,
        updatedBy: header.updated_by,
        updatedAt: header.updated_at,
        acceptedEntries: 0,
        conflicts: 0,
      },
      accepted: 0,
      conflicts: 0,
    };
  }

  // 快速前进判定：客户端 baseVersion == 服务器版本
  const fastForward = header !== undefined && change.baseVersion === header.version;

  let accepted = 0;
  let conflicts = 0;
  let headerChanged = false;

  if (!header) {
    db.prepare(
      `INSERT INTO session_headers
         (uuid, cwd, name, header, created_at, version, deleted, updated_by, updated_by_device_id, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
    ).run(
      change.uuid,
      change.cwd,
      change.name ?? null,
      change.headerJson ?? null,
      change.createdAt ?? nowMs,
      deviceName,
      device.deviceId,
      nowMs,
    );
    header = db
      .prepare("SELECT * FROM session_headers WHERE uuid = ?")
      .get(change.uuid) as typeof header;
    headerChanged = true;
  } else if (change.headerJson && !header.header) {
    // 补全 header 信息
    db.prepare(`UPDATE session_headers SET header = ?, created_at = COALESCE(created_at, ?) WHERE uuid = ?`).run(
      change.headerJson,
      change.createdAt ?? nowMs,
      change.uuid,
    );
    headerChanged = true;
  }

  const select = db.prepare(
    `SELECT line, source_device, source_device_id, received_at FROM session_entries
     WHERE session_uuid = ? AND entry_id = ?`,
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO session_entries
       (session_uuid, entry_id, line, source_device, source_device_id, received_at, role, readable, occurred_at, sort_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  );
  const update = db.prepare(
    `UPDATE session_entries SET line = ?, source_device = ?, source_device_id = ?, received_at = ?,
       role = ?, readable = ?, occurred_at = ? WHERE session_uuid = ? AND entry_id = ?`,
  );
  for (const e of change.entries) {
    const existing = select.get(change.uuid, e.id) as
      | { line: string; source_device: string; source_device_id: string; received_at: number }
      | undefined;
    const meta = entryMetadata(e.lineJson, nowMs);
    if (!existing) {
      const result = insert.run(
        change.uuid,
        e.id,
        e.lineJson,
        deviceName,
        device.deviceId,
        nowMs,
        meta.role,
        meta.readable ? 1 : 0,
        meta.occurredAt,
      );
      if (result.changes > 0) {
        const seq = touchChange(dbs, change.uuid, e.id, "entry", "insert");
        db.prepare(`UPDATE session_entries SET sort_seq = ? WHERE session_uuid = ? AND entry_id = ?`).run(
          seq,
          change.uuid,
          e.id,
        );
        upsertUsageFromLine(dbs, change.uuid, e.id, e.lineJson, deviceName, device.deviceId);
        accepted++;
      }
    } else if (existing.line !== e.lineJson && !fastForward) {
      const existingTs = parseEntryTimestamp(existing.line, existing.received_at);
      const newTs = parseEntryTimestamp(e.lineJson, nowMs);
      if (newTs >= existingTs) {
        update.run(
          e.lineJson,
          deviceName,
          device.deviceId,
          nowMs,
          meta.role,
          meta.readable ? 1 : 0,
          meta.occurredAt,
          change.uuid,
          e.id,
        );
        touchChange(dbs, change.uuid, e.id, "entry", "update");
        upsertUsageFromLine(dbs, change.uuid, e.id, e.lineJson, deviceName, device.deviceId);
        accepted++;
      } else {
        conflicts++;
        recordEntryConflict(
          dbs,
          change.uuid,
          e.id,
          deviceName,
          existing.source_device,
          device.deviceId,
          existing.source_device_id,
          e.lineJson,
          existing.line,
        );
      }
    }
  }

  // 删除标记
  let deleted = header?.deleted ?? 0;
  if (change.deleted) {
    deleted = 1;
    db.prepare(
      `UPDATE session_headers SET deleted = 1, updated_by = ?, updated_by_device_id = ?, updated_at = ? WHERE uuid = ?`,
    ).run(
      deviceName,
      device.deviceId,
      nowMs,
      change.uuid,
    );
    headerChanged = true;
  }

  const metadataChanged = Boolean(
    header &&
      (header.cwd !== change.cwd || (change.name !== undefined && change.name !== header.name)),
  );
  const mutated = accepted > 0 || change.deleted === true || metadataChanged || headerChanged;
  const version = existedBefore ? (header?.version ?? 0) + (mutated ? 1 : 0) : 1;
  if (mutated) {
    db.prepare(
      `UPDATE session_headers SET cwd = ?, name = COALESCE(?, name), version = ?, updated_by = ?,
         updated_by_device_id = ?, updated_at = ? WHERE uuid = ?`,
    ).run(change.cwd, change.name ?? null, version, deviceName, device.deviceId, nowMs, change.uuid);
    touchChange(dbs, change.uuid, "", "header", deleted === 1 ? "tombstone" : "upsert");
  }
  if (accepted > 0) refreshHeaderSummary(dbs, change.uuid);

  const merged: MergedSession = {
    uuid: change.uuid,
    cwd: change.cwd,
    name: change.name ?? header?.name ?? null,
    version,
    deleted: deleted === 1,
    updatedBy: mutated ? deviceName : header?.updated_by ?? deviceName,
    updatedAt: mutated ? nowMs : header?.updated_at ?? nowMs,
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
  deviceAId: string,
  deviceBId: string,
  contentA: string,
  contentB: string,
) {
  dbs.db
    .prepare(
      `INSERT INTO conflicts
         (object_key, path, kind, device_a, device_b, device_a_id, device_b_id, content_a, content_b, created_at)
       VALUES (?, ?, 'session-entry', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(`session/${sessionUuid}`, entryId, deviceA, deviceB, deviceAId, deviceBId, contentA, contentB, now());
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
    `SELECT line FROM session_entries WHERE session_uuid = ? ORDER BY received_at, rowid`,
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
    lines: h.deleted === 1 ? [] : (stmt.all(h.uuid) as Array<{ line: string }>).map((r) => r.line),
  }));
}

/** v2 增量拉取：按紧凑变更索引的单调 seq 返回当前最新状态。 */
export function pullSessionDeltas(
  dbs: SyncDb,
  cursor: number,
  limit = 500,
  maxBytes = 2 * 1024 * 1024,
): SessionPullResponseV2 {
  const safeLimit = Math.min(Math.max(limit, 1), 2_000);
  const safeBytes = Math.min(Math.max(maxBytes, 64 * 1024), 8 * 1024 * 1024);
  const rows = dbs.db
    .prepare(
      `SELECT seq, session_uuid, entry_id, kind, op FROM session_change_index
       WHERE seq > ? ORDER BY seq LIMIT ?`,
    )
    .all(cursor, safeLimit + 1) as Array<{
    seq: number;
    session_uuid: string;
    entry_id: string;
    kind: "header" | "entry";
    op: "insert" | "update" | "upsert" | "tombstone";
  }>;
  const changes: SessionDelta[] = [];
  let bytes = 0;
  let consumed = 0;
  for (const row of rows.slice(0, safeLimit)) {
    let delta: SessionDelta | null = null;
    if (row.kind === "header") {
      const header = dbs.db.prepare(`SELECT * FROM session_headers WHERE uuid = ?`).get(row.session_uuid) as
        | SessionHeaderRow & { header: string | null; created_at: number | null }
        | undefined;
      if (header) {
        delta = {
          seq: row.seq,
          kind: "header",
          op: header.deleted === 1 ? "tombstone" : "upsert",
          session: {
            uuid: header.uuid,
            cwd: header.cwd,
            name: header.name,
            headerJson: header.header,
            createdAt: header.created_at,
            version: header.version,
            deleted: header.deleted === 1,
            updatedBy: header.updated_by,
            updatedAt: header.updated_at,
          },
        };
      }
    } else {
      const entry = dbs.db
        .prepare(
          `SELECT entry_id, line, source_device, source_device_id FROM session_entries
           WHERE session_uuid = ? AND entry_id = ?`,
        )
        .get(row.session_uuid, row.entry_id) as
        | { entry_id: string; line: string; source_device: string; source_device_id: string }
        | undefined;
      if (entry) {
        const header = dbs.db.prepare(`SELECT * FROM session_headers WHERE uuid = ?`).get(row.session_uuid) as
          | SessionHeaderRow & { header: string | null; created_at: number | null }
          | undefined;
        if (!header) continue;
        delta = {
          seq: row.seq,
          kind: "entry",
          op: row.op === "update" ? "update" : "insert",
          uuid: row.session_uuid,
          session: {
            uuid: header.uuid,
            cwd: header.cwd,
            name: header.name,
            headerJson: header.header,
            createdAt: header.created_at,
            version: header.version,
            deleted: header.deleted === 1,
            updatedBy: header.updated_by,
            updatedAt: header.updated_at,
          },
          entry: {
            id: entry.entry_id,
            parentId: entryMetadata(entry.line, 0).parentId,
            lineJson: entry.line,
            sourceDeviceId: entry.source_device_id,
            sourceDevice: entry.source_device,
          },
        };
      }
    }
    consumed++;
    if (!delta) continue;
    const size = Buffer.byteLength(JSON.stringify(delta), "utf8");
    if (changes.length > 0 && bytes + size > safeBytes) {
      consumed--;
      break;
    }
    bytes += size;
    changes.push(delta);
  }
  const nextCursor = changes.length > 0 ? changes[changes.length - 1].seq : cursor;
  return { changes, nextCursor, hasMore: rows.length > consumed };
}

/** 写入不进入会话正文的插件内部用量事件。 */
export function mergeUsageEvents(
  dbs: SyncDb,
  events: UsageEventChange[],
  device: { deviceId: string; name: string },
): number {
  const insert = dbs.db.prepare(
    `INSERT OR IGNORE INTO session_usage
       (session_uuid, entry_id, occurred_at, provider, model, source_device, source_device_id, requests,
        input_tokens, output_tokens, cache_read, cache_write, total_tokens, cost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let accepted = 0;
  const touched = new Set<string>();
  for (const event of events.slice(0, 1_000)) {
    if (!event.id || !event.sessionUuid) continue;
    const result = insert.run(
      event.sessionUuid,
      `plugin:${event.id}`,
      event.occurredAt,
      event.provider,
      event.model,
      device.name,
      device.deviceId,
      event.requests ?? 1,
      event.input,
      event.output,
      event.cacheRead,
      event.cacheWrite,
      event.totalTokens,
      usageCostUsd(event, event.cost, event.occurredAt),
    );
    if (result.changes > 0) {
      accepted++;
      touched.add(event.sessionUuid);
    }
  }
  for (const uuid of touched) refreshHeaderSummary(dbs, uuid);
  return accepted;
}

interface SessionHeaderRow {
  uuid: string;
  cwd: string;
  name: string | null;
  header: string | null;
  created_at: number | null;
  version: number;
  deleted: number;
  content_pruned: number;
  updated_by: string;
  updated_by_device_id: string;
  updated_at: number;
  entry_count: number;
  readable_count: number;
  total_tokens: number;
  total_cost: number;
}

/** 恢复已删除会话（清除 tombstone） */
export function restoreSession(
  dbs: SyncDb,
  uuid: string,
  device: { deviceId: string; name: string },
): boolean {
  const res = dbs.db
    .prepare(
      `UPDATE session_headers
       SET deleted = 0, version = version + 1, updated_by = ?, updated_by_device_id = ?, updated_at = ?
       WHERE uuid = ? AND content_pruned = 0`,
    )
    .run(device.name, device.deviceId, now(), uuid);
  if (res.changes > 0) touchChange(dbs, uuid, "", "header", "upsert");
  return res.changes > 0;
}

export interface PruneSessionsResult {
  requested: number;
  pruned: number;
  missing: string[];
  usageRows: number;
}

/**
 * 永久裁剪会话正文：只保留 uuid、时间、tombstone 与独立用量行。
 * 该操作不可通过 restore 恢复正文，但用量总览仍能按日期/模型/设备聚合。
 */
export function pruneSessions(dbs: SyncDb, uuids: string[], actor: string): PruneSessionsResult {
  const unique = [...new Set(uuids.map((uuid) => uuid.trim()).filter(Boolean))];
  const missing: string[] = [];
  let pruned = 0;
  let usageRows = 0;
  const db = dbs.db;

  const selectHeader = db.prepare(`SELECT uuid, content_pruned FROM session_headers WHERE uuid = ?`);
  const selectEntries = db.prepare(
    `SELECT entry_id, line, source_device, source_device_id FROM session_entries WHERE session_uuid = ?`,
  );
  const clearUsage = db.prepare(`DELETE FROM session_usage WHERE session_uuid = ?`);
  const insertUsage = db.prepare(
    `INSERT OR REPLACE INTO session_usage
       (session_uuid, entry_id, occurred_at, provider, model, source_device, source_device_id, requests,
        input_tokens, output_tokens, cache_read, cache_write, total_tokens, cost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const deleteEntries = db.prepare(`DELETE FROM session_entries WHERE session_uuid = ?`);
  const deleteEntryChanges = db.prepare(`DELETE FROM session_change_index WHERE session_uuid = ? AND kind = 'entry'`);
  const deleteConflicts = db.prepare(`DELETE FROM conflicts WHERE object_key = ?`);
  const pruneHeader = db.prepare(
    `UPDATE session_headers
     SET cwd = '', name = NULL, header = NULL, deleted = 1, content_pruned = 1,
         version = version + 1, updated_by = ?, updated_at = ?
     WHERE uuid = ?`,
  );

  const transaction = db.transaction(() => {
    for (const uuid of unique) {
      const header = selectHeader.get(uuid) as { uuid: string; content_pruned: number } | undefined;
      if (!header) {
        missing.push(uuid);
        continue;
      }
      if (header.content_pruned === 1) {
        pruned++;
        continue;
      }
      clearUsage.run(uuid);
      const entries = selectEntries.all(uuid) as Array<{
        entry_id: string;
        line: string;
        source_device: string;
        source_device_id: string;
      }>;
      for (const entry of entries) {
        const hit = parseUsageHit(entry.line, entry.source_device, uuid);
        if (!hit) continue;
        insertUsage.run(
          uuid,
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
        usageRows++;
      }
      deleteEntries.run(uuid);
      deleteEntryChanges.run(uuid);
      deleteConflicts.run(`session/${uuid}`);
      pruneHeader.run(actor, now(), uuid);
      refreshHeaderSummary(dbs, uuid);
      touchChange(dbs, uuid, "", "header", "tombstone");
      pruned++;
    }
  });
  transaction();

  return { requested: unique.length, pruned, missing, usageRows };
}
