import type { FastifyInstance } from "fastify";
import type { SyncDb } from "../db.js";

/**
 * 用量统计聚合（受 /api/v1 token 认证保护）。
 *
 * 数据来源：session_entries 中的 JSONL 消息条目（assistant / toolResult 的 usage、
 * compaction 的 usage）。按 天 / 模型 / 设备 聚合 tokens 与金额(cost)，支持
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

interface UsageHit {
  ts: number;
  provider: string;
  model: string;
  device: string;
  sessionUuid: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

/** 从一条 JSONL 会话条目中解析用量命中；无用量信息返回 null */
function parseHit(line: string, sourceDevice: string, sessionUuid: string): UsageHit | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const tsRaw = obj.timestamp;
    const ts = typeof tsRaw === "string" ? Date.parse(tsRaw) : typeof tsRaw === "number" ? tsRaw : undefined;
    if (typeof ts !== "number" || Number.isNaN(ts)) return null;

    let role = "";
    let provider = "";
    let model = "";
    let usage: Record<string, unknown> | undefined;

    if (obj.type === "message" && obj.message && typeof obj.message === "object") {
      const m = obj.message as Record<string, unknown>;
      role = String(m.role ?? "");
      if (role !== "assistant" && role !== "toolResult") return null;
      provider = String(m.provider ?? "");
      model = String(m.model ?? "");
      usage = (m.usage ?? undefined) as Record<string, unknown> | undefined;
    } else if (obj.type === "compaction") {
      model = "(compaction)";
      usage = (obj.usage ?? undefined) as Record<string, unknown> | undefined;
    } else {
      return null;
    }
    if (!usage || typeof usage !== "object" || Object.keys(usage).length === 0) return null;

    const input = Number(usage.input ?? 0) || 0;
    const output = Number(usage.output ?? 0) || 0;
    const cacheRead = Number(usage.cacheRead ?? 0) || 0;
    const cacheWrite = Number(usage.cacheWrite ?? 0) || 0;
    const total = Number(usage.totalTokens ?? 0) || input + output + cacheRead + cacheWrite;
    const costObj = (usage.cost ?? {}) as Record<string, unknown>;
    const cost = Number(costObj.total ?? 0) || 0;
    if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && total === 0 && cost === 0) {
      return null; // 无用量信息
    }
    return { ts, provider, model, device: sourceDevice, sessionUuid, input, output, cacheRead, cacheWrite, total, cost };
  } catch {
    return null; // 损坏行
  }
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function addAgg(map: Map<string, StatsAgg>, key: string, hit: UsageHit): void {
  const row = map.get(key) ?? emptyAgg();
  row.requests += 1;
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

    const stmt = dbs.db.prepare(
      `SELECT line, source_device, session_uuid FROM session_entries`,
    );

    for (const r of stmt.iterate() as IterableIterator<{
      line: string;
      source_device: string;
      session_uuid: string;
    }>) {
      const hit = parseHit(r.line, r.source_device, r.session_uuid);
      if (!hit) continue;
      if (cutoff && hit.ts < cutoff) continue;

      allDevices.add(hit.device || "unknown");
      allModels.add(hit.model || "(unknown)");
      if (deviceFilter && hit.device !== deviceFilter) continue;
      if (modelFilter && hit.model !== modelFilter) continue;

      summary.requests += 1;
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
