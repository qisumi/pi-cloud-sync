/**
 * 共享类型：同步协议（server 与 extension 共用）
 * 保持零依赖：仅包含纯类型与常量，可在 server 与扩展中直接导入。
 */

/** 同步的数据范围（scope） */
export const SYNC_SCOPES = ["config", "session", "plugin"] as const;
export type SyncScope = (typeof SYNC_SCOPES)[number];

/** 对象类型 */
export type ObjectKind = "config" | "plugin-file" | "package-manifest";

/** 配置对象 key（如 config/settings.json） */
export interface ObjectKeyInfo {
  kind: ObjectKind;
  /** 相对 ~/.pi/agent 的文件名，如 settings.json */
  file: string;
}

/** 推送单个配置/文件变更 */
export interface PushChange {
  kind: ObjectKind;
  /** 对象 key，如 "config/settings.json" */
  key: string;
  /** 客户端上次看到的服务器内容哈希（用于判断是否并发修改） */
  baseSha256: string | null;
  /** JSON 字段级变更（kind=config 且文件是 JSON 时使用） */
  jsonFields?: JsonFieldChange[];
  /** 非 JSON 文件整体内容（base64），或 JSON 场景下作为合并后的兜底 */
  contentB64?: string;
  /** 整体内容哈希（客户端当前 sha256） */
  sha256?: string;
  /** 文件 mtime / 客户端修改时间（ms） */
  mtime?: number;
}

/** JSON 字段级变更 */
export interface JsonFieldChange {
  /** 点路径，如 "theme"、"compaction.enabled" */
  path: string;
  /** JSON 字符串值 */
  valueJson: string;
  /** 客户端本地字段版本（客户端递增计数） */
  version: number;
}

/** 字段版本记录（服务器返回给客户端，客户端持久化用于下次 diff） */
export interface FieldVersion {
  path: string;
  version: number;
  updatedBy: string;
  updatedAt: number;
}

/** 对象合并结果 */
export interface MergedObject {
  key: string;
  kind: ObjectKind;
  /** 服务器当前全局版本 */
  version: number;
  /** 合并后的内容 sha256 */
  sha256: string;
  /** 合并后的完整内容（JSON 序列化或原文件内容），base64 编码 */
  contentB64: string;
  /** 合并后的字段版本映射（仅 JSON） */
  fieldVersions: FieldVersion[];
  updatedBy: string;
  updatedAt: number;
  deleted: boolean;
}

/** 冲突记录 */
export interface ConflictRecord {
  id: number;
  objectKey: string;
  /** 冲突位置：字段路径或 "file" */
  path: string;
  kind: ObjectKind | "session-entry";
  deviceA: string;
  deviceB: string;
  /** A 侧内容（JSON 字符串或文本） */
  contentA: string;
  /** B 侧内容 */
  contentB: string;
  resolution: "keep-a" | "keep-b" | "manual" | null;
  resolvedAt: number | null;
  createdAt: number;
}

/* ---------------- 会话同步 ---------------- */

/** 会话增量条目 */
export interface SessionEntryChange {
  /** entry id（8 位 hex） */
  id: string;
  parentId: string | null;
  /** 完整 JSON 行（不含换行），供服务器原样存储 */
  lineJson: string;
}

/** 推送单个会话的增量 */
export interface SessionChange {
  /** 会话 uuid（header id） */
  uuid: string;
  cwd: string;
  name?: string;
  /** 会话原始 header 行（JSON，不含换行） */
  headerJson?: string;
  /** 会话创建时间（ms） */
  createdAt?: number;
  /** 客户端上次同步到的服务器版本 */
  baseVersion: number;
  /** 新增条目（增量） */
  entries: SessionEntryChange[];
  /** 本地删除标记 */
  deleted?: boolean;
  mtime: number;
}

/** 服务器返回的会话合并结果 */
export interface MergedSession {
  uuid: string;
  cwd: string;
  name: string | null;
  version: number;
  deleted: boolean;
  updatedBy: string;
  updatedAt: number;
  /** 服务器上已知的 entryId 集合（用于客户端更新游标） */
  entryIds: string[];
  /** 本次接受的条目数 */
  acceptedEntries: number;
  /** 本次冲突条目数 */
  conflicts: number;
}

/** 会话快照（pull 返回的完整内容） */
export interface SessionSnapshot {
  uuid: string;
  cwd: string;
  name: string | null;
  /** 原始 header 行 */
  headerJson: string | null;
  /** 创建时间 ms */
  createdAt: number | null;
  version: number;
  deleted: boolean;
  updatedBy: string;
  updatedAt: number;
  /** 完整 JSONL 行数组（不含 header 行） */
  lines: string[];
}

/** 拉取请求 */
export interface PullRequest {
  /** 上次拉取后至今的增量时间戳（ms），null=全量 */
  since?: number | null;
  /** 需要的对象 key 列表（null=全部） */
  keys?: string[] | null;
}

/** 拉取响应 */
export interface PullResponse {
  objects: MergedObject[];
  sessions: SessionSnapshot[];
  /** 包清单（合并后） */
  packageManifest: MergedObject | null;
  /** 本机缺失且应安装的包（客户端根据包清单自行计算，服务器只回传清单） */
  serverTime: number;
}

/** 推送响应 */
export interface PushResponse {
  /** 合并后的对象 */
  objects: MergedObject[];
  /** 本次产生的新冲突 */
  conflicts: ConflictRecord[];
  /** 会话合并结果 */
  sessions: MergedSession[];
}

/* ---------------- 设备 ---------------- */

export interface DeviceInfo {
  deviceId: string;
  name: string;
  platform: string;
  piVersion: string;
  extensionVersion: string;
  lastSeen: number;
  createdAt: number;
}

export interface HeartbeatRequest {
  deviceId: string;
  name: string;
  platform: string;
  piVersion: string;
  extensionVersion: string;
}

/* ---------------- API 信封 ---------------- */

export interface ApiEnvelope<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

/** API 错误码 */
export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL"
  | "FORBIDDEN";

export interface ApiErrorBody {
  ok: false;
  error: ApiErrorCode;
  message: string;
}

/** 会话 token 版本常量 */
export const SYNC_PROTOCOL_VERSION = 1;
