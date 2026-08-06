import type { FastifyInstance } from "fastify";
import type { SyncDb } from "../db.js";
import { pruneSessions } from "../sessions.js";
import { usageCostUsd } from "../pricing.js";

interface EntryView {
  id: string;
  type: "message";
  role: "user" | "assistant";
  text: string;
  model?: string;
  provider?: string;
  ts?: number;
  sourceDevice?: string;
  usage?: { input: number; output: number; totalTokens: number; cost: number };
}

/** 仅提取对话正文；thinking 与 toolCall 块不会进入网页阅读流。 */
function extractReadableText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((value) => {
      const block = value as Record<string, unknown>;
      if (block.type === "text") return String(block.text ?? "");
      if (block.type === "image") return "[图片]";
      return "";
    })
    .filter((text) => text.trim().length > 0)
    .join("\n\n")
    .trim();
}

/** 网页只展示真实的 user / assistant 文本消息，工具结果与纯工具调用仍可参与统计。 */
function parseReadableEntry(line: string): EntryView | null {
  try {
    const object = JSON.parse(line) as Record<string, unknown>;
    if (object.type !== "message" || !object.message || typeof object.message !== "object") return null;
    const message = object.message as Record<string, unknown>;
    const role = String(message.role ?? "");
    if (role !== "user" && role !== "assistant") return null;
    const text = extractReadableText(message.content);
    if (!text) return null;

    const tsRaw = object.timestamp;
    const ts = typeof tsRaw === "string" ? Date.parse(tsRaw) : typeof tsRaw === "number" ? tsRaw : undefined;
    const entry: EntryView = {
      id: String(object.id ?? ""),
      type: "message",
      role,
      text,
      model: typeof message.model === "string" ? message.model : undefined,
      provider: typeof message.provider === "string" ? message.provider : undefined,
      ts: Number.isNaN(ts ?? Number.NaN) ? undefined : ts,
    };
    const usage = message.usage as Record<string, unknown> | undefined;
    if (usage && Object.keys(usage).length > 0) {
      const cost = (usage.cost ?? {}) as Record<string, unknown>;
      const input = Number(usage.input ?? 0) || 0;
      const output = Number(usage.output ?? 0) || 0;
      const cacheRead = Number(usage.cacheRead ?? 0) || 0;
      const cacheWrite = Number(usage.cacheWrite ?? 0) || 0;
      entry.usage = {
        input,
        output,
        totalTokens: Number(usage.totalTokens ?? 0) || 0,
        cost: usageCostUsd({ provider: entry.provider ?? "", model: entry.model ?? "", input, output, cacheRead, cacheWrite }, Number(cost.total ?? 0) || 0),
      };
    }
    return entry;
  } catch {
    return null;
  }
}

function positiveInt(value: string | undefined, fallback: number, max: number): number {
  return Math.min(Math.max(Number.parseInt(value ?? "", 10) || fallback, 1), max);
}

/** 注册网页端 API（受 /api/v1 token 认证保护） */
export function registerWebRoutes(app: FastifyInstance, dbs: SyncDb) {
  app.get<{
    Querystring: { page?: string; limit?: string; q?: string; status?: string; sort?: string };
  }>("/api/v1/web/sessions", async (req) => {
    const page = positiveInt(req.query.page, 1, 1_000_000);
    const pageSize = positiveInt(req.query.limit, 40, 100);
    const query = String(req.query.q ?? "").trim().slice(0, 200);
    const status = ["active", "deleted", "all"].includes(String(req.query.status))
      ? String(req.query.status)
      : "active";
    const sort = String(req.query.sort ?? "updated-desc");
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (status === "active") clauses.push("h.deleted = 0");
    if (status === "deleted") clauses.push("h.deleted = 1");
    if (query) {
      clauses.push(
        `(instr(lower(COALESCE(h.name, '')), lower(?)) > 0
          OR instr(lower(COALESCE(h.cwd, '')), lower(?)) > 0
          OR instr(lower(h.uuid), lower(?)) > 0
          OR instr(lower(COALESCE(h.updated_by, '')), lower(?)) > 0)`,
      );
      params.push(query, query, query, query);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const order =
      sort === "updated-asc"
        ? "h.updated_at ASC"
        : sort === "entries-desc"
          ? "entry_count DESC, h.updated_at DESC"
          : sort === "name-asc"
            ? "COALESCE(h.name, h.uuid) COLLATE NOCASE ASC"
            : "h.updated_at DESC";

    const total = (dbs.db.prepare(`SELECT COUNT(*) AS count FROM session_headers h ${where}`).get(...params) as {
      count: number;
    }).count;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * pageSize;
    const rows = dbs.db
      .prepare(
        `SELECT h.uuid, h.cwd, h.name, h.version, h.deleted, h.content_pruned, h.updated_by, h.updated_at,
                h.entry_count, h.total_tokens AS retained_tokens, h.total_cost AS retained_cost
         FROM session_headers h
         ${where}
         ORDER BY ${order}
         LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, offset) as Array<{
      uuid: string;
      cwd: string;
      name: string | null;
      version: number;
      deleted: number;
      content_pruned: number;
      updated_by: string;
      updated_at: number;
      entry_count: number;
      retained_tokens: number;
      retained_cost: number;
    }>;

    return {
      ok: true,
      data: {
        items: rows.map((row) => ({
          uuid: row.uuid,
          cwd: row.cwd,
          name: row.name,
          version: row.version,
          deleted: row.deleted === 1,
          contentPruned: row.content_pruned === 1,
          updatedBy: row.updated_by,
          updatedAt: row.updated_at,
          entryCount: row.entry_count,
          retainedTokens: row.retained_tokens,
          retainedCost: row.retained_cost,
        })),
        page: safePage,
        pageSize,
        total,
        totalPages,
      },
    };
  });

  app.get<{ Params: { uuid: string }; Querystring: { limit?: string; offset?: string } }>(
    "/api/v1/web/sessions/:uuid",
    async (req, reply) => {
      const uuid = req.params.uuid;
      const header = dbs.db.prepare(`SELECT * FROM session_headers WHERE uuid = ?`).get(uuid) as
        | {
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
        | undefined;
      if (!header) return reply.code(404).send({ ok: false, error: "NOT_FOUND", message: "session not found" });

      const limit = positiveInt(req.query.limit, 100, 500);
      const offset = Math.max(Number.parseInt(req.query.offset ?? "0", 10) || 0, 0);
      const rows = dbs.db
        .prepare(
          `SELECT line, source_device, received_at FROM session_entries
           WHERE session_uuid = ? AND readable = 1 ORDER BY sort_seq LIMIT ? OFFSET ?`,
        )
        .all(uuid, limit, offset) as Array<{ line: string; source_device: string; received_at: number }>;
      const readable: EntryView[] = [];
      for (const row of rows) {
        const entry = parseReadableEntry(row.line);
        if (!entry) continue;
        entry.sourceDevice = row.source_device;
        readable.push(entry);
      }
      const usage = dbs.db
        .prepare(
          `SELECT COALESCE(SUM(requests), 0) AS requests,
                  COALESCE(SUM(total_tokens), 0) AS total_tokens,
                  COALESCE(SUM(cost), 0) AS cost,
                  COUNT(DISTINCT NULLIF(model, '')) AS models
           FROM session_usage WHERE session_uuid = ?`,
        )
        .get(uuid) as { requests: number; total_tokens: number; cost: number; models: number };

      return {
        ok: true,
        data: {
          uuid,
          cwd: header.cwd,
          name: header.name,
          headerJson: header.header,
          createdAt: header.created_at,
          version: header.version,
          deleted: header.deleted === 1,
          contentPruned: header.content_pruned === 1,
          updatedBy: header.updated_by,
          updatedAt: header.updated_at,
          total: header.readable_count,
          rawTotal: header.entry_count,
          offset,
          entries: readable,
          usageSummary: {
            requests: usage.requests,
            totalTokens: usage.total_tokens,
            cost: usage.cost,
            models: usage.models,
          },
        },
      };
    },
  );

  app.post<{ Body: { uuids?: unknown; confirm?: boolean } }>(
    "/api/v1/web/sessions/delete",
    async (req, reply) => {
      if (req.body?.confirm !== true) {
        return reply.code(400).send({ ok: false, error: "BAD_REQUEST", message: "confirm must be true" });
      }
      if (!Array.isArray(req.body?.uuids)) {
        return reply.code(400).send({ ok: false, error: "BAD_REQUEST", message: "uuids must be an array" });
      }
      const uuids = req.body.uuids
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0 && value.length <= 160);
      if (uuids.length === 0 || uuids.length > 200) {
        return reply.code(400).send({ ok: false, error: "BAD_REQUEST", message: "select 1-200 sessions" });
      }
      return { ok: true, data: pruneSessions(dbs, uuids, "web-console") };
    },
  );
}
