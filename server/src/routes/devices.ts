import type { FastifyInstance } from "fastify";
import type { SyncDb } from "../db.js";
import { now } from "../db.js";
import type { HeartbeatRequest } from "@pi-cloud-sync/shared";

/** 设备注册 + 心跳。返回 deviceId（新设备生成）。 */
export function registerDeviceRoutes(app: FastifyInstance, dbs: SyncDb) {
  app.post<{ Body: HeartbeatRequest }>("/api/v1/devices/heartbeat", async (req, reply) => {
    const b = req.body ?? ({} as HeartbeatRequest);
    const name = (b.name ?? "unknown").toString().slice(0, 128);
    const platform = (b.platform ?? "").toString().slice(0, 64);
    const piVersion = (b.piVersion ?? "").toString().slice(0, 32);
    const extVersion = (b.extensionVersion ?? "").toString().slice(0, 32);

    let deviceId = b.deviceId?.toString().slice(0, 64) || "";
    const nowMs = now();

    if (deviceId) {
      const exists = dbs.db.prepare("SELECT 1 FROM devices WHERE device_id = ?").get(deviceId);
      if (!exists) deviceId = "";
    }
    if (!deviceId) {
      const { newDeviceId } = await import("../db.js");
      deviceId = newDeviceId();
      dbs.db
        .prepare(
          `INSERT INTO devices (device_id, name, platform, pi_version, ext_version, last_seen, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(deviceId, name, platform, piVersion, extVersion, nowMs, nowMs);
    } else {
      dbs.db
        .prepare(
          `UPDATE devices SET name = ?, platform = ?, pi_version = ?, ext_version = ?, last_seen = ?
           WHERE device_id = ?`,
        )
        .run(name, platform, piVersion, extVersion, nowMs, deviceId);
    }

    return { ok: true, data: { deviceId, name, lastSeen: nowMs } };
  });

  app.get("/api/v1/devices", async () => {
    const rows = dbs.db
      .prepare(
        `SELECT device_id, name, platform, pi_version, ext_version, last_seen, created_at
         FROM devices ORDER BY last_seen DESC`,
      )
      .all() as Array<{
      device_id: string;
      name: string;
      platform: string;
      pi_version: string;
      ext_version: string;
      last_seen: number;
      created_at: number;
    }>;
    return {
      ok: true,
      data: rows.map((r) => ({
        deviceId: r.device_id,
        name: r.name,
        platform: r.platform,
        piVersion: r.pi_version,
        extensionVersion: r.ext_version,
        lastSeen: r.last_seen,
        createdAt: r.created_at,
      })),
    };
  });
}
