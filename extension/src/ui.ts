import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import type { QuotaReport } from "./quota/index.js";
import { computeDeltas, toSnapshot } from "./quota/history.js";
import type { QuotaMeter } from "./quota/types.js";

/**
 * 命令输出助手：
 * - TUI 模式：短文本走 notify toast；长文本用 SelectList 对话框展示（↑↓ 滚动，Esc 关闭）。
 * - print/json/rpc 模式：直接 console.log（可被脚本捕获）。
 */
export async function output(ctx: ExtensionCommandContext, text: string, title = "pi-cloud-sync"): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    console.log(text);
    return;
  }

  const lines = text.split("\n");
  if (lines.length <= 6) {
    ctx.ui.notify(lines.filter(Boolean).join(" | "), "info");
    return;
  }

  const items: SelectItem[] = lines.map((l) => ({
    value: l,
    label: l || " ",
    description: l.length > 120 ? l.slice(0, 120) + "…" : undefined,
  }));

  await ctx.ui.custom<null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(new Text(theme.fg("dim", "↑↓ 滚动  •  Enter 选择  •  Esc 关闭"), 1, 0));

    const selectList = new SelectList(items, Math.min(items.length, 15), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    selectList.onSelect = () => done(null);
    selectList.onCancel = () => done(null);
    container.addChild(selectList);
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

/** 对话框类交互：确认对话框封装 */
export async function confirm(ctx: ExtensionCommandContext, title: string, message: string): Promise<boolean> {
  if (!ctx.hasUI) return true;
  return ctx.ui.confirm(title, message);
}

/* ==================== 额度面板 ==================== */

/** 按终端显示宽度补齐（CJK 双宽） */
function padTo(s: string, width: number): string {
  const visible = [...s].reduce((n, c) => n + (c.charCodeAt(0) > 0xff ? 2 : 1), 0);
  return s + " ".repeat(Math.max(0, width - visible));
}

function barWidth(theme: unknown, usedPct: number | null, width = 20): string {
  const th = theme as { fg: (color: string, s: string) => string };
  if (usedPct == null) return th.fg("dim", "░".repeat(width));
  const color = usedPct >= 90 ? "error" : usedPct >= 70 ? "warning" : "success";
  const filled = Math.min(width, Math.max(0, Math.round((usedPct / 100) * width)));
  return th.fg(color, "█".repeat(filled)) + th.fg("dim", "░".repeat(width - filled));
}

function fmtQuotaReset(resetsAt: number | null): string {
  if (!resetsAt) return "";
  const d = new Date(resetsAt);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtQuotaNum(n: number | null): string {
  if (n == null) return "--";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtQuotaLeft(resetsAt: number | null): string {
  if (!resetsAt) return "";
  const diff = resetsAt - Date.now();
  if (diff <= 0) return " · 即将重置";
  const min = Math.floor(diff / 60000);
  if (min < 60) return ` · ${min} 分后重置`;
  const h = Math.floor(min / 60);
  if (h < 24) return ` · ${h} 小时${min % 60 ? ` ${min % 60} 分` : ""}后重置`;
  return ` · ${Math.floor(h / 24)} 天${h % 24} 小时后重置`;
}

/** 渲染一个额度计量行（含进度条） */
function meterRow(theme: { fg: (color: string, s: string) => string }, m: QuotaMeter): string {
  const head = padTo(m.label, 9);
  if (m.id === "deepseek.balance") {
    const v = m.current ?? 0;
    const icon = m.status === "critical" ? "⚠" : m.status === "warn" ? "▲" : "●";
    const color = m.status === "critical" ? "error" : m.status === "warn" ? "warning" : "success";
    return `  ${head}${theme.fg(color, `${icon} ${m.unit}${v.toFixed(2)}`)}${theme.fg("dim", "  余额")}`;
  }
  if (m.usedPct == null) return `  ${head}${theme.fg("dim", "--")}`;
  const tokens =
    m.current != null && m.limit != null ? ` (${fmtQuotaNum(m.current)}/${fmtQuotaNum(m.limit)})` : "";
  const left = m.usedPct >= 90 ? "0" : Math.max(0, 100 - m.usedPct).toFixed(0);
  const leftColor = m.usedPct >= 90 ? "error" : m.usedPct >= 70 ? "warning" : "text";
  return (
    `  ${head}${barWidth(theme, m.usedPct)} ` +
    theme.fg(leftColor, `剩 ${left}%`) +
    theme.fg("dim", `${tokens}${fmtQuotaLeft(m.resetsAt)}`) +
    (m.resetsAt ? ` (${fmtQuotaReset(m.resetsAt)})` : "")
  );
}

/**
 * 额度探测面板：美观简洁地展示各渠道额度（TUI 模式）。
 * Esc 关闭，不阻塞其他交互。
 */
export async function quotaDialog(ctx: ExtensionCommandContext, report: QuotaReport): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  await ctx.ui.custom<null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    const th = theme as unknown as { fg: (color: string, s: string) => string };
    const rows: string[] = [];
    rows.push(theme.fg("accent", theme.bold(" 额度探测 Quota")));

    for (const p of report.providers) {
      rows.push("");
      if (!p.configured) {
        rows.push(theme.fg("dim", ` ${p.label}  ✕ ${p.error ?? "未配置"}`));
        continue;
      }
      if (!p.ok) {
        rows.push(theme.fg("warning", ` ${p.label}  ✕ ${p.error ?? "探测失败"}`));
        continue;
      }
      rows.push(theme.fg("text", ` ${p.label}`));
      for (const m of p.meters) rows.push(meterRow(th, m));
    }

    // 对比上次
    const deltas = computeDeltas(toSnapshot(report.providers, report.ts), report.prev);
    const comps: string[] = [];
    if (deltas.deepseekSpent != null && deltas.deepseekSpent > 0) {
      comps.push(`DeepSeek 消耗 ${deltas.deepseekSpent.toFixed(2)}`);
    }
    if (deltas.zaiFiveHourDelta != null && deltas.zaiFiveHourDelta > 0) {
      comps.push(`Z.AI 5h +${deltas.zaiFiveHourDelta.toFixed(1)}%`);
    }
    if (deltas.codexWeeklyDelta != null && deltas.codexWeeklyDelta > 0) {
      comps.push(`Codex 周 +${deltas.codexWeeklyDelta.toFixed(1)}%`);
    }
    if (comps.length > 0) {
      rows.push("");
      rows.push(theme.fg("muted", ` 对比上次: ${comps.join(" · ")}`));
    }

    rows.push("");
    rows.push(theme.fg("dim", " Esc 关闭"));

    rows.forEach((row, i) => {
      container.addChild(new Text(row, 1, i + 1));
    });
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        if (_kb.matches(data, "tui.select.cancel")) {
          done(null);
          return;
        }
        tui.requestRender();
      },
    };
  });
}

/**
 * 长任务即时反馈助手：
 * - TUI 模式：开始立即弹出 toast（notify）+ 底部状态栏（setStatus），任务中可随时更新，结束自动清除。
 * - 其他模式（print / json / rpc）：返回 null，静默降级，不打断脚本输出。
 */
export interface ProgressFeedback {
  /** 更新当前进度信息（toast + 底部状态栏） */
  set(message: string): void;
  /** 任务成功完成：清除底部状态，toast 提示结果 */
  done(result?: string): void;
  /** 任务失败：清除底部状态，toast 报错 */
  error(message: string): void;
}

const STATUS_KEY = "pisync";

/** 开始一个带即时反馈的长任务。返回 null 表示当前环境不支持 TUI 反馈。 */
export function startProgress(ctx: ExtensionCommandContext, initial: string): ProgressFeedback | null {
  if (!ctx.hasUI || ctx.mode !== "tui") return null;

  try {
    ctx.ui.notify(initial, "info");
    ctx.ui.setStatus(STATUS_KEY, initial);
  } catch {
    return null; // 极少数环境下 UI 不可用，静默降级
  }

  let lastNotifyAt = 0;
  return {
    set(message: string) {
      try {
        ctx.ui.setStatus(STATUS_KEY, message);
        // 节流 toast：频繁阶段更新只刷新底部状态栏，避免刷屏
        const now = Date.now();
        if (now - lastNotifyAt > 1500) {
          lastNotifyAt = now;
          ctx.ui.notify(message, "info");
        }
      } catch {
        // ignore
      }
    },
    done(result?: string) {
      try {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        if (result) ctx.ui.notify(result, "info");
      } catch {
        // ignore
      }
    },
    error(message: string) {
      try {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        ctx.ui.notify(message, "error");
      } catch {
        // ignore
      }
    },
  };
}
