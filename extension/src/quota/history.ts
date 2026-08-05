/**
 * 额度快照历史：每次探测后追加到 agentDir/pi-quota.jsonl，
 * 用于对比两次探测之间的消耗（余额减少 / 用量增加）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "../config.js";
import type { QuotaProbeResult, QuotaSnapshot } from "./types.js";

const HISTORY_FILE = "pi-quota.jsonl";
const MAX_LOAD = 50;

export function quotaHistoryPath(): string {
  return join(agentDir(), HISTORY_FILE);
}

/** 从探测结果构建可持久化的快照 */
export function toSnapshot(providers: QuotaProbeResult[], ts: number): QuotaSnapshot {
  const pick = (id: "deepseek" | "zai" | "codex") => providers.find((p) => p.provider === id);
  const meter = (p: QuotaProbeResult | undefined, id: string) => p?.meters.find((m) => m.id === id);

  const ds = pick("deepseek");
  const zai = pick("zai");
  const codex = pick("codex");

  return {
    ts,
    deepseek:
      ds?.ok && meter(ds, "deepseek.balance")?.current != null
        ? {
            balance: meter(ds, "deepseek.balance")!.current!,
            currency: meter(ds, "deepseek.balance")!.unit,
          }
        : null,
    zai:
      zai?.ok && (meter(zai, "zai.fiveHour")?.usedPct != null || meter(zai, "zai.weekly")?.usedPct != null)
        ? {
            fiveHourUsedPct: meter(zai, "zai.fiveHour")?.usedPct ?? null,
            weeklyUsedPct: meter(zai, "zai.weekly")?.usedPct ?? null,
          }
        : null,
    codex:
      codex?.ok && meter(codex, "codex.weekly")?.usedPct != null
        ? {
            fiveHourUsedPct: meter(codex, "codex.fiveHour")?.usedPct ?? null,
            weeklyUsedPct: meter(codex, "codex.weekly")?.usedPct ?? null,
            weeklyResetsAt: meter(codex, "codex.weekly")?.resetsAt ?? null,
          }
        : null,
  };
}

/** 追加一条快照到历史文件（写失败不阻塞） */
export function recordSnapshot(snapshot: QuotaSnapshot): void {
  try {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(quotaHistoryPath(), JSON.stringify(snapshot) + "\n", { flag: "a" });
  } catch {
    // ignore
  }
}

/** 读取历史快照（新→旧），最多 MAX_LOAD 条 */
export function loadHistory(limit = MAX_LOAD): QuotaSnapshot[] {
  const out: QuotaSnapshot[] = [];
  try {
    if (!existsSync(quotaHistoryPath())) return out;
    const lines = readFileSync(quotaHistoryPath(), "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]) as QuotaSnapshot);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return out;
}

/** 最近一条快照（不含本次） */
export function latestSnapshot(beforeTs = Date.now()): QuotaSnapshot | null {
  const h = loadHistory();
  return h.find((s) => s.ts < beforeTs) ?? null;
}

/** 本次探测的消耗/用量对比（vs 上一次快照） */
export interface QuotaDeltas {
  /** DeepSeek 余额减少额（上次 - 本次），无则为 null */
  deepseekSpent: number | null;
  /** Z.AI 5h 已用百分比增加 */
  zaiFiveHourDelta: number | null;
  /** Z.AI 周已用百分比增加 */
  zaiWeeklyDelta: number | null;
  /** Codex 周已用百分比增加 */
  codexWeeklyDelta: number | null;
}

export function computeDeltas(current: QuotaSnapshot, prev: QuotaSnapshot | null): QuotaDeltas {
  if (!prev) {
    return { deepseekSpent: null, zaiFiveHourDelta: null, zaiWeeklyDelta: null, codexWeeklyDelta: null };
  }
  return {
    deepseekSpent:
      current.deepseek && prev.deepseek
        ? Math.max(0, Math.round((prev.deepseek.balance - current.deepseek.balance) * 100) / 100)
        : null,
    zaiFiveHourDelta:
      current.zai?.fiveHourUsedPct != null && prev.zai?.fiveHourUsedPct != null
        ? Math.max(0, current.zai.fiveHourUsedPct - prev.zai.fiveHourUsedPct)
        : null,
    zaiWeeklyDelta:
      current.zai?.weeklyUsedPct != null && prev.zai?.weeklyUsedPct != null
        ? Math.max(0, current.zai.weeklyUsedPct - prev.zai.weeklyUsedPct)
        : null,
    codexWeeklyDelta:
      current.codex?.weeklyUsedPct != null && prev.codex?.weeklyUsedPct != null
        ? Math.max(0, current.codex.weeklyUsedPct - prev.codex.weeklyUsedPct)
        : null,
  };
}
