import type { FastifyInstance } from "fastify";
import type { FastifyRequest } from "fastify";
import type { SyncDb } from "../db.js";
import { mergeObject } from "../merge.js";
import { mergeSession, pullSessions, restoreSession } from "../sessions.js";
import type {
  ConflictRecord,
  MergedObject,
  MergedSession,
  PullRequest,
  PushChange,
  SessionChange,
} from "@pi-cloud-sync/shared";
import type { ServerConfig } from "../config.js";

const MAX_CHANGES = 500;
const MAX_SESSIONS_PER_PUSH = 200;

function headerValue(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length > 0) return v[0];
  return undefined;
}

export function registerSyncRoutes(app: FastifyInstance, dbs: SyncDb, cfg: ServerConfig) {
  /* ---------- 对象推送（config / plugin-file / package-manifest） ---------- */
  app.post<{ Body: { changes: PushChange[] } }>("/api/v1/sync/push", async (req, reply) => {
    const changes = (req.body?.changes ?? []).slice(0, MAX_CHANGES);
    if (changes.length === 0) {
      return reply.code(400).send({ ok: false, error: "BAD_REQUEST", message: "empty changes" });
    }

    const device = resolveDevice(dbs, headerValue(req, "x-device-id"), headerValue(req, "x-device-name"));
    if (!device) {
      return reply
        .code(400)
        .send({ ok: false, error: "BAD_REQUEST", message: "x-device-id required; heartbeat first" });
    }

    const objects: MergedObject[] = [];
    const conflicts: ConflictRecord[] = [];
    const insertConflicts = dbs.db.prepare(
      `INSERT INTO conflicts (object_key, path, kind, device_a, device_b, content_a, content_b, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const tx = dbs.db.transaction(() => {
      for (const change of changes) {
        if (!change.key || !change.kind) continue;
        if (change.contentB64 && change.contentB64.length > cfg.maxObjectBytes) {
          continue; // 单对象过大，跳过
        }
        const result = mergeObject(dbs, change, device);
        objects.push(result.merged);
        for (const c of result.conflicts) {
          insertConflicts.run(
            c.objectKey,
            c.path,
            c.kind,
            c.deviceA,
            c.deviceB,
            c.contentA,
            c.contentB,
            now(),
          );
          conflicts.push({
            id: 0,
            ...c,
            kind: c.kind as ConflictRecord["kind"],
            resolution: null,
            resolvedAt: null,
            createdAt: now(),
          });
        }
      }
    });
    tx();

    return { ok: true, data: { objects, conflicts } };
  });

  /* ---------- 对象拉取 ---------- */
  app.post<{ Body: PullRequest }>("/api/v1/sync/pull", async (req) => {
    const body = req.body ?? {};
    const since = body.since ?? null;

    let rows;
    if (since) {
      rows = dbs.db
        .prepare(`SELECT * FROM objects WHERE updated_at > ? ORDER BY key`)
        .all(since) as Array<{
        key: string;
        kind: string;
        version: number;
        sha256: string;
        data: string;
        updated_by: string;
        updated_at: number;
        deleted: number;
      }>;
    } else {
      rows = dbs.db.prepare(`SELECT * FROM objects ORDER BY key`).all() as Array<{
        key: string;
        kind: string;
        version: number;
        sha256: string;
        data: string;
        updated_by: string;
        updated_at: number;
        deleted: number;
      }>;
    }

    const keyFilter = body.keys?.length ? new Set(body.keys) : null;

    const objects = [];
    for (const r of rows) {
      if (keyFilter && !keyFilter.has(r.key)) continue;
      const fieldVersions = (
        dbs.db
          .prepare(
            `SELECT path, version, updated_by, updated_at FROM config_field_versions WHERE object_key = ? ORDER BY path`,
          )
          .all(r.key) as Array<{
          path: string;
          version: number;
          updated_by: string;
          updated_at: number;
        }>
      ).map((f) => ({
        path: f.path,
        version: f.version,
        updatedBy: f.updated_by,
        updatedAt: f.updated_at,
      }));
      objects.push({
        key: r.key,
        kind: r.kind,
        version: r.version,
        sha256: r.sha256,
        contentB64: Buffer.from(r.data, "utf8").toString("base64"),
        fieldVersions,
        updatedBy: r.updated_by,
        updatedAt: r.updated_at,
        deleted: r.deleted === 1,
      });
    }

    const sessions = pullSessions(dbs, since);
    const packageManifest = objects.find((o) => o.key === "plugin/package-manifest") ?? null;

    return { ok: true, data: { objects, sessions, packageManifest, serverTime: now() } };
  });

  /* ---------- 会话推送 ---------- */
  app.post<{ Body: { sessions: SessionChange[] } }>("/api/v1/sessions/push", async (req, reply) => {
    const sessions = (req.body?.sessions ?? []).slice(0, MAX_SESSIONS_PER_PUSH);
    if (sessions.length === 0) {
      return reply.code(400).send({ ok: false, error: "BAD_REQUEST", message: "empty sessions" });
    }
    const device = resolveDevice(dbs, headerValue(req, "x-device-id"), headerValue(req, "x-device-name"));
    if (!device) {
      return reply
        .code(400)
        .send({ ok: false, error: "BAD_REQUEST", message: "x-device-id required; heartbeat first" });
    }

    const results: MergedSession[] = [];
    const conflicts: ConflictRecord[] = [];
    const insertConflict = dbs.db.prepare(
      `INSERT INTO conflicts (object_key, path, kind, device_a, device_b, content_a, content_b, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const tx = dbs.db.transaction(() => {
      for (const s of sessions) {
        const total = dbs.db
          .prepare(`SELECT COUNT(*) AS c FROM session_entries WHERE session_uuid = ?`)
          .get(s.uuid) as { c: number };
        if (total.c + s.entries.length > cfg.maxBatchEntries) {
          // 超过批量上限：只接受前 N 条
          const room = Math.max(0, cfg.maxBatchEntries - total.c);
          s.entries = s.entries.slice(0, room);
        }
        const r = mergeSession(dbs, s, device);
        results.push(r.merged);
        if (r.conflicts > 0) {
          conflicts.push({
            id: 0,
            objectKey: `session/${s.uuid}`,
            path: "(entry conflict)",
            kind: "session-entry",
            deviceA: device.name,
            deviceB: device.name,
            contentA: "",
            contentB: "",
            resolution: null,
            resolvedAt: null,
            createdAt: now(),
          });
        }
      }
    });
    tx();

    return { ok: true, data: { sessions: results, conflicts } };
  });

  /* ---------- 会话拉取 ---------- */
  app.post<{ Body: { since?: number | null } }>("/api/v1/sessions/pull", async (req) => {
    const since = req.body?.since ?? null;
    return { ok: true, data: { sessions: pullSessions(dbs, since) } };
  });

  /* ---------- 会话恢复（撤销删除） ---------- */
  app.post<{ Body: { uuid: string } }>("/api/v1/sessions/restore", async (req, reply) => {
    const uuid = req.body?.uuid;
    if (!uuid) return reply.code(400).send({ ok: false, error: "BAD_REQUEST", message: "uuid required" });
    const device = resolveDevice(dbs, headerValue(req, "x-device-id"), headerValue(req, "x-device-name"));
    const ok = restoreSession(dbs, uuid, device?.name ?? "unknown");
    return { ok, data: { restored: ok } };
  });
}

function resolveDevice(
  dbs: SyncDb,
  deviceId: string | undefined,
  deviceName: string | undefined,
): { deviceId: string; name: string } | null {
  if (!deviceId) return null;
  const row = dbs.db.prepare("SELECT device_id, name FROM devices WHERE device_id = ?").get(deviceId) as
    | { device_id: string; name: string }
    | undefined;
  if (row) return { deviceId: row.device_id, name: deviceName || row.name || "unknown" };
  // 宽容处理：未注册设备自动注册（首包场景）
  dbs.db
    .prepare(
      `INSERT OR IGNORE INTO devices (device_id, name, platform, pi_version, ext_version, last_seen, created_at)
       VALUES (?, ?, '', '', '', ?, ?)`,
    )
    .run(deviceId, deviceName || "unknown", now(), now());
  return { deviceId, name: deviceName || "unknown" };
}

function now(): number {
  return Date.now();
}
