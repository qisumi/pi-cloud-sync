import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { sessionsDir } from "../sync/sessions.js";
import { agentDir } from "../config.js";
import type { UsageRecord, UsageInput } from "./collector.js";
import { estimateUsageCostUsd } from "./pricing.js";

/* ---------------- 会话扫描（历史数据补齐） ---------------- */

interface UsageField {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

function normalizeUsage(
  u: UsageField | undefined,
  provider: string,
  model: string,
): Required<Pick<UsageRecord, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens" | "cost">> {
  const input = u?.input ?? 0;
  const output = u?.output ?? 0;
  const cacheRead = u?.cacheRead ?? 0;
  const cacheWrite = u?.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: u?.totalTokens ?? 0,
    cost: estimateUsageCostUsd({ provider, model, input, output, cacheRead, cacheWrite }, u?.cost?.total ?? 0),
  };
}

/** 扫描单个会话文件，生成 usage 记录（按 entryId 去重） */
export function scanSessionFile(
  path: string,
  sessionId: string,
  project: string,
  sessionName: string | null,
  device: string,
): UsageRecord[] {
  const out: UsageRecord[] = [];
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return out;
  }

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as {
        type?: string;
        id?: string;
        timestamp?: string;
        message?: {
          role?: string;
          provider?: string;
          model?: string;
          usage?: UsageField;
        };
        usage?: UsageField;
      };
      const id = obj.id ?? "";
      const ts = obj.timestamp ? Date.parse(obj.timestamp) : Date.now();
      if (Number.isNaN(ts)) continue;

      if (obj.type === "message" && obj.message) {
        const m = obj.message;
        if ((m.role === "assistant" || m.role === "toolResult") && m.usage) {
          const u = normalizeUsage(m.usage, m.provider ?? "", m.model ?? "");
          if (u.input === 0 && u.output === 0 && u.cacheRead === 0 && u.cacheWrite === 0 && u.cost === 0 && !u.totalTokens) {
            continue; // 无用量信息
          }
          out.push({
            key: `${sessionId}|${m.role}|${id}`,
            ts,
            sessionId,
            sessionName,
            project,
            provider: m.provider ?? "",
            model: m.model ?? "",
            ...u,
            requests: 1,
            device,
            source: "scan",
          });
        }
      } else if (obj.type === "compaction" && obj.usage) {
        const u = normalizeUsage(obj.usage, "", "(compaction)");
        out.push({
          key: `${sessionId}|compaction|${id}`,
          ts,
          sessionId,
          sessionName,
          project,
          provider: "",
          model: "(compaction)",
          ...u,
          requests: 1,
          device,
          source: "scan",
        });
      }
    } catch {
      // 忽略损坏行
    }
  }
  return out;
}

/** 扫描全部会话目录 */
export function scanAllSessions(device: string): UsageRecord[] {
  const root = sessionsDir();
  if (!existsSync(root)) return [];
  const indexPath = join(agentDir(), "pi-usage-index.json");
  const index = loadUsageIndex(indexPath);
  const found = new Set<string>();
  let dirty = false;

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const key = relative(root, p).replace(/\\/g, "/");
        found.add(key);
        const info = statSync(p);
        const cached = index.files[key];
        if (!cached || cached.size !== info.size || cached.mtimeMs !== info.mtimeMs) {
          index.files[key] = { size: info.size, mtimeMs: info.mtimeMs, records: parseSessionForScan(p, device) };
          dirty = true;
        } else if (cached.records.some((record) => record.device !== device)) {
          cached.records.forEach((record) => { record.device = device; });
          dirty = true;
        }
      }
    }
  };
  walk(root);
  for (const key of Object.keys(index.files)) {
    if (!found.has(key)) {
      delete index.files[key];
      dirty = true;
    }
  }
  if (dirty) saveUsageIndex(indexPath, index);
  const seen = new Set<string>();
  const out: UsageRecord[] = [];
  for (const file of Object.values(index.files)) {
    for (const record of file.records) {
      if (!seen.has(record.key)) {
        seen.add(record.key);
        out.push(record);
      }
    }
  }
  return out;
}

interface UsageIndex {
  version: 1;
  files: Record<string, { size: number; mtimeMs: number; records: UsageRecord[] }>;
}

let memoryUsageIndex: { path: string; value: UsageIndex } | null = null;

function loadUsageIndex(path: string): UsageIndex {
  if (memoryUsageIndex?.path === path) return memoryUsageIndex.value;
  let value: UsageIndex = { version: 1, files: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as UsageIndex;
    if (parsed.version === 1 && parsed.files && typeof parsed.files === "object") value = parsed;
  } catch {
    // 首次运行或旧索引损坏时按需重建。
  }
  memoryUsageIndex = { path, value };
  return value;
}

function saveUsageIndex(path: string, index: UsageIndex): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(index), "utf8");
  renameSync(temporary, path);
}

function parseSessionForScan(path: string, device: string): UsageRecord[] {
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
    if (lines.length === 0) return [];
    const header = JSON.parse(lines[0]) as { type?: string; id?: string; cwd?: string };
    if (header.type !== "session" || !header.id) return [];
    let name: string | null = null;
    for (const l of lines) {
      try {
        const o = JSON.parse(l);
        if (o.type === "session_info" && o.name) name = o.name;
      } catch {
        // ignore
      }
    }
    return scanSessionFile(path, header.id, header.cwd ?? "", name, device);
  } catch {
    return [];
  }
}

/* ---------------- 聚合 ---------------- */

export interface AggRow {
  label: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  requests: number;
}

export interface AggSummary {
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalTokens: number;
  totalCost: number;
  requests: number;
  sessions: number;
  firstTs: number | null;
  lastTs: number | null;
}

export interface StatsReport {
  summary: AggSummary;
  byDay: AggRow[];
  byModel: AggRow[];
  bySession: AggRow[];
  sessionDetail: AggRow | null;
  recordsUsed: number;
  liveCount: number;
  scanCount: number;
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 合并 live + 会话扫描记录（同一会话有 live 记录则跳过该会话的 scan 记录） */
export function mergeRecords(live: UsageRecord[], scanned: UsageRecord[]): UsageRecord[] {
  const liveSessions = new Set(live.map((r) => r.sessionId));
  const out = [...live];
  const seen = new Set(live.map((r) => r.key));
  for (const r of scanned) {
    if (liveSessions.has(r.sessionId)) continue; // 会话已有实时数据
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    out.push(r);
  }
  return out;
}

export function buildReport(
  records: UsageRecord[],
  opts: {
    days?: number | null; // 时间范围（天）
    groupBySessionTop?: number; // 会话 Top N
    sessionId?: string | null; // 只看某会话
  } = {},
): StatsReport {
  const now = Date.now();
  const cutoff = opts.days ? now - opts.days * 86400_000 : null;

  const filtered = records.filter((r) => (cutoff ? r.ts >= cutoff : true));

  const summary: AggSummary = {
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    requests: 0,
    sessions: 0,
    firstTs: null,
    lastTs: null,
  };

  const dayMap = new Map<string, AggRow>();
  const modelMap = new Map<string, AggRow>();
  const sessionMap = new Map<string, AggRow>();
  const sessionNames = new Map<string, string>();

  for (const r of filtered) {
    if (r.ts > (summary.lastTs ?? 0)) summary.lastTs = r.ts;
    if (summary.firstTs === null || r.ts < summary.firstTs) summary.firstTs = r.ts;

    summary.totalInput += r.input;
    summary.totalOutput += r.output;
    summary.totalCacheRead += r.cacheRead;
    summary.totalCacheWrite += r.cacheWrite;
    summary.totalTokens += r.totalTokens || r.input + r.output + r.cacheRead + r.cacheWrite;
    summary.totalCost += r.cost;
    summary.requests += r.requests;
    if (r.sessionName) sessionNames.set(r.sessionId, r.sessionName);

    const add = (m: Map<string, AggRow>, key: string, label: string) => {
      const row = m.get(key) ?? { label, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, requests: 0 };
      row.input += r.input;
      row.output += r.output;
      row.cacheRead += r.cacheRead;
      row.cacheWrite += r.cacheWrite;
      row.total += r.totalTokens || r.input + r.output + r.cacheRead + r.cacheWrite;
      row.cost += r.cost;
      row.requests += r.requests;
      m.set(key, row);
    };

    add(dayMap, dayLabel(r.ts), dayLabel(r.ts));
    const modelLabel = r.model || "(unknown)";
    add(modelMap, modelLabel, modelLabel);
    const sessLabel = sessionNames.get(r.sessionId) ?? r.sessionId.slice(0, 8);
    add(sessionMap, r.sessionId, sessLabel);
  }

  summary.sessions = sessionMap.size;

  const sortByTotal = (rows: AggRow[]) => [...rows].sort((a, b) => b.total - a.total);
  const top = opts.groupBySessionTop ?? 10;

  const sessionDetail =
    opts.sessionId && sessionMap.get(opts.sessionId)
      ? {
          ...sessionMap.get(opts.sessionId)!,
          label: sessionNames.get(opts.sessionId) ?? opts.sessionId.slice(0, 8),
        }
      : null;

  return {
    summary,
    byDay: sortByTotal([...dayMap.values()]).reverse(), // 按日期升序
    byModel: sortByTotal([...modelMap.values()]),
    bySession: sortByTotal([...sessionMap.values()]).slice(0, top),
    sessionDetail,
    recordsUsed: filtered.length,
    liveCount: records.filter((r) => r.source === "live").length,
    scanCount: records.filter((r) => r.source === "scan").length,
  };
}
