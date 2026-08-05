import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { SessionChange, SessionEntryChange, SessionSnapshot } from "../types.js";
import type { SyncConfig, SyncState } from "../config.js";
import { agentDir, ensureSessionState } from "../config.js";
import { sha256 } from "./configs.js";

export function sessionsDir(): string {
  return join(agentDir(), "sessions");
}

/** 与 pi 一致的 cwd 编码：C:/Users/x → --C--Users-x-- */
export function encodeCwdPath(cwd: string): string {
  const norm = cwd.replace(/[\\/:]/g, "-");
  return `--${norm}--`;
}

export interface LocalSession {
  uuid: string;
  cwd: string;
  name: string | null;
  headerJson: string | null;
  createdAt: number;
  path: string;
  entries: SessionEntryChange[];
}

function readJsonL(file: string): string[] {
  const content = readFileSync(file, "utf8");
  return content.split("\n").filter((l) => l.trim().length > 0);
}

/** 扫描本地全部会话文件 */
export function scanLocalSessions(): LocalSession[] {
  const root = sessionsDir();
  if (!existsSync(root)) return [];
  const out: LocalSession[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const parsed = parseSessionFile(p);
        if (parsed) out.push(parsed);
      }
    }
  };
  walk(root);
  return out;
}

function parseSessionFile(path: string): LocalSession | null {
  try {
    const lines = readJsonL(path);
    if (lines.length === 0) return null;
    const header = JSON.parse(lines[0]) as {
      type?: string;
      id?: string;
      cwd?: string;
      timestamp?: string | number;
      name?: string;
    };
    if (header.type !== "session" || !header.id) return null;

    const entries: SessionEntryChange[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      try {
        const obj = JSON.parse(line) as { id?: string; parentId?: string | null };
        if (!obj.id) continue;
        entries.push({
          id: obj.id,
          parentId: obj.parentId ?? null,
          lineJson: line,
        });
      } catch {
        // 跳过损坏行
      }
    }

    const name =
      (lines
        .map((l) => {
          try {
            const o = JSON.parse(l);
            return o.type === "session_info" && o.name ? o.name : undefined;
          } catch {
            return undefined;
          }
        })
        .find(Boolean) as string | undefined) ?? null;

    return {
      uuid: header.id,
      cwd: header.cwd ?? "",
      name,
      headerJson: lines[0],
      createdAt:
        typeof header.timestamp === "number"
          ? header.timestamp
          : typeof header.timestamp === "string"
            ? Date.parse(header.timestamp)
            : statSync(path).mtimeMs,
      path,
      entries,
    };
  } catch {
    return null;
  }
}

/**
 * 上传前剥离敏感/大体积内容（本地文件保持完整，仅同步副本精简）：
 * - toolResult：工具输出替换为占位（减轻服务器存储与传输负担）
 * - assistant：移除 thinking 思考块
 * - compaction retainedTail：同样清理
 */
export function sanitizeEntryLine(
  line: string,
  opts: { stripToolOutputs: boolean; stripThinking: boolean },
): string {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.type === "message" && obj.message && typeof obj.message === "object") {
      const m = obj.message as Record<string, unknown>;
      if (m.role === "toolResult" && opts.stripToolOutputs) {
        m.content = [{ type: "text", text: "[tool output omitted — 工具输出未同步]" }];
        if (m.details && typeof m.details === "object") {
          const d = m.details as Record<string, unknown>;
          if (typeof d.output === "string") d.output = "[omitted]";
          if (typeof d.error === "string") d.error = "[omitted]";
          if (typeof d.input === "string" && d.input.length > 200) d.input = d.input.slice(0, 200) + "…";
        }
      }
      if (m.role === "assistant" && opts.stripThinking && Array.isArray(m.content)) {
        m.content = (m.content as Array<{ type?: string }>).filter((b) => b.type !== "thinking");
      }
    }
    if (obj.type === "compaction" && Array.isArray(obj.retainedTail)) {
      obj.retainedTail = (obj.retainedTail as Array<Record<string, unknown>>).map((msg) => {
        if (msg.role === "toolResult" && opts.stripToolOutputs) {
          msg.content = [{ type: "text", text: "[tool output omitted — 工具输出未同步]" }];
        }
        if (msg.role === "assistant" && opts.stripThinking && Array.isArray(msg.content)) {
          msg.content = (msg.content as Array<{ type?: string }>).filter((b) => b.type !== "thinking");
        }
        return msg;
      });
    }
    return JSON.stringify(obj);
  } catch {
    return line; // 解析失败原样推送
  }
}

/** 构建需要推送的会话增量（上传前剥离工具输出与思考过程） */
export function buildSessionChanges(
  sessions: LocalSession[],
  state: SyncState,
  cfg: SyncConfig,
): SessionChange[] {
  const changes: SessionChange[] = [];
  for (const s of sessions) {
    ensureSessionState(state, s.uuid);
    const st = state.sessions[s.uuid];
    const pushed = new Set(st.pushed);
    const newEntries = s.entries
      .filter((e) => !pushed.has(e.id))
      .map((e) => ({
        ...e,
        lineJson: sanitizeEntryLine(e.lineJson, {
          stripToolOutputs: cfg.sync.stripToolOutputs ?? true,
          stripThinking: cfg.sync.stripThinking ?? true,
        }),
      }));
    if (newEntries.length === 0 && st.serverVersion === 0) continue;

    changes.push({
      uuid: s.uuid,
      cwd: s.cwd,
      name: s.name ?? undefined,
      headerJson: s.headerJson ?? undefined,
      createdAt: s.createdAt,
      baseVersion: st.serverVersion,
      entries: newEntries,
      mtime: Math.trunc(Date.now()),
    });
  }
  return changes;
}

/** 应用拉取的会话快照到本地 */
export function applyPulledSessions(
  cfg: SyncConfig,
  state: SyncState,
  snapshots: SessionSnapshot[],
  opts: { skipFile?: string } = {},
): { wrote: number; skipped: number } {
  let wrote = 0;
  let skipped = 0;

  for (const snap of snapshots) {
    if (snap.deleted) {
      // 软删除：本地若存在则删除文件（保留 tombstone 信息在云端）
      const local = findLocalByUuid(snap.uuid);
      if (local) {
        try {
          rmSync(local.path, { force: true });
          wrote++;
        } catch {
          skipped++;
        }
      }
      continue;
    }

    const local = findLocalByUuid(snap.uuid);
    if (local && resolve(local.path) === resolve(opts.skipFile ?? "")) {
      skipped++;
      continue; // 当前活动会话不写盘
    }

    // 合并条目（按 entryId 去重；内容不同以本地为准——本地总是最新，冲突在服务器已裁决）
    const merged = new Map<string, string>();
    if (local) {
      for (const e of local.entries) merged.set(e.id, e.lineJson);
    }
    for (const line of snap.lines) {
      try {
        const obj = JSON.parse(line) as { id: string };
        if (obj.id && !merged.has(obj.id)) merged.set(obj.id, line);
      } catch {
        // ignore
      }
    }

    const dir = join(sessionsDir(), encodeCwdPath(snap.cwd));
    mkdirSync(dir, { recursive: true });

    let fileName: string;
    if (local) {
      fileName = basename(local.path);
    } else {
      const ts = snap.createdAt ?? Date.now();
      fileName = `${ts}_${snap.uuid}.jsonl`;
    }
    const outPath = join(dir, fileName);

    const header = snap.headerJson ?? JSON.stringify({
      type: "session",
      version: 3,
      id: snap.uuid,
      timestamp: new Date(snap.createdAt ?? Date.now()).toISOString(),
      cwd: snap.cwd,
    });
    const lines = [header, ...merged.values()];
    const content = lines.join("\n") + "\n";
    writeFileSync(outPath, content, "utf8");
    wrote++;

    ensureSessionState(state, snap.uuid);
    const st = state.sessions[snap.uuid];
    st.serverVersion = snap.version;
    st.pushed = [...merged.keys()];
  }
  return { wrote, skipped };
}

export function findLocalByUuid(uuid: string): LocalSession | null {
  return scanLocalSessions().find((s) => s.uuid === uuid) ?? null;
}

/** 搜索本地会话（uuid / name / cwd 模糊匹配） */
export function searchLocalSessions(query: string): LocalSession[] {
  const q = query.toLowerCase();
  return scanLocalSessions().filter((s) => {
    if (!q) return true;
    return (
      s.uuid.toLowerCase().includes(q) ||
      (s.name ?? "").toLowerCase().includes(q) ||
      s.cwd.toLowerCase().includes(q)
    );
  });
}

/** 供 /qisumi-sync-find 使用：本地 + 已拉取快照去重后的会话列表 */
export function localSessionsIndex(): Array<{
  uuid: string;
  name: string | null;
  cwd: string;
  path: string | null;
  entryCount: number;
}> {
  return scanLocalSessions().map((s) => ({
    uuid: s.uuid,
    name: s.name,
    cwd: s.cwd,
    path: s.path,
    entryCount: s.entries.length,
  }));
}

/** 比较本地会话与拉取快照的哈希，判断是否需要写盘 */
export function sessionContentHash(lines: string[]): string {
  return sha256(lines.join("\n"));
}

export function pathOfSessionDir(): string {
  return sessionsDir();
}
