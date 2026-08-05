import type { AggRow, StatsReport } from "./analyzer.js";

export type OutputFormat = "table" | "json" | "csv" | "markdown";

/** 展示选项 */
export interface FormatOptions {
  /** 价格显示货币：usd=$ / cny=¥（默认） */
  currency: "usd" | "cny";
  /** USD→CNY 汇率（currency=cny 时用于换算显示） */
  usdCnyRate: number;
  /** compact=概要 + 两张轻量表；full=token 构成 + 按会话明细 */
  view: "compact" | "full";
  /** 时间窗口（天），仅用于表头展示 */
  days?: number | null;
}

const DEFAULT_OPTS: FormatOptions = { currency: "cny", usdCnyRate: 7.15, view: "compact" };

function fmtNum(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** 金额显示：cny=¥（按汇率换算） / usd=$（原值） */
function fmtCost(n: number, o: FormatOptions): string {
  if (n === 0) return o.currency === "cny" ? "¥0.00" : "$0.00";
  if (o.currency === "cny") {
    const v = n * o.usdCnyRate;
    return `¥${v.toFixed(v < 0.01 ? 4 : 2)}`;
  }
  return `$${n.toFixed(4)}`;
}

/** 终端可见宽度：CJK / 全角字符 / emoji 按双宽处理。 */
function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  return code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff))
    ? 2
    : 1;
}

function displayWidth(s: string): number {
  return [...s].reduce((width, char) => width + charWidth(char), 0);
}

function pad(s: string, width: number, align: "left" | "right" = "left"): string {
  const padLen = Math.max(0, width - displayWidth(s));
  return align === "right" ? " ".repeat(padLen) + s : s + " ".repeat(padLen);
}

function truncate(s: string, width: number): string {
  if (displayWidth(s) <= width) return s;
  let out = "";
  let used = 0;
  for (const char of s) {
    const next = used + charWidth(char);
    if (next > width - 1) break;
    out += char;
    used = next;
  }
  return out + "…";
}

function renderTable(headers: string[], data: string[][], numericFrom = 1): string {
  if (data.length === 0) return "暂无数据";
  const colWidths = headers.map(displayWidth);
  for (const row of data) {
    row.forEach((cell, i) => {
      colWidths[i] = Math.max(colWidths[i], displayWidth(cell));
    });
  }
  const line = (row: string[]) =>
    row.map((cell, i) => pad(cell, colWidths[i], i >= numericFrom ? "right" : "left")).join("  ");
  const divider = colWidths.map((width) => "─".repeat(width)).join("  ");
  return [line(headers), divider, ...data.map(line)].join("\n");
}

function detailedTable(rows: AggRow[], o: FormatOptions): string {
  return renderTable(
    ["项目", "Input", "Output", "CacheR", "CacheW", "Total", "Cost", "Req"],
    rows.map((r) => [
      truncate(r.label, 28),
      fmtNum(r.input),
      fmtNum(r.output),
      fmtNum(r.cacheRead),
      fmtNum(r.cacheWrite),
      fmtNum(r.total),
      fmtCost(r.cost, o),
      String(r.requests),
    ]),
  );
}

function compactTable(rows: AggRow[], o: FormatOptions, label: string): string {
  return renderTable(
    [label, "Tokens", "Cost", "Req"],
    rows.map((r) => [truncate(r.label, 28), fmtNum(r.total), fmtCost(r.cost, o), String(r.requests)]),
  );
}

function summaryLines(r: StatsReport, o: FormatOptions): string[] {
  const s = r.summary;
  return [
    `总 Token: ${fmtNum(s.totalTokens)}  (输入 ${fmtNum(s.totalInput)} / 输出 ${fmtNum(s.totalOutput)} / 缓存读 ${fmtNum(s.totalCacheRead)} / 缓存写 ${fmtNum(s.totalCacheWrite)})`,
    `总费用: ${fmtCost(s.totalCost, o)}   请求数: ${s.requests}   会话数: ${s.sessions}`,
    `时间范围: ${s.firstTs ? new Date(s.firstTs).toLocaleString() : "-"}  ~  ${s.lastTs ? new Date(s.lastTs).toLocaleString() : "-"}`,
    `数据来源: live ${r.liveCount} 条 / session scan ${r.scanCount} 条 (共 ${r.recordsUsed} 条使用)`,
  ];
}

export function formatReport(
  report: StatsReport,
  format: OutputFormat = "table",
  rawOpts: Partial<FormatOptions> = {},
): string {
  const o: FormatOptions = { ...DEFAULT_OPTS, ...rawOpts };
  if (format === "json") {
    return JSON.stringify(report, null, 2);
  }
  if (format === "csv") {
    const cols = ["label", "input", "output", "cacheRead", "cacheWrite", "total", "cost", "requests"];
    const esc = (s: string | number) => `"${String(s).replace(/"/g, '""')}"`;
    const rows = [
      cols.map(esc).join(","),
      ...report.byModel.map((r) => cols.map((c) => esc((r as unknown as Record<string, string | number>)[c])).join(",")),
      ...report.bySession.map((r) => cols.map((c) => esc((r as unknown as Record<string, string | number>)[c])).join(",")),
    ];
    return rows.join("\n");
  }
  if (format === "markdown") {
    const md = (rows: AggRow[], title: string) => {
      const h = ["Label", "Input", "Output", "CacheR", "CacheW", "Total", "Cost", "Req"];
      const lines = [`### ${title}`, "", `| ${h.join(" | ")} |`, `| ${h.map(() => "---").join(" | ")} |`];
      for (const r of rows) {
        lines.push(
          `| ${truncate(r.label, 32)} | ${fmtNum(r.input)} | ${fmtNum(r.output)} | ${fmtNum(r.cacheRead)} | ${fmtNum(r.cacheWrite)} | ${fmtNum(r.total)} | ${fmtCost(r.cost, o)} | ${r.requests} |`,
        );
      }
      return lines.join("\n");
    };
    const title = `# Usage Report${o.days ? ` (近 ${o.days} 天)` : ""}`;
    if (o.view === "full") {
      return [
        title,
        "",
        ...summaryLines(report, o).map((line) => `- ${line}`),
        "",
        md(report.byDay, "按天 (By Day)"),
        "",
        md(report.byModel, "按模型 (By Model)"),
        "",
        md(report.bySession, "按会话 (By Session)"),
      ].join("\n");
    }
    return [title, "", md(report.byDay, "按天 (By Day)"), "", md(report.byModel, "按模型 (By Model)")].join("\n");
  }

  const lines: string[] = [`用量 Usage · ${o.days ? `近 ${o.days} 天` : "全部时间"}`];
  if (o.view === "full") {
    lines.push(...summaryLines(report, o));
  } else {
    const s = report.summary;
    lines.push(`合计 ${fmtNum(s.totalTokens)} tokens · ${fmtCost(s.totalCost, o)} · ${s.requests} 请求 · ${s.sessions} 会话`);
  }

  lines.push("", "按天 By Day");
  lines.push(o.view === "full" ? detailedTable(report.byDay, o) : compactTable(report.byDay, o, "日期"));
  lines.push("", "按模型 By Model");
  lines.push(o.view === "full" ? detailedTable(report.byModel, o) : compactTable(report.byModel, o, "模型"));

  if (o.view === "full") {
    lines.push("", "按会话 By Session (Top)", detailedTable(report.bySession, o));
    if (report.sessionDetail) {
      lines.push("", "当前会话 Current Session", detailedTable([report.sessionDetail], o));
    }
  }
  return lines.join("\n");
}

/** 格式化一个会话的明细 */
export function formatSessionSummary(label: string, report: StatsReport, rawOpts: Partial<FormatOptions> = {}): string {
  const o: FormatOptions = { ...DEFAULT_OPTS, ...rawOpts };
  const d = report.sessionDetail;
  if (!d) return "当前会话无用量数据。";
  return [
    `当前会话 · ${label}`,
    `${fmtNum(d.total)} tokens · ${fmtCost(d.cost, o)} · ${d.requests} 请求`,
    `输入 ${fmtNum(d.input)} · 输出 ${fmtNum(d.output)} · 缓存读 ${fmtNum(d.cacheRead)} · 缓存写 ${fmtNum(d.cacheWrite)}`,
  ].join("\n");
}

export function fmtTokens(n: number): string {
  return fmtNum(n);
}

export function fmtUsd(n: number): string {
  return fmtCost(n, DEFAULT_OPTS);
}
