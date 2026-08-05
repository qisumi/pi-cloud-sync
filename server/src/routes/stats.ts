import type { FastifyInstance } from "fastify";
import type { SyncDb } from "../db.js";
import { parseUsageHit, type UsageHit } from "../usage.js";

/**
 * 用量统计聚合（受 /api/v1 token 认证保护）。
 *
 * 数据来源：活跃会话的 session_entries，以及正文裁剪后不含内容的 session_usage。
 * 按 天 / 模型 / 设备 聚合 tokens 与金额(cost)，支持
 * days(1d/7d/30d/all)、device、model 过滤，默认聚合全部客户端。
 */

interface StatsAgg {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

function emptyAgg(): StatsAgg {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function addAgg(map: Map<string, StatsAgg>, key: string, hit: UsageHit): void {
  const row = map.get(key) ?? emptyAgg();
  row.requests += hit.requests;
  row.input += hit.input;
  row.output += hit.output;
  row.cacheRead += hit.cacheRead;
  row.cacheWrite += hit.cacheWrite;
  row.total += hit.total;
  row.cost += hit.cost;
  map.set(key, row);
}

export function registerStatsRoutes(app: FastifyInstance, dbs: SyncDb) {
  app.get<{
    Querystring: { days?: string; device?: string; model?: string };
  }>("/api/v1/web/stats", async (req) => {
    const daysRaw = req.query.days;
    const days =
      daysRaw && daysRaw !== "all" ? Math.max(1, parseInt(daysRaw, 10) || 0) : null;
    const deviceFilter = req.query.device ? String(req.query.device) : null;
    const modelFilter = req.query.model ? String(req.query.model) : null;

    const nowMs = Date.now();
    const cutoff = days ? nowMs - days * 86400_000 : null;

    const summary: StatsAgg & { sessions: number } = { ...emptyAgg(), sessions: 0 };
    const dayMap = new Map<string, StatsAgg>();
    const modelMap = new Map<string, StatsAgg>();
    const deviceMap = new Map<string, StatsAgg>();
    const sessionSet = new Set<string>();

    // 过滤下拉选项：只看时间范围内出现过的设备/模型（不受 device/model 筛选影响）
    const allDevices = new Set<string>();
    const allModels = new Set<string>();

    const consumeHit = (hit: UsageHit) => {
      if (cutoff && hit.ts < cutoff) return;

      allDevices.add(hit.device || "unknown");
      allModels.add(hit.model || "(unknown)");
      if (deviceFilter && hit.device !== deviceFilter) return;
      if (modelFilter && hit.model !== modelFilter) return;

      summary.requests += hit.requests;
      summary.input += hit.input;
      summary.output += hit.output;
      summary.cacheRead += hit.cacheRead;
      summary.cacheWrite += hit.cacheWrite;
      summary.total += hit.total;
      summary.cost += hit.cost;
      sessionSet.add(hit.sessionUuid);

      addAgg(dayMap, dayLabel(hit.ts), hit);
      addAgg(modelMap, hit.model || "(unknown)", hit);
      addAgg(deviceMap, hit.device || "unknown", hit);
    };

    const stmt = dbs.db.prepare(`SELECT line, source_device, session_uuid FROM session_entries`);

    for (const r of stmt.iterate() as IterableIterator<{
      line: string;
      source_device: string;
      session_uuid: string;
    }>) {
      const hit = parseUsageHit(r.line, r.source_device, r.session_uuid);
      if (!hit) continue;
      consumeHit(hit);
    }

    const usageSql =
      `SELECT session_uuid, entry_id, occurred_at, provider, model, source_device, requests,
              input_tokens, output_tokens, cache_read, cache_write, total_tokens, cost
       FROM session_usage${cutoff ? " WHERE occurred_at >= ?" : ""}`;
    const usageRows = cutoff
      ? dbs.db.prepare(usageSql).iterate(cutoff)
      : dbs.db.prepare(usageSql).iterate();
    for (const row of usageRows as IterableIterator<{
      session_uuid: string;
      entry_id: string;
      occurred_at: number;
      provider: string;
      model: string;
      source_device: string;
      requests: number;
      input_tokens: number;
      output_tokens: number;
      cache_read: number;
      cache_write: number;
      total_tokens: number;
      cost: number;
    }>) {
      consumeHit({
        entryId: row.entry_id,
        ts: row.occurred_at,
        provider: row.provider,
        model: row.model,
        device: row.source_device,
        sessionUuid: row.session_uuid,
        requests: row.requests,
        input: row.input_tokens,
        output: row.output_tokens,
        cacheRead: row.cache_read,
        cacheWrite: row.cache_write,
        total: row.total_tokens,
        cost: row.cost,
      });
    }
    summary.sessions = sessionSet.size;

    const sortByTotalDesc = (rows: Array<[string, StatsAgg]>) =>
      [...rows].sort((a, b) => b[1].total - a[1].total);

    const byDay = [...dayMap.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, a]) => ({
        date,
        requests: a.requests,
        input: a.input,
        output: a.output,
        total: a.total,
        cost: a.cost,
      }));

    const byModel = sortByTotalDesc([...modelMap.entries()]).map(([model, a]) => ({
      model,
      requests: a.requests,
      input: a.input,
      output: a.output,
      cacheRead: a.cacheRead,
      cacheWrite: a.cacheWrite,
      total: a.total,
      cost: a.cost,
    }));

    const byDevice = sortByTotalDesc([...deviceMap.entries()]).map(([device, a]) => ({
      device,
      requests: a.requests,
      input: a.input,
      output: a.output,
      total: a.total,
      cost: a.cost,
    }));

    return {
      ok: true,
      data: {
        range: { days, from: cutoff, to: nowMs },
        summary: {
          requests: summary.requests,
          input: summary.input,
          output: summary.output,
          cacheRead: summary.cacheRead,
          cacheWrite: summary.cacheWrite,
          totalTokens: summary.total,
          cost: summary.cost,
          sessions: summary.sessions,
          devices: allDevices.size,
        },
        byDay,
        byModel,
        byDevice,
        devices: [...allDevices].sort(),
        models: [...allModels].sort(),
      },
    };
  });
}
