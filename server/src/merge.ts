import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { SyncDb } from "./db.js";
import type {
  FieldVersion,
  JsonFieldChange,
  MergedObject,
  PushChange,
} from "@pi-cloud-sync/shared";
import { now } from "./db.js";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 从 JSON 对象中按点路径读取值；不存在返回 undefined */
export function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** 按点路径设置值（自动创建中间对象），返回是否发生变更 */
export function setByPath(obj: Record<string, unknown>, path: string, value: unknown): boolean {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    const next = cur[p];
    if (next === null || next === undefined || typeof next !== "object") {
      cur[p] = {};
    }
    cur = cur[p] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  const prev = cur[last];
  cur[last] = value;
  return JSON.stringify(prev) !== JSON.stringify(value);
}

/** 收集对象中所有叶子字段的点路径（用于全量替换时初始化字段版本） */
export function collectLeafPaths(obj: unknown, prefix = ""): string[] {
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

/** 计算字段版本哈希映射，用于快速比较 */
export function fieldVersionFingerprint(fvs: FieldVersion[]): string {
  return fvs
    .map((f) => `${f.path}=${f.version}`)
    .sort()
    .join("|");
}

export interface ObjectMergeResult {
  merged: MergedObject;
  conflicts: Array<{
    objectKey: string;
    path: string;
    kind: string;
    deviceA: string;
    deviceB: string;
    contentA: string;
    contentB: string;
  }>;
}

/**
 * 处理单个配置/文件对象变更（JSON 字段级合并 or 非 JSON LWW）。
 */
export function mergeObject(
  dbs: SyncDb,
  change: PushChange,
  device: { deviceId: string; name: string },
): ObjectMergeResult {
  const db = dbs.db;
  const row = db
    .prepare("SELECT * FROM objects WHERE key = ?")
    .get(change.key) as
    | {
        key: string;
        kind: string;
        version: number;
        sha256: string;
        data: string;
        updated_by: string;
        updated_at: number;
        deleted: number;
      }
    | undefined;

  const conflicts: ObjectMergeResult["conflicts"] = [];
  const nowMs = now();
  const deviceName = device.name;

  // 服务器上无此对象 → 直接创建
  if (!row) {
    return createObject(dbs, change, deviceName, nowMs);
  }

  // 快速前进：客户端基础哈希 == 服务器当前哈希
  const fastForward = change.baseSha256 !== null && change.baseSha256 === row.sha256;

  if (fastForward) {
    return applyFastForward(dbs, change, row, deviceName, nowMs);
  }

  // 并发修改：仅 JSON 且客户端提供字段变更时做字段级合并
  if (change.jsonFields && change.jsonFields.length > 0 && isJsonObject(row.data)) {
    return mergeJsonFields(dbs, change, row, deviceName, nowMs);
  }

  // 兜底：非 JSON / 无法合并 → 整体 LWW（版本比较），失败方存档为冲突
  return mergeWholeFileLww(dbs, change, row, deviceName, nowMs, conflicts);
}

/** 服务器上无此对象：全量创建 */
function createObject(
  dbs: SyncDb,
  change: PushChange,
  deviceName: string,
  nowMs: number,
): ObjectMergeResult {
  const db = dbs.db;
  const content = decodeContent(change);
  const sha = change.sha256 ?? sha256Hex(content);
  const conflicts: ObjectMergeResult["conflicts"] = [];

  db.prepare(
    `INSERT INTO objects (key, kind, version, sha256, data, updated_by, updated_at, deleted)
     VALUES (?, ?, 1, ?, ?, ?, ?, 0)`,
  ).run(change.key, change.kind, sha, content, deviceName, nowMs);

  const fieldVersions: FieldVersion[] = [];
  // 记录字段版本：若客户端提供了字段变更则用之，否则从内容中推导（version=1）
  if (change.jsonFields && change.jsonFields.length > 0) {
    for (const f of change.jsonFields) {
      db.prepare(
        `INSERT INTO config_field_versions (object_key, path, version, value, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(change.key, f.path, f.version, f.valueJson, deviceName, nowMs);
      fieldVersions.push({
        path: f.path,
        version: f.version,
        updatedBy: deviceName,
        updatedAt: nowMs,
      });
    }
  } else {
    try {
      const parsed = JSON.parse(content);
      for (const path of collectLeafPaths(parsed)) {
        const value = getByPath(parsed, path);
        db.prepare(
          `INSERT INTO config_field_versions (object_key, path, version, value, updated_by, updated_at)
           VALUES (?, ?, 1, ?, ?, ?)`,
        ).run(change.key, path, JSON.stringify(value), deviceName, nowMs);
        fieldVersions.push({ path, version: 1, updatedBy: deviceName, updatedAt: nowMs });
      }
    } catch {
      // 非 JSON，无字段版本
    }
  }

  const merged: MergedObject = {
    key: change.key,
    kind: change.kind,
    version: 1,
    sha256: sha,
    contentB64: Buffer.from(content, "utf8").toString("base64"),
    fieldVersions,
    updatedBy: deviceName,
    updatedAt: nowMs,
    deleted: false,
  };
  return { merged, conflicts };
}

function applyFastForward(
  dbs: SyncDb,
  change: PushChange,
  row: { key: string; version: number },
  deviceName: string,
  nowMs: number,
): ObjectMergeResult {
  const db = dbs.db;
  const content = decodeContent(change);
  const sha = change.sha256 ?? sha256Hex(content);
  const conflicts: ObjectMergeResult["conflicts"] = [];
  const nextVersion = row.version + 1;

  db.prepare(
    `UPDATE objects SET version = ?, sha256 = ?, data = ?, updated_by = ?, updated_at = ? WHERE key = ?`,
  ).run(nextVersion, sha, content, deviceName, nowMs, change.key);

  const fieldVersions: FieldVersion[] = [];
  if (change.jsonFields && change.jsonFields.length > 0) {
    const upsert = db.prepare(
      `INSERT INTO config_field_versions (object_key, path, version, value, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(object_key, path) DO UPDATE SET
         version = excluded.version,
         value = excluded.value,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    );
    for (const f of change.jsonFields) {
      upsert.run(change.key, f.path, f.version, f.valueJson, deviceName, nowMs);
      fieldVersions.push({ path: f.path, version: f.version, updatedBy: deviceName, updatedAt: nowMs });
    }
    // 补全未变更字段的版本（保证响应中字段版本完整）
    const known = new Set(fieldVersions.map((f) => f.path));
    for (const p of currentFieldPaths(db, change.key)) {
      if (!known.has(p)) {
        const fv = db
          .prepare(
            `SELECT version, updated_by, updated_at FROM config_field_versions WHERE object_key = ? AND path = ?`,
          )
          .get(change.key, p) as { version: number; updated_by: string; updated_at: number };
        fieldVersions.push({
          path: p,
          version: fv.version,
          updatedBy: fv.updated_by,
          updatedAt: fv.updated_at,
        });
      }
    }
  }

  const merged: MergedObject = {
    key: change.key,
    kind: change.kind,
    version: nextVersion,
    sha256: sha,
    contentB64: Buffer.from(content, "utf8").toString("base64"),
    fieldVersions,
    updatedBy: deviceName,
    updatedAt: nowMs,
    deleted: false,
  };
  return { merged, conflicts };
}

/** JSON 字段级合并：逐字段比较版本号，高版本胜出；双方同级且不同 → 冲突 */
function mergeJsonFields(
  dbs: SyncDb,
  change: PushChange,
  row: { key: string; version: number; sha256: string; data: string },
  deviceName: string,
  nowMs: number,
): ObjectMergeResult {
  const db = dbs.db;
  const conflicts: ObjectMergeResult["conflicts"] = [];
  const serverObj = JSON.parse(row.data) as Record<string, unknown>;
  const clientObj = JSON.parse(decodeContent(change)) as Record<string, unknown>;
  const clientFields = new Map(change.jsonFields!.map((f) => [f.path, f]));

  const getFieldRow = db.prepare(
    `SELECT version, updated_by FROM config_field_versions WHERE object_key = ? AND path = ?`,
  );
  const upsertField = db.prepare(
    `INSERT INTO config_field_versions (object_key, path, version, value, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(object_key, path) DO UPDATE SET
       version = excluded.version, value = excluded.value,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  );

  // 收集服务器端已有的字段（含服务器侧新字段）
  const serverFields = currentFieldRows(db, change.key);

  const accepted: FieldVersion[] = [];
  const allPaths = new Set<string>([...serverFields.map((f) => f.path), ...clientFields.keys()]);

  const readFieldValue = (path: string): string =>
    ((db
      .prepare(`SELECT value FROM config_field_versions WHERE object_key = ? AND path = ?`)
      .get(change.key, path) as { value: string } | undefined)?.value ?? "");

  // 若服务器有客户端不知道的字段（客户端 baseSha 过期但版本没冲突），客户端字段并入
  for (const path of allPaths) {
    const cf = clientFields.get(path);
    const sf = serverFields.find((f) => f.path === path);
    const serverValueJson = sf ? readFieldValue(path) : undefined;

    if (!cf) {
      // 服务器独有字段：保留服务器版本
      accepted.push({
        path,
        version: sf!.version,
        updatedBy: sf!.updated_by,
        updatedAt: sf!.updated_at,
      });
      continue;
    }

    if (!sf) {
      // 客户端新字段：直接采纳
      applyClientField(change.key, cf, upsertField, deviceName, nowMs);
      setByPath(serverObj, path, JSON.parse(cf.valueJson));
      accepted.push({ path, version: cf.version, updatedBy: deviceName, updatedAt: nowMs });
      continue;
    }

    const sfVersion = sf.version;
    const clientWins = cf.version > sfVersion;
    const serverWins = cf.version < sfVersion;

    // 数组字段：版本相同时做并集合并（如 packages 清单），避免同字段冲突
    const clientVal = JSON.parse(cf.valueJson);
    const serverValRaw = JSON.parse(serverValueJson ?? "null");
    const bothArrays =
      Array.isArray(clientVal) &&
      Array.isArray(serverValRaw) &&
      cf.version === sfVersion;

    if (bothArrays) {
      const union = unionArrays(clientVal as unknown[], serverValRaw as unknown[]);
      const unionJson = JSON.stringify(union);
      if (unionJson !== serverValueJson) {
        upsertField.run(change.key, path, sfVersion + 1, unionJson, deviceName, nowMs);
        setByPath(serverObj, path, union);
        accepted.push({ path, version: sfVersion + 1, updatedBy: deviceName, updatedAt: nowMs });
      } else {
        accepted.push({ path, version: sfVersion, updatedBy: sf.updated_by, updatedAt: sf.updated_at });
      }
      continue;
    }

    if (clientWins) {
      applyClientField(change.key, cf, upsertField, deviceName, nowMs);
      setByPath(serverObj, path, JSON.parse(cf.valueJson));
      accepted.push({ path, version: cf.version, updatedBy: deviceName, updatedAt: nowMs });
    } else if (serverWins) {
      // 服务器版本更新 → 服务器胜出；客户端变更记录为冲突（单侧）
      accepted.push({ path, version: sfVersion, updatedBy: sf.updated_by, updatedAt: sf.updated_at });
      const serverVal = serverValueJson ?? "";
      if (cf.valueJson !== serverVal) {
        conflicts.push({
          objectKey: change.key,
          path,
          kind: change.kind,
          deviceA: deviceName,
          deviceB: sf.updated_by,
          contentA: cf.valueJson,
          contentB: serverVal,
        });
      }
    } else {
      // 版本相同：值不同才视为冲突（客户端内容作为 B 侧，胜者待用户裁决）
      const serverVal = serverValueJson ?? "";
      if (cf.valueJson !== serverVal) {
        conflicts.push({
          objectKey: change.key,
          path,
          kind: change.kind,
          deviceA: deviceName,
          deviceB: sf.updated_by,
          contentA: cf.valueJson,
          contentB: serverVal,
        });
        accepted.push({ path, version: sfVersion, updatedBy: sf.updated_by, updatedAt: sf.updated_at });
      } else {
        accepted.push({ path, version: sfVersion, updatedBy: sf.updated_by, updatedAt: sf.updated_at });
      }
    }
  }

  // 保留客户端新增但服务器端字段表中不存在的、以及客户端删除的字段（以客户端对象为基准）
  // 客户端整体 JSON 中缺失的服务器字段（说明客户端删除了该字段）→ 应用删除
  const serverPaths = new Set(serverFields.map((f) => f.path));
  for (const path of serverPaths) {
    if (!allPaths.has(path)) {
      // 客户端不携带该字段（可能被删除或客户端版本较旧未同步到）
      // 安全起见：保留服务器字段，不删除
      const sf = serverFields.find((f) => f.path === path)!;
      accepted.push({ path, version: sf.version, updatedBy: sf.updated_by, updatedAt: sf.updated_at });
    }
  }

  // 客户端整体内容中服务器没有的字段（新增字段，但客户端未在 jsonFields 中列出——一般不会发生，兜底）
  const clientPaths = new Set(collectLeafPaths(clientObj));
  for (const path of clientPaths) {
    if (!allPaths.has(path)) {
      const value = getByPath(clientObj, path);
      const cf = { path, valueJson: JSON.stringify(value), version: 1 };
      applyClientField(change.key, cf, upsertField, deviceName, nowMs);
      setByPath(serverObj, path, value);
      accepted.push({ path, version: 1, updatedBy: deviceName, updatedAt: nowMs });
    }
  }

  // 冲突已存在时，本合并保持服务器对象不变（等用户解决）；未冲突字段合并进服务器对象
  const mergedContent = JSON.stringify(serverObj, null, 2);
  const sha = sha256Hex(mergedContent);
  const nextVersion = row.version + 1;

  db.prepare(
    `UPDATE objects SET version = ?, sha256 = ?, data = ?, updated_by = ?, updated_at = ? WHERE key = ?`,
  ).run(nextVersion, sha, mergedContent, deviceName, nowMs, change.key);

  for (const c of conflicts) {
    db.prepare(
      `INSERT INTO conflicts (object_key, path, kind, device_a, device_b, content_a, content_b, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(c.objectKey, c.path, c.kind, c.deviceA, c.deviceB, c.contentA, c.contentB, nowMs);
  }

  const merged: MergedObject = {
    key: change.key,
    kind: change.kind,
    version: nextVersion,
    sha256: sha,
    contentB64: Buffer.from(mergedContent, "utf8").toString("base64"),
    fieldVersions: accepted,
    updatedBy: deviceName,
    updatedAt: nowMs,
    deleted: false,
  };
  return { merged, conflicts };
}

interface FieldUpsert {
  run(objectKey: string, path: string, version: number, value: string, device: string, at: number): unknown;
}

function unionArrays(a: unknown[], b: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of [...a, ...b]) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function applyClientField(
  objectKey: string,
  f: JsonFieldChange,
  upsert: FieldUpsert,
  deviceName: string,
  nowMs: number,
) {
  upsert.run(objectKey, f.path, f.version, f.valueJson, deviceName, nowMs);
}

/** 非 JSON 整体 LWW：版本高者胜；同版本按 mtime；失败方存档冲突 */
function mergeWholeFileLww(
  dbs: SyncDb,
  change: PushChange,
  row: { key: string; version: number; sha256: string; data: string; updated_by: string; updated_at: number },
  deviceName: string,
  nowMs: number,
  conflicts: ObjectMergeResult["conflicts"],
): ObjectMergeResult {
  const db = dbs.db;
  const content = decodeContent(change);
  const sha = change.sha256 ?? sha256Hex(content);
  const conflictsLocal = conflicts;

  // 简单规则：客户端推的内容较新（mtime 更大或服务器无版本信息）则覆盖，否则保留服务器版
  const serverMtime = row.updated_at;
  const clientMtime = change.mtime ?? nowMs;
  const clientWins = clientMtime >= serverMtime;

  if (clientWins && row.sha256 !== sha) {
    const nextVersion = row.version + 1;
    db.prepare(
      `UPDATE objects SET version = ?, sha256 = ?, data = ?, updated_by = ?, updated_at = ? WHERE key = ?`,
    ).run(nextVersion, sha, content, deviceName, nowMs, change.key);
    const merged: MergedObject = {
      key: change.key,
      kind: change.kind,
      version: nextVersion,
      sha256: sha,
      contentB64: Buffer.from(content, "utf8").toString("base64"),
      fieldVersions: [],
      updatedBy: deviceName,
      updatedAt: nowMs,
      deleted: false,
    };
    return { merged, conflicts: conflictsLocal };
  }

  // 客户端失败：存档冲突（服务器内容作为胜者）
  if (row.sha256 !== sha) {
    conflictsLocal.push({
      objectKey: change.key,
      path: "file",
      kind: change.kind,
      deviceA: deviceName,
      deviceB: row.updated_by,
      contentA: content,
      contentB: row.data,
    });
  }

  const merged: MergedObject = {
    key: change.key,
    kind: change.kind,
    version: row.version,
    sha256: row.sha256,
    contentB64: Buffer.from(row.data, "utf8").toString("base64"),
    fieldVersions: [],
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    deleted: false,
  };
  return { merged, conflicts: conflictsLocal };
}

function decodeContent(change: PushChange): string {
  if (change.contentB64) return Buffer.from(change.contentB64, "base64").toString("utf8");
  if (change.jsonFields) {
    // 由字段重建 JSON（近似；客户端一般会同时给 contentB64）
    const obj: Record<string, unknown> = {};
    for (const f of change.jsonFields) setByPath(obj, f.path, JSON.parse(f.valueJson));
    return JSON.stringify(obj);
  }
  return "";
}

function isJsonObject(data: string): boolean {
  try {
    const v = JSON.parse(data);
    return v !== null && typeof v === "object" && !Array.isArray(v);
  } catch {
    return false;
  }
}

function currentFieldPaths(db: Database.Database, objectKey: string): string[] {
  const rows = db
    .prepare(`SELECT path FROM config_field_versions WHERE object_key = ? ORDER BY path`)
    .all(objectKey) as Array<{ path: string }>;
  return rows.map((r) => r.path);
}

function currentFieldRows(
  db: Database.Database,
  objectKey: string,
): Array<{ path: string; version: number; updated_by: string; updated_at: number }> {
  return db
    .prepare(
      `SELECT path, version, updated_by, updated_at FROM config_field_versions WHERE object_key = ? ORDER BY path`,
    )
    .all(objectKey) as Array<{ path: string; version: number; updated_by: string; updated_at: number }>;
}
