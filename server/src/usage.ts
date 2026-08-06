import { usageCostUsd } from "./pricing.js";

export interface UsageHit {
  entryId: string;
  ts: number;
  provider: string;
  model: string;
  device: string;
  sessionUuid: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

/** 从一条 JSONL 会话条目中解析用量；不保留消息正文或工具内容。 */
export function parseUsageHit(line: string, sourceDevice: string, sessionUuid: string): UsageHit | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const tsRaw = obj.timestamp;
    const ts = typeof tsRaw === "string" ? Date.parse(tsRaw) : typeof tsRaw === "number" ? tsRaw : undefined;
    if (typeof ts !== "number" || Number.isNaN(ts)) return null;

    let provider = "";
    let model = "";
    let usage: Record<string, unknown> | undefined;

    if (obj.type === "message" && obj.message && typeof obj.message === "object") {
      const message = obj.message as Record<string, unknown>;
      const role = String(message.role ?? "");
      if (role !== "assistant" && role !== "toolResult") return null;
      provider = String(message.provider ?? "");
      model = String(message.model ?? "");
      usage = message.usage as Record<string, unknown> | undefined;
    } else if (obj.type === "compaction") {
      model = "(compaction)";
      usage = obj.usage as Record<string, unknown> | undefined;
    } else {
      return null;
    }
    if (!usage || typeof usage !== "object" || Object.keys(usage).length === 0) return null;

    const input = Number(usage.input ?? 0) || 0;
    const output = Number(usage.output ?? 0) || 0;
    const cacheRead = Number(usage.cacheRead ?? 0) || 0;
    const cacheWrite = Number(usage.cacheWrite ?? 0) || 0;
    const total = Number(usage.totalTokens ?? 0) || input + output + cacheRead + cacheWrite;
    const costObject = (usage.cost ?? {}) as Record<string, unknown>;
    const reportedCost = Number(costObject.total ?? 0) || 0;
    const cost = usageCostUsd({ provider, model, input, output, cacheRead, cacheWrite }, reportedCost);
    if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && total === 0 && cost === 0) return null;

    return {
      entryId: String(obj.id ?? ""),
      ts,
      provider,
      model,
      device: sourceDevice,
      sessionUuid,
      requests: 1,
      input,
      output,
      cacheRead,
      cacheWrite,
      total,
      cost,
    };
  } catch {
    return null;
  }
}
