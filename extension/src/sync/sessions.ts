import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open, opendir, stat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { SessionChange, SessionDelta, SessionEntryChange, SessionSnapshot } from "../types.js";
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

export interface SessionCheckpoint {
  uuid: string;
  path: string;
  size: number;
  mtimeMs: number;
  offset: number;
  headerHash: string;
  boundaryHash: string;
  cwd: string;
  name: string | null;
  createdAt: number;
}

export interface PendingSessionChange {
  change: SessionChange;
  checkpoint: SessionCheckpoint;
  bytesRead: number;
  reconciled: boolean;
}

async function walkJsonl(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    const handle = await opendir(dir);
    for await (const entry of handle) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
    }
  };
  try {
    await walk(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return out;
}

async function readBytes(path: string, start: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function boundaryHash(path: string, offset: number): Promise<string> {
  const size = Math.min(256, offset);
  return size === 0 ? "" : sha256((await readBytes(path, offset - size, size)).toString("base64"));
}

function headerInfo(line: string, fallbackMtime: number) {
  const header = JSON.parse(line) as { type?: string; id?: string; cwd?: string; timestamp?: string | number };
  if (header.type !== "session" || !header.id) return null;
  const createdAt = typeof header.timestamp === "number"
    ? header.timestamp
    : typeof header.timestamp === "string"
      ? Date.parse(header.timestamp)
      : fallbackMtime;
  return { uuid: header.id, cwd: header.cwd ?? "", createdAt: Number.isFinite(createdAt) ? createdAt : fallbackMtime };
}

function entriesFromLines(lines: string[], cfg: SyncConfig): { entries: SessionEntryChange[]; name?: string } {
  const entries: SessionEntryChange[] = [];
  let name: string | undefined;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as { id?: string; parentId?: string | null; type?: string; name?: string };
      if (obj.type === "session_info" && typeof obj.name === "string") name = obj.name;
      if (!obj.id) continue;
      entries.push({
        id: obj.id,
        parentId: obj.parentId ?? null,
        lineJson: sanitizeEntryLine(line, {
          stripToolOutputs: cfg.sync.stripToolOutputs ?? true,
          stripThinking: cfg.sync.stripThinking ?? true,
        }),
      });
    } catch {
      // 残损但有换行的记录留给后续全量对账，不中断其他会话。
    }
  }
  return { entries, name };
}

/**
 * v2 增量扫描：未变化文件只 stat；追加文件仅读新增完整行；截断/覆盖/边界异常自动全量对账。
 */
export async function scanSessionIncrements(state: SyncState, cfg: SyncConfig): Promise<PendingSessionChange[]> {
  const started = performance.now();
  const root = sessionsDir();
  const files = await walkJsonl(root);
  const byPath = new Map(
    Object.entries(state.sessions)
      .filter(([, value]) => value.path)
      .map(([uuid, value]) => [value.path!.replace(/\\/g, "/"), { uuid, value }] as const),
  );
  const pending: PendingSessionChange[] = [];
  let bytesReadTotal = 0;

  await Promise.all(files.map(async (path) => {
    const info = await stat(path);
    const relativePath = relative(root, path).replace(/\\/g, "/");
    const known = byPath.get(relativePath);
    if (known && known.value.size === info.size && known.value.mtimeMs === info.mtimeMs && known.value.offset >= info.size) return;

    let start = known?.value.offset ?? 0;
    let reconciled = !known || info.size < start;
    if (!reconciled && start > 0 && known?.value.boundaryHash) {
      const currentBoundary = await boundaryHash(path, start);
      bytesReadTotal += Math.min(256, start);
      if (currentBoundary !== known.value.boundaryHash) reconciled = true;
    }
    if (reconciled) start = 0;

    const buffer = await readBytes(path, start, Math.max(0, info.size - start));
    bytesReadTotal += buffer.length;
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < 0) return; // 尾行尚未写完，偏移不前进。
    const complete = buffer.subarray(0, lastNewline + 1);
    const lines = complete.toString("utf8").split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) return;

    let uuid = known?.uuid;
    let cwd = known?.value.cwd ?? "";
    let createdAt = known?.value.createdAt ?? (info.birthtimeMs || info.mtimeMs);
    let headerJson: string | undefined;
    let dataLines = lines;
    if (start === 0) {
      const header = headerInfo(lines[0]!, info.mtimeMs);
      if (!header) return;
      ({ uuid, cwd, createdAt } = header);
      headerJson = lines[0]!;
      dataLines = lines.slice(1);
    } else if (!uuid || !cwd) {
      const headerBuffer = await readBytes(path, 0, Math.min(info.size, 16 * 1024));
      bytesReadTotal += headerBuffer.length;
      const headerLine = headerBuffer.toString("utf8").split("\n", 1)[0]!;
      const header = headerInfo(headerLine, info.mtimeMs);
      if (!header) return;
      ({ uuid, cwd, createdAt } = header);
      headerJson = headerLine;
    }
    if (!uuid) return;

    const parsed = entriesFromLines(dataLines, cfg);
    const name = parsed.name ?? known?.value.name ?? null;
    const offset = start + complete.length;
    const checkpoint: SessionCheckpoint = {
      uuid,
      path: relativePath,
      size: info.size,
      mtimeMs: info.mtimeMs,
      offset,
      headerHash: headerJson ? sha256(headerJson) : known?.value.headerHash ?? "",
      boundaryHash: await boundaryHash(path, offset),
      cwd,
      name,
      createdAt,
    };
    bytesReadTotal += Math.min(256, offset);
    pending.push({
      change: {
        uuid,
        cwd,
        name: name ?? undefined,
        headerJson,
        createdAt,
        baseVersion: state.sessions[uuid]?.serverVersion ?? 0,
        entries: parsed.entries,
        mtime: Math.trunc(info.mtimeMs),
      },
      checkpoint,
      bytesRead: buffer.length,
      reconciled,
    });
  }));

  state.lastScan = {
    files: files.length,
    bytesRead: bytesReadTotal,
    durationMs: performance.now() - started,
    at: Date.now(),
  };
  return pending.sort((a, b) => a.checkpoint.path.localeCompare(b.checkpoint.path));
}

/** 服务端完整确认后才推进本地字节游标。 */
export function commitSessionCheckpoint(state: SyncState, checkpoint: SessionCheckpoint, serverVersion: number): void {
  state.sessions[checkpoint.uuid] = { ...checkpoint, serverVersion };
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
 * - toolResult：移除输出正文和调用细节，只保留关联字段与用量元数据
 * - assistant：移除 thinking 与 toolCall 块，仅同步最终回答
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
        m.content = [];
        delete m.details;
      }
      if (m.role === "assistant" && Array.isArray(m.content)) {
        m.content = (m.content as Array<{ type?: string }>).filter((block) => {
          if (opts.stripThinking && block.type === "thinking") return false;
          if (opts.stripToolOutputs && (block.type === "toolCall" || block.type === "tool_call")) return false;
          return true;
        });
      }
    }
    if (obj.type === "compaction" && Array.isArray(obj.retainedTail)) {
      obj.retainedTail = (obj.retainedTail as Array<Record<string, unknown>>)
        .filter((msg) => !(opts.stripToolOutputs && msg.role === "toolResult"))
        .map((msg) => {
          if (msg.role === "assistant" && Array.isArray(msg.content)) {
            msg.content = (msg.content as Array<{ type?: string }>).filter((block) => {
              if (opts.stripThinking && block.type === "thinking") return false;
              if (opts.stripToolOutputs && (block.type === "toolCall" || block.type === "tool_call")) return false;
              return true;
            });
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
    const newEntries = s.entries
      .filter(() => st.offset === 0)
      .map((e) => ({
        ...e,
        lineJson: sanitizeEntryLine(e.lineJson, {
          stripToolOutputs: cfg.sync.stripToolOutputs ?? true,
          stripThinking: cfg.sync.stripThinking ?? true,
        }),
      }));
    if (newEntries.length === 0) continue;

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
      ensureSessionState(state, snap.uuid);
      state.sessions[snap.uuid].serverVersion = snap.version;
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
    try {
      const fileStat = statSync(outPath);
      st.path = relative(sessionsDir(), outPath).replace(/\\/g, "/");
      st.size = fileStat.size;
      st.mtimeMs = fileStat.mtimeMs;
      st.offset = fileStat.size;
      st.headerHash = sha256(header);
      st.boundaryHash = sha256(Buffer.from(content, "utf8").subarray(Math.max(0, Buffer.byteLength(content) - 256)).toString("base64"));
      st.cwd = snap.cwd;
      st.name = snap.name;
      st.createdAt = snap.createdAt ?? Date.now();
    } catch {
      // 状态元数据在下次扫描时重建。
    }
  }
  return { wrote, skipped };
}

function inboxDir(): string {
  return join(agentDir(), "pi-sync-inbox");
}

/** 将 v2 游标变更安全地合并到 JSONL；活动会话先进入 inbox，避免写坏正在追加的文件。 */
export async function applySessionDeltas(
  state: SyncState,
  deltas: SessionDelta[],
  opts: { skipFile?: string } = {},
): Promise<{ wrote: number; skipped: number; entries: number; inbox: number }> {
  const grouped = new Map<string, SessionDelta[]>();
  const put = (delta: SessionDelta) => {
    const uuid = delta.kind === "header" ? delta.session.uuid : delta.uuid;
    grouped.set(uuid, [...(grouped.get(uuid) ?? []), delta]);
  };
  for (const delta of deltas) put(delta);

  // 先吸收上轮因活动会话而暂存的变更。
  if (existsSync(inboxDir())) {
    for (const name of readdirSync(inboxDir()).filter((value) => value.endsWith(".json"))) {
      try {
        const saved = JSON.parse(readFileSync(join(inboxDir(), name), "utf8")) as SessionDelta[];
        for (const delta of saved) put(delta);
      } catch {
        // 损坏 inbox 留待人工检查，不影响其他会话。
      }
    }
  }

  const locals = new Map(scanLocalSessions().map((session) => [session.uuid, session] as const));
  let wrote = 0;
  let skipped = 0;
  let entries = 0;
  let inbox = 0;
  await mkdir(inboxDir(), { recursive: true });

  for (const [uuid, rawChanges] of grouped) {
    const changes = [...new Map(rawChanges.sort((a, b) => a.seq - b.seq).map((delta) => [delta.seq, delta])).values()];
    const local = locals.get(uuid);
    const inboxPath = join(inboxDir(), `${uuid}.json`);
    if (local && opts.skipFile && resolve(local.path) === resolve(opts.skipFile)) {
      await writeFile(`${inboxPath}.tmp`, JSON.stringify(changes), "utf8");
      await rename(`${inboxPath}.tmp`, inboxPath);
      skipped++;
      inbox += changes.length;
      continue;
    }

    const last = changes[changes.length - 1]!;
    const session = last.session;
    if (changes.some((delta) => delta.kind === "header" && delta.op === "tombstone")) {
      if (local) await rm(local.path, { force: true });
      ensureSessionState(state, uuid);
      state.sessions[uuid].serverVersion = session.version;
      await rm(inboxPath, { force: true });
      wrote++;
      continue;
    }

    const merged = new Map<string, string>();
    if (local) for (const entry of local.entries) merged.set(entry.id, entry.lineJson);
    for (const delta of changes) {
      if (delta.kind !== "entry") continue;
      // 同步副本可能已剥离工具输出/思考；绝不覆盖本机同 ID 的完整原始行。
      if (!merged.has(delta.entry.id)) merged.set(delta.entry.id, delta.entry.lineJson);
      entries++;
    }
    const dir = join(sessionsDir(), encodeCwdPath(session.cwd));
    await mkdir(dir, { recursive: true });
    const outPath = local?.path ?? join(dir, `${session.createdAt ?? Date.now()}_${uuid}.jsonl`);
    const header = session.headerJson ?? JSON.stringify({
      type: "session",
      version: 3,
      id: uuid,
      timestamp: new Date(session.createdAt ?? Date.now()).toISOString(),
      cwd: session.cwd,
    });
    const content = `${[header, ...merged.values()].join("\n")}\n`;
    const temporary = `${outPath}.pi-sync.tmp`;
    await writeFile(temporary, content, "utf8");
    await rename(temporary, outPath);
    const fileStat = await stat(outPath);
    const checkpoint: SessionCheckpoint = {
      uuid,
      path: relative(sessionsDir(), outPath).replace(/\\/g, "/"),
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      offset: fileStat.size,
      headerHash: sha256(header),
      boundaryHash: await boundaryHash(outPath, fileStat.size),
      cwd: session.cwd,
      name: session.name,
      createdAt: session.createdAt ?? Date.now(),
    };
    commitSessionCheckpoint(state, checkpoint, session.version);
    await rm(inboxPath, { force: true });
    wrote++;
  }
  return { wrote, skipped, entries, inbox };
}

export function pendingInboxCount(): number {
  if (!existsSync(inboxDir())) return 0;
  return readdirSync(inboxDir()).filter((name) => name.endsWith(".json")).length;
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
