import type { FastifyInstance } from "fastify";
import type { SyncDb } from "../db.js";
import { now } from "../db.js";
import type { HeartbeatRequest } from "@pi-cloud-sync/shared";

interface DeviceRow {
  device_id: string;
  name: string;
  platform: string;
  pi_version: string;
  ext_version: string;
  last_seen: number;
  created_at: number;
  status: "active" | "legacy" | "merged" | "retired";
  merged_into: string | null;
  merged_at: number | null;
  retired_at: number | null;
  is_legacy: number;
  name_locked: number;
}

interface MergeBody {
  sourceDeviceIds?: unknown;
  targetDeviceId?: unknown;
  confirmTargetName?: unknown;
}

function normalizeMerge(dbs: SyncDb, body: MergeBody): { sources: DeviceRow[]; target: DeviceRow } | null {
  if (!Array.isArray(body.sourceDeviceIds) || typeof body.targetDeviceId !== "string") return null;
  const ids = [...new Set(body.sourceDeviceIds.filter((value): value is string => typeof value === "string" && value.length > 0))];
  if (ids.length === 0 || ids.length > 50 || ids.includes(body.targetDeviceId)) return null;
  const target = dbs.db.prepare(`SELECT * FROM devices WHERE device_id = ?`).get(body.targetDeviceId) as DeviceRow | undefined;
  if (!target || target.status === "merged") return null;
  const sources = ids
    .map((id) => dbs.db.prepare(`SELECT * FROM devices WHERE device_id = ?`).get(id) as DeviceRow | undefined)
    .filter((row): row is DeviceRow => Boolean(row));
  return sources.length === ids.length ? { sources, target } : null;
}

function mergePreview(dbs: SyncDb, sources: DeviceRow[], target: DeviceRow) {
  const ids = sources.map((source) => source.device_id);
  const placeholders = ids.map(() => "?").join(",");
  const scalar = (sql: string) => (dbs.db.prepare(sql).get(...ids) as { count: number }).count;
  const sessions = (
    dbs.db
      .prepare(
        `SELECT COUNT(DISTINCT uuid) AS count FROM session_headers
         WHERE updated_by_device_id IN (${placeholders})
            OR uuid IN (SELECT session_uuid FROM session_entries WHERE source_device_id IN (${placeholders}))`,
      )
      .get(...ids, ...ids) as { count: number }
  ).count;
  return {
    target: { deviceId: target.device_id, name: target.name },
    sources: sources.map((source) => ({
      deviceId: source.device_id,
      name: source.name,
      status: source.status,
      online: source.last_seen > Date.now() - 5 * 60_000,
    })),
    affected: {
      sessions,
      entries: scalar(`SELECT COUNT(*) AS count FROM session_entries WHERE source_device_id IN (${placeholders})`),
      usageRows: scalar(`SELECT COUNT(*) AS count FROM session_usage WHERE source_device_id IN (${placeholders})`),
      objects: scalar(`SELECT COUNT(*) AS count FROM objects WHERE updated_by_device_id IN (${placeholders})`),
      fields: scalar(`SELECT COUNT(*) AS count FROM config_field_versions WHERE updated_by_device_id IN (${placeholders})`),
      conflicts: (
        dbs.db
          .prepare(
            `SELECT COUNT(*) AS count FROM conflicts
             WHERE device_a_id IN (${placeholders}) OR device_b_id IN (${placeholders})`,
          )
          .get(...ids, ...ids) as { count: number }
      ).count,
    },
    irreversible: true,
    onlineWarning: sources.some((source) => source.last_seen > Date.now() - 5 * 60_000),
  };
}

/** 设备注册、心跳、重命名与永久历史合并。 */
export function registerDeviceRoutes(app: FastifyInstance, dbs: SyncDb) {
  app.post<{ Body: HeartbeatRequest }>("/api/v1/devices/heartbeat", async (req) => {
    const body = req.body ?? ({} as HeartbeatRequest);
    const requestedName = (body.name ?? "unknown").toString().trim().slice(0, 128) || "unknown";
    const platform = (body.platform ?? "").toString().slice(0, 64);
    const piVersion = (body.piVersion ?? "").toString().slice(0, 32);
    const extVersion = (body.extensionVersion ?? "").toString().slice(0, 32);
    let deviceId = body.deviceId?.toString().slice(0, 64) || "";
    const nowMs = now();
    let reactivated = false;
    let existing = deviceId
      ? (dbs.db.prepare(`SELECT * FROM devices WHERE device_id = ?`).get(deviceId) as DeviceRow | undefined)
      : undefined;
    if (!existing) {
      const { newDeviceId } = await import("../db.js");
      deviceId = newDeviceId();
      dbs.db
        .prepare(
          `INSERT INTO devices
             (device_id, name, platform, pi_version, ext_version, last_seen, created_at, status, is_legacy)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0)`,
        )
        .run(deviceId, requestedName, platform, piVersion, extVersion, nowMs, nowMs);
      existing = dbs.db.prepare(`SELECT * FROM devices WHERE device_id = ?`).get(deviceId) as DeviceRow;
    } else {
      reactivated = existing.status === "merged";
      if (existing.status === "retired") {
        // 已删除（退役）设备：保持退役状态，不复活、不改名，只刷新心跳与版本信息；
        // 若确需恢复，在 Web 控制台「已退役」筛选中手动恢复。
        dbs.db
          .prepare(`UPDATE devices SET platform = ?, pi_version = ?, ext_version = ?, last_seen = ? WHERE device_id = ?`)
          .run(platform, piVersion, extVersion, nowMs, deviceId);
      } else {
        const name = existing.name_locked === 1 && !reactivated ? existing.name : requestedName;
        dbs.db
          .prepare(
            `UPDATE devices SET name = ?, platform = ?, pi_version = ?, ext_version = ?, last_seen = ?,
             status = 'active', merged_into = NULL, merged_at = NULL, is_legacy = 0
           WHERE device_id = ?`,
          )
          .run(name, platform, piVersion, extVersion, nowMs, deviceId);
      }
    }
    const row = dbs.db.prepare(`SELECT name FROM devices WHERE device_id = ?`).get(deviceId) as { name: string };
    return { ok: true, data: { deviceId, name: row.name, lastSeen: nowMs, reactivated } };
  });

  app.get("/api/v1/devices", async () => {
    const rows = dbs.db
      .prepare(
        `SELECT d.*,
           (SELECT COUNT(DISTINCT h.uuid) FROM session_headers h
             WHERE h.updated_by_device_id = d.device_id
                OR h.uuid IN (SELECT e.session_uuid FROM session_entries e WHERE e.source_device_id = d.device_id)) AS session_count,
           (SELECT COUNT(*) FROM session_entries e WHERE e.source_device_id = d.device_id) AS entry_count,
           (SELECT COALESCE(SUM(total_tokens), 0) FROM session_usage u WHERE u.source_device_id = d.device_id) AS total_tokens,
           (SELECT COALESCE(SUM(cost), 0) FROM session_usage u WHERE u.source_device_id = d.device_id) AS total_cost
         FROM devices d ORDER BY CASE d.status WHEN 'active' THEN 0 WHEN 'legacy' THEN 1 WHEN 'retired' THEN 2 ELSE 3 END, d.last_seen DESC`,
      )
      .all() as Array<DeviceRow & { session_count: number; entry_count: number; total_tokens: number; total_cost: number }>;
    return {
      ok: true,
      data: rows.map((row) => ({
        deviceId: row.device_id,
        name: row.name,
        platform: row.platform,
        piVersion: row.pi_version,
        extensionVersion: row.ext_version,
        lastSeen: row.last_seen,
        createdAt: row.created_at,
        status: row.status,
        mergedInto: row.merged_into,
        mergedAt: row.merged_at,
        retiredAt: row.retired_at ?? null,
        isLegacy: row.is_legacy === 1,
        sessionCount: row.session_count,
        entryCount: row.entry_count,
        totalTokens: row.total_tokens,
        totalCost: row.total_cost,
      })),
    };
  });

  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>("/api/v1/devices/:id", async (req, reply) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 128) : "";
    if (!name) return reply.code(400).send({ ok: false, error: "BAD_REQUEST", message: "name required" });
    const result = dbs.db
      .prepare(`UPDATE devices SET name = ?, name_locked = 1 WHERE device_id = ? AND status <> 'merged'`)
      .run(name, req.params.id);
    if (result.changes === 0) return reply.code(404).send({ ok: false, error: "NOT_FOUND", message: "device not found" });
    return { ok: true, data: { deviceId: req.params.id, name } };
  });

  app.delete<{ Params: { id: string }; Body: { confirmName?: unknown } }>("/api/v1/devices/:id", async (req, reply) => {
    const row = dbs.db.prepare(`SELECT * FROM devices WHERE device_id = ?`).get(req.params.id) as DeviceRow | undefined;
    if (!row) return reply.code(404).send({ ok: false, error: "NOT_FOUND", message: "device not found" });
    if (row.status === "merged") {
      return reply.code(400).send({ ok: false, error: "BAD_REQUEST", message: "merged device is already hidden from lists" });
    }
    const confirmName = typeof req.body?.confirmName === "string" ? req.body.confirmName : "";
    if (confirmName !== row.name) {
      return reply.code(400).send({ ok: false, error: "BAD_REQUEST", message: "device name confirmation mismatch" });
    }
    const affected = {
      sessions: (
        dbs.db
          .prepare(
            `SELECT COUNT(DISTINCT h.uuid) AS count FROM session_headers h
             WHERE h.updated_by_device_id = ?
                OR h.uuid IN (SELECT e.session_uuid FROM session_entries e WHERE e.source_device_id = ?)`,
          )
          .get(row.device_id, row.device_id) as { count: number }
      ).count,
      entries: (dbs.db.prepare(`SELECT COUNT(*) AS count FROM session_entries WHERE source_device_id = ?`).get(row.device_id) as { count: number }).count,
      usageRows: (dbs.db.prepare(`SELECT COUNT(*) AS count FROM session_usage WHERE source_device_id = ?`).get(row.device_id) as { count: number }).count,
    };
    const retiredAt = now();
    // 退役不迁移历史行：会话/条目/用量保留原 device_id，统计侧统一归并到「其他设备」；
    // 之后若该设备再次心跳，保持退役状态，不会重新出现在设备列表。
    dbs.db.prepare(`UPDATE devices SET status = 'retired', retired_at = ? WHERE device_id = ?`).run(retiredAt, row.device_id);
    return { ok: true, data: { deviceId: row.device_id, name: row.name, retiredAt, affected } };
  });

  app.post<{ Params: { id: string } }>("/api/v1/devices/:id/restore", async (req, reply) => {
    const row = dbs.db.prepare(`SELECT * FROM devices WHERE device_id = ?`).get(req.params.id) as DeviceRow | undefined;
    if (!row) return reply.code(404).send({ ok: false, error: "NOT_FOUND", message: "device not found" });
    if (row.status !== "retired") {
      return reply.code(400).send({ ok: false, error: "BAD_REQUEST", message: "only retired devices can be restored" });
    }
    dbs.db
      .prepare(
        `UPDATE devices SET status = CASE WHEN is_legacy = 1 THEN 'legacy' ELSE 'active' END, retired_at = NULL WHERE device_id = ?`,
      )
      .run(row.device_id);
    return { ok: true, data: { deviceId: row.device_id, name: row.name, restoredAt: now() } };
  });

  app.post<{ Body: MergeBody }>("/api/v1/devices/merge/preview", async (req, reply) => {
    const normalized = normalizeMerge(dbs, req.body ?? {});
    if (!normalized) return reply.code(400).send({ ok: false, error: "BAD_REQUEST", message: "invalid merge selection" });
    return { ok: true, data: mergePreview(dbs, normalized.sources, normalized.target) };
  });

  app.post<{ Body: MergeBody }>("/api/v1/devices/merge", async (req, reply) => {
    const normalized = normalizeMerge(dbs, req.body ?? {});
    if (!normalized) return reply.code(400).send({ ok: false, error: "BAD_REQUEST", message: "invalid merge selection" });
    if (req.body.confirmTargetName !== normalized.target.name) {
      return reply.code(400).send({ ok: false, error: "BAD_REQUEST", message: "target name confirmation mismatch" });
    }
    const preview = mergePreview(dbs, normalized.sources, normalized.target);
    const mergedAt = now();
    const tx = dbs.db.transaction(() => {
      for (const source of normalized.sources) {
        const args = [normalized.target.device_id, normalized.target.name, source.device_id];
        dbs.db.prepare(`UPDATE session_headers SET updated_by_device_id = ?, updated_by = ? WHERE updated_by_device_id = ?`).run(...args);
        dbs.db.prepare(`UPDATE session_entries SET source_device_id = ?, source_device = ? WHERE source_device_id = ?`).run(...args);
        dbs.db.prepare(`UPDATE session_usage SET source_device_id = ?, source_device = ? WHERE source_device_id = ?`).run(...args);
        dbs.db.prepare(`UPDATE objects SET updated_by_device_id = ?, updated_by = ? WHERE updated_by_device_id = ?`).run(...args);
        dbs.db.prepare(`UPDATE config_field_versions SET updated_by_device_id = ?, updated_by = ? WHERE updated_by_device_id = ?`).run(...args);
        dbs.db
          .prepare(
            `UPDATE conflicts SET device_a_id = ?, device_a = ?
             WHERE device_a_id = ? OR (device_a_id = '' AND device_a = ?)`,
          )
          .run(normalized.target.device_id, normalized.target.name, source.device_id, source.name);
        dbs.db
          .prepare(
            `UPDATE conflicts SET device_b_id = ?, device_b = ?
             WHERE device_b_id = ? OR (device_b_id = '' AND device_b = ?)`,
          )
          .run(normalized.target.device_id, normalized.target.name, source.device_id, source.name);
        dbs.db
          .prepare(`UPDATE devices SET status = 'merged', merged_into = ?, merged_at = ? WHERE device_id = ?`)
          .run(normalized.target.device_id, mergedAt, source.device_id);
        dbs.db
          .prepare(
            `INSERT INTO device_merge_history
               (source_device_id, source_name, target_device_id, target_name, affected_json, merged_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            source.device_id,
            source.name,
            normalized.target.device_id,
            normalized.target.name,
            JSON.stringify(preview.affected),
            mergedAt,
          );
      }
    });
    tx();
    return { ok: true, data: { ...preview, mergedAt } };
  });
}
