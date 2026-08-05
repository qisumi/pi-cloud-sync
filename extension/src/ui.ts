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
 * - static=true 时：TUI 用非交互静态面板直接展示全部内容（Esc 关闭，不要求选中）。
 */
export async function output(
  ctx: ExtensionCommandContext,
  text: string,
  title = "pi-cloud-sync",
  opts?: { static?: boolean },
): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    console.log(text);
    return;
  }

  const lines = text.split("\n");
  if (lines.length <= 6) {
    ctx.ui.notify(lines.filter(Boolean).join(" | "), "info");
    return;
  }

  if (opts?.static) {
    await showTextPane(ctx, title, lines);
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
  }, {
    overlay: true,
    overlayOptions: { anchor: "center", width: "90%", maxHeight: Math.min(items.length + 5, 22) },
  });
}

/** 非交互静态文本面板：一次展示全部内容，Esc/Enter 关闭 */
async function showTextPane(ctx: ExtensionCommandContext, title: string, lines: string[]): Promise<void> {
  const max = 50; // 上限保护：超出部分折叠为提示行
  const visible = lines.length > max ? [...lines.slice(0, max), `… 还有 ${lines.length - max} 行（完整内容请用 --save=file）`] : lines;
  await ctx.ui.custom<null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    // 单个 Text 统一换行：paddingY 始终为 0，避免逐行组件累积垂直留白。
    container.addChild(new Text(visible.join("\n"), 1, 0));
    container.addChild(new Text(theme.fg("dim", " Esc/Enter 关闭"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        if (_kb.matches(data, "tui.select.cancel") || _kb.matches(data, "tui.select.confirm")) {
          done(null);
          return;
        }
        tui.requestRender();
      },
    };
  }, {
    overlay: true,
    overlayOptions: { anchor: "center", width: "90%", maxHeight: Math.min(visible.length + 5, 28) },
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

function barWidth(theme: unknown, usedPct: number | null, width = 12): string {
  const th = theme as { fg: (color: string, s: string) => string };
  if (usedPct == null) return th.fg("dim", "░".repeat(width));
  const color = usedPct >= 90 ? "error" : usedPct >= 70 ? "warning" : "success";
  const filled = Math.min(width, Math.max(0, Math.round((usedPct / 100) * width)));
  return th.fg(color, "█".repeat(filled)) + th.fg("dim", "░".repeat(width - filled));
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
  if (m.id === "deepseek.balance") {
    const v = m.current ?? 0;
    const icon = m.status === "critical" ? "⚠" : m.status === "warn" ? "▲" : "●";
    const color = m.status === "critical" ? "error" : m.status === "warn" ? "warning" : "success";
    return theme.fg(color, `${icon} ${m.unit}${v.toFixed(2)}`);
  }
  if (m.id === "codex.resetCredits") {
    return theme.fg("success", `● ${Math.round(m.current ?? 0)} 次可用`);
  }
  if (m.usedPct == null) return theme.fg("dim", "--");
  const tokens =
    m.current != null && m.limit != null ? ` ${fmtQuotaNum(m.current)}/${fmtQuotaNum(m.limit)}` : "";
  const left = m.usedPct >= 90 ? "0" : Math.max(0, 100 - m.usedPct).toFixed(0);
  const leftColor = m.usedPct >= 90 ? "error" : m.usedPct >= 70 ? "warning" : "text";
  return (
    `${barWidth(theme, m.usedPct)} ` +
    theme.fg(leftColor, `剩 ${left}%`) +
    theme.fg("dim", `${tokens}${fmtQuotaLeft(m.resetsAt)}`)
  );
}

/** 计量器短标签（深色/紧凑显示用） */
function shortLabel(m: QuotaMeter): string {
  if (m.id === "deepseek.balance") return "余额";
  if (m.id === "codex.resetCredits") return "重置";
  if (m.id.startsWith("codex.additional.")) return m.label.replace(/额度/g, "").replace(/\s*·\s*/g, "·");
  if (m.id.endsWith(".fiveHour")) return "5h";
  if (m.id.endsWith(".weekly")) return "周";
  if (m.id.endsWith(".monthly")) return "月";
  return m.label;
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
    const ts = new Date(report.ts);
    const pad2 = (x: number) => String(x).padStart(2, "0");
    rows.push(
      theme.fg(
        "accent",
        ` 额度 Quota · ${ts.getMonth() + 1}月${ts.getDate()}日 ${pad2(ts.getHours())}:${pad2(ts.getMinutes())}`,
      ),
    );

    // 渠道名列宽（CJK 双宽）
    const visLen = (s: string) => [...s].reduce((n, c) => n + (c.charCodeAt(0) > 0xff ? 2 : 1), 0);
    const provPad = Math.min(28, Math.max(0, ...report.providers.map((p) => visLen(p.label)))) + 2;
    const blank = " ".repeat(provPad);
    const meterPad = Math.min(24, Math.max(0, ...report.providers.map((p) => p.meters.map((m) => visLen(shortLabel(m))).reduce((a, b) => Math.max(a, b), 0)))) + 1;

    for (const p of report.providers) {
      const providerLabel = padTo(p.label, provPad);
      if (!p.configured) {
        rows.push(theme.fg("dim", ` ${providerLabel}○ ${p.error ?? "未配置"}`));
        continue;
      }
      if (!p.ok) {
        rows.push(theme.fg("warning", ` ${providerLabel}✕ ${p.error ?? "探测失败"}`));
        continue;
      }
      p.meters.forEach((m, i) => {
        const head = i === 0 ? ` ${providerLabel}` : ` ${blank}`;
        rows.push(`${head}${theme.fg("dim", padTo(shortLabel(m), meterPad))}${meterRow(th, m)}`);
      });
    }

    // 对比上次（单行）
    const deltas = computeDeltas(toSnapshot(report.providers, report.ts), report.prev);
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
      rows.push(theme.fg("muted", ` 对比上次: ${comps.join(" · ")}`));
    }

    // 单个 Text 渲染所有数据行，避免每行 padding 累积造成空屏。
    container.addChild(new Text(rows.join("\n"), 1, 0));
    container.addChild(new Text(theme.fg("dim", " Esc 关闭"), 1, 0));
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
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: "90%",
      maxHeight: Math.min(report.providers.reduce((n, p) => n + Math.max(1, p.meters.length), 0) + 6, 24),
    },
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
