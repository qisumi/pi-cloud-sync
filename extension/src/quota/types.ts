/** 额度探测公共类型 */

export type QuotaProviderId = "deepseek" | "zai" | "codex";

/** 单个额度计量器 */
export interface QuotaMeter {
  /** 唯一标识，如 deepseek.balance / zai.fiveHour / zai.weekly / codex.weekly */
  id: string;
  /** 展示名 */
  label: string;
  /** 已用百分比（0-100）；不适用（如余额）时为 null */
  usedPct: number | null;
  /** 剩余百分比（100 - usedPct） */
  leftPct: number | null;
  /** 当前值（数值） */
  current: number | null;
  /** 上限 */
  limit: number | null;
  /** 单位符号/说明（¥、$、tokens、%…） */
  unit: string;
  /** 下次重置时间（epoch ms），未知为 null */
  resetsAt: number | null;
  status: "ok" | "warn" | "critical" | "unknown";
}

/** 单个渠道的探测结果 */
export interface QuotaProbeResult {
  provider: QuotaProviderId;
  label: string;
  /** 本地是否找到凭据 */
  configured: boolean;
  ok: boolean;
  /** 失败原因（未配置 / HTTP / 网络错误…） */
  error?: string;
  meters: QuotaMeter[];
  /** 探测时间 */
  ts: number;
}

/** 一次探测的全部结果（本地快照用） */
export interface QuotaSnapshot {
  ts: number;
  /** 各渠道探测是否成功 */
  deepseek: { balance: number; currency: string } | null;
  zai: { fiveHourUsedPct: number | null; weeklyUsedPct: number | null; plan?: string } | null;
  codex: { fiveHourUsedPct: number | null; weeklyUsedPct: number | null; weeklyResetsAt: number | null } | null;
}

/** 探测报告（含上一次快照用于对比） */
export interface QuotaReport {
  ts: number;
  providers: QuotaProbeResult[];
  /** 上一次成功快照（用于展示消耗对比） */
  prev: QuotaSnapshot | null;
}
