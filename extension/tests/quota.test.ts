import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeDeepSeek, probeZai, probeCodex, readCodexAuth } from "../src/quota/providers.js";
import { probeAllQuotas, formatQuotaText, quotaSummary } from "../src/quota/index.js";
import { recordSnapshot, latestSnapshot, computeDeltas, quotaHistoryPath, toSnapshot } from "../src/quota/history.js";
import type { QuotaSnapshot } from "../src/quota/types.js";

function tempAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-sync-quota-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

function write(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

/** 构造 mock fetch：按 URL 前缀路由到响应；不匹配则抛网络错误 */
function mockFetch(routes: Array<{ match: RegExp | string; respond: () => Response | Promise<Response> }>) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const r = routes.find((x) => (typeof x.match === "string" ? url.includes(x.match) : x.match.test(url)));
    if (!r) throw new Error(`network error: ${url}`);
    return r.respond();
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/* ---------------- DeepSeek ---------------- */

test("quota: deepseek balance ok", async () => {
  const dir = tempAgentDir();
  write(join(dir, "auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: "sk-ds-123" } }));

  const res = await probeDeepSeek(
    mockFetch([
      {
        match: "user/balance",
        respond: () =>
          jsonResponse({
            is_available: true,
            balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }],
          }),
      },
    ]),
  );
  assert.equal(res.ok, true);
  assert.equal(res.configured, true);
  assert.equal(res.meters.length, 1);
  assert.equal(res.meters[0].id, "deepseek.balance");
  assert.equal(res.meters[0].current, 110);
  assert.equal(res.meters[0].unit, "¥");
  assert.equal(res.meters[0].status, "ok");
});

test("quota: deepseek key invalid -> ok=false, no throw", async () => {
  const dir = tempAgentDir();
  write(join(dir, "auth.json"), JSON.stringify({ deepseek: { key: "sk-invalid" } }));
  const res = await probeDeepSeek(
    mockFetch([{ match: "user/balance", respond: () => jsonResponse({ error: "invalid" }, 401) }]),
  );
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /401/);
});

test("quota: deepseek not configured -> ok=false with hint", async () => {
  tempAgentDir();
  delete process.env.DEEPSEEK_API_KEY;
  const res = await probeDeepSeek(mockFetch([]));
  assert.equal(res.ok, false);
  assert.equal(res.configured, false);
  assert.match(res.error ?? "", /未配置/);
});

test("quota: deepseek network error -> ok=false, no throw", async () => {
  tempAgentDir();
  write(join(process.env.PI_CODING_AGENT_DIR!, "auth.json"), JSON.stringify({ deepseek: { key: "sk-x" } }));
  const res = await probeDeepSeek(mockFetch([])); // 无路由 → network error
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /network error/);
});

/* ---------------- Z.AI ---------------- */

const ZAI_RESPONSE = {
  data: {
    limits: [
      { type: "TOKENS_LIMIT", percentage: 40, currentValue: 3200000, usage: 8000000, limitWindowSeconds: 18000 },
      { type: "TOKENS_LIMIT", percentage: 62.5, currentValue: 10000000, usage: 16000000, limitWindowSeconds: 604800 },
      { type: "TIME_LIMIT", percentage: 5, currentValue: 5, usage: 100 },
    ],
  },
};

test("quota: zai 5h + weekly classification", async () => {
  tempAgentDir();
  write(join(process.env.PI_CODING_AGENT_DIR!, "auth.json"), JSON.stringify({ zai: { type: "api_key", key: "zai-key" } }));

  const res = await probeZai(
    mockFetch([{ match: "/api/monitor/usage/quota/limit", respond: () => jsonResponse(ZAI_RESPONSE) }]),
  );
  assert.equal(res.ok, true);
  const five = res.meters.find((m) => m.id === "zai.fiveHour");
  const weekly = res.meters.find((m) => m.id === "zai.weekly");
  assert.ok(five && weekly);
  assert.equal(five.usedPct, 40);
  assert.equal(five.current, 3200000);
  assert.equal(five.limit, 8000000);
  assert.equal(weekly.usedPct, 62.5);
  assert.equal(weekly.leftPct, 37.5);
});

test("quota: zai 401 then Bearer retry works", async () => {
  tempAgentDir();
  write(join(process.env.PI_CODING_AGENT_DIR!, "auth.json"), JSON.stringify({ "z-ai": "plain-token" }));
  let calls = 0;
  const res = await probeZai(async (url, init) => {
    calls++;
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    if (auth === "plain-token") return jsonResponse({ error: "no" }, 401); // 直接 token 失败
    return jsonResponse(ZAI_RESPONSE); // Bearer 成功
  });
  assert.equal(res.ok, true);
  assert.equal(calls, 2);
});

test("quota: zai key from auth.json by default (zai-coding-cn, pi provider id)", async () => {
  tempAgentDir();
  // pi /login 写入的 provider id：zai-coding-cn（中国 Coding Plan）
  write(
    join(process.env.PI_CODING_AGENT_DIR!, "auth.json"),
    JSON.stringify({ "zai-coding-cn": { type: "api_key", key: "zai-cn-key" } }),
  );
  const res = await probeZai(async (_url, init) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    assert.equal(auth, "zai-cn-key"); // 未设任何 ZAI_* 环境变量时默认取自 auth.json
    return jsonResponse(ZAI_RESPONSE);
  });
  assert.equal(res.ok, true);
});

test("quota: zai env var fallback when auth.json lacks key", async () => {
  tempAgentDir();
  write(join(process.env.PI_CODING_AGENT_DIR!, "auth.json"), JSON.stringify({ "some-other-provider": "x" }));
  process.env.ZAI_CODING_CN_API_KEY = "env-key";
  try {
    const res = await probeZai(async (_url, init) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      assert.equal(auth, "env-key"); // auth.json 无 zai key 时回退到环境变量
      return jsonResponse(ZAI_RESPONSE);
    });
    assert.equal(res.ok, true);
  } finally {
    delete process.env.ZAI_CODING_CN_API_KEY;
  }
});

test("quota: zai no plan -> ok=false with hint", async () => {
  tempAgentDir();
  write(join(process.env.PI_CODING_AGENT_DIR!, "auth.json"), JSON.stringify({ zhipu: "zhipu-key" }));
  const res = await probeZai(
    mockFetch([{ match: "/quota/limit", respond: () => jsonResponse({ data: { limits: [] } }) }]),
  );
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /Coding Plan|额度/);
});

/* ---------------- Codex ---------------- */

const CODEX_RESPONSE = {
  rate_limit: {
    primary_window: { used_percent: 30, limit_window_seconds: 18000, resets_at: 9999999999 },
    secondary_window: { used_percent: 55, limit_window_seconds: 604800, resets_at: 9999999999 + 3 * 86400 },
  },
};

function setupCodexAuth(dir: string) {
  const codexHome = join(dir, "codex-home");
  write(join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "tok-abc", account_id: "acct-1" } }));
  process.env.CODEX_HOME = codexHome;
}

test("quota: codex weekly + 5h from wham/usage", async () => {
  const dir = tempAgentDir();
  setupCodexAuth(dir);

  const res = await probeCodex(
    mockFetch([{ match: "wham/usage", respond: () => jsonResponse(CODEX_RESPONSE) }]),
  );
  assert.equal(res.ok, true);
  const five = res.meters.find((m) => m.id === "codex.fiveHour");
  const weekly = res.meters.find((m) => m.id === "codex.weekly");
  assert.ok(five && weekly);
  assert.equal(five.usedPct, 30);
  assert.equal(weekly.usedPct, 55);
  assert.equal(weekly.leftPct, 45);
  // resets_at 是 epoch 秒 → 转 ms
  assert.ok(weekly.resetsAt! > 1e12);
});

test("quota: codex classifies a weekly-only primary window", async () => {
  const dir = tempAgentDir();
  setupCodexAuth(dir);

  const res = await probeCodex(
    mockFetch([
      {
        match: "wham/usage",
        respond: () =>
          jsonResponse({
            plan_type: "pro",
            rate_limit: {
              primary_window: {
                used_percent: 18,
                limit_window_seconds: 604800,
                reset_after_seconds: 3600,
              },
              secondary_window: null,
            },
          }),
      },
    ]),
  );

  assert.equal(res.ok, true);
  assert.equal(res.label, "Codex (pro)");
  assert.equal(res.meters.find((m) => m.id === "codex.weekly")?.usedPct, 18);
  assert.equal(res.meters.some((m) => m.id === "codex.fiveHour"), false);
  assert.ok(res.meters[0].resetsAt! > Date.now());
});

test("quota: codex accepts camel-case app-server snapshots", async () => {
  const dir = tempAgentDir();
  setupCodexAuth(dir);

  const res = await probeCodex(
    mockFetch([
      {
        match: "wham/usage",
        respond: () =>
          jsonResponse({
            rateLimits: {
              primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 9999999999 },
              secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 9999999999 },
            },
          }),
      },
    ]),
  );

  assert.equal(res.ok, true);
  assert.equal(res.meters.find((m) => m.id === "codex.fiveHour")?.usedPct, 25);
  assert.equal(res.meters.find((m) => m.id === "codex.weekly")?.usedPct, 40);
});

test("quota: codex recovers quota windows from nested keyed response variants", async () => {
  const dir = tempAgentDir();
  setupCodexAuth(dir);

  const res = await probeCodex(
    mockFetch([{
      match: "wham/usage",
      respond: () => jsonResponse({
        data: {
          subscriptions: {
            codex: {
              buckets: {
                short_window: { remaining_percent: 80, window_seconds: 18000, reset_after_seconds: 60 },
                weekly_window: { current: 60, limit: 100, window_seconds: 604800, reset_after_seconds: 3600 },
              },
            },
          },
        },
      }),
    }]),
  );

  assert.equal(res.ok, true);
  assert.equal(res.meters.find((meter) => meter.id === "codex.fiveHour")?.usedPct, 20);
  assert.equal(res.meters.find((meter) => meter.id === "codex.weekly")?.usedPct, 60);
});

test("quota: codex exposes additional limits and reset credits", async () => {
  const dir = tempAgentDir();
  setupCodexAuth(dir);

  const res = await probeCodex(
    mockFetch([
      {
        match: "wham/usage",
        respond: () =>
          jsonResponse({
            plan_type: "prolite",
            rate_limit: null,
            additional_rate_limits: [
              {
                limit_name: "Codex Spark",
                metered_feature: "codex_spark",
                rate_limit: {
                  primary_window: { used_percent: 12, limit_window_seconds: 604800, reset_at: 9999999999 },
                },
              },
            ],
            rate_limit_reset_credits: { available_count: 2 },
          }),
      },
    ]),
  );

  assert.equal(res.ok, true);
  assert.equal(res.label, "Codex (prolite)");
  assert.equal(res.meters.find((m) => m.id.includes("codex.additional.codex.spark.weekly"))?.usedPct, 12);
  assert.equal(res.meters.find((m) => m.id === "codex.resetCredits")?.current, 2);
});

test("quota: codex not logged in -> ok=false with hint", async () => {
  const dir = tempAgentDir();
  process.env.CODEX_HOME = join(dir, "empty-codex");
  const res = await probeCodex(mockFetch([]));
  assert.equal(res.ok, false);
  assert.equal(res.configured, false);
  assert.match(res.error ?? "", /auth\.json/);
});

test("quota: codex network failure (no VPN) -> ok=false, NO throw", async () => {
  const dir = tempAgentDir();
  setupCodexAuth(dir);
  // 无路由 → fetch 抛网络错误；必须被捕获而不是向上抛
  const res = await probeCodex(mockFetch([]));
  assert.equal(res.ok, false);
  assert.equal(res.configured, true);
  assert.match(res.error ?? "", /network error/);
});

/* ---------------- 编排 + 快照 ---------------- */

test("quota: probeAllQuotas records snapshot and keeps history deltas", async () => {
  const dir = tempAgentDir();
  setupCodexAuth(dir);
  write(
    join(dir, "auth.json"),
    JSON.stringify({
      deepseek: { key: "sk-ds" },
      zai: { key: "zai-k" },
    }),
  );

  const fetchImpl = mockFetch([
    { match: "user/balance", respond: () => jsonResponse({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "50.00" }] }) },
    { match: "/quota/limit", respond: () => jsonResponse({ data: { limits: [{ type: "TOKENS_LIMIT", percentage: 40, currentValue: 1, usage: 2 }] } }) },
    { match: "wham/usage", respond: () => jsonResponse(CODEX_RESPONSE) },
  ]);

  const r1 = await probeAllQuotas(fetchImpl);
  assert.equal(r1.providers.length, 3);
  assert.equal(r1.providers.find((p) => p.provider === "deepseek")?.ok, true);
  assert.equal(r1.providers.find((p) => p.provider === "zai")?.ok, true);
  assert.equal(r1.providers.find((p) => p.provider === "codex")?.ok, true);
  assert.equal(r1.prev, null); // 首次探测无历史
  assert.ok(existsSync(quotaHistoryPath()));

  // 第二次探测：余额减少 → 记录消耗 delta
  const fetchImpl2 = mockFetch([
    { match: "user/balance", respond: () => jsonResponse({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "48.30" }] }) },
    { match: "/quota/limit", respond: () => jsonResponse({ data: { limits: [{ type: "TOKENS_LIMIT", percentage: 45, currentValue: 1, usage: 2 }] } }) },
    { match: "wham/usage", respond: () => jsonResponse(CODEX_RESPONSE) },
  ]);
  const r2 = await probeAllQuotas(fetchImpl2);
  assert.ok(r2.prev);
  assert.equal(r2.prev.deepseek?.balance, 50);
  const deltas = computeDeltas(toSnapshot(r2.providers, r2.ts), r2.prev);
  assert.equal(deltas.deepseekSpent, 1.7); // 50.00 - 48.30
  assert.equal(deltas.zaiFiveHourDelta, 5); // 45 - 40
});

test("quota: codex failure allowed in orchestration (does not break others)", async () => {
  const dir = tempAgentDir();
  process.env.CODEX_HOME = join(dir, "no-codex");
  write(join(dir, "auth.json"), JSON.stringify({ deepseek: { key: "sk-ds" } }));

  const fetchImpl = mockFetch([
    { match: "user/balance", respond: () => jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "5.00" }] }) },
    // zai 无 key → 未配置；codex 网络错误
  ]);
  const r = await probeAllQuotas(fetchImpl);
  const ds = r.providers.find((p) => p.provider === "deepseek");
  const zai = r.providers.find((p) => p.provider === "zai");
  const codex = r.providers.find((p) => p.provider === "codex");
  assert.equal(ds?.ok, true);
  assert.equal(zai?.configured, false);
  assert.equal(codex?.ok, false); // 允许失败
  // 文本输出不抛错且包含关键信息
  const text = formatQuotaText(r);
  assert.match(text, /DeepSeek/);
  assert.match(text, /Codex/);
  assert.ok(!text.includes("参考价"), "额度输出不应混入模型参考价格");
  // 宽松分组：每组 = 组名行 + 缩进数据行，组间空行分隔（不再是每渠道单行紧凑）
  assert.ok(text.includes("\n\n"), "组间应有空行分隔");
  assert.ok(text.split("\n").length > 6, `宽松分组后行数应多于 6，实际 ${text.split("\n").length} 行`);
  assert.ok(/^\s{2}/m.test(text), "数据行应缩进 2 空格");
  const summary = quotaSummary(r);
  assert.match(summary, /余额/);
});

test("quota: history helpers", () => {
  const dir = tempAgentDir();
  const s1: QuotaSnapshot = { ts: 1000, deepseek: { balance: 100, currency: "¥" }, zai: null, codex: null };
  const s2: QuotaSnapshot = { ts: 2000, deepseek: { balance: 90, currency: "¥" }, zai: null, codex: null };
  recordSnapshot(s1);
  recordSnapshot(s2);
  const d = computeDeltas(s2, latestSnapshot(2000));
  assert.equal(d.deepseekSpent, 10);
  assert.equal(readFileSync(quotaHistoryPath(), "utf8").split("\n").filter(Boolean).length, 2);
});
