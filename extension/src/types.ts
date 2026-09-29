/**
 * 协议类型（vendored 副本）
 * 与仓库根目录 shared/src/index.ts 保持同步；扩展保持零运行时依赖，
 * 以便作为独立 pi 包分发。
 */

export type ObjectKind = "config" | "plugin-file" | "package-manifest";

export interface JsonFieldChange {
  path: string;
  /** JSON 字符串值；null = 删除该路径（真实 JSON null 值传字符串 "null"） */
  valueJson: string | null;
  version: number;
}

export interface FieldVersion {
  path: string;
  version: number;
  updatedBy: string;
  updatedAt: number;
}

export interface PushChange {
  kind: ObjectKind;
  key: string;
  baseSha256: string | null;
  jsonFields?: JsonFieldChange[];
  contentB64?: string;
  sha256?: string;
  mtime?: number;
}

export interface MergedObject {
  key: string;
  kind: ObjectKind;
  version: number;
  sha256: string;
  contentB64: string;
  fieldVersions: FieldVersion[];
  updatedBy: string;
  updatedAt: number;
  deleted: boolean;
}

export interface ConflictRecord {
  id: number;
  objectKey: string;
  path: string;
  kind: ObjectKind | "session-entry";
  deviceA: string;
  deviceB: string;
  contentA: string;
  contentB: string;
  resolution: "keep-a" | "keep-b" | "manual" | null;
  resolvedAt: number | null;
  createdAt: number;
}

export interface SessionEntryChange {
  id: string;
  parentId: string | null;
  lineJson: string;
}

export interface SessionChange {
  uuid: string;
  cwd: string;
  name?: string;
  /** 会话原始 header 行（JSON，不含换行） */
  headerJson?: string;
  /** 会话创建时间（ms） */
  createdAt?: number;
  baseVersion: number;
  entries: SessionEntryChange[];
  deleted?: boolean;
  mtime: number;
}

export interface MergedSession {
  uuid: string;
  cwd: string;
  name: string | null;
  version: number;
  deleted: boolean;
  updatedBy: string;
  updatedAt: number;
  acceptedEntries: number;
  conflicts: number;
}

export interface UsageEventChange {
  id: string;
  sessionUuid: string;
  occurredAt: number;
  provider: string;
  model: string;
  requests?: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export type SessionDelta =
  | {
      seq: number;
      kind: "header";
      op: "upsert" | "tombstone";
      session: Omit<SessionSnapshot, "lines">;
    }
  | {
      seq: number;
      kind: "entry";
      op: "insert" | "update";
      uuid: string;
      session: Omit<SessionSnapshot, "lines">;
      entry: SessionEntryChange & { sourceDeviceId: string; sourceDevice: string };
    };

export interface SessionPullRequestV2 {
  cursor?: number | null;
  limit?: number;
  maxBytes?: number;
}

export interface SessionPullResponseV2 {
  changes: SessionDelta[];
  nextCursor: number;
  hasMore: boolean;
}

export interface SessionPushRequestV2 {
  sessions: SessionChange[];
  usageEvents?: UsageEventChange[];
}

export interface SessionPushResponseV2 {
  sessions: MergedSession[];
  conflicts: ConflictRecord[];
  acceptedUsageEvents: number;
}

export interface SessionSnapshot {
  uuid: string;
  cwd: string;
  name: string | null;
  headerJson: string | null;
  createdAt: number | null;
  version: number;
  deleted: boolean;
  updatedBy: string;
  updatedAt: number;
  lines: string[];
}

export interface PullRequest {
  since?: number | null;
  keys?: string[] | null;
  includeSessions?: boolean;
}

export interface PullResponse {
  objects: MergedObject[];
  sessions: SessionSnapshot[];
  packageManifest: MergedObject | null;
  serverTime: number;
}

export interface PushResponse {
  objects: MergedObject[];
  conflicts: ConflictRecord[];
  sessions: MergedSession[];
}

export interface DeviceInfo {
  deviceId: string;
  name: string;
  platform: string;
  piVersion: string;
  extensionVersion: string;
  lastSeen: number;
  createdAt: number;
  status: "active" | "legacy" | "merged";
  mergedInto: string | null;
  mergedAt: number | null;
  isLegacy: boolean;
  sessionCount: number;
  entryCount: number;
  totalTokens: number;
  totalCost: number;
}

export interface HeartbeatRequest {
  deviceId: string;
  name: string;
  platform: string;
  piVersion: string;
  extensionVersion: string;
}

export interface ApiEnvelope<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export const SYNC_PROTOCOL_VERSION = 2;
