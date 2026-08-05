/**
 * 额度探测：DeepSeek（余额） / Z.AI 智谱 GLM Coding Plan（5h/周 tokens） / Codex（ChatGPT 订阅动态窗口）。
 *
 * 端点参考开源实现：
 * - DeepSeek 官方 `GET /user/balance`
 * - Z.AI monitor API（api.z.ai / open.bigmodel.cn）`/api/monitor/usage/quota/limit`
 *   （melon-hub/zai-usage-tracker、guyinwonder168/opencode-glm-quota、robinebers/openusage）
 * - Codex `https://chatgpt.com/backend-api/wham/usage`（读取 ~/.codex/auth.json OAuth 凭据）
 *
 * Codex 允许失败（无 VPN 时网络不可达），只标记不可用，不影响其他渠道。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { agentDir } from "../config.js";
import type { QuotaMeter, QuotaProbeResult, QuotaProviderId } from "./types.js";

const TIMEOUT_MS = 12_000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function defaultFetch(): FetchLike {
  return (url, init) => fetch(url, init);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`请求超时 (${Math.round(ms / 1000)}s)`)), ms),
    ),
  ]);
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clampPct(v: number | null): number | null {
  if (v == null) return null;
  return Math.max(0, Math.min(100, v));
}

function meterStatus(usedPct: number | null): QuotaMeter["status"] {
  if (usedPct == null) return "unknown";
  if (usedPct >= 90) return "critical";
  if (usedPct >= 70) return "warn";
  return "ok";
}

function baseResult(provider: QuotaProviderId, label: string, ts: number): QuotaProbeResult {
  return { provider, label, configured: false, ok: false, meters: [], ts };
}

function failResult(r: QuotaProbeResult, configured: boolean, error: string): QuotaProbeResult {
  return { ...r, configured, error };
}

/* ---------------- 凭据发现 ---------------- */

/** 读取 pi 的 auth.json（~/.pi/agent/auth.json），包含各 provider 的 api key */
export function readPiAuth(): Record<string, unknown> {
  try {
    const p = join(agentDir(), "auth.json");
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function extractKey(entry: unknown): string | null {
  if (typeof entry === "string" && entry.trim()) return entry.trim();
  if (entry && typeof entry === "object") {
    const o = entry as Record<string, unknown>;
    for (const k of ["key", "apiKey", "api_key", "token", "accessToken"]) {
      if (typeof o[k] === "string" && o[k].trim()) return o[k].trim();
    }
  }
  return null;
}

/** 在 auth.json 中按候选 provider id（含大小写不敏感匹配）查找 key */
export function findKey(auth: Record<string, unknown>, ids: string[]): string | null {
  for (const id of ids) {
    const direct = auth[id];
    const k = extractKey(direct);
    if (k) return k;
    const lower = id.toLowerCase();
    for (const [k2, v] of Object.entries(auth)) {
      if (k2.toLowerCase() === lower) {
        const kk = extractKey(v);
        if (kk) return kk;
      }
    }
  }
  return null;
}

const DEEPSEEK_IDS = ["deepseek"];
// pi 的 provider id：zai（全球 Coding Plan）/ zai-coding-cn（中国 Coding Plan），
// 以及常见别名（含大小写不敏感匹配）
const ZAI_IDS = [
  "zai",
  "zai-coding-cn",
  "zai-coding-plan",
  "zai-cn",
  "z-ai",
  "z.ai",
  "glm",
  "zhipu",
  "zhipuai",
  "bigmodel",
];

export function deepseekKey(): string | null {
  return process.env.DEEPSEEK_API_KEY || findKey(readPiAuth(), DEEPSEEK_IDS) || null;
}

export function zaiKey(): string | null {
  // 默认从 auth.json 读取（pi /login 写入的 provider id：zai / zai-coding-cn），
  // 环境变量作为覆盖
  return (
    findKey(readPiAuth(), ZAI_IDS) ||
    process.env.ZAI_CODING_CN_API_KEY ||
    process.env.ZAI_API_KEY ||
    process.env.ZHIPU_API_KEY ||
    process.env.GLM_API_KEY ||
    null
  );
}

export interface CodexAuth {
  accessToken: string;
  accountId: string | null;
}

export function codexAuthPath(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
}

export function readCodexAuth(path: string = codexAuthPath()): CodexAuth | null {
  try {
    if (!existsSync(path)) return null;
    const j = JSON.parse(readFileSync(path, "utf8")) as {
      tokens?: { access_token?: string; account_id?: string };
    };
    const at = j.tokens?.access_token;
    if (!at) return null;
    return { accessToken: at, accountId: j.tokens?.account_id ?? null };
  } catch {
    return null;
  }
}

/* ---------------- DeepSeek：账户余额（金额） ---------------- */

export async function probeDeepSeek(fetchImpl: FetchLike = defaultFetch()): Promise<QuotaProbeResult> {
  const ts = Date.now();
  const r = baseResult("deepseek", "DeepSeek", ts);
  const key = deepseekKey();
  if (!key) {
    return failResult(r, false, "未配置：auth.json 无 deepseek key 或未设 DEEPSEEK_API_KEY");
  }
  r.configured = true;
  try {
    const res = await withTimeout(
      fetchImpl("https://api.deepseek.com/user/balance", {
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      }),
      TIMEOUT_MS,
    );
    if (res.status === 401) return failResult(r, true, "API Key 无效 (401)");
    if (!res.ok) return failResult(r, true, `HTTP ${res.status}`);
    const j = (await res.json()) as {
      is_available?: boolean;
      balance_infos?: Array<{ currency?: string; total_balance?: string; granted_balance?: string; topped_up_balance?: string }>;
    };
    const info = j.balance_infos?.[0];
    const total = num(info?.total_balance) ?? 0;
    const currency = (info?.currency ?? "USD").toUpperCase();
    const symbol = currency === "CNY" ? "¥" : "$";
    const status: QuotaMeter["status"] = total <= 0 ? "critical" : total < 10 ? "warn" : "ok";
    r.ok = true;
    r.meters = [
      {
        id: "deepseek.balance",
        label: "账户余额",
        usedPct: null,
        leftPct: null,
        current: total,
        limit: null,
        unit: symbol,
        resetsAt: null,
        status,
      },
    ];
    return r;
  } catch (err) {
    return failResult(r, true, err instanceof Error ? err.message : String(err));
  }
}

/* ---------------- Z.AI / 智谱 GLM Coding Plan：5h + 周 tokens 额度 ---------------- */

interface ZaiLimit {
  type?: string;
  percentage?: number | string;
  currentValue?: number | string;
  usage?: number | string;
  resetAt?: number | string;
  resetsAt?: number | string;
  limitWindowSeconds?: number | string;
  windowSeconds?: number | string;
}

export async function probeZai(fetchImpl: FetchLike = defaultFetch()): Promise<QuotaProbeResult> {
  const ts = Date.now();
  const r = baseResult("zai", "Z.AI GLM 编程套餐", ts);
  const key = zaiKey();
  if (!key) {
    return failResult(r, false, "未配置：auth.json 无 zai/zai-coding-cn key（请先 /login）或未设 ZAI_CODING_CN_API_KEY");
  }
  r.configured = true;
  const baseUrl = (process.env.ZAI_BASE_URL ?? "https://open.bigmodel.cn").replace(/\/+$/, "");
  const url = `${baseUrl}/api/monitor/usage/quota/limit`;

  try {
    // 先直接 token（社区实现），401 再尝试 Bearer
    const auths = [key, `Bearer ${key}`];
    let lastErr: Error | null = null;
    for (const auth of auths) {
      try {
        const res = await withTimeout(
          fetchImpl(url, {
            headers: {
              authorization: auth,
              accept: "application/json",
              "accept-language": "en-US,en",
              "content-type": "application/json",
            },
          }),
          TIMEOUT_MS,
        );
        if (res.status === 401) {
          lastErr = new Error("401");
          continue;
        }
        if (!res.ok) return failResult(r, true, `HTTP ${res.status}`);
        const j = (await res.json()) as Record<string, unknown>;
        const data = (j.data ?? j) as { limits?: ZaiLimit[] };
        const limits = Array.isArray(data.limits) ? data.limits : [];
        const tokenLimits = limits.filter((l) => l.type === "TOKENS_LIMIT");
        if (tokenLimits.length === 0) {
          return failResult(r, true, "未返回额度数据（可能没有有效 Coding Plan）");
        }

        const meters: QuotaMeter[] = [];
        tokenLimits.forEach((l, i) => {
          // 按窗口时长分类：≤24h → 5小时滚动，>24h → 周额度；缺省时按顺序
          const winSecs = num(l.limitWindowSeconds ?? l.windowSeconds);
          const kind: "5h" | "weekly" =
            winSecs == null ? (i === 0 ? "5h" : "weekly") : winSecs <= 24 * 3600 ? "5h" : "weekly";
          const usedPct = clampPct(num(l.percentage));
          const resetsAt = num(l.resetAt ?? l.resetsAt);
          meters.push({
            id: kind === "5h" ? "zai.fiveHour" : "zai.weekly",
            label: kind === "5h" ? "5 小时额度" : "周额度",
            usedPct,
            leftPct: usedPct != null ? 100 - usedPct : null,
            current: num(l.currentValue),
            limit: num(l.usage),
            unit: "tokens",
            resetsAt,
            status: meterStatus(usedPct),
          });
        });
        r.ok = true;
        r.meters = meters;
        return r;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (e.message.includes("401")) {
          lastErr = e;
          continue;
        }
        throw e;
      }
    }
    return failResult(r, true, lastErr ? "API Key 无效 (401)" : "请求失败");
  } catch (err) {
    return failResult(r, true, err instanceof Error ? err.message : String(err));
  }
}

/* ---------------- Codex（OpenAI 订阅）：按窗口时长识别短周期/周/月额度（允许失败） ---------------- */

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function firstObject(...values: unknown[]): JsonObject | null {
  for (const value of values) {
    const object = asObject(value);
    if (object) return object;
  }
  return null;
}

function firstArray(...values: unknown[]): unknown[] {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function codexWindowSeconds(window: JsonObject): number | null {
  const seconds = num(
    window.limit_window_seconds ??
      window.limitWindowSeconds ??
      window.window_seconds ??
      window.windowSeconds,
  );
  if (seconds != null) return seconds;
  const minutes = num(
    window.window_minutes ??
      window.windowMinutes ??
      window.window_duration_mins ??
      window.windowDurationMins,
  );
  return minutes == null ? null : minutes * 60;
}

function codexResetAt(window: JsonObject, nowMs: number): number | null {
  let resetsAt = num(
    window.resets_at ?? window.resetsAt ?? window.reset_at ?? window.resetAt,
  );
  if (resetsAt != null) {
    // WHAM 使用 epoch 秒，app-server 快照也可能已经是毫秒。
    return resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  }
  const afterSeconds = num(window.reset_after_seconds ?? window.resetAfterSeconds);
  return afterSeconds == null ? null : nowMs + afterSeconds * 1000;
}

type CodexWindowKind = "fiveHour" | "weekly" | "monthly";

function classifyCodexWindow(
  windowSeconds: number | null,
  fallback: CodexWindowKind,
): CodexWindowKind {
  if (windowSeconds == null) return fallback;
  if (windowSeconds <= 36 * 3600) return "fiveHour";
  if (windowSeconds <= 14 * 86400) return "weekly";
  return "monthly";
}

function codexWindowLabel(kind: CodexWindowKind, windowSeconds: number | null): string {
  if (kind === "weekly") return "周额度";
  if (kind === "monthly") return "月额度";
  if (windowSeconds != null) {
    const hours = Math.round((windowSeconds / 3600) * 10) / 10;
    return `${Number.isInteger(hours) ? hours.toFixed(0) : hours.toFixed(1)} 小时额度`;
  }
  return "5 小时额度";
}

function safeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "") || "limit";
}

export async function probeCodex(fetchImpl: FetchLike = defaultFetch()): Promise<QuotaProbeResult> {
  const ts = Date.now();
  const r = baseResult("codex", "Codex (OpenAI 订阅)", ts);
  const auth = readCodexAuth();
  if (!auth) {
    return failResult(r, false, "未配置：~/.codex/auth.json 无 tokens.access_token（请先 codex login）");
  }
  r.configured = true;
  try {
    const res = await withTimeout(
      fetchImpl("https://chatgpt.com/backend-api/wham/usage", {
        headers: {
          authorization: `Bearer ${auth.accessToken}`,
          "openai-beta": "codex-1",
          originator: "Codex Desktop",
          accept: "application/json",
          ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}),
        },
      }),
      TIMEOUT_MS,
    );
    if (res.status === 401) return failResult(r, true, "登录已失效 (401)，请重新 codex login");
    if (!res.ok) return failResult(r, true, `HTTP ${res.status}`);
    const j = (await res.json()) as JsonObject;
    const wrappers = [j, asObject(j.data), asObject(j.result), asObject(j.usage)].filter(
      (value): value is JsonObject => value !== null,
    );
    const root = wrappers.find((value) =>
      ["rate_limit", "rateLimit", "rate_limits", "rateLimits", "rateLimitsByLimitId"].some(
        (key) => value[key] != null,
      ),
    ) ?? j;
    const plan = [root.plan_type, root.planType, j.plan_type, j.planType].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    if (plan) r.label = `Codex (${plan.trim().slice(0, 32)})`;

    const defaultRateLimit = firstObject(
      root.rate_limit,
      root.rateLimit,
      root.rate_limits,
      root.rateLimits,
    );
    const meters: QuotaMeter[] = [];
    const meterIds = new Set<string>();

    const pushWindow = (
      idBase: string,
      labelPrefix: string,
      window: JsonObject | null,
      fallbackKind: CodexWindowKind,
    ) => {
      if (!window) return;
      const usedPct = clampPct(
        num(
          window.used_percent ??
            window.usedPercent ??
            window.usage_percent ??
            window.usagePercent ??
            window.percentage,
        ),
      );
      if (usedPct == null) return;
      const windowSeconds = codexWindowSeconds(window);
      const kind = classifyCodexWindow(windowSeconds, fallbackKind);
      let id = `${idBase}.${kind}`;
      let suffix = 2;
      while (meterIds.has(id)) id = `${idBase}.${kind}.${suffix++}`;
      meterIds.add(id);
      const windowLabel = codexWindowLabel(kind, windowSeconds);
      meters.push({
        id,
        label: labelPrefix ? `${labelPrefix} · ${windowLabel}` : windowLabel,
        usedPct,
        leftPct: 100 - usedPct,
        current: null,
        limit: null,
        unit: "%",
        resetsAt: codexResetAt(window, ts),
        status: meterStatus(usedPct),
      });
    };

    const pushRateLimit = (idBase: string, labelPrefix: string, rateLimit: JsonObject | null) => {
      if (!rateLimit) return;
      pushWindow(
        idBase,
        labelPrefix,
        firstObject(rateLimit.primary_window, rateLimit.primaryWindow, rateLimit.primary),
        "fiveHour",
      );
      pushWindow(
        idBase,
        labelPrefix,
        firstObject(rateLimit.secondary_window, rateLimit.secondaryWindow, rateLimit.secondary),
        "weekly",
      );
      pushWindow(
        idBase,
        labelPrefix,
        firstObject(rateLimit.tertiary_window, rateLimit.tertiaryWindow, rateLimit.tertiary),
        "monthly",
      );
    };

    // 不能按 primary/secondary 的位置写死：部分 Pro/Team 响应只在 primary
    // 返回一个周/月窗口，secondary 为 null。应依据窗口时长逐项归类。
    pushRateLimit("codex", "", defaultRateLimit);

    const additional = firstArray(
      root.additional_rate_limits,
      root.additionalRateLimits,
      j.additional_rate_limits,
      j.additionalRateLimits,
    );
    for (const raw of additional) {
      const item = asObject(raw);
      if (!item) continue;
      const nameValue = item.limit_name ?? item.limitName ?? item.metered_feature ?? item.meteredFeature;
      const name = typeof nameValue === "string" && nameValue.trim() ? nameValue.trim().slice(0, 48) : "附加额度";
      pushRateLimit(
        `codex.additional.${safeSlug(name)}`,
        name,
        firstObject(item.rate_limit, item.rateLimit, item.rate_limits, item.rateLimits),
      );
    }

    // app-server 的多桶返回：rateLimitsByLimitId.{id}.primary/secondary。
    const byLimitId = firstObject(root.rateLimitsByLimitId, root.rate_limits_by_limit_id);
    if (byLimitId) {
      for (const [limitId, raw] of Object.entries(byLimitId)) {
        if (limitId === "codex" && meters.some((meter) => meter.id.startsWith("codex."))) continue;
        const snapshot = asObject(raw);
        if (!snapshot) continue;
        const nameValue = snapshot.limitName ?? snapshot.limit_name;
        const name = typeof nameValue === "string" && nameValue.trim() ? nameValue.trim().slice(0, 48) : limitId;
        pushRateLimit(`codex.additional.${safeSlug(limitId)}`, name, snapshot);
      }
    }

    const resetCredits = firstObject(
      root.rate_limit_reset_credits,
      root.rateLimitResetCredits,
      j.rate_limit_reset_credits,
      j.rateLimitResetCredits,
    );
    const availableResets = resetCredits
      ? num(resetCredits.available_count ?? resetCredits.availableCount)
      : null;
    if (availableResets != null && availableResets > 0) {
      meters.push({
        id: "codex.resetCredits",
        label: "可用额度重置",
        usedPct: null,
        leftPct: null,
        current: availableResets,
        limit: null,
        unit: "次",
        resetsAt: null,
        status: "ok",
      });
    }

    if (meters.length === 0) return failResult(r, true, "当前订阅未返回可用额度窗口");
    r.ok = true;
    r.meters = meters;
    return r;
  } catch (err) {
    // 网络不可达（无 VPN）等：标记不可用但不抛错
    return failResult(r, true, err instanceof Error ? err.message : String(err));
  }
}
