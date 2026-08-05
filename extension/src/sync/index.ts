import type { SyncClient } from "../client.js";
import type { SyncConfig, SyncState } from "../config.js";
import { loadState, saveState, ensureObjectState } from "../config.js";
import { buildConfigChanges, applyMergedConfig } from "./configs.js";
import {
  applySessionDeltas,
  commitSessionCheckpoint,
  scanSessionIncrements,
} from "./sessions.js";
import {
  buildPackageManifestChange,
  buildExtensionFileChanges,
  applyExtensionFiles,
  extractPackages,
  diffPackages,
  readLocalPackages,
} from "./plugins.js";
import { SYNC_PROTOCOL_VERSION, type PushChange, type SessionChange } from "../types.js";

export interface SyncReport {
  pushed: { configs: number; sessions: number; entries: number; extensions: number; manifest: boolean };
  pulled: { objects: number; sessions: number; entries: number; extensions: number; installed: string[] };
  conflicts: number;
  errors: string[];
  serverTime: number;
  cursor?: number;
  inbox?: number;
  bytesRead?: number;
}

function emptyReport(): SyncReport {
  return {
    pushed: { configs: 0, sessions: 0, entries: 0, extensions: 0, manifest: false },
    pulled: { objects: 0, sessions: 0, entries: 0, extensions: 0, installed: [] },
    conflicts: 0,
    errors: [],
    serverTime: 0,
  };
}

/** 每包最多 250 条且 JSON 负载约 2 MiB。 */
function splitSessionChange(change: SessionChange): SessionChange[] {
  if (change.entries.length === 0) return [{ ...change, entries: [] }];
  const chunks: SessionChange[] = [];
  let entries: SessionChange["entries"] = [];
  let bytes = 1024 + Buffer.byteLength(change.headerJson ?? "", "utf8");
  const flush = () => {
    if (entries.length === 0) return;
    chunks.push({ ...change, headerJson: chunks.length === 0 ? change.headerJson : undefined, entries });
    entries = [];
    bytes = 1024;
  };
  for (const entry of change.entries) {
    const entryBytes = Buffer.byteLength(entry.lineJson, "utf8") + 256;
    if (entryBytes > 2 * 1024 * 1024) throw new Error(`会话 ${change.uuid} 含超过 2 MiB 的单条记录`);
    if (entries.length >= 250 || bytes + entryBytes > 2 * 1024 * 1024) flush();
    entries.push(entry);
    bytes += entryBytes;
  }
  flush();
  return chunks;
}

/** 设备心跳 + 返回客户端实例 */
export async function heartbeat(
  cfg: SyncConfig,
  state: SyncState,
  client: SyncClient,
  piVersion = "",
  extVersion = "",
): Promise<void> {
  try {
    const health = await client.health();
    if (health.protocol !== SYNC_PROTOCOL_VERSION) {
      throw new Error(`协议不匹配：插件 v${SYNC_PROTOCOL_VERSION}，服务端 v${health.protocol ?? "未知"}，请同步升级`);
    }
    const res = await client.heartbeat({
      name: cfg.deviceName || "unknown",
      platform: process.platform,
      piVersion,
      extensionVersion: extVersion,
    });
    if (res.deviceId) {
      state.deviceId = res.deviceId;
      client.setDeviceId(res.deviceId);
    }
    state.lastHeartbeat = Date.now();
    saveState(state);
  } catch (err) {
    throw new Error(`heartbeat failed: ${(err as Error).message}`);
  }
}

/** 推送本地变更 */
export async function push(
  cfg: SyncConfig,
  state: SyncState,
  client: SyncClient,
  piVersion: string,
  extVersion: string,
  onStage?: (msg: string) => void,
  skipHeartbeat = false,
): Promise<SyncReport> {
  const report: SyncReport = {
    pushed: { configs: 0, sessions: 0, entries: 0, extensions: 0, manifest: false },
    pulled: { objects: 0, sessions: 0, entries: 0, extensions: 0, installed: [] },
    conflicts: 0,
    errors: [],
    serverTime: 0,
  };

  if (!skipHeartbeat) {
    try {
      onStage?.("正在连接服务器…");
      await heartbeat(cfg, state, client, piVersion, extVersion);
    } catch (err) {
      report.errors.push((err as Error).message);
      return report;
    }
  }

  // 构建 diff 会暂存本地哈希/字段版本；服务端未确认时整体回滚，确保断网后仍会重试。
  const objectStateBefore = structuredClone(state.objects);
  const changes: PushChange[] = [];
  if (cfg.sync.scopes.config) {
    changes.push(...buildConfigChanges(cfg, state));
  }
  if (cfg.sync.scopes.plugins) {
    const manifest = buildPackageManifestChange(cfg, state);
    if (manifest) {
      changes.push(manifest);
      report.pushed.manifest = true;
    }
    const extFiles = buildExtensionFileChanges(state);
    changes.push(...extFiles);
    report.pushed.extensions = extFiles.length;
  }

  if (changes.length > 0) {
    onStage?.("正在上传配置与扩展…");
    try {
      const res = await client.pushObjects(changes);
      for (const merged of res.objects) {
        // 服务器合并结果回写本地状态
        if (merged.kind === "config") {
          applyMergedConfig(cfg, state, merged);
          report.pushed.configs++;
        } else if (merged.kind === "plugin-file") {
          ensureObjectState(state, merged.key);
          state.objects[merged.key] = {
            ...state.objects[merged.key],
            baseSha256: merged.sha256,
            localSha256: merged.sha256,
            serverVersion: merged.version,
            fields: {},
          };
        } else if (merged.kind === "package-manifest") {
          ensureObjectState(state, merged.key);
          state.objects[merged.key] = {
            ...state.objects[merged.key],
            baseSha256: merged.sha256,
            localSha256: merged.sha256,
            serverVersion: merged.version,
            fields: merged.fieldVersions.reduce(
              (acc, fv) => {
                acc[fv.path] = { version: fv.version, value: "" };
                return acc;
              },
              {} as Record<string, { version: number; value: string }>,
            ),
          };
        }
      }
      report.conflicts += res.conflicts.length;
      if (res.conflicts.length > 0) {
        report.errors.push(`${res.conflicts.length} conflict(s) recorded — run /qisumi-sync-conflicts to review`);
      }
    } catch (err) {
      state.objects = objectStateBefore;
      report.pushed.extensions = 0;
      report.pushed.manifest = false;
      report.errors.push(`push objects failed: ${(err as Error).message}`);
    }
  }

  if (cfg.sync.scopes.sessions) {
    onStage?.("正在上传会话…");
    try {
      const pending = await scanSessionIncrements(state, cfg);
      report.bytesRead = state.lastScan?.bytesRead ?? 0;
      for (const item of pending) {
        let version = item.change.baseVersion;
        const chunks = splitSessionChange(item.change);
        let complete = true;
        try {
          for (const chunk of chunks) {
            chunk.baseVersion = version;
            const res = await client.pushSessionsV2([chunk]);
            const merged = res.sessions[0];
            if (!merged) throw new Error(`服务器未确认会话 ${item.change.uuid}`);
            version = merged.version;
            report.pushed.entries += merged.acceptedEntries;
            report.conflicts += merged.conflicts + res.conflicts.length;
          }
        } catch (error) {
          complete = false;
          throw error;
        } finally {
          if (complete) {
            commitSessionCheckpoint(state, item.checkpoint, version);
            report.pushed.sessions++;
          }
        }
      }

      // AI 自动命名等插件内部用量单独同步，不写入会话正文。
      while (state.pendingUsageEvents.length > 0) {
        const batch = state.pendingUsageEvents.slice(0, 250);
        const res = await client.pushSessionsV2([], batch);
        if (res.acceptedUsageEvents < batch.length) throw new Error("服务器未完整确认用量事件");
        state.pendingUsageEvents.splice(0, batch.length);
      }
    } catch (err) {
      report.errors.push(`push sessions failed: ${(err as Error).message}`);
    }
  }

  saveState(state);
  return report;
}

/** 拉取远端变更 */
export async function pull(
  cfg: SyncConfig,
  state: SyncState,
  client: SyncClient,
  opts: {
    skipFile?: string;
    installPackages?: boolean;
    piExec?: (args: string[]) => Promise<void>;
    onStage?: (msg: string) => void;
    skipHeartbeat?: boolean;
  } = {},
): Promise<SyncReport> {
  const report: SyncReport = {
    pushed: { configs: 0, sessions: 0, entries: 0, extensions: 0, manifest: false },
    pulled: { objects: 0, sessions: 0, entries: 0, extensions: 0, installed: [] },
    conflicts: 0,
    errors: [],
    serverTime: 0,
  };

  if (!opts.skipHeartbeat) {
    try {
      opts.onStage?.("正在连接服务器…");
      await heartbeat(cfg, state, client, "", "");
    } catch (err) {
      report.errors.push((err as Error).message);
      return report;
    }
  }

  let pullSucceeded = false;
  try {
    opts.onStage?.("正在拉取配置与扩展…");
    const res = await client.pull(
      {
        since: state.lastPullAt ?? null,
        includeSessions: false,
      },
      { timeoutMs: 120_000 },
    );
    report.serverTime = res.serverTime;

    for (const obj of res.objects) {
      if (obj.kind === "config") {
        applyMergedConfig(cfg, state, obj);
        report.pulled.objects++;
      } else if (obj.kind === "plugin-file") {
        report.pulled.objects++;
      } else if (obj.kind === "package-manifest") {
        ensureObjectState(state, obj.key);
        state.objects[obj.key] = {
          baseSha256: obj.sha256,
          localSha256: obj.sha256,
          serverVersion: obj.version,
          fields: obj.fieldVersions.reduce(
            (acc, fv) => {
              acc[fv.path] = { version: fv.version, value: "" };
              return acc;
            },
            {} as Record<string, { version: number; value: string }>,
          ),
        };
      }
    }
    report.pulled.extensions = applyExtensionFiles(state, res.objects);

    // 会话按 v2 单调游标分页拉取；游标只在安全落盘或进入 inbox 后推进。
    if (cfg.sync.scopes.sessions) {
      opts.onStage?.("正在应用会话到本地…");
      let hasMore = true;
      while (hasMore) {
        const page = await client.pullSessionsV2({ cursor: state.sessionCursor, limit: 500, maxBytes: 2 * 1024 * 1024 });
        const applied = await applySessionDeltas(state, page.changes, { skipFile: opts.skipFile });
        report.pulled.sessions += applied.wrote;
        report.pulled.entries += applied.entries;
        report.inbox = applied.inbox;
        state.sessionCursor = page.nextCursor;
        report.cursor = page.nextCursor;
        hasMore = page.hasMore;
        saveState(state);
      }
    }

    // 包清单：自动安装缺失包
    const install = opts.installPackages ?? cfg.sync.autoInstallPackages;
    if (install && res.packageManifest) {
      const target = extractPackages(res.packageManifest);
      const local = readLocalPackages(cfg);
      const { toInstall } = diffPackages(local, target);
      if (toInstall.length > 0) {
        report.pulled.installed = toInstall.map((p) => p.source);
        if (opts.piExec) {
          for (const p of toInstall) {
            try {
              opts.onStage?.(`正在安装包 ${p.source}…`);
              await opts.piExec([p.source]);
            } catch (err) {
              report.errors.push(`install ${p.source} failed: ${(err as Error).message}`);
            }
          }
        }
      }
    }
    pullSucceeded = true;
  } catch (err) {
    report.errors.push(`pull failed: ${(err as Error).message}`);
  }

  if (pullSucceeded) state.lastPullAt = Date.now();
  saveState(state);
  return report;
}

/** 完整同步：先拉后推 */
export async function syncNow(
  cfg: SyncConfig,
  client: SyncClient,
  piVersion: string,
  extVersion: string,
  opts: { skipFile?: string; piExec?: (args: string[]) => Promise<void>; onStage?: (msg: string) => void } = {},
): Promise<{ pullReport: SyncReport; pushReport: SyncReport }> {
  const state = loadState();
  try {
    opts.onStage?.("正在连接服务器…");
    await heartbeat(cfg, state, client, piVersion, extVersion);
  } catch (error) {
    const failed = emptyReport();
    failed.errors.push((error as Error).message);
    return { pullReport: failed, pushReport: emptyReport() };
  }
  const pullReport = await pull(cfg, state, client, { ...opts, skipHeartbeat: true });
  const pushReport = await push(cfg, state, client, piVersion, extVersion, opts.onStage, true);
  return { pullReport, pushReport };
}

/** 解决冲突 */
export async function resolveConflict(
  cfg: SyncConfig,
  client: SyncClient,
  id: number,
  resolution: "keep-a" | "keep-b" | "manual",
  content?: string,
): Promise<void> {
  await client.resolveConflict(id, resolution, content);
  // 解决后重新拉取，应用胜者内容
  const state = loadState();
  await pull(cfg, state, client, {});
}
