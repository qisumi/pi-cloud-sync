import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MergedObject, PushChange } from "../types.js";
import type { SyncConfig, SyncState } from "../config.js";
import { agentDir, ensureObjectState } from "../config.js";
import { sha256 } from "./configs.js";

export const PACKAGE_MANIFEST_KEY = "plugin/package-manifest";
const EXTENSIONS_DIR = join(agentDir(), "extensions");

export interface PackageEntry {
  source: string;
  name?: string;
  version?: string;
}

/** 从 settings.json 提取 packages 清单 */
export function readLocalPackages(cfg: SyncConfig): PackageEntry[] {
  try {
    const settingsPath = join(agentDir(), "settings.json");
    if (!existsSync(settingsPath)) return [];
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { packages?: unknown };
    if (!Array.isArray(settings.packages)) return [];
    return settings.packages.map((p) => {
      if (typeof p === "string") {
        const name = p.split("@").filter(Boolean)[0] ?? p;
        return { source: p, name };
      }
      if (p && typeof p === "object") {
        const s = (p as { source?: unknown }).source;
        if (typeof s === "string") {
          const o = p as Record<string, unknown>;
          return {
            source: s,
            name: typeof o.name === "string" ? o.name : undefined,
            version: typeof o.version === "string" ? o.version : undefined,
          };
        }
      }
      return { source: String(p) };
    });
  } catch {
    return [];
  }
}

/** 本地自定义扩展文件（agentDir/extensions/*.ts 及其子目录 index.ts） */
export function listCustomExtensionFiles(): Array<{ path: string; rel: string; size: number; mtimeMs: number }> {
  const out: Array<{ path: string; rel: string; size: number; mtimeMs: number }> = [];
  if (!existsSync(EXTENSIONS_DIR)) return out;

  const walk = (dir: string, relDir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p, join(relDir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const info = statSync(p);
        out.push({ path: p, rel: join(relDir, entry.name), size: info.size, mtimeMs: info.mtimeMs });
      }
    }
  };
  walk(EXTENSIONS_DIR, "");
  return out;
}

/** 构建包清单推送（包清单作为独立对象，packages 数组字段做并集合并） */
export function buildPackageManifestChange(cfg: SyncConfig, state: SyncState): PushChange | null {
  const packages = readLocalPackages(cfg);
  const payload = JSON.stringify({ packages, device: cfg.deviceName }, null, 2);
  const sha = sha256(payload);

  ensureObjectState(state, PACKAGE_MANIFEST_KEY);
  const st = state.objects[PACKAGE_MANIFEST_KEY];
  if (st.localSha256 === sha) return null;
  st.localSha256 = sha;

  const version = (st.fields["packages"]?.version ?? 0) + 1;
  st.fields["packages"] = { version, value: JSON.stringify(packages) };

  return {
    kind: "package-manifest",
    key: PACKAGE_MANIFEST_KEY,
    baseSha256: st.baseSha256,
    sha256: sha,
    contentB64: Buffer.from(payload, "utf8").toString("base64"),
    mtime: Math.trunc(Date.now()),
    jsonFields: [{ path: "packages", valueJson: JSON.stringify(packages), version }],
  };
}

/** 构建自定义扩展文件变更（整体 LWW） */
export function buildExtensionFileChanges(state: SyncState): PushChange[] {
  const changes: PushChange[] = [];
  for (const f of listCustomExtensionFiles()) {
    const key = `plugin/extension/${f.rel.replace(/\\/g, "/")}`;
    ensureObjectState(state, key);
    const st = state.objects[key];
    if (st.localSha256 && st.localSize === f.size && st.localMtimeMs === f.mtimeMs) continue;
    const content = readFileSync(f.path, "utf8");
    const sha = sha256(content);
    st.localSize = f.size;
    st.localMtimeMs = f.mtimeMs;
    if (st.localSha256 === sha) continue;
    st.localSha256 = sha;
    changes.push({
      kind: "plugin-file",
      key,
      baseSha256: st.baseSha256,
      sha256: sha,
      contentB64: Buffer.from(content, "utf8").toString("base64"),
      mtime: Math.trunc(f.mtimeMs),
    });
  }
  return changes;
}

/** 应用拉取到的自定义扩展文件 */
export function applyExtensionFiles(state: SyncState, objects: MergedObject[]): number {
  let wrote = 0;
  for (const obj of objects) {
    if (obj.kind !== "plugin-file" || !obj.key.startsWith("plugin/extension/")) continue;
    const rel = obj.key.slice("plugin/extension/".length);
    if (rel.includes("..")) continue; // 路径穿越防护
    const target = join(EXTENSIONS_DIR, rel);
    const content = Buffer.from(obj.contentB64, "base64").toString("utf8");
    if (!existsSync(target) || readFileSync(target, "utf8") !== content) {
      mkdirSync(join(EXTENSIONS_DIR, dirOf(rel)), { recursive: true });
      writeFileSync(target, content, "utf8");
      wrote++;
    }
    ensureObjectState(state, obj.key);
    state.objects[obj.key] = {
      baseSha256: obj.sha256,
      localSha256: obj.sha256,
      serverVersion: obj.version,
      fields: {},
    };
    const info = statSync(target);
    state.objects[obj.key].localSize = info.size;
    state.objects[obj.key].localMtimeMs = info.mtimeMs;
  }
  return wrote;
}

function dirOf(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx > 0 ? rel.slice(0, idx) : "";
}

/** 从包清单对象提取 packages 数组 */
export function extractPackages(merged: MergedObject): PackageEntry[] {
  try {
    const obj = JSON.parse(Buffer.from(merged.contentB64, "base64").toString("utf8")) as {
      packages?: PackageEntry[];
    };
    return obj.packages ?? [];
  } catch {
    return [];
  }
}

/** 对比本地与目标包清单，返回缺失/版本不同的包 */
export function diffPackages(local: PackageEntry[], target: PackageEntry[]): {
  toInstall: PackageEntry[];
  toRemove: PackageEntry[];
} {
  const localMap = new Map(local.map((p) => [p.source, p]));
  const targetMap = new Map(target.map((p) => [p.source, p]));
  const toInstall = target.filter((p) => !localMap.has(p.source));
  const toRemove = local.filter((p) => !targetMap.has(p.source));
  return { toInstall, toRemove };
}

/** 更新本地 settings.json 的 packages 字段（安装/移除后同步） */
export function applyPackagesToSettings(packages: PackageEntry[]): void {
  const settingsPath = join(agentDir(), "settings.json");
  if (!existsSync(settingsPath)) return;
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  settings.packages = packages.map((p) => p.source);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}
