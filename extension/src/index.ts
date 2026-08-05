import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
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

async function cmdSync(args: string, ctx: ExtensionCommandContext): Promise<string> {
  const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);

  if (!sub || sub === "status") return syncStatus(ctx);

  if (sub === "push") {
    if (!serverConfigured()) return "服务器未配置：运行 /sync config";
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

  if (sub === "pull") {
    if (!serverConfigured()) return "服务器未配置：运行 /sync config";
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

  if (sub === "now") {
    if (!serverConfigured()) return "服务器未配置：运行 /sync config";
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

  if (sub === "conflicts") {
    const action = rest[0];
    if (action === "resolve") {
      const id = parseInt(rest[1] ?? "", 10);
      const how = (rest[2] ?? "keep-b") as "keep-a" | "keep-b";
      if (Number.isNaN(id)) return "用法: /sync conflicts resolve <id> keep-a|keep-b";
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
        "\n解决: /sync conflicts resolve <id> keep-a|keep-b"
      );
    } catch (err) {
      progress?.error(`获取冲突失败：${(err as Error).message}`);
      return `获取冲突失败: ${(err as Error).message}`;
    }
  }

  if (sub === "devices") {
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

  if (sub === "find") {
    const query = rest.join(" ");
    const sessions = searchLocalSessions(query);
    if (sessions.length === 0) return "未找到匹配的会话";
    return sessions
      .map((s) => `• ${s.name ?? s.uuid}  (${s.entries.length} entries)\n  cwd: ${s.cwd}\n  uuid: ${s.uuid}`)
      .join("\n");
  }

  if (sub === "restore") {
    const uuid = rest[0];
    if (!uuid) return "用法: /sync restore <session-uuid>";
    try {
      const ok = await client().restoreSession(uuid);
      return ok ? `会话 ${uuid} 已恢复（清除删除标记）。` : `未找到会话 ${uuid}`;
    } catch (err) {
      return `恢复失败: ${(err as Error).message}`;
    }
  }

  if (sub === "list") {
    const sessions = localSessionsIndex();
    if (sessions.length === 0) return "本地没有会话";
    return sessions
      .map((s) => `• ${s.name ?? s.uuid}  (${s.entryCount} entries) — ${s.cwd}`)
      .join("\n");
  }

  if (sub === "config") return cmdSyncConfig(rest, ctx);

  return [
    "用法: /sync <subcommand>",
    "  status     查看同步状态",
    "  push       推送本地变更",
    "  pull       拉取远端变更",
    "  now        完整同步（先拉后推）",
    "  conflicts  查看/解决冲突 (resolve <id> keep-a|keep-b)",
    "  devices    查看设备列表",
    "  find <q>   搜索本地会话",
    "  list       列出本地会话",
    "  restore <uuid>  恢复已删除会话",
    "  config     配置（服务器 / 令牌 / 设备名 / 开关）",
  ].join("\n");
}

function preview(s: string, max = 80): string {
  const clean = s.replace(/\n/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

async function syncStatus(ctx: ExtensionCommandContext): Promise<string> {
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
    lines.push("服务器状态: 未配置 — 运行 /sync config 开始");
  }
  return Promise.resolve(lines.join("\n"));
}

async function cmdSyncConfig(rest: string[], ctx: ExtensionCommandContext): Promise<string> {
  const action = rest[0];

  if (action === "show") {
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
    ].join("\n");
  }

  if (action === "set") {
    const [key, ...valueParts] = rest.slice(1);
    const value = valueParts.join(" ");
    if (!key || value === "")
      return "用法: /sync config set <key> <value>  (key 如 deviceName, server.url, server.token)";
    cfg = setConfigPath(cfg, key, value);
    saveConfig(cfg);
    return `已设置 ${key} = ${key.includes("token") ? "***" : value}`;
  }

  if (action === "reset") {
    cfg.server = null;
    saveConfig(cfg);
    return "已清除服务器配置。";
  }

  if (action === "import") {
    const url = rest[1];
    const token = rest[2];
    if (!url || !token) return "用法: /sync config import <server-url> <token>";
    cfg.server = { url, token, verifyTls: true };
    saveConfig(cfg);
    return "服务器配置已导入。运行 /sync now 开始同步。";
  }

  // 交互式向导
  if (!ctx.hasUI) return "非交互模式下请使用: /sync config import <url> <token>";

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
  return `配置已保存。设备 "${deviceName}" 已关联到 ${url}。运行 /sync now 开始同步。`;
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
  let days: number | null = null;
  let top = 10;
  let saveTo: string | null = null;
  let currentSession = false;

  for (const p of parts) {
    if (p === "today") days = 1;
    else if (p === "7d" || p === "week") days = 7;
    else if (p === "30d" || p === "month") days = 30;
    else if (p === "all") days = null;
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

  const sessionId = currentSession ? ctx.sessionManager.getSessionId() : null;
  const report = buildReport(records, { days, groupBySessionTop: top, sessionId });

  progress?.done();

  if (currentSession) {
    return formatSessionSummary(ctx.sessionManager.getSessionId() ?? "session", report);
  }

  let outputText: string;
  if (format === "csv") {
    outputText = formatReport(report, "csv");
  } else {
    outputText = formatReport(report, format);
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

/* ============================ /quota 命令 ============================ */

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

/* ============================ 入口 ============================ */

export default function (pi: ExtensionAPI) {
  piApi = pi;
  cfg = loadConfig();
  collector = new UsageCollector();

  pi.registerCommand("sync", {
    description: "云同步：status | push | pull | now | conflicts | devices | find | list | restore | config",
    handler: async (args, ctx) => {
      const result = await cmdSync(args ?? "", ctx);
      await output(ctx, result, "sync");
    },
  });

  pi.registerCommand("usage", {
    description: "用量统计：[today|7d|30d|all|Nd] [current] [--json|--csv|--md] [--save=file] [--top=N] [live]",
    handler: async (args, ctx) => {
      const result = await cmdUsage(args ?? "", ctx);
      await output(ctx, result, "usage");
    },
  });

  pi.registerCommand("quota", {
    description: "额度探测：DeepSeek 余额 / Z.AI 5h 额度 / Codex 周额度 [--json]",
    handler: async (args, ctx) => {
      const result = await cmdQuota(args ?? "", ctx);
      await output(ctx, result, "quota");
    },
  });

  registerEvents(pi);
}
