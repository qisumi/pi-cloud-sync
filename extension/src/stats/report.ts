import type { AggRow, StatsReport } from "./analyzer.js";

export type OutputFormat = "table" | "json" | "csv" | "markdown";

/** 展示选项 */
export interface FormatOptions {
  /** 价格显示货币：usd=$ / cny=¥（默认） */
  currency: "usd" | "cny";
  /** USD→CNY 汇率（currency=cny 时用于换算显示） */
  usdCnyRate: number;
  /** compact=仅两张表（按天/按模型，默认）；full=概要 + 按会话全量 */
  view: "compact" | "full";
  /** 时间窗口（天），仅用于表头展示 */
  days?: number | null;
}

const DEFAULT_OPTS: FormatOptions = { currency: "cny", usdCnyRate: 7.15, view: "compact" };

function fmtNum(n: number): string {
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

function pad(s: string, width: number, align: "left" | "right" = "left"): string {
  if (s.length >= width) return s;
  const padLen = width - s.length;
  return align === "right" ? " ".repeat(padLen) + s : s + " ".repeat(padLen);
}

function table(rows: AggRow[], o: FormatOptions, extraCols?: string[]): string {
  const headers = ["Label", ...(extraCols ?? []), "Input", "Output", "CacheR", "CacheW", "Total", "Cost", "Req"];
  const colWidths = headers.map((h) => h.length);
  const data = rows.map((r) => [
    truncate(r.label, 32),
    ...(extraCols ?? []).map(() => ""),
    String(fmtNum(r.input)),
    String(fmtNum(r.output)),
    String(fmtNum(r.cacheRead)),
    String(fmtNum(r.cacheWrite)),
    String(fmtNum(r.total)),
    fmtCost(r.cost, o),
    String(r.requests),
  ]);
  for (const row of data) {
    row.forEach((cell, i) => {
      colWidths[i] = Math.max(colWidths[i], cell.length);
    });
  }
  const sep = headers.map((h, i) => "-".repeat(colWidths[i] + 2)).join("+");
  const headerLine = headers.map((h, i) => " " + pad(h, colWidths[i]) + " ").join("|");
  const lines = [sep, headerLine, sep];
  for (const row of data) {
    lines.push(row.map((cell, i) => " " + pad(cell, colWidths[i], i > 0 ? "right" : "left") + " ").join("|"));
  }
  lines.push(sep);
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
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
        ...summaryLines(report, o).map((l) => `- ${l}`),
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

  // table
  const lines: string[] = [];
  lines.push(`═══ 用量统计 Usage${o.days ? ` (近 ${o.days} 天)` : " (全部)"} ═══`);
  if (o.view === "full") {
    lines.push(...summaryLines(report, o));
    lines.push("");
  }
  lines.push("─ 按天 By Day ─");
  lines.push(table(report.byDay, o));
  lines.push("");
  lines.push("─ 按模型 By Model ─");
  lines.push(table(report.byModel, o));
  if (o.view === "full") {
    lines.push("");
    lines.push(`─ 按会话 By Session (Top) ─`);
    lines.push(table(report.bySession, o));
    if (report.sessionDetail) {
      lines.push("");
      lines.push("─ 当前会话 Current Session ─");
      lines.push(table([report.sessionDetail], o));
    }
  }
  return lines.join("\n");
}

/** 格式化一个会话的明细 */
export function formatSessionSummary(label: string, report: StatsReport, rawOpts: Partial<FormatOptions> = {}): string {
  const o: FormatOptions = { ...DEFAULT_OPTS, ...rawOpts };
  const d = report.sessionDetail;
  if (!d) return `当前会话无用量数据。`;
  return [
    `会话: ${label}`,
    `Token: 输入 ${fmtNum(d.input)} / 输出 ${fmtNum(d.output)} / 缓存读 ${fmtNum(d.cacheRead)} / 缓存写 ${fmtNum(d.cacheWrite)} / 合计 ${fmtNum(d.total)}`,
    `费用: ${fmtCost(d.cost, o)}   请求: ${d.requests}`,
  ].join("\n");
}

export function fmtTokens(n: number): string {
  return fmtNum(n);
}

export function fmtUsd(n: number): string {
  return fmtCost(n, DEFAULT_OPTS);
}
