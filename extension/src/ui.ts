import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type Component, type SelectItem, SelectList, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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
  let panelWidth = 80; // 兜底宽度；factory 内按内容实际宽度计算
  await ctx.ui.custom<null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    // 面板主体（标题 + 正文 + 提示行）作为一个整体块居中，行内保持左对齐（表格列对齐不变）。
    const body = [theme.fg("accent", theme.bold(title)), ...visible, theme.fg("dim", " Esc/Enter 关闭")];
    panelWidth = panelWidthFor(body);
    container.addChild(new CenteredBlock(body.join("\n"), 1));
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

/** 组名后缀：区分同一渠道下的多个计量器（5h / 周 / 月 / 重置） */
function groupTag(m: QuotaMeter): string {
  if (m.id === "deepseek.balance") return "";
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
  let panelWidth = 80; // 兜底宽度；factory 内按内容实际宽度计算
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
    rows.push("");

    // 已配置渠道：每个计量器一组（组名行 + 缩进数据行），组间空行分隔
    for (const p of report.providers) {
      if (!p.configured || !p.ok) continue;
      p.meters.forEach((m) => {
        const tag = groupTag(m);
        rows.push(theme.fg("text", ` ${p.label}${tag ? ` ${tag}` : ""}`));
        rows.push(`    ${meterRow(th, m)}`);
        rows.push("");
      });
    }

    // 未配置 / 探测失败的渠道：单行提示
    for (const p of report.providers) {
      if (p.configured && p.ok) continue;
      const prefix = p.configured ? "✕" : "○";
      const color = p.configured ? "warning" : "dim";
      rows.push(theme.fg(color, ` ${p.label}  ${prefix} ${p.error ?? (p.configured ? "探测失败" : "未配置")}`));
      rows.push("");
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
      rows.push("");
    }

    rows.push(theme.fg("dim", " Esc 关闭"));
    rows.push("");

    // 单个 CenteredBlock 渲染所有数据行：整块内容左右居中，行内保持左对齐（组名/进度条缩进不变），避免每行 padding 累积造成空屏。
    container.addChild(new CenteredBlock(rows.join("\n"), 1));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    panelWidth = panelWidthFor(rows);

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
    overlayOptions: () => ({
      anchor: "center",
      width: panelWidth,
      maxHeight: Math.min(
        report.providers.reduce((n, p) => n + (p.configured && p.ok ? Math.max(1, p.meters.length) * 3 : 2), 0) + 6,
        30,
      ),
    }),
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

/* ==================== 块级居中组件 ==================== */

/**
 * 按内容最大显示宽度计算弹窗面板宽度（列数）：内容宽 + 左右 padding/边框 + 少量余量。
 * - 面板宽与内容贴合（TUI 内部会 clamp 到终端宽度，超宽内容自动退化）。
 * - 带最小宽度下限，避免内容过窄时面板变成一条细缝。
 */
function panelWidthFor(lines: string[], min = 44): number {
  const maxLine = lines.reduce((m, l) => Math.max(m, visibleWidth(l)), 0);
  return Math.max(min, maxLine + 4);
}

/**
 * 块级居中多行文本组件（行内文字不做居中）：
 * - 以「整块内容」为一个整体左右居中：先取所有行中的最大显示宽度作为块宽，再统一左移
 *   （保留每行原有的缩进 / 表格列对齐结构），例如表格整体居中但列仍对齐。
 * - 显示宽度由 visibleWidth 计算：CJK 全角按 2 列、ANSI 转义序列不计宽。
 * - 块宽不小于面板可用宽度时退化为左对齐；单行超宽时自动换行兜底（窄终端）。
 * - 每行都补齐到面板全宽，保证差分渲染不残留旧字符；无垂直 padding，间距由调用方空行控制。
 */
class CenteredBlock implements Component {
  private lines: string[];
  private paddingX: number;
  private cachedWidth?: number;
  private cachedOut?: string[];

  constructor(text: string, paddingX = 1) {
    this.lines = text.split("\n");
    this.paddingX = paddingX;
  }

  setText(text: string): void {
    this.lines = text.split("\n");
    this.cachedWidth = undefined;
    this.cachedOut = undefined;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedOut = undefined;
  }

  render(width: number): string[] {
    if (this.cachedOut && this.cachedWidth === width) return this.cachedOut;
    const contentWidth = Math.max(1, width - this.paddingX * 2);
    const normalized = this.lines.map((l) => l.replace(/\t/g, "   "));
    const blockWidth = normalized.reduce((m, l) => Math.max(m, visibleWidth(l)), 0);
    // 块宽小于面板可用宽度时才整体平移；否则退化为左对齐
    const shift = blockWidth < contentWidth ? Math.floor((contentWidth - blockWidth) / 2) : 0;
    const out: string[] = [];
    for (const line of normalized) {
      if (shift > 0) {
        // 整块平移：所有行加同一个左缩进，行内对齐结构不变
        const vw = visibleWidth(line);
        out.push(" ".repeat(this.paddingX + shift) + line + " ".repeat(width - this.paddingX - shift - vw));
      } else {
        // 左对齐兜底：单行超宽自动换行
        for (const seg of wrapTextWithAnsi(line, contentWidth)) {
          if (seg === "") {
            out.push(" ".repeat(width));
          } else {
            const vw = visibleWidth(seg);
            out.push(" ".repeat(this.paddingX) + seg + " ".repeat(width - this.paddingX - vw));
          }
        }
      }
    }
    this.cachedWidth = width;
    this.cachedOut = out;
    return out;
  }
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
