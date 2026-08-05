/**
 * 额度探测编排：并发探测 DeepSeek / Z.AI / Codex，记录本地快照，
 * 输出用于 TUI 面板 / 纯文本 / JSON 的展示数据。
 */
import type { QuotaProbeResult, QuotaReport, QuotaSnapshot } from "./types.js";
import { probeDeepSeek, probeZai, probeCodex, type FetchLike } from "./providers.js";
import { recordSnapshot, toSnapshot, latestSnapshot, computeDeltas } from "./history.js";

/** 并发探测全部渠道（Codex 失败不抛错） */
export async function probeAllQuotas(fetchImpl?: FetchLike): Promise<QuotaReport> {
  const ts = Date.now();
  const settled = await Promise.allSettled([
    probeDeepSeek(fetchImpl),
    probeZai(fetchImpl),
    probeCodex(fetchImpl),
  ]);
  const providers: QuotaProbeResult[] = settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    const labels: Array<QuotaProbeResult["provider"]> = ["deepseek", "zai", "codex"];
    return {
      provider: labels[i],
      label: labels[i],
      configured: false,
      ok: false,
      meters: [],
      ts,
      error: s.reason instanceof Error ? s.reason.message : String(s.reason),
    };
  });

  const snapshot = toSnapshot(providers, ts);
  recordSnapshot(snapshot);
  return { ts, providers, prev: latestSnapshot(ts) };
}

/* ---------------- 文本格式化（非 TUI 模式） ---------------- */

function fmtNum(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtReset(resetsAt: number | null): string {
  if (!resetsAt) return "";
  const d = new Date(resetsAt);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDuration(ms: number): string {
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时 ${min % 60} 分`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

function bar(usedPct: number | null, width = 12): string {
  if (usedPct == null) return "░".repeat(width);
  const filled = Math.min(width, Math.max(0, Math.round((usedPct / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function meterLine(m: QuotaProbeResult["meters"][number], padLen: number): string {
  const head = m.label.padEnd(padLen);
  if (m.id === "deepseek.balance") {
    const v = m.current ?? 0;
    const flag = m.status === "critical" ? "⚠" : m.status === "warn" ? "▲" : "●";
    return `${head} ${flag} ${m.unit}${v.toFixed(2)}`;
  }
  if (m.usedPct == null) return `${head} --`;
  const reset = m.resetsAt ? ` · 重置 ${fmtReset(m.resetsAt)}` : "";
  const tokens =
    m.current != null && m.limit != null ? ` (${fmtNum(m.current)}/${fmtNum(m.limit)})` : "";
  return `${head} ${bar(m.usedPct)} ${m.usedPct.toFixed(0)}% 已用 · 剩 ${(100 - m.usedPct).toFixed(0)}%${tokens}${reset}`;
}

export function formatQuotaText(report: QuotaReport): string {
  const deltas = computeDeltas(toSnapshot(report.providers, report.ts), report.prev);
  const lines: string[] = ["═══ 额度探测 Quota ═══"];

  for (const p of report.providers) {
    lines.push(`─ ${p.label} ─`);
    if (!p.configured) {
      lines.push(`  ✕ ${p.error ?? "未配置"}`);
      continue;
    }
    if (!p.ok) {
      lines.push(`  ✕ 探测失败: ${p.error ?? "未知错误"}`);
      continue;
    }
    const pad = Math.max(...p.meters.map((m) => m.label.length), 6) + 1;
    for (const m of p.meters) lines.push(`  ${meterLine(m, pad)}`);
  }

  // 对比上次
  const prevTs = report.prev?.ts;
  const comps: string[] = [];
  if (deltas.deepseekSpent != null && deltas.deepseekSpent > 0) {
    comps.push(`DeepSeek 消耗 ${deltas.deepseekSpent.toFixed(2)}`);
  }
  if (deltas.zaiFiveHourDelta != null && deltas.zaiFiveHourDelta > 0) {
    comps.push(`Z.AI 5h 用量 +${deltas.zaiFiveHourDelta.toFixed(1)}%`);
  }
  if (deltas.codexWeeklyDelta != null && deltas.codexWeeklyDelta > 0) {
    comps.push(`Codex 周用量 +${deltas.codexWeeklyDelta.toFixed(1)}%`);
  }
  if (comps.length > 0) {
    lines.push(`对比上次${prevTs ? ` (${new Date(prevTs).toLocaleString()})` : ""}: ${comps.join(" · ")}`);
  } else if (prevTs) {
    lines.push(`与上次探测 (${new Date(prevTs).toLocaleString()}) 相比无明显消耗`);
  }
  return lines.join("\n");
}

/** 快捷：单行概要（用于 toast / 状态栏） */
export function quotaSummary(report: QuotaReport): string {
  const parts: string[] = [];
  for (const p of report.providers) {
    if (!p.configured || !p.ok) continue;
    for (const m of p.meters) {
      if (m.id === "deepseek.balance") parts.push(`${m.unit}${(m.current ?? 0).toFixed(2)} 余额`);
      else if (m.usedPct != null) parts.push(`${m.label} ${(100 - m.usedPct).toFixed(0)}% 剩余`);
    }
  }
  const failed = report.providers.filter((p) => p.configured && !p.ok);
  return (
    (parts.length ? parts.join(" · ") : "未获取到额度") +
    (failed.length ? ` · ${failed.length} 个渠道不可用` : "")
  );
}

export type { QuotaReport, QuotaSnapshot, QuotaProbeResult };
