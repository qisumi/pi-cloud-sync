/**
 * USD→CNY 汇率获取（Exchangerate-API，免费接口）。
 *
 * 用于 stats 货币显示（cny）时把 pi 计算的 USD 成本换算为人民币。
 * 运行时优先拉取实时汇率（6 小时缓存），失败回退到配置 stats.usdCnyRate。
 */
const EXCHANGE_API = "https://open.er-api.com/v6/latest/USD";
const CACHE_TTL_MS = 6 * 3600_000;
const FETCH_TIMEOUT_MS = 8_000;

let cache: { cny: number; at: number } | null = null;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** 实时拉取 USD→CNY（带 6h 缓存）；失败返回 null（调用方回退配置值） */
export async function fetchUsdCnyRate(
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): Promise<number | null> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.cny;
  try {
    const res = await Promise.race([
      fetchImpl(EXCHANGE_API, { headers: { accept: "application/json" } }),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("exchange rate timeout")), FETCH_TIMEOUT_MS),
      ),
    ]);
    if (!res.ok) return null;
    const j = (await res.json()) as { rates?: Record<string, unknown>; result?: string };
    if (j.result === "error" || !j.rates) return null;
    const cny = Number(j.rates.CNY);
    if (!Number.isFinite(cny) || cny <= 0) return null;
    cache = { cny, at: Date.now() };
    return cny;
  } catch {
    return null;
  }
}

/** 清空缓存（测试用） */
export function clearRateCache(): void {
  cache = null;
}
