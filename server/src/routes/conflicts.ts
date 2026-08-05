import type { FastifyInstance } from "fastify";
import type { SyncDb } from "../db.js";
import { now } from "../db.js";
import { sha256Hex } from "../merge.js";
import type { ConflictRecord } from "@pi-cloud-sync/shared";

export function registerConflictRoutes(app: FastifyInstance, dbs: SyncDb) {
  app.get("/api/v1/conflicts", async () => {
    const rows = dbs.db
      .prepare(
        `SELECT id, object_key, path, kind, device_a, device_b, content_a, content_b,
                resolution, resolved_at, created_at
         FROM conflicts ORDER BY resolved_at IS NOT NULL, created_at DESC`,
      )
      .all() as Array<{
      id: number;
      object_key: string;
      path: string;
      kind: string;
      device_a: string;
      device_b: string;
      content_a: string;
      content_b: string;
      resolution: string | null;
      resolved_at: number | null;
      created_at: number;
    }>;

    const out: ConflictRecord[] = rows.map((r) => ({
      id: r.id,
      objectKey: r.object_key,
      path: r.path,
      kind: r.kind as ConflictRecord["kind"],
      deviceA: r.device_a,
      deviceB: r.device_b,
      contentA: r.content_a,
      contentB: r.content_b,
      resolution: r.resolution as ConflictRecord["resolution"],
      resolvedAt: r.resolved_at,
      createdAt: r.created_at,
    }));
    return { ok: true, data: out };
  });

  /** 解决冲突：keep-a / keep-b / manual（需携带 content 覆盖） */
  app.post<{ Params: { id: string }; Body: { resolution: string; content?: string } }>(
    "/api/v1/conflicts/:id/resolve",
    async (req, reply) => {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) {
        return reply.code(400).send({ ok: false, error: "BAD_REQUEST", message: "bad id" });
      }
      const row = dbs.db.prepare(`SELECT * FROM conflicts WHERE id = ?`).get(id) as
        | {
            id: number;
            object_key: string;
            path: string;
            kind: string;
            content_a: string;
            content_b: string;
          }
        | undefined;
      if (!row) {
        return reply.code(404).send({ ok: false, error: "NOT_FOUND", message: "conflict not found" });
      }

      const resolution = req.body?.resolution;
      if (!["keep-a", "keep-b", "manual"].includes(resolution ?? "")) {
        return reply
          .code(400)
          .send({ ok: false, error: "BAD_REQUEST", message: "resolution must be keep-a|keep-b|manual" });
      }

      let winner: string | null = null;
      if (resolution === "keep-a") winner = row.content_a;
      else if (resolution === "keep-b") winner = row.content_b;
      else winner = req.body?.content ?? null;
      if (winner === null) {
        return reply.code(400).send({ ok: false, error: "BAD_REQUEST", message: "content required for manual" });
      }

      const tx = dbs.db.transaction(() => {
        dbs.db
          .prepare(`UPDATE conflicts SET resolution = ?, resolved_at = ? WHERE id = ?`)
          .run(resolution, now(), id);

        // 应用到对象（若冲突对象仍存在）
        if (row.kind !== "session-entry") {
          const obj = dbs.db.prepare(`SELECT * FROM objects WHERE key = ?`).get(row.object_key) as
            | { key: string; version: number; sha256: string; data: string }
            | undefined;
          if (obj) {
            // 应用胜者内容到字段级版本表 + 对象数据
            const newObj = applyWinnerToObject(dbs, row.object_key, row.path, winner, obj);
            if (newObj) {
              dbs.db
                .prepare(
                  `UPDATE objects SET version = ?, sha256 = ?, data = ?, updated_by = 'resolve', updated_at = ?
                   WHERE key = ?`,
                )
                .run(newObj.version, newObj.sha, newObj.data, now(), row.object_key);
            }
          }
        }
      });
      tx();

      return { ok: true, data: { id, resolution } };
    },
  );
}

function applyWinnerToObject(
  dbs: SyncDb,
  objectKey: string,
  path: string,
  winner: string,
  obj: { version: number; data: string },
): { version: number; sha: string; data: string } | null {
  // 仅支持 JSON 对象按字段应用
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(obj.data);
  } catch {
    return null;
  }
  try {
    setPath(parsed, path, JSON.parse(winner));
  } catch {
    return null;
  }
  const data = JSON.stringify(parsed, null, 2);
  return { version: obj.version + 1, sha: sha256Hex(data), data };
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}
