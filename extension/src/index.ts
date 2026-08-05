import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { SyncConfig } from "./config.js";
import {
  loadConfig,
  saveConfig,
  loadState,
  saveState,
  ensureDeviceId,
  configPath,
} from "./config.js";
import { SyncClient } from "./client.js";
import { push, pull, syncNow, resolveConflict } from "./sync/index.js";
import { searchLocalSessions, localSessionsIndex } from "./sync/sessions.js";
import { UsageCollector } from "./stats/collector.js";
import { scanAllSessions, mergeRecords, buildReport } from "./stats/analyzer.js";
import { formatReport, formatSessionSummary } from "./stats/report.js";
import { fetchUsdCnyRate } from "./stats/rates.js";
import { output, startProgress, quotaDialog } from "./ui.js";
import { probeAllQuotas, formatQuotaText, quotaSummary } from "./quota/index.js";
import { writeFileSync } from "node:fs";

const EXT_VERSION = "0.1.0";
let cfg: SyncConfig = loadConfig();
let collector = new UsageCollector();
let piApi: ExtensionAPI | undefined;

function client(): SyncClient {
  const state = loadState();
  const deviceId = state.deviceId ?? ensureDeviceId();
  return new SyncClient(cfg, deviceId);
}

function serverConfigured(): boolean {
  return !!cfg.server?.url && !!cfg.server?.token;
}

function fmtPushed(r: { pushed: { configs: number; sessions: number; entries: number; extensions: number; manifest: boolean } }) {
  return `configs=${r.pushed.configs} sessions=${r.pushed.sessions} entries=${r.pushed.entries} extensions=${r.pushed.extensions} manifest=${r.pushed.manifest ? "yes" : "no"}`;
}

function fmtPulled(r: { pulled: { objects: number; sessions: number; entries: number; extensions: number; installed: string[] } }) {
  const installed = r.pulled.installed.length > 0 ? ` installed=[${r.pulled.installed.join(", ")}]` : "";
  return `objects=${r.pulled.objects} sessions=${r.pulled.sessions} entries=${r.pulled.entries} extensions=${r.pulled.extensions}${installed}`;
}

/* ============================ 命令 ============================ */

/** 服务器未配置提示 */
function requireServer(): string | null {
  if (!serverConfigured()) return "服务器未配置：运行 /qisumi-sync-config-import <url> <token>";
  return null;
}

async function cmdSyncPush(ctx: ExtensionCommandContext): Promise<string> {
  const unconf = requireServer();
  if (unconf) return unconf;
  const progress = startProgress(ctx, "正在推送变更到服务器…");
  const c = client();
  const report = await push(cfg, loadState(), c, "0.83.0", EXT_VERSION, (m) => progress?.set(m));
  if (report.errors.length > 0) {
    progress?.error(`推送失败：${report.errors[0]}`);
    return `推送完成（部分失败）\n${report.errors.join("\n")}`;
  }
  progress?.done();
  return `推送完成: ${fmtPushed(report)}${report.conflicts ? `, ${report.conflicts} 个冲突` : ""}`;
}

async function cmdSyncPull(ctx: ExtensionCommandContext): Promise<string> {
  const unconf = requireServer();
  if (unconf) return unconf;
  const progress = startProgress(ctx, "正在从服务器拉取变更…");
  const c = client();
  const report = await pull(cfg, loadState(), c, {
    skipFile: ctx.sessionManager.getSessionFile() ?? undefined,
    piExec: (args) => piExec(args),
    onStage: (m) => progress?.set(m),
  });
  if (report.errors.length > 0) {
    progress?.error(`拉取失败：${report.errors[0]}`);
    return `拉取完成（部分失败）\n${report.errors.join("\n")}`;
  }
  progress?.done();
  return `拉取完成: ${fmtPulled(report)}${report.conflicts ? `, ${report.conflicts} 个冲突` : ""}`;
}

async function cmdSyncNow(ctx: ExtensionCommandContext): Promise<string> {
  const unconf = requireServer();
  if (unconf) return unconf;
  const progress = startProgress(ctx, "正在同步（先拉后推）…");
  const c = client();
  const { pullReport, pushReport } = await syncNow(cfg, c, "0.83.0", EXT_VERSION, {
    skipFile: ctx.sessionManager.getSessionFile() ?? undefined,
    piExec: (args) => piExec(args),
    onStage: (m) => progress?.set(m),
  });
  const errs = [...pullReport.errors, ...pushReport.errors];
  const lines = [
    `拉取: ${fmtPulled(pullReport)}`,
    `推送: ${fmtPushed(pushReport)}`,
    `冲突: ${pullReport.conflicts + pushReport.conflicts}`,
  ];
  if (errs.length > 0) {
    progress?.error(`同步失败：${errs[0]}`);
    lines.push("错误: " + errs.join("; "));
  } else {
    progress?.done();
  }
  return lines.join("\n");
}

async function cmdSyncConflicts(ctx: ExtensionCommandContext): Promise<string> {
  const progress = startProgress(ctx, "正在获取冲突列表…");
  try {
    const conflicts = await client().listConflicts();
    if (conflicts.length === 0) {
      progress?.done();
      return "没有冲突记录 🎉";
    }
    progress?.done();
    return (
      `共 ${conflicts.length} 个冲突（未解决 ${conflicts.filter((c) => !c.resolvedAt).length}）:\n` +
      conflicts
        .map(
          (c) =>
            `#${c.id} [${c.resolvedAt ? "已解决" : "未解决"}] ${c.objectKey} @${c.path}\n` +
            `  ${c.deviceA} vs ${c.deviceB}\n` +
            `  A: ${preview(c.contentA)}\n  B: ${preview(c.contentB)}`,
        )
        .join("\n") +
      "\n解决: /qisumi-sync-conflicts-resolve <id> keep-a|keep-b"
    );
  } catch (err) {
    progress?.error(`获取冲突失败：${(err as Error).message}`);
    return `获取冲突失败: ${(err as Error).message}`;
  }
}

async function cmdSyncConflictResolve(args: string, ctx: ExtensionCommandContext): Promise<string> {
  const [idRaw, howRaw] = args.trim().split(/\s+/);
  const id = parseInt(idRaw ?? "", 10);
  const how = (howRaw ?? "keep-b") as "keep-a" | "keep-b";
  if (Number.isNaN(id)) return "用法: /qisumi-sync-conflicts-resolve <id> keep-a|keep-b";
  const progress = startProgress(ctx, `正在解决冲突 #${id}…`);
  try {
    await resolveConflict(cfg, client(), id, how);
    progress?.done();
    return `冲突 #${id} 已解决（${how}），已重新拉取。`;
  } catch (err) {
    progress?.error(`解决失败：${(err as Error).message}`);
    return `解决失败: ${(err as Error).message}`;
  }
}

async function cmdSyncDevices(ctx: ExtensionCommandContext): Promise<string> {
  const progress = startProgress(ctx, "正在获取设备列表…");
  try {
    const devices = await client().listDevices();
    if (devices.length === 0) {
      progress?.done();
      return "暂无设备记录";
    }
    progress?.done();
    return devices
      .map(
        (d) =>
          `• ${d.name}  (${d.platform}, pi ${d.piVersion})  上次在线: ${new Date(d.lastSeen).toLocaleString()}`,
      )
      .join("\n");
  } catch (err) {
    progress?.error(`获取设备列表失败：${(err as Error).message}`);
    return `获取设备列表失败: ${(err as Error).message}`;
  }
}

function cmdSyncFind(args: string): string {
  const query = args.trim();
  if (!query) return "用法: /qisumi-sync-find <关键词>";
  const sessions = searchLocalSessions(query);
  if (sessions.length === 0) return "未找到匹配的会话";
  return sessions
    .map((s) => `• ${s.name ?? s.uuid}  (${s.entries.length} entries)\n  cwd: ${s.cwd}\n  uuid: ${s.uuid}`)
    .join("\n");
}

async function cmdSyncRestore(args: string): Promise<string> {
  const uuid = args.trim().split(/\s+/)[0] ?? "";
  if (!uuid) return "用法: /qisumi-sync-restore <session-uuid>";
  try {
    const ok = await client().restoreSession(uuid);
    return ok ? `会话 ${uuid} 已恢复（清除删除标记）。` : `未找到会话 ${uuid}`;
  } catch (err) {
    return `恢复失败: ${(err as Error).message}`;
  }
}

function cmdSyncList(): string {
  const sessions = localSessionsIndex();
  if (sessions.length === 0) return "本地没有会话";
  return sessions.map((s) => `• ${s.name ?? s.uuid}  (${s.entryCount} entries) — ${s.cwd}`).join("\n");
}

function preview(s: string, max = 80): string {
  const clean = s.replace(/\n/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

async function cmdSyncStatus(ctx: ExtensionCommandContext): Promise<string> {
  const state = loadState();
  const lines = [
    "═══ pi-cloud-sync 状态 ═══",
    `设备名: ${cfg.deviceName}  (id: ${(state.deviceId ?? "未注册").slice(0, 8)}…)`,
    `服务器: ${cfg.server?.url ?? "(未配置)"}`,
    `自动同步: ${cfg.sync.automatic ? "开" : "关"}  (启动 ${cfg.sync.onStartup} / 退出 ${cfg.sync.onShutdown})`,
    `同步范围: ${
      Object.entries(cfg.sync.scopes)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(", ") || "(无)"
    }`,
    `配置文件: ${cfg.sync.includeConfigs.join(", ")}`,
    `上次心跳: ${state.lastHeartbeat ? new Date(state.lastHeartbeat).toLocaleString() : "-"}`,
    `上次拉取: ${state.lastPullAt ? new Date(state.lastPullAt).toLocaleString() : "-"}`,
    `已跟踪对象: ${Object.keys(state.objects).length}   会话: ${Object.keys(state.sessions).length}`,
    `统计采集: ${cfg.stats.collect ? "开" : "关"}`,
  ];
  if (serverConfigured()) {
    const progress = startProgress(ctx, "正在获取服务器状态…");
    try {
      const health = await client().health();
      lines.push(`服务器状态: healthy (${health.version}, 协议 v1)`);
      const conflicts = await client().listConflicts();
      lines.push(`未解决冲突: ${conflicts.filter((c) => !c.resolvedAt).length}`);
      progress?.done();
    } catch (err) {
      progress?.error(`服务器不可达：${(err as Error).message}`);
      lines.push(`服务器状态: 不可达 (${(err as Error).message})`);
    }
  } else {
    lines.push("服务器状态: 未配置 — 运行 /qisumi-sync-config-import <url> <token> 开始");
  }
  return Promise.resolve(lines.join("\n"));
}

function cmdSyncConfigShow(): string {
  return [
    "═══ pi-cloud-sync 配置 ═══",
    `配置文件: ${configPath()}`,
    `deviceName: ${cfg.deviceName}`,
    `server.url: ${cfg.server?.url ?? ""}`,
    `server.token: ${cfg.server?.token ? "***" + cfg.server.token.slice(-4) : ""}`,
    `sync.automatic: ${cfg.sync.automatic}`,
    `sync.onStartup: ${cfg.sync.onStartup}`,
    `sync.onShutdown: ${cfg.sync.onShutdown}`,
    `sync.scopes: ${JSON.stringify(cfg.sync.scopes)}`,
    `sync.includeConfigs: ${JSON.stringify(cfg.sync.includeConfigs)}`,
    `sync.autoInstallPackages: ${cfg.sync.autoInstallPackages}`,
    `stats.collect: ${cfg.stats.collect}`,
    `stats.currency: ${cfg.stats.currency}  (--cny/--usd 可临时切换)`,
    `stats.usdCnyRate: ${cfg.stats.usdCnyRate}`,
  ].join("\n");
}

function cmdSyncConfigSet(args: string): string {
  const [key, ...valueParts] = args.trim().split(/\s+/);
  const value = valueParts.join(" ");
  if (!key || value === "")
    return "用法: /qisumi-sync-config-set <key> <value>  (key 如 deviceName, server.url, server.token)";
  cfg = setConfigPath(cfg, key, value);
  saveConfig(cfg);
  return `已设置 ${key} = ${key.includes("token") ? "***" : value}`;
}

function cmdSyncConfigReset(): string {
  cfg.server = null;
  saveConfig(cfg);
  return "已清除服务器配置。";
}

function cmdSyncConfigImport(args: string): string {
  const [url, token] = args.trim().split(/\s+/);
  if (!url || !token) return "用法: /qisumi-sync-config-import <server-url> <token>";
  cfg.server = { url, token, verifyTls: true };
  saveConfig(cfg);
  return "服务器配置已导入。运行 /qisumi-sync-now 开始同步。";
}

/** 交互式配置向导（TUI）；非交互模式提示用命令导入 */
async function cmdSyncConfigWizard(ctx: ExtensionCommandContext): Promise<string> {
  if (!ctx.hasUI) return "非交互模式下请使用: /qisumi-sync-config-import <url> <token>";

  const url = await ctx.ui.input("服务器地址 (https://sync.example.com):", cfg.server?.url ?? "");
  if (!url) return "已取消";
  const token = await ctx.ui.input("访问令牌:", cfg.server?.token ?? "");
  if (!token) return "已取消";
  const deviceName = await ctx.ui.input("当前设备名称:", cfg.deviceName);
  if (!deviceName) return "已取消";
  const auto = await ctx.ui.confirm("启用自动同步?", String(cfg.sync.automatic));

  cfg.server = { url: url.replace(/\/+$/, ""), token, verifyTls: true };
  cfg.deviceName = deviceName;
  cfg.sync.automatic = auto;
  saveConfig(cfg);
  return `配置已保存。设备 "${deviceName}" 已关联到 ${url}。运行 /qisumi-sync-now 开始同步。`;
}

/** 点路径设置配置（string 值，JSON 自动解析） */
function setConfigPath(cfg: SyncConfig, key: string, value: string): SyncConfig {
  const parse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  };
  const set = (obj: Record<string, unknown>, path: string, v: unknown) => {
    const parts = path.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
      cur = cur[p] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = v;
  };
  set(cfg as unknown as Record<string, unknown>, key, parse(value));
  return cfg;
}

async function cmdUsage(args: string, ctx: ExtensionCommandContext): Promise<string> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let format: "table" | "json" | "csv" | "markdown" = "table";
  // 默认近 7 天；all/full 可看全部
  let days: number | null = 7;
  let top = 10;
  let saveTo: string | null = null;
  let currentSession = false;
  let fullView = false;
  // 价格显示货币：默认取配置（cny=¥），可用 --cny / --usd 临时切换
  let currency: "usd" | "cny" = cfg.stats?.currency ?? "cny";
  let rate = cfg.stats?.usdCnyRate ?? 6.76;

  for (const p of parts) {
    if (p === "today") days = 1;
    else if (p === "7d" || p === "week") days = 7;
    else if (p === "30d" || p === "month") days = 30;
    else if (p === "all") days = null;
    else if (p === "full" || p === "--full") fullView = true;
    else if (p === "--cny") currency = "cny";
    else if (p === "--usd") currency = "usd";
    else if (p === "--json") format = "json";
    else if (p === "--csv") format = "csv";
    else if (p === "--md" || p === "--markdown") format = "markdown";
    else if (p === "current") currentSession = true;
    else if (p === "live") return toggleLive(ctx);
    else if (p.startsWith("--save=")) saveTo = p.slice("--save=".length);
    else if (p.startsWith("--top=")) top = parseInt(p.slice("--top=".length), 10) || 10;
    else if (/^\d+d$/.test(p)) days = parseInt(p, 10);
  }

  const state = loadState();
  const deviceId = state.deviceId ?? ensureDeviceId();
  const progress = startProgress(ctx, "正在扫描会话并统计用量…");
  const live = cfg.stats.collect ? collector.loadAll() : [];
  const scanned = scanAllSessions(deviceId);
  const records = mergeRecords(live, scanned);

  // 人民币显示：优先拉取 Exchangerate-API 实时汇率（6h 缓存），失败回退配置值
  if (currency === "cny") {
    const liveRate = await fetchUsdCnyRate();
    if (liveRate) rate = liveRate;
  }

  const sessionId = currentSession ? ctx.sessionManager.getSessionId() : null;
  const report = buildReport(records, { days, groupBySessionTop: top, sessionId });

  progress?.done();

  const opts = { currency, usdCnyRate: rate, view: fullView ? ("full" as const) : ("compact" as const), days };

  if (currentSession) {
    return formatSessionSummary(ctx.sessionManager.getSessionId() ?? "session", report, opts);
  }

  let outputText: string;
  if (format === "csv") {
    outputText = formatReport(report, "csv");
  } else {
    outputText = formatReport(report, format, opts);
  }

  if (saveTo) {
    writeFileSync(saveTo, outputText, "utf8");
    return `报告已保存到 ${saveTo}`;
  }
  return outputText;
}

function toggleLive(ctx: ExtensionCommandContext): string {
  cfg.stats.collect = !cfg.stats.collect;
  saveConfig(cfg);
  ctx.ui.notify(`实时统计采集: ${cfg.stats.collect ? "开" : "关"}`, "info");
  return `实时统计采集已${cfg.stats.collect ? "开启" : "关闭"}。`;
}

async function piExec(args: string[]): Promise<void> {
  if (!piApi) throw new Error("extension not initialized");
  await piApi.exec("pi", args, { timeout: 120_000 });
}

/* ============================ /qisumi-quota 命令 ============================ */

async function cmdQuota(args: string, ctx: ExtensionCommandContext): Promise<string> {
  const json = args.includes("--json");
  const progress = startProgress(ctx, "正在探测额度（DeepSeek / Z.AI / Codex）…");
  let report;
  try {
    report = await probeAllQuotas();
  } catch (err) {
    progress?.error(`额度探测失败：${(err as Error).message}`);
    return `额度探测失败: ${(err as Error).message}`;
  }

  if (json) {
    progress?.done();
    return JSON.stringify(report, null, 2);
  }

  progress?.done();
  if (ctx.hasUI && ctx.mode === "tui") {
    await quotaDialog(ctx, report);
    return `额度探测完成 · ${quotaSummary(report)}`;
  }
  return formatQuotaText(report);
}

/* ============================ 事件 ============================ */

function registerEvents(pi: ExtensionAPI) {
  // 自动拉取
  pi.on("session_start", async (_event, ctx) => {
    if (!serverConfigured() || !cfg.sync.automatic || cfg.sync.onStartup !== "pull") return;
    const c = client();
    pull(cfg, loadState(), c, {
      skipFile: ctx.sessionManager.getSessionFile() ?? undefined,
      piExec: (args) => piExec(args),
    })
      .then((report) => {
        if (report.errors.length > 0) {
          ctx.ui.notify(`同步: ${report.errors.join("; ")}`, "warning");
        }
      })
      .catch((err) => ctx.ui.notify(`同步失败: ${(err as Error).message}`, "error"));
  });

  // 自动推送（会话关闭/切换时）
  pi.on("session_shutdown", () => {
    if (!serverConfigured() || !cfg.sync.automatic || cfg.sync.onShutdown !== "push") return;
    const c = client();
    push(cfg, loadState(), c, "0.83.0", EXT_VERSION).catch(() => {
      // 静默失败：进程可能即将退出
    });
  });

  // 用量统计：assistant / toolResult 消息
  pi.on("message_end", async (event, ctx) => {
    if (!cfg.stats.collect) return;
    const m = event.message as {
      role?: string;
      provider?: string;
      model?: string;
      usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        totalTokens?: number;
        cost?: { total?: number };
      };
    };
    if (m.role !== "assistant" && m.role !== "toolResult") return;
    if (!m.usage || !m.model) return;
    const sm = ctx.sessionManager;
    collector.record({
      sessionId: sm.getSessionId(),
      sessionName: sm.getSessionName() ?? null,
      project: sm.getCwd() ?? ctx.cwd,
      provider: m.provider ?? "",
      model: m.model,
      usage: m.usage,
      role: m.role,
      device: cfg.deviceName,
    });
  });

  // 用量统计：compaction
  pi.on("session_compact", async (event, ctx) => {
    if (!cfg.stats.collect) return;
    const usage = (event.compactionEntry as { usage?: unknown } | undefined)?.usage as
      | {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
          totalTokens?: number;
          cost?: { total?: number };
        }
      | undefined;
    if (!usage) return;
    const sm = ctx.sessionManager;
    collector.record({
      sessionId: sm.getSessionId(),
      sessionName: sm.getSessionName() ?? null,
      project: sm.getCwd() ?? ctx.cwd,
      provider: "",
      model: "(compaction)",
      usage,
      role: "assistant",
      device: cfg.deviceName,
    });
  });
}

/* ============================ 命令总览 ============================ */

const SYNC_COMMANDS: Array<[string, string]> = [
  ["/qisumi-sync", "同步状态（无参）；help 查看子命令列表"],
  ["/qisumi-sync-status", "查看同步状态"],
  ["/qisumi-sync-push", "推送本地变更到服务器"],
  ["/qisumi-sync-pull", "从服务器拉取变更"],
  ["/qisumi-sync-now", "完整同步（先拉后推）"],
  ["/qisumi-sync-conflicts", "查看冲突记录"],
  ["/qisumi-sync-conflicts-resolve <id> keep-a|keep-b", "解决指定冲突"],
  ["/qisumi-sync-devices", "查看已关联设备"],
  ["/qisumi-sync-find <关键词>", "搜索本地会话"],
  ["/qisumi-sync-list", "列出本地会话"],
  ["/qisumi-sync-restore <uuid>", "恢复已删除会话"],
  ["/qisumi-sync-config", "交互式配置向导"],
  ["/qisumi-sync-config-show", "查看当前配置"],
  ["/qisumi-sync-config-set <key> <value>", "设置配置项"],
  ["/qisumi-sync-config-import <url> <token>", "导入服务器配置"],
  ["/qisumi-sync-config-reset", "清除服务器配置"],
];

const OTHER_COMMANDS: Array<[string, string]> = [
  ["/qisumi-usage [today|7d|30d|all|Nd] [current|full] [--cny|--usd] [--json|--csv|--md] [--save=file] [--top=N] [live]", "用量统计（默认近 7 天：分日 + 分模型两表）"],
  ["/qisumi-quota [--json]", "额度探测（DeepSeek 余额 / Z.AI 5h+周 / Codex 周）"],
];

function cmdOverview(): string {
  const lines = ["═══ pi-cloud-sync · /qisumi 命令总览 ═══", ""];
  lines.push("─ 云同步 Sync ─");
  for (const [cmd, desc] of SYNC_COMMANDS) lines.push(`  ${cmd.padEnd(44)} ${desc}`);
  lines.push("", "─ 统计与额度 ─");
  for (const [cmd, desc] of OTHER_COMMANDS) lines.push(`  ${cmd.padEnd(44)} ${desc}`);
  lines.push("", "输入 /qisumi- 可自动补全所有命令。");
  return lines.join("\n");
}

function syncHelp(): string {
  return ["用法: /qisumi-sync <status|help>", ...SYNC_COMMANDS.map(([cmd, desc]) => `  ${cmd.padEnd(44)} ${desc}`)].join("\n");
}

/* ============================ 入口 ============================ */

export default function (pi: ExtensionAPI) {
  piApi = pi;
  cfg = loadConfig();
  collector = new UsageCollector();

  const reg = (
    name: string,
    description: string,
    run: (args: string, ctx: ExtensionCommandContext) => Promise<string>,
    options: {
      title?: string;
      static?: boolean;
      completions?: (prefix: string) => AutocompleteItem[] | null;
    } = {},
  ) => {
    pi.registerCommand(name, {
      description,
      ...(options.completions ? { getArgumentCompletions: options.completions } : {}),
      handler: async (args, ctx) => {
        const result = await run(args ?? "", ctx);
        await output(ctx, result, options.title ?? name, options.static ? { static: true } : undefined);
      },
    });
  };

  // /qisumi 总览
  reg("qisumi", "命令总览：全部 /qisumi-* 指令说明", () => Promise.resolve(cmdOverview()));

  // ---- 云同步 Sync ----
  reg("qisumi-sync", "同步状态（无参）；输入 help 查看全部子命令", (args, ctx) => {
    if (args.trim() === "help") return Promise.resolve(syncHelp());
    return cmdSyncStatus(ctx);
  });
  reg("qisumi-sync-status", "查看同步状态", (_args, ctx) => cmdSyncStatus(ctx), { title: "同步状态" });
  reg("qisumi-sync-push", "推送本地变更到服务器", (_args, ctx) => cmdSyncPush(ctx), { title: "推送" });
  reg("qisumi-sync-pull", "从服务器拉取变更", (_args, ctx) => cmdSyncPull(ctx), { title: "拉取" });
  reg("qisumi-sync-now", "完整同步（先拉后推）", (_args, ctx) => cmdSyncNow(ctx), { title: "同步" });
  reg("qisumi-sync-conflicts", "查看冲突记录", (_args, ctx) => cmdSyncConflicts(ctx), { title: "冲突" });
  reg("qisumi-sync-conflicts-resolve", "解决冲突 <id> keep-a|keep-b", (args, ctx) => cmdSyncConflictResolve(args, ctx), {
    title: "解决冲突",
    completions: (prefix) => {
      const words = prefix.trim().split(/\s+/).filter(Boolean);
      const p = words.length >= 2 ? words[words.length - 1] : "";
      if (p && !p.startsWith("k")) return null;
      return ["keep-a", "keep-b"]
        .filter((c) => c.startsWith(p))
        .map((value) => ({ value, label: value }));
    },
  });
  reg("qisumi-sync-devices", "查看已关联设备", (_args, ctx) => cmdSyncDevices(ctx), { title: "设备" });
  reg("qisumi-sync-find", "搜索本地会话 <关键词>", (args) => Promise.resolve(cmdSyncFind(args)), { title: "搜索会话" });
  reg("qisumi-sync-list", "列出本地会话", () => Promise.resolve(cmdSyncList()), { title: "本地会话" });
  reg("qisumi-sync-restore", "恢复已删除会话 <uuid>", (args) => Promise.resolve(cmdSyncRestore(args)), { title: "恢复会话" });
  reg("qisumi-sync-config", "交互式配置向导（服务器 / 令牌 / 设备名 / 开关）", (_args, ctx) => cmdSyncConfigWizard(ctx), {
    title: "配置",
  });
  reg("qisumi-sync-config-show", "查看当前配置", () => Promise.resolve(cmdSyncConfigShow()), { title: "配置" });
  reg("qisumi-sync-config-set", "设置配置项 <key> <value>", (args) => Promise.resolve(cmdSyncConfigSet(args)), {
    title: "配置",
    completions: (prefix) => {
      const words = prefix.trim().split(/\s+/).filter(Boolean);
      if (words.length >= 2) return null;
      const p = words[0] ?? "";
      const keys = [
        "deviceName",
        "server.url",
        "server.token",
        "sync.automatic",
        "sync.onStartup",
        "sync.onShutdown",
        "sync.scopes.config",
        "sync.includeConfigs",
        "stats.collect",
        "stats.currency",
        "stats.usdCnyRate",
      ];
      return keys.filter((k) => k.startsWith(p)).map((value) => ({ value, label: value }));
    },
  });
  reg("qisumi-sync-config-import", "导入服务器配置 <url> <token>", (args) => Promise.resolve(cmdSyncConfigImport(args)), {
    title: "配置",
  });
  reg("qisumi-sync-config-reset", "清除服务器配置", () => Promise.resolve(cmdSyncConfigReset()), { title: "配置" });

  // ---- 用量统计 ----
  reg(
    "qisumi-usage",
    "用量统计：[today|7d|30d|all|Nd] [current|full] [--cny|--usd] [--json|--csv|--md] [--save=file] [--top=N] [live]（默认近7天：按天+按模型两表）",
    (args, ctx) => cmdUsage(args, ctx),
    {
      title: "用量统计 Usage",
      static: true,
      completions: (prefix) => {
        const words = prefix.trim().split(/\s+/).filter(Boolean);
        const p = words.length ? words[words.length - 1] : "";
        const opts = ["today", "7d", "30d", "all", "full", "current", "live", "--cny", "--usd", "--json", "--csv", "--md", "--top=", "--save="];
        return opts.filter((o) => o.startsWith(p)).map((value) => ({ value, label: value }));
      },
    },
  );

  // ---- 额度探测 ----
  reg("qisumi-quota", "额度探测：DeepSeek 余额 / Z.AI 5h+周 / Codex 周 [--json]", (args, ctx) => cmdQuota(args, ctx), {
    title: "额度探测",
    completions: (prefix) => {
      if (prefix.trim() === "--") return [{ value: "--json", label: "--json 输出 JSON" }];
      return prefix.trim().startsWith("--") ? [{ value: "--json", label: "--json 输出 JSON" }] : null;
    },
  });

  registerEvents(pi);
}
