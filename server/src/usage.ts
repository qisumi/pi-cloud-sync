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

/** 从一条 JSONL 会话条目中解析用量；不保留消息正文或工具内容。
 *  hint 用于 Codex rollout：token_count 行自身不含 model/provider，
 *  需由调用方按最近的 turn_context / session_meta 维护后传入（见 rolloutModelHint）。 */
export function parseUsageHit(
  line: string,
  sourceDevice: string,
  sessionUuid: string,
  hint?: { model?: string; provider?: string },
): UsageHit | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const tsRaw = obj.timestamp;
    const ts = typeof tsRaw === "string" ? Date.parse(tsRaw) : typeof tsRaw === "number" ? tsRaw : undefined;
    if (typeof ts !== "number" || Number.isNaN(ts)) return null;

    const entryId = String(obj.id ?? "");

    // Codex rollout：token 用量记录在 event_msg.payload.type === "token_count" 的 info 里，
    // 取 last_token_usage（本次增量）。input_tokens 已含 cached_input_tokens，需拆分；
    // output_tokens 已含 reasoning_output_tokens；rollout 不报告 cache writes。
    if (obj.type === "event_msg") {
      const payload = obj.payload as Record<string, unknown> | undefined;
      if (payload && payload.type === "token_count") {
        const info = (payload.info ?? {}) as Record<string, unknown>;
        const src = (info.last_token_usage ?? info.total_token_usage ?? {}) as Record<string, unknown>;
        const num = (v: unknown) => Number(v ?? 0) || 0;
        const cacheRead = num(src.cached_input_tokens);
        const input = Math.max(0, num(src.input_tokens) - cacheRead);
        const output = num(src.output_tokens);
        if (input === 0 && cacheRead === 0 && output === 0) return null;
        const total = num(src.total_tokens) || input + cacheRead + output;
        const model = hint?.model ?? "";
        const provider = hint?.provider ?? "codex";
        const cost = usageCostUsd({ provider, model, input, output, cacheRead, cacheWrite: 0 }, 0);
        return {
          entryId,
          ts,
          provider,
          model,
          device: sourceDevice,
          sessionUuid,
          requests: 1,
          input,
          output,
          cacheRead,
          cacheWrite: 0,
          total,
          cost,
        };
      }
      return null;
    }

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
      entryId,
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

/** 从 Codex rollout 行提取当前 model / provider（turn_context / session_meta）。
 *  调用方在有序遍历 entries 时调用本函数维护 hint，再传给 parseUsageHit 处理 token_count 行。
 *  非模型上下文行返回 null（不更新 hint）。 */
export function rolloutModelHint(line: string): { model?: string; provider?: string } | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (typeof obj.type !== "string") return null;
    const payload = obj.payload as Record<string, unknown> | undefined;
    if (!payload) return null;
    if (obj.type === "turn_context") {
      const model = typeof payload.model === "string" ? payload.model.trim() : "";
      return model ? { model } : null;
    }
    if (obj.type === "session_meta") {
      const out: { model?: string; provider?: string } = {};
      const model = typeof payload.model === "string" ? payload.model.trim() : "";
      const provider = typeof payload.model_provider === "string" ? payload.model_provider.trim() : "";
      if (model) out.model = model;
      if (provider) out.provider = provider;
      return Object.keys(out).length > 0 ? out : null;
    }
    return null;
  } catch {
    return null;
  }
}
