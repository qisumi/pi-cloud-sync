import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { MergedObject, PushChange, FieldVersion } from "../types.js";
import type { SyncConfig, SyncState } from "../config.js";
import { agentDir, ensureObjectState } from "../config.js";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function objectKeyForConfig(file: string): string {
  return `config/${file}`;
}

function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

function collectLeafPaths(obj: unknown, prefix = ""): string[] {
  if (obj === null || obj === undefined) return [];
  if (typeof obj !== "object") return [prefix];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out.push(...collectLeafPaths(v, p));
    } else {
      out.push(p);
    }
  }
  return out;
}

function isJsonObject(content: string): boolean {
  try {
    const v = JSON.parse(content);
    return v !== null && typeof v === "object" && !Array.isArray(v);
  } catch {
    return false;
  }
}

export function localConfigPath(cfg: SyncConfig, file: string): string {
  return join(agentDir(), file);
}

export interface LocalConfigChange {
  key: string;
  file: string;
  localSha: string;
}

/**
 * 计算所有本地配置变更（相对上次推送的本地状态）。
 * 返回 PushChange 列表（含字段级 diff）。
 */
export function buildConfigChanges(cfg: SyncConfig, state: SyncState): PushChange[] {
  const changes: PushChange[] = [];
  for (const file of cfg.sync.includeConfigs) {
    const path = resolve(localConfigPath(cfg, file));
    if (!existsSync(path)) continue;
    const key = objectKeyForConfig(file);
    ensureObjectState(state, key);
    const st = state.objects[key];

    const content = readFileSync(path, "utf8");
    const sha = sha256(content);

    // 本地未变 → 跳过
    if (st.localSha256 === sha) continue;
    st.localSha256 = sha; // 更新本地基线（无论推送成败都记录，避免反复推送同一内容）

    const mtime = Math.trunc(existsSync(path) ? readFileStat(path) : Date.now());

    if (isJsonObject(content)) {
      changes.push({
        kind: "config",
        key,
        baseSha256: st.baseSha256,
        sha256: sha,
        contentB64: Buffer.from(content, "utf8").toString("base64"),
        mtime,
        jsonFields: diffJsonFields(st, content),
      });
    } else {
      changes.push({
        kind: "config",
        key,
        baseSha256: st.baseSha256,
        sha256: sha,
        contentB64: Buffer.from(content, "utf8").toString("base64"),
        mtime,
      });
    }
  }
  return changes;
}

/** 对比上次推送的 JSON 与当前内容，生成字段级变更（版本递增） */
function diffJsonFields(st: { fields: Record<string, { version: number; value: string }> }, content: string) {
  const prev = loadPrevJson(st);
  const cur = JSON.parse(content) as Record<string, unknown>;
  const prevPaths = new Set(collectLeafPaths(prev));
  const curPaths = new Set(collectLeafPaths(cur));
  const all = new Set([...prevPaths, ...curPaths]);

  const fields: Array<{ path: string; valueJson: string; version: number }> = [];
  for (const path of all) {
    const prevVal = getByPath(prev, path);
    const curVal = getByPath(cur, path);
    const prevJson = prevVal === undefined ? undefined : JSON.stringify(prevVal);
    const curJson = curVal === undefined ? undefined : JSON.stringify(curVal);
    if (prevJson === curJson) continue;
    const known = st.fields[path];
    const version = (known?.version ?? 0) + 1;
    fields.push({ path, valueJson: JSON.stringify(curVal), version });
    st.fields[path] = { version, value: JSON.stringify(curVal) };
  }
  return fields;
}

/** 从字段版本表中重建上次推送的 JSON（便于 diff） */
function loadPrevJson(st: { fields: Record<string, { version: number; value: string }> }): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [path, f] of Object.entries(st.fields)) {
    try {
      setByPath(obj, path, JSON.parse(f.value));
    } catch {
      // ignore
    }
  }
  return obj;
}

function readFileStat(path: string): number {
  return statSync(path).mtimeMs;
}

/** 将服务器合并结果应用到本地文件，并更新状态 */
export function applyMergedConfig(
  cfg: SyncConfig,
  state: SyncState,
  merged: MergedObject,
): { wrote: boolean; content: string } {
  const file = merged.key.startsWith("config/") ? merged.key.slice("config/".length) : merged.key;
  const path = resolve(localConfigPath(cfg, file));
  const content = Buffer.from(merged.contentB64, "base64").toString("utf8");

  let wrote = false;
  if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
    writeFileSync(path, content, "utf8");
    wrote = true;
  }

  ensureObjectState(state, merged.key);
  const st = state.objects[merged.key];
  st.baseSha256 = merged.sha256;
  st.localSha256 = merged.sha256;
  st.serverVersion = merged.version;
  st.fields = {};
  // 从合并后的内容中提取字段值（供下次 diff 使用）
  let mergedJson: Record<string, unknown> | null = null;
  try {
    mergedJson = JSON.parse(content) as Record<string, unknown>;
  } catch {
    mergedJson = null;
  }
  for (const fv of merged.fieldVersions) {
    const value = mergedJson ? getByPath(mergedJson, fv.path) : undefined;
    st.fields[fv.path] = {
      version: fv.version,
      value: value === undefined ? "" : JSON.stringify(value),
    };
  }
  return { wrote, content };
}

export function fieldVersionMap(merged: MergedObject): Record<string, FieldVersion> {
  const map: Record<string, FieldVersion> = {};
  for (const fv of merged.fieldVersions) map[fv.path] = fv;
  return map;
}
