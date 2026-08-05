import type { FastifyInstance } from "fastify";
import type { SyncDb } from "../db.js";

interface EntryView {
  id: string;
  type: string;
  role?: string;
  text?: string;
  model?: string;
  provider?: string;
  ts?: number;
  toolName?: string;
  usage?: { input: number; output: number; totalTokens: number; cost: number };
  summary?: string;
}

/** 从消息 content 提取可读文本（string 或 block 数组） */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const block = b as Record<string, unknown>;
        if (block.type === "text") return String(block.text ?? "");
        if (block.type === "toolCall") {
          const name = String(block.name ?? "tool");
          return `[调用工具 ${name}]`;
        }
        if (block.type === "image") return "[图片]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function parseEntry(line: string): EntryView | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const id = String(obj.id ?? "");
    const tsRaw = obj.timestamp;
    const ts = typeof tsRaw === "string" ? Date.parse(tsRaw) : typeof tsRaw === "number" ? tsRaw : undefined;
    const base: EntryView = { id, type: String(obj.type ?? "?"), ts: Number.isNaN(ts ?? NaN) ? undefined : ts };

    if (obj.type === "message") {
      const m = (obj.message ?? {}) as Record<string, unknown>;
      base.role = String(m.role ?? "");
      base.text = extractText(m.content);
      base.model = typeof m.model === "string" ? m.model : undefined;
      base.provider = typeof m.provider === "string" ? m.provider : undefined;
      if (m.role === "toolResult") base.toolName = typeof m.toolName === "string" ? m.toolName : undefined;
      const u = (m.usage ?? {}) as Record<string, unknown>;
      if (u && Object.keys(u).length > 0) {
        const cost = (u.cost ?? {}) as Record<string, unknown>;
        base.usage = {
          input: Number(u.input ?? 0),
          output: Number(u.output ?? 0),
          totalTokens: Number(u.totalTokens ?? 0),
          cost: Number(cost.total ?? 0),
        };
      }
      return base;
    }
    if (obj.type === "compaction") {
      base.summary = typeof obj.summary === "string" ? obj.summary : undefined;
      base.type = "compaction";
      return base;
    }
    if (obj.type === "branch_summary") {
      base.summary = typeof obj.summary === "string" ? obj.summary : undefined;
      base.type = "branch_summary";
      return base;
    }
    // 其余类型（session_info / model_change / thinking_level_change / custom / label）
    base.type = String(obj.type ?? "?");
    if (obj.type === "session_info") base.text = String(obj.name ?? "");
    if (obj.type === "model_change") base.text = `${obj.provider ?? ""}/${obj.modelId ?? ""}`;
    return base;
  } catch {
    return null;
  }
}

/** 注册网页端 API（受 /api/v1 token 认证保护） */
export function registerWebRoutes(app: FastifyInstance, dbs: SyncDb) {
  // 会话列表
  app.get("/api/v1/web/sessions", async () => {
    const rows = dbs.db
      .prepare(
        `SELECT h.uuid, h.cwd, h.name, h.version, h.deleted, h.updated_by, h.updated_at,
                (SELECT COUNT(*) FROM session_entries e WHERE e.session_uuid = h.uuid) AS entry_count
         FROM session_headers h
         ORDER BY h.updated_at DESC`,
      )
      .all() as Array<{
      uuid: string;
      cwd: string;
      name: string | null;
      version: number;
      deleted: number;
      updated_by: string;
      updated_at: number;
      entry_count: number;
    }>;
    return {
      ok: true,
      data: rows.map((r) => ({
        uuid: r.uuid,
        cwd: r.cwd,
        name: r.name,
        version: r.version,
        deleted: r.deleted === 1,
        updatedBy: r.updated_by,
        updatedAt: r.updated_at,
        entryCount: r.entry_count,
      })),
    };
  });

  // 会话详情（条目流）
  app.get<{ Params: { uuid: string }; Querystring: { limit?: string; offset?: string } }>(
    "/api/v1/web/sessions/:uuid",
    async (req, reply) => {
      const uuid = req.params.uuid;
      const header = dbs.db
        .prepare(`SELECT * FROM session_headers WHERE uuid = ?`)
        .get(uuid) as
        | { uuid: string; cwd: string; name: string | null; header: string | null; created_at: number | null; deleted: number; updated_by: string; updated_at: number }
        | undefined;
      if (!header) {
        return reply.code(404).send({ ok: false, error: "NOT_FOUND", message: "session not found" });
      }

      const limit = Math.min(Math.max(parseInt(req.query.limit ?? "1000", 10) || 1000, 1), 5000);
      const offset = Math.max(parseInt(req.query.offset ?? "0", 10) || 0, 0);

      const rows = dbs.db
        .prepare(
          `SELECT line, source_device, received_at FROM session_entries
           WHERE session_uuid = ? ORDER BY received_at LIMIT ? OFFSET ?`,
        )
        .all(uuid, limit, offset) as Array<{ line: string; source_device: string; received_at: number }>;

      const entries: EntryView[] = [];
      for (const r of rows) {
        const e = parseEntry(r.line);
        if (e) {
          (e as unknown as { sourceDevice?: string }).sourceDevice = r.source_device;
          entries.push(e);
        }
      }

      return {
        ok: true,
        data: {
          uuid,
          cwd: header.cwd,
          name: header.name,
          headerJson: header.header,
          createdAt: header.created_at,
          deleted: header.deleted === 1,
          updatedBy: header.updated_by,
          updatedAt: header.updated_at,
          total: (dbs.db.prepare(`SELECT COUNT(*) c FROM session_entries WHERE session_uuid = ?`).get(uuid) as { c: number }).c,
          offset,
          entries,
        },
      };
    },
  );
}
