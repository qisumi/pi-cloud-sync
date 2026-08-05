import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { agentDir } from "../config.js";

export const STATS_FILE = "pi-stats.jsonl";

export interface UsageRecord {
  /** 去重键 */
  key: string;
  ts: number;
  sessionId: string;
  sessionName: string | null;
  /** 工作目录（项目） */
  project: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  /** 总费用（本地货币） */
  cost: number;
  requests: number;
  device: string;
  /** 来源：live=事件实时采集, scan=会话文件扫描 */
  source: "live" | "scan";
}

export interface UsageInput {
  ts?: number;
  sessionId: string;
  sessionName?: string | null;
  project?: string;
  provider: string;
  model: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: { total?: number };
  };
  role: "assistant" | "toolResult";
  entryId?: string;
  device?: string;
}

export function statsFilePath(): string {
  return join(agentDir(), STATS_FILE);
}

function usageKey(input: UsageInput): string {
  if (input.entryId) return `${input.sessionId}|${input.role}|${input.entryId}`;
  // 无 entryId（实时事件）：用时间戳+用量指纹
  return `${input.sessionId}|${input.ts ?? Date.now()}|${input.role}|${input.provider}|${input.model}|${input.usage?.input ?? 0}|${input.usage?.output ?? 0}`;
}

/** 实时采集器：追加写入 + 内存去重 */
export class UsageCollector {
  private seen = new Set<string>();
  private records: UsageRecord[] = [];
  private writeQueue: Promise<void> = Promise.resolve();
  private filePath = statsFilePath();

  constructor() {
    try {
      if (existsSync(this.filePath)) {
        for (const line of readFileSync(this.filePath, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const rec = JSON.parse(line) as UsageRecord;
            this.seen.add(rec.key);
            this.records.push(rec);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }

  /** 记录一条用量（自动去重） */
  record(input: UsageInput): UsageRecord | null {
    const key = usageKey(input);
    if (this.seen.has(key)) return null;
    this.seen.add(key);

    const usage = input.usage ?? {};
    const rec: UsageRecord = {
      key,
      ts: input.ts ?? Date.now(),
      sessionId: input.sessionId,
      sessionName: input.sessionName ?? null,
      project: input.project ?? "",
      provider: input.provider,
      model: input.model,
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      cost: usage.cost?.total ?? 0,
      requests: 1,
      device: input.device ?? "",
      source: "live",
    };
    this.records.push(rec);
    try {
      mkdirSync(agentDir(), { recursive: true });
      const line = JSON.stringify(rec) + "\n";
      this.writeQueue = this.writeQueue.then(() => appendFile(this.filePath, line, "utf8")).catch(() => undefined);
    } catch {
      // 写失败不阻塞主流程
    }
    return rec;
  }

  /** 读取全部实时记录 */
  loadAll(): UsageRecord[] {
    return this.records.slice();
  }

  hasAnyForSession(sessionId: string): boolean {
    return this.loadAll().some((r) => r.sessionId === sessionId);
  }
}
