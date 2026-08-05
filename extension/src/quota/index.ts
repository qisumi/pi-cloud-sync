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
  const diff = resetsAt - Date.now();
  if (diff <= 0) return "即将重置";
  const min = Math.round(diff / 60000);
  if (min < 60) return `${min}分后重置`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}时${min % 60 ? `${min % 60}分` : ""}后重置`;
  return `${Math.floor(h / 24)}天${h % 24 ? `${h % 24}时` : ""}后重置`;
}

function bar(usedPct: number | null, width = 10): string {
  if (usedPct == null) return "░".repeat(width);
  const filled = Math.min(width, Math.max(0, Math.round((usedPct / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** 单行计量：label(含前缀) + 数据，紧凑无多余换行 */
function meterLine(m: QuotaProbeResult["meters"][number]): string {
  if (m.id === "deepseek.balance") {
    const v = m.current ?? 0;
    const flag = m.status === "critical" ? "⚠" : m.status === "warn" ? "▲" : "●";
    return `${flag} ${m.unit}${v.toFixed(2)} 余额`;
  }
  if (m.id === "codex.resetCredits") {
    return `● 可用 ${Math.round(m.current ?? 0)} 次`;
  }
  if (m.usedPct == null) return "--";
  const tokens =
    m.current != null && m.limit != null ? ` ${fmtNum(m.current)}/${fmtNum(m.limit)}` : "";
  const reset = m.resetsAt ? ` · ${fmtReset(m.resetsAt)}` : "";
  return `${bar(m.usedPct)} 剩 ${Math.max(0, 100 - m.usedPct).toFixed(0)}%${tokens}${reset}`;
}

export function formatQuotaText(report: QuotaReport): string {
  const deltas = computeDeltas(toSnapshot(report.providers, report.ts), report.prev);
  const ts = new Date(report.ts);
  const pad2 = (x: number) => String(x).padStart(2, "0");
  const lines: string[] = [
    `═══ 额度 Quota · ${ts.getMonth() + 1}月${ts.getDate()}日 ${pad2(ts.getHours())}:${pad2(ts.getMinutes())} ═══`,
  ];

  // 渠道名列宽（CJK 双宽）
  const visLen = (s: string) => [...s].reduce((n, c) => n + (c.charCodeAt(0) > 0xff ? 2 : 1), 0);
  const padVisible = (s: string, width: number) => s + " ".repeat(Math.max(0, width - visLen(s)));
  const provPad =
    Math.max(0, ...report.providers.map((p) => visLen(p.label))) +
    (report.providers.length > 0 ? 2 : 0);
  const blank = " ".repeat(provPad);

  for (const p of report.providers) {
    if (!p.configured || !p.ok) {
      lines.push(`${padVisible(p.label, provPad)}✕ ${p.error ?? "未配置"}`);
      continue;
    }
    p.meters.forEach((m, i) => {
      const head = i === 0 ? padVisible(p.label, provPad) : blank;
      const label = m.id === "deepseek.balance" ? "" : `${m.label} `;
      lines.push(`${head}${label}${meterLine(m)}`);
    });
  }

  // 对比上次（单行）
  const prevTs = report.prev?.ts;
  const comps: string[] = [];
  if (deltas.deepseekSpent != null && deltas.deepseekSpent > 0) {
    comps.push(`DeepSeek 消耗 ${deltas.deepseekSpent.toFixed(2)}`);
  }
  if (deltas.zaiFiveHourDelta != null && deltas.zaiFiveHourDelta > 0) {
    comps.push(`Z.AI 5h +${deltas.zaiFiveHourDelta.toFixed(0)}%`);
  }
  if (deltas.zaiWeeklyDelta != null && deltas.zaiWeeklyDelta > 0) {
    comps.push(`Z.AI 周 +${deltas.zaiWeeklyDelta.toFixed(0)}%`);
  }
  if (deltas.codexWeeklyDelta != null && deltas.codexWeeklyDelta > 0) {
    comps.push(`Codex 周 +${deltas.codexWeeklyDelta.toFixed(0)}%`);
  }
  if (comps.length > 0) {
    lines.push(`对比上次${prevTs ? ` (${new Date(prevTs).toLocaleString()})` : ""}: ${comps.join(" · ")}`);
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
