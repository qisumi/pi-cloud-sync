import type { FastifyInstance } from "fastify";
import type { SyncDb } from "../db.js";

interface AggregateRow {
  requests: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total: number;
  cost: number;
  sessions?: number;
  devices?: number;
}

const aggregateColumns = `COALESCE(SUM(requests), 0) AS requests,
  COALESCE(SUM(input_tokens), 0) AS input,
  COALESCE(SUM(output_tokens), 0) AS output,
  COALESCE(SUM(cache_read), 0) AS cache_read,
  COALESCE(SUM(cache_write), 0) AS cache_write,
  COALESCE(SUM(total_tokens), 0) AS total,
  COALESCE(SUM(cost), 0) AS cost`;

/** 仅对已物化的 session_usage 做 SQL 聚合，不再解析会话正文。 */
export function registerStatsRoutes(app: FastifyInstance, dbs: SyncDb) {
  app.get<{
    Querystring: { days?: string; device?: string; deviceId?: string; model?: string };
  }>("/api/v1/web/stats", async (req) => {
    const daysRaw = req.query.days;
    const days = daysRaw && daysRaw !== "all" ? Math.max(1, Number.parseInt(daysRaw, 10) || 1) : null;
    const cutoff = days ? Date.now() - days * 86400_000 : null;
    let deviceId = String(req.query.deviceId ?? "").trim();
    if (!deviceId && req.query.device) {
      const row = dbs.db.prepare(`SELECT device_id FROM devices WHERE name = ? ORDER BY last_seen DESC LIMIT 1`).get(req.query.device) as
        | { device_id: string }
        | undefined;
      deviceId = row?.device_id ?? "";
    }
    const model = String(req.query.model ?? "").trim();
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (cutoff) {
      clauses.push(`u.occurred_at >= ?`);
      params.push(cutoff);
    }
    if (deviceId) {
      clauses.push(`u.source_device_id = ?`);
      params.push(deviceId);
    }
    if (model) {
      clauses.push(`u.model = ?`);
      params.push(model);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const summary = dbs.db
      .prepare(
        `SELECT ${aggregateColumns}, COUNT(DISTINCT session_uuid) AS sessions,
           COUNT(DISTINCT NULLIF(source_device_id, '')) AS devices
         FROM session_usage u ${where}`,
      )
      .get(...params) as AggregateRow & { sessions: number; devices: number };

    const dayRows = dbs.db
      .prepare(
        `SELECT strftime('%Y-%m-%d', occurred_at / 1000, 'unixepoch', 'localtime') AS label,
           ${aggregateColumns} FROM session_usage u ${where}
         GROUP BY label ORDER BY label`,
      )
      .all(...params) as Array<AggregateRow & { label: string }>;
    const modelRows = dbs.db
      .prepare(
        `SELECT CASE WHEN model = '' THEN '(unknown)' ELSE model END AS label,
           ${aggregateColumns} FROM session_usage u ${where}
         GROUP BY label ORDER BY total DESC`,
      )
      .all(...params) as Array<AggregateRow & { label: string }>;
    const deviceRows = dbs.db
      .prepare(
        `SELECT u.source_device_id AS device_id, COALESCE(d.name, u.source_device, 'unknown') AS label,
           ${aggregateColumns} FROM session_usage u
         LEFT JOIN devices d ON d.device_id = u.source_device_id ${where}
         GROUP BY u.source_device_id, label ORDER BY total DESC`,
      )
      .all(...params) as Array<AggregateRow & { device_id: string; label: string }>;

    const optionClauses = cutoff ? `WHERE u.occurred_at >= ?` : "";
    const optionParams = cutoff ? [cutoff] : [];
    const devices = dbs.db
      .prepare(
        `SELECT DISTINCT u.source_device_id AS device_id, COALESCE(d.name, u.source_device, 'unknown') AS name
         FROM session_usage u LEFT JOIN devices d ON d.device_id = u.source_device_id ${optionClauses}
         ORDER BY name`,
      )
      .all(...optionParams) as Array<{ device_id: string; name: string }>;
    const models = dbs.db
      .prepare(`SELECT DISTINCT CASE WHEN model = '' THEN '(unknown)' ELSE model END AS model FROM session_usage u ${optionClauses} ORDER BY model`)
      .all(...optionParams) as Array<{ model: string }>;

    const base = (row: AggregateRow) => ({
      requests: row.requests,
      input: row.input,
      output: row.output,
      cacheRead: row.cache_read,
      cacheWrite: row.cache_write,
      total: row.total,
      cost: row.cost,
    });
    return {
      ok: true,
      data: {
        range: { days, from: cutoff, to: Date.now() },
        summary: {
          ...base(summary),
          totalTokens: summary.total,
          sessions: summary.sessions,
          devices: summary.devices,
        },
        byDay: dayRows.map((row) => ({ date: row.label, ...base(row) })),
        byModel: modelRows.map((row) => ({ model: row.label, ...base(row) })),
        byDevice: deviceRows.map((row) => ({ deviceId: row.device_id, device: row.label, ...base(row) })),
        devices: devices.map((row) => ({ deviceId: row.device_id, name: row.name })),
        models: models.map((row) => row.model),
      },
    };
  });
}
