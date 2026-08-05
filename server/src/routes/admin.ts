import type { FastifyInstance } from "fastify";
import type { SyncDb } from "../db.js";
import { now } from "../db.js";
import { generateToken, hashToken } from "../auth.js";
import { listTokens } from "./admin-tokens.js";

/** 管理端点：令牌管理（需 ADMIN_TOKEN） */
export function registerAdminRoutes(app: FastifyInstance, dbs: SyncDb) {
  // 注意：auth 中间件在 index.ts 中按路径前缀保护 /api/v1/admin

  app.post<{ Body: { name?: string } }>("/api/v1/admin/tokens", async (req, reply) => {
    const name = (req.body?.name ?? "device").toString().slice(0, 128);
    const token = generateToken();
    dbs.db
      .prepare(`INSERT INTO tokens (name, token, token_hash, created_at) VALUES (?, ?, ?, ?)`)
      .run(name, token, hashToken(token), now());
    return { ok: true, data: { name, token } };
  });

  app.get("/api/v1/admin/tokens", async () => {
    const rows = dbs.db.prepare(`SELECT id, name, created_at FROM tokens ORDER BY id`).all();
    return { ok: true, data: rows };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/admin/tokens/:id", async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return reply.code(400).send({ ok: false, error: "BAD_REQUEST", message: "bad id" });
    }
    const res = dbs.db.prepare(`DELETE FROM tokens WHERE id = ?`).run(id);
    if (res.changes === 0) {
      return reply.code(404).send({ ok: false, error: "NOT_FOUND", message: "token not found" });
    }
    return { ok: true, data: { deleted: id } };
  });

  // 统计汇总（供管理面板/调试）
  app.get("/api/v1/admin/stats", async () => {
    const counts = {
      objects: (dbs.db.prepare(`SELECT COUNT(*) c FROM objects`).get() as { c: number }).c,
      sessions: (dbs.db.prepare(`SELECT COUNT(*) c FROM session_headers`).get() as { c: number }).c,
      entries: (dbs.db.prepare(`SELECT COUNT(*) c FROM session_entries`).get() as { c: number }).c,
      conflicts: (dbs.db.prepare(`SELECT COUNT(*) c FROM conflicts`).get() as { c: number }).c,
      devices: (dbs.db.prepare(`SELECT COUNT(*) c FROM devices`).get() as { c: number }).c,
    };
    return { ok: true, data: counts };
  });
}
