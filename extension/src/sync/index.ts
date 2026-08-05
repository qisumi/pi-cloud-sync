import type { SyncClient } from "../client.js";
import type { SyncConfig, SyncState } from "../config.js";
import { loadState, saveState, ensureObjectState } from "../config.js";
import { buildConfigChanges, applyMergedConfig } from "./configs.js";
import { buildSessionChanges, applyPulledSessions, scanLocalSessions } from "./sessions.js";
import {
  buildPackageManifestChange,
  buildExtensionFileChanges,
  applyExtensionFiles,
  extractPackages,
  diffPackages,
  readLocalPackages,
} from "./plugins.js";
import type { PushChange } from "../types.js";

export interface SyncReport {
  pushed: { configs: number; sessions: number; entries: number; extensions: number; manifest: boolean };
  pulled: { objects: number; sessions: number; entries: number; extensions: number; installed: string[] };
  conflicts: number;
  errors: string[];
  serverTime: number;
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
): Promise<SyncReport> {
  const report: SyncReport = {
    pushed: { configs: 0, sessions: 0, entries: 0, extensions: 0, manifest: false },
    pulled: { objects: 0, sessions: 0, entries: 0, extensions: 0, installed: [] },
    conflicts: 0,
    errors: [],
    serverTime: 0,
  };

  try {
    onStage?.("正在连接服务器…");
    await heartbeat(cfg, state, client, piVersion, extVersion);
  } catch (err) {
    report.errors.push((err as Error).message);
    return report;
  }

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
            baseSha256: merged.sha256,
            localSha256: merged.sha256,
            serverVersion: merged.version,
            fields: {},
          };
        } else if (merged.kind === "package-manifest") {
          ensureObjectState(state, merged.key);
          state.objects[merged.key] = {
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
        report.errors.push(`${res.conflicts.length} conflict(s) recorded — run /sync conflicts to review`);
      }
    } catch (err) {
      report.errors.push(`push objects failed: ${(err as Error).message}`);
    }
  }

  if (cfg.sync.scopes.sessions) {
    onStage?.("正在上传会话…");
    try {
      const local = scanLocalSessions();
      const sessionChanges = buildSessionChanges(local, state, cfg);
      if (sessionChanges.length > 0) {
        const res = await client.pushSessions(sessionChanges);
        for (const merged of res) {
          const st = state.sessions[merged.uuid] ?? { serverVersion: 0, pushed: [] };
          st.serverVersion = merged.version;
          st.pushed = merged.entryIds;
          state.sessions[merged.uuid] = st;
          report.pushed.sessions++;
          report.pushed.entries += merged.acceptedEntries;
          report.conflicts += merged.conflicts;
        }
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
  opts: { skipFile?: string; installPackages?: boolean; piExec?: (args: string[]) => Promise<void>; onStage?: (msg: string) => void } = {},
): Promise<SyncReport> {
  const report: SyncReport = {
    pushed: { configs: 0, sessions: 0, entries: 0, extensions: 0, manifest: false },
    pulled: { objects: 0, sessions: 0, entries: 0, extensions: 0, installed: [] },
    conflicts: 0,
    errors: [],
    serverTime: 0,
  };

  try {
    opts.onStage?.("正在连接服务器…");
    await heartbeat(cfg, state, client, "", "");
  } catch (err) {
    report.errors.push((err as Error).message);
    return report;
  }

  try {
    opts.onStage?.("正在拉取配置与扩展…");
    const res = await client.pull(
      {
        since: state.lastPullAt ?? null,
        includeSessions: cfg.sync.scopes.sessions,
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

    // 会话拉取
    if (cfg.sync.scopes.sessions) {
      opts.onStage?.("正在应用会话到本地…");
      const written = applyPulledSessions(cfg, state, res.sessions, { skipFile: opts.skipFile });
      report.pulled.sessions += written.wrote;
      report.pulled.entries += res.sessions.reduce((n, s) => n + s.lines.length, 0);
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
  } catch (err) {
    report.errors.push(`pull failed: ${(err as Error).message}`);
  }

  state.lastPullAt = Date.now();
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
  const pullReport = await pull(cfg, state, client, opts);
  const pushReport = await push(cfg, state, client, piVersion, extVersion, opts.onStage);
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
