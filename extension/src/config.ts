import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import { randomUUID } from "node:crypto";

export const CONFIG_FILE = "pi-sync.json";
export const STATE_FILE = "pi-sync-state.json";

export interface SyncConfig {
  version: number;
  /** 当前设备名称（参与来源标注与冲突记录） */
  deviceName: string;
  server: {
    url: string;
    token: string;
    verifyTls: boolean;
  } | null;
  sync: {
    automatic: boolean;
    onStartup: "pull" | "none";
    onShutdown: "push" | "none";
    scopes: { config: boolean; sessions: boolean; plugins: boolean };
    includeConfigs: string[];
    autoInstallPackages: boolean;
    pruneTombstonesAfterDays: number;
    /** 不同步工具输出与工具调用块（只保留用量元数据，本地文件保持完整） */
    stripToolOutputs: boolean;
    /** 不同步思考过程（上传时移除 thinking 块） */
    stripThinking: boolean;
  };
  stats: {
    collect: boolean;
    /** 价格显示货币：usd=$ / cny=¥（默认） */
    currency: "usd" | "cny";
    /** USD→CNY 汇率（currency=cny 时用于换算显示；运行时优先拉取 Exchangerate-API 实时汇率） */
    usdCnyRate: number;
  };
  session: {
    /** 自动为新会话命名（取首条用户消息摘要） */
    autoName: boolean;
    /** 自动命名最大长度 */
    autoNameMax: number;
    /** provider → 仅供 AI 自动命名使用的低价模型 id */
    autoNameModelByProvider: Record<string, string>;
  };
  /** 兼容旧版字段（WebDAV 等），保留不动 */
  legacy?: Record<string, unknown>;
}

const DEFAULTS: SyncConfig = {
  version: 5,
  deviceName: "",
  server: null,
  sync: {
    automatic: true,
    onStartup: "pull",
    onShutdown: "push",
    scopes: { config: true, sessions: true, plugins: true },
    includeConfigs: ["settings.json", "keybindings.json", "models.json", "auth.json"],
    autoInstallPackages: true,
    pruneTombstonesAfterDays: 30,
    stripToolOutputs: true,
    stripThinking: true,
  },
  stats: { collect: true, currency: "cny", usdCnyRate: 6.76 },
  session: {
    autoName: true,
    autoNameMax: 32,
    // 各订阅内成本相对低的模型（deepseek 2026-08-17 起峰谷定价：高峰 9-12/14-18 北京时、空闲半价；
    // v4-flash 峰值 3.0/9.0 元 vs v4-pro 9.0/27.0 元，flash 仍最便宜；
    // openai-codex 目录价 gpt-6-luna 0.1/0.5 USD 最便宜（2026-09-22 发布，取代 gpt-5.6-luna 0.2/1.2；
    // gpt-6-astra 10/50 不适合）；
    // xiaomi-token-plan-cn：mimo-v2.6-flash 沿用 v2.5 按量价 1/2 元，为套餐内最低；
    // zai-coding-cn：glm-5.3-flash 已全量上线套餐且额度 3×，按量价 0.8/2.8 元低于 glm-4.7 的 2/8）
    autoNameModelByProvider: {
      deepseek: "deepseek-v4-flash",
      "zai-coding-cn": "glm-5.3-flash",
      "openai-codex": "gpt-6-luna",
      "xiaomi-token-plan-cn": "mimo-v2.6-flash",
    },
  },
};

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function configPath(): string {
  return join(agentDir(), CONFIG_FILE);
}

export function statePath(): string {
  return join(agentDir(), STATE_FILE);
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === null || patch === undefined) return base;
  // 注意 typeof null === "object"，必须先排除 null
  if (base !== null && typeof base === "object" && typeof patch === "object" && !Array.isArray(base) && !Array.isArray(patch)) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      out[k] = deepMerge((base as Record<string, unknown>)[k], v);
    }
    return out;
  }
  return patch;
}

/** 加载配置；不存在则返回默认值。兼容旧格式（storageConnections 等保留为 legacy）。 */
export function loadConfig(): SyncConfig {
  const cfg = structuredClone(DEFAULTS) as SyncConfig & { [k: string]: unknown };
  try {
    if (existsSync(configPath())) {
      const raw = JSON.parse(readFileSync(configPath(), "utf8"));
      const merged = deepMerge(structuredClone(DEFAULTS), raw);
      Object.assign(cfg, merged);
      // 收集旧字段到 legacy（storageConnections / syncSetups / activeSyncSetup）
      const legacy: Record<string, unknown> = {};
      for (const k of ["storageConnections", "syncSetups", "activeSyncSetup"]) {
        if (raw && typeof raw === "object" && k in raw) legacy[k] = (raw as Record<string, unknown>)[k];
      }
      if (Object.keys(legacy).length > 0) cfg.legacy = legacy;
    }
  } catch (err) {
    console.error("[pi-cloud-sync] failed to load config:", err);
  }
  if (!cfg.deviceName) cfg.deviceName = hostname();
  // 迁移：v3 → v4 自动把 auth.json 加入同步列表（默认无感开启，仅执行一次）
  if ((cfg.version ?? 0) < 4 && !cfg.sync.includeConfigs.includes("auth.json")) {
    cfg.sync.includeConfigs.push("auth.json");
    cfg.version = 4;
    try {
      saveConfig(cfg);
    } catch {
      // ignore
    }
  } else if ((cfg.version ?? 0) < 4) {
    cfg.version = 4;
  }
  // 迁移：旧“切换主会话低价模型”配置改为“独立 AI 命名模型”。
  if ((cfg.version ?? 0) < 5) {
    const legacySession = cfg.session as unknown as {
      cheapModelByProvider?: Record<string, string>;
      defaultCheapModel?: boolean;
      autoNameModelByProvider?: Record<string, string>;
    };
    if (legacySession.cheapModelByProvider) {
      cfg.session.autoNameModelByProvider = legacySession.cheapModelByProvider;
    }
    delete legacySession.cheapModelByProvider;
    delete legacySession.defaultCheapModel;
    cfg.version = 5;
    try {
      saveConfig(cfg);
    } catch {
      // ignore
    }
  }
  return cfg as SyncConfig;
}

export function saveConfig(cfg: SyncConfig): void {
  mkdirSync(agentDir(), { recursive: true });
  const out: Record<string, unknown> = {
    version: cfg.version,
    deviceName: cfg.deviceName,
    server: cfg.server,
    sync: cfg.sync,
    stats: cfg.stats,
    session: cfg.session,
  };
  if (cfg.legacy) Object.assign(out, cfg.legacy);
  writeFileSync(configPath(), JSON.stringify(out, null, 2) + "\n", "utf8");
}

/** 生成本机持久设备 ID（存于 state 文件，避免每次同步注册新设备） */
export function ensureDeviceId(): string {
  const state = loadStateRaw();
  if (typeof state.deviceId === "string" && state.deviceId) return state.deviceId;
  const id = randomUUID();
  saveStateRaw({ ...state, deviceId: id });
  return id;
}

function loadStateRaw(): Record<string, unknown> {
  try {
    if (existsSync(statePath())) {
      return JSON.parse(readFileSync(statePath(), "utf8"));
    }
  } catch {
    // ignore
  }
  return {};
}

function saveStateRaw(state: Record<string, unknown>): void {
  mkdirSync(agentDir(), { recursive: true });
  const target = statePath();
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, JSON.stringify(state) + "\n", "utf8");
  renameSync(temporary, target);
}

/* ---------------- 同步状态（游标、字段版本、会话基线） ---------------- */

export interface SyncState {
  stateVersion: number;
  deviceId?: string;
  /** 上次心跳时间 */
  lastHeartbeat?: number;
  /** 上次 pull 时间（增量拉取游标） */
  lastPullAt?: number;
  /** v2 会话增量拉取游标 */
  sessionCursor: number;
  /** 每个对象 key 的客户端状态 */
  objects: Record<
    string,
    {
      /** 客户端上次推送/接收的服务器内容哈希 */
      baseSha256: string | null;
      /** 服务器已知版本 */
      serverVersion: number;
      /** 客户端本地上次推送的内容哈希（用于 diff） */
      localSha256: string | null;
      /** 最近一次检查的文件元数据；未变化时避免读取和哈希正文 */
      localSize?: number;
      localMtimeMs?: number;
      /** 客户端字段版本表：path -> { version, value } */
      fields: Record<string, { version: number; value: string }>;
    }
  >;
  /** 每个会话 uuid 的推送游标 */
  sessions: Record<
    string,
    {
      serverVersion: number;
      /** 相对 sessions 根目录的文件路径 */
      path?: string;
      size: number;
      mtimeMs: number;
      /** 已确认上传到服务端的完整行字节偏移 */
      offset: number;
      headerHash: string;
      boundaryHash: string;
      cwd?: string;
      name?: string | null;
      createdAt?: number;
      /** v1 状态迁移时临时读取，保存时不再扩张 */
      pushed?: string[];
    }
  >;
  /** 包清单上次推送的哈希 */
  packageManifestSha256: string | null;
  /** 尚未同步到服务端的插件内部用量事件 */
  pendingUsageEvents: import("./types.js").UsageEventChange[];
  lastScan?: { files: number; bytesRead: number; durationMs: number; at: number };
}

export function loadState(): SyncState {
  const raw = loadStateRaw();
  const state: SyncState = {
    stateVersion: 2,
    deviceId: typeof raw.deviceId === "string" ? raw.deviceId : undefined,
    lastHeartbeat: typeof raw.lastHeartbeat === "number" ? raw.lastHeartbeat : undefined,
    lastPullAt: typeof raw.lastPullAt === "number" ? raw.lastPullAt : undefined,
    sessionCursor: typeof raw.sessionCursor === "number" ? raw.sessionCursor : 0,
    objects: (raw.objects ?? {}) as SyncState["objects"],
    sessions: (raw.sessions ?? {}) as SyncState["sessions"],
    packageManifestSha256:
      typeof raw.packageManifestSha256 === "string" ? raw.packageManifestSha256 : null,
    pendingUsageEvents: Array.isArray(raw.pendingUsageEvents)
      ? (raw.pendingUsageEvents as SyncState["pendingUsageEvents"])
      : [],
    lastScan:
      raw.lastScan && typeof raw.lastScan === "object"
        ? (raw.lastScan as SyncState["lastScan"])
        : undefined,
  };
  for (const session of Object.values(state.sessions)) {
    session.size = Number(session.size ?? 0);
    session.mtimeMs = Number(session.mtimeMs ?? 0);
    session.offset = Number(session.offset ?? 0);
    session.headerHash = String(session.headerHash ?? "");
    session.boundaryHash = String(session.boundaryHash ?? "");
    session.cwd = typeof session.cwd === "string" ? session.cwd : undefined;
    session.name = typeof session.name === "string" ? session.name : null;
    session.createdAt = typeof session.createdAt === "number" ? session.createdAt : undefined;
    delete session.pushed;
  }
  for (const object of Object.values(state.objects)) {
    object.localSize = typeof object.localSize === "number" ? object.localSize : undefined;
    object.localMtimeMs = typeof object.localMtimeMs === "number" ? object.localMtimeMs : undefined;
  }
  return state;
}

export function saveState(state: SyncState): void {
  saveStateRaw(state as unknown as Record<string, unknown>);
}

/** 初始化一个对象的 state 记录（保留已有字段版本） */
export function ensureObjectState(state: SyncState, key: string): void {
  if (!state.objects[key]) {
    state.objects[key] = { baseSha256: null, serverVersion: 0, localSha256: null, fields: {} };
  }
}

export function ensureSessionState(state: SyncState, uuid: string): void {
  if (!state.sessions[uuid]) {
    state.sessions[uuid] = {
      serverVersion: 0,
      size: 0,
      mtimeMs: 0,
      offset: 0,
      headerHash: "",
      boundaryHash: "",
    };
  }
}
