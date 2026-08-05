import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, loadState, saveState } from "../src/config.js";
import { buildConfigChanges, applyMergedConfig, sha256 } from "../src/sync/configs.js";
import {
  scanLocalSessions,
  buildSessionChanges,
  applyPulledSessions,
  encodeCwdPath,
  searchLocalSessions,
  scanSessionIncrements,
  commitSessionCheckpoint,
} from "../src/sync/sessions.js";
import { UsageCollector } from "../src/stats/collector.js";
import { scanSessionFile, mergeRecords, buildReport } from "../src/stats/analyzer.js";
import { formatReport } from "../src/stats/report.js";
import { fetchUsdCnyRate, clearRateCache } from "../src/stats/rates.js";
import { generateAiSessionName, summarizeName } from "../src/session.js";
import type { MergedObject, SessionSnapshot } from "../src/types.js";

function tempAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-sync-ext-test-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

function write(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

test("config: field-level diff & merge application", () => {
  const dir = tempAgentDir();
  const cfg = loadConfig();
  cfg.sync.includeConfigs = ["settings.json"];
  saveConfig(cfg);

  const settingsPath = join(dir, "settings.json");
  write(settingsPath, JSON.stringify({ theme: "dark", defaultProvider: "deepseek", compaction: { enabled: true } }));

  const state = loadState();
  const changes = buildConfigChanges(cfg, state);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].key, "config/settings.json");
  assert.ok(changes[0].jsonFields);
  assert.equal(changes[0].jsonFields!.length, 3);
  assert.equal(changes[0].jsonFields!.find((f) => f.path === "theme")?.version, 1);

  // 再次构建：无变更
  const changes2 = buildConfigChanges(cfg, state);
  assert.equal(changes2.length, 0);

  // 修改一个字段 → 只 diff 该字段，版本 +1
  write(settingsPath, JSON.stringify({ theme: "light", defaultProvider: "deepseek", compaction: { enabled: true } }));
  const changes3 = buildConfigChanges(cfg, state);
  assert.equal(changes3.length, 1);
  const themeField = changes3[0].jsonFields!.find((f) => f.path === "theme")!;
  assert.equal(themeField.version, 2);
  assert.equal(changes3[0].jsonFields!.length, 1);
});

test("config: apply merged object writes file and updates state", () => {
  const dir = tempAgentDir();
  const cfg = loadConfig();
  cfg.sync.includeConfigs = ["settings.json"];
  saveConfig(cfg);

  const state = loadState();
  const merged: MergedObject = {
    key: "config/settings.json",
    kind: "config",
    version: 5,
    sha256: "abc",
    contentB64: Buffer.from(JSON.stringify({ theme: "synced" }), "utf8").toString("base64"),
    fieldVersions: [
      { path: "theme", version: 3, updatedBy: "dev-b", updatedAt: Date.now() },
    ],
    updatedBy: "dev-b",
    updatedAt: Date.now(),
    deleted: false,
  };
  const { wrote, content } = applyMergedConfig(cfg, state, merged);
  assert.equal(wrote, true);
  assert.equal(JSON.parse(content).theme, "synced");
  assert.equal(state.objects["config/settings.json"].baseSha256, "abc");
  assert.equal(state.objects["config/settings.json"].fields["theme"].version, 3);
  assert.equal(state.objects["config/settings.json"].fields["theme"].value, JSON.stringify("synced"));
});

test("session: scan, diff, apply pulled", () => {
  const dir = tempAgentDir();
  const cfg = loadConfig();
  const uuid = "sess-uuid-test";
  const cwd = "C:/Users/test/proj";
  const sessionDir = join(dir, "sessions", encodeCwdPath(cwd));
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, `1234_${uuid}.jsonl`);

  const header = JSON.stringify({ type: "session", version: 3, id: uuid, timestamp: "2024-01-01T00:00:00.000Z", cwd });
  const e1 = JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "2024-01-01T00:00:01.000Z", message: { role: "user", content: "hi" } });
  write(file, `${header}\n${e1}\n`);

  // 扫描
  const local = scanLocalSessions();
  assert.equal(local.length, 1);
  assert.equal(local[0].uuid, uuid);
  assert.equal(local[0].entries.length, 1);

  // diff
  const state = loadState();
  const changes = buildSessionChanges(local, state, cfg);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].entries.length, 1);
  assert.equal(changes[0].baseVersion, 0);

  // 应用拉取：服务器新增了 e2
  const snap: SessionSnapshot = {
    uuid,
    cwd,
    name: null,
    headerJson: header,
    createdAt: 1704067200000,
    version: 2,
    deleted: false,
    updatedBy: "dev-b",
    updatedAt: Date.now(),
    lines: [
      e1,
      JSON.stringify({ type: "message", id: "e2", parentId: "e1", timestamp: "2024-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hello" }], provider: "anthropic", model: "claude", usage: { input: 10, output: 5, totalTokens: 15 } } }),
    ],
  };
  const res = applyPulledSessions(cfg, state, [snap]);
  assert.equal(res.wrote, 1);
  assert.ok(state.sessions[uuid].offset > 0);
  assert.equal(state.sessions[uuid].serverVersion, 2);

  // 再次扫描本地文件：应有 2 条
  const local2 = scanLocalSessions();
  assert.equal(local2[0].entries.length, 2);

  // 搜索
  const found = searchLocalSessions("proj");
  assert.equal(found.length, 1);
});

test("stats: collector dedupe + analyzer aggregation", () => {
  const dir = tempAgentDir();
  process.env.PI_CODING_AGENT_DIR = dir;
  const collector = new UsageCollector();

  const base = {
    sessionId: "s1",
    sessionName: "Test Session",
    project: "/proj",
    provider: "anthropic",
    model: "claude-sonnet",
    device: "dev-a",
  };
  collector.record({ ...base, role: "assistant", ts: 1704067200000, usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.01 } } });
  // 重复记录应被去重
  collector.record({ ...base, role: "assistant", ts: 1704067200000, usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.01 } } });
  collector.record({ ...base, role: "assistant", ts: 1704153600000, usage: { input: 200, output: 100, totalTokens: 300, cost: { total: 0.02 } } });
  collector.record({ ...base, role: "toolResult", ts: 1704153600000, model: "claude-sonnet", usage: { input: 5, output: 10, totalTokens: 15 } });

  const all = collector.loadAll();
  assert.equal(all.length, 3); // 去重生效

  const report = buildReport(all, {});
  assert.equal(report.summary.totalInput, 305);
  assert.equal(report.summary.totalOutput, 160);
  assert.equal(report.summary.totalCost, 0.03);
  assert.equal(report.summary.requests, 3);
  assert.equal(report.byModel.length, 1);
  assert.equal(report.bySession.length, 1);

  // 按天
  const report2 = buildReport(all, { days: 1 });
  assert.ok(report2.summary.totalInput <= 305); // 只包含最近一天

  // 格式化不抛异常
  const text = formatReport(report);
  assert.ok(text.includes("Tokens"));

  // compact 视图（默认）：只有 按天 + 按模型 两张表，不含按会话
  const compact = formatReport(report, "table", { days: 7 });
  assert.ok(compact.includes("近 7 天"));
  assert.ok(compact.includes("按天 By Day"));
  assert.ok(compact.includes("按模型 By Model"));
  assert.ok(compact.includes("合计"));
  assert.ok(!compact.includes("按会话"));
  assert.ok(!compact.includes("总 Token"));

  // full 视图：恢复概要 + 按会话
  const full = formatReport(report, "table", { view: "full" });
  assert.ok(full.includes("总 Token"));
  assert.ok(full.includes("按会话"));

  // CNY 默认显示 ¥，并可按汇率换算
  const cny = formatReport(report, "table", { currency: "cny", usdCnyRate: 7.15 });
  assert.ok(cny.includes("¥"));
  assert.ok(!cny.includes("$"));
  const usd = formatReport(report, "table", { currency: "usd" });
  assert.ok(usd.includes("$"));
  assert.ok(!usd.includes("¥"));
});

test("stats: usd-cny rate from exchangerate-api (mock), cache, failure fallback", async () => {
  clearRateCache();
  // 正常响应：解析 rates.CNY
  let calls = 0;
  const okFetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({ result: "success", rates: { USD: 1, CNY: 6.762932 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const r1 = await fetchUsdCnyRate(okFetch);
  assert.ok(Math.abs((r1 ?? 0) - 6.762932) < 1e-6);
  // 6h 缓存：第二次不重新请求
  const r2 = await fetchUsdCnyRate(okFetch);
  assert.equal(r2, r1);
  assert.equal(calls, 1);

  // 失败（网络错误）→ null
  clearRateCache();
  const failFetch = async () => {
    throw new Error("network down");
  };
  assert.equal(await fetchUsdCnyRate(failFetch), null);

  // 响应不含 CNY / result=error → null
  clearRateCache();
  const badFetch = async () => new Response(JSON.stringify({ result: "error" }), { status: 200 });
  assert.equal(await fetchUsdCnyRate(badFetch), null);
});

test("session: summarizeName strips markdown/code and truncates", () => {
  assert.equal(summarizeName("帮我重构一下这个函数", 32), "帮我重构一下这个函数");
  // markdown / 代码 / 链接清理
  assert.equal(summarizeName("**重点**：修复 [#42](https://x.y) 的 bug\n```js\ncode\n```", 32), "重点：修复 42 的 bug");
  // 超长截断 + 省略号
  const long = "这是一个非常非常非常非常非常非常非常非常非常长的会话描述";
  const s = summarizeName(long, 16);
  assert.equal(s.length, 16);
  assert.ok(s.endsWith("…"));
  // 空/纯符号 → 占位名
  assert.equal(summarizeName("``` ```\n###", 32), "（未命名会话）");
});

test("session: config defaults include independent AI auto-name model mapping", () => {
  const c = loadConfig();
  assert.equal(c.session.autoName, true);
  assert.equal(c.session.autoNameMax, 32);
  assert.equal(c.session.autoNameModelByProvider["deepseek"], "deepseek-v4-flash");
  assert.equal(c.session.autoNameModelByProvider["zai-coding-cn"], "glm-4.7");
  assert.equal(c.session.autoNameModelByProvider["openai-codex"], "gpt-5.6-luna");
  // saveConfig 往返保留 session
  saveConfig(c);
  const c2 = loadConfig();
  assert.deepEqual(c2.session.autoNameModelByProvider, c.session.autoNameModelByProvider);
});

test("session: AI auto-name uses an independent mapped model and falls back safely", async () => {
  tempAgentDir();
  const cfg = loadConfig();
  cfg.session.autoNameMax = 32;
  cfg.session.autoNameModelByProvider = { deepseek: "deepseek-v4-flash" };
  const cheapModel = { provider: "deepseek", id: "deepseek-v4-flash", api: "openai-completions" };
  const context = {
    model: { provider: "deepseek", id: "deepseek-v4-pro" },
    modelRegistry: {
      find(provider: string, model: string) {
        assert.equal(provider, "deepseek");
        assert.equal(model, "deepseek-v4-flash");
        return cheapModel;
      },
      async getApiKeyAndHeaders(model: unknown) {
        assert.equal(model, cheapModel);
        return { ok: true, apiKey: "test-key" };
      },
    },
  };
  let calls = 0;
  const fakeComplete = async (model: unknown, request: any, options: any) => {
    calls++;
    assert.equal(model, cheapModel);
    assert.deepEqual(request.tools, []);
    assert.equal(options.maxTokens, 64);
    assert.equal(options.cacheRetention, "none");
    assert.match(options.sessionId, /^pi-sync-autoname-/);
    return {
      role: "assistant",
      content: [{ type: "text", text: "修复同步性能" }],
      api: "openai-completions",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 12,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 16,
        cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
      },
    };
  };

  const named = await generateAiSessionName(context as any, "main-session", "请修复同步性能", cfg, fakeComplete as any);
  assert.equal(named.title, "修复同步性能");
  assert.equal(named.usage?.sessionId, "main-session");
  assert.equal(named.usage?.model, "deepseek-v4-flash");
  assert.equal(named.usage?.totalTokens, 16);
  assert.equal(calls, 1);

  const invalidComplete = async () => ({
    ...(await fakeComplete(cheapModel, { tools: [] }, { maxTokens: 64, cacheRetention: "none", sessionId: "pi-sync-autoname-invalid" })),
    content: [{ type: "text", text: "标题：解释\n第二行" }],
  });
  const fallback = await generateAiSessionName(context as any, "main-session", "请修复同步性能", cfg, invalidComplete as any);
  assert.equal(fallback.title, "请修复同步性能");

  const noCredentialContext = {
    ...context,
    modelRegistry: { ...context.modelRegistry, async getApiKeyAndHeaders() { return { ok: false }; } },
  };
  const noCredential = await generateAiSessionName(noCredentialContext as any, "main-session", "本地兜底标题", cfg, fakeComplete as any);
  assert.equal(noCredential.title, "本地兜底标题");
  assert.equal(calls, 2, "无凭据时不应请求命名模型");

  const sessionSource = readFileSync(join(import.meta.dirname, "../src/session.ts"), "utf8");
  assert.ok(!sessionSource.includes("pi.setModel("), "自动命名不得切换主会话模型");
});

test("session sync v2: unchanged files are stat-only and partial tails resume incrementally", async () => {
  const dir = tempAgentDir();
  const cfg = loadConfig();
  const state = loadState();
  const cwd = "C:/work/incremental";
  const uuid = "incremental-session";
  const sessionDir = join(dir, "sessions", encodeCwdPath(cwd));
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, `1_${uuid}.jsonl`);
  const header = JSON.stringify({ type: "session", version: 3, id: uuid, timestamp: "2026-08-06T00:00:00.000Z", cwd });
  const e1 = JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "2026-08-06T00:00:01.000Z", message: { role: "user", content: "one" } });
  write(file, `${header}\n${e1}\n`);

  const first = await scanSessionIncrements(state, cfg);
  assert.equal(first.length, 1);
  assert.equal(first[0].reconciled, true);
  assert.deepEqual(first[0].change.entries.map((entry) => entry.id), ["e1"]);
  commitSessionCheckpoint(state, first[0].checkpoint, 1);

  const unchanged = await scanSessionIncrements(state, cfg);
  assert.equal(unchanged.length, 0);
  assert.equal(state.lastScan?.bytesRead, 0, "未变化文件不得读取 JSONL 正文");

  const e2 = JSON.stringify({ type: "message", id: "e2", parentId: "e1", timestamp: "2026-08-06T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "two" }] } });
  const e3 = JSON.stringify({ type: "message", id: "e3", parentId: "e2", timestamp: "2026-08-06T00:00:03.000Z", message: { role: "user", content: "three" } });
  const split = Math.floor(e3.length / 2);
  appendFileSync(file, `${e2}\n${e3.slice(0, split)}`, "utf8");
  const appended = await scanSessionIncrements(state, cfg);
  assert.equal(appended.length, 1);
  assert.deepEqual(appended[0].change.entries.map((entry) => entry.id), ["e2"]);
  assert.ok(appended[0].checkpoint.offset < appended[0].checkpoint.size, "残缺尾行不推进游标");
  commitSessionCheckpoint(state, appended[0].checkpoint, 2);

  appendFileSync(file, `${e3.slice(split)}\n`, "utf8");
  const resumed = await scanSessionIncrements(state, cfg);
  assert.equal(resumed.length, 1);
  assert.deepEqual(resumed[0].change.entries.map((entry) => entry.id), ["e3"]);
  commitSessionCheckpoint(state, resumed[0].checkpoint, 3);

  writeFileSync(file, `${header}\n${e1}\n`, "utf8");
  const rewritten = await scanSessionIncrements(state, cfg);
  assert.equal(rewritten.length, 1);
  assert.equal(rewritten[0].reconciled, true);
  assert.deepEqual(rewritten[0].change.entries.map((entry) => entry.id), ["e1"]);
});

test("stats: session scan produces records", () => {
  const dir = tempAgentDir();
  const cwd = "/proj2";
  const sessionDir = join(dir, "sessions", encodeCwdPath(cwd));
  mkdirSync(sessionDir, { recursive: true });
  const uuid = "scan-sess";
  const file = join(sessionDir, `999_${uuid}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: uuid, timestamp: "2024-01-01T00:00:00.000Z", cwd }),
    JSON.stringify({ type: "session_info", id: "i1", parentId: null, timestamp: "2024-01-01T00:00:00.100Z", name: "My Session" }),
    JSON.stringify({
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2024-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        provider: "openai",
        model: "gpt-4o",
        usage: { input: 50, output: 25, totalTokens: 75, cost: { total: 0.005 } },
      },
    }),
    JSON.stringify({
      type: "compaction",
      id: "c1",
      parentId: "m1",
      timestamp: "2024-01-02T00:00:00.000Z",
      summary: "s",
      tokensBefore: 100,
      usage: { input: 10, output: 5, totalTokens: 15 },
    }),
  ];
  write(file, lines.join("\n") + "\n");

  const records = scanSessionFile(file, uuid, cwd, "My Session", "dev-a");
  assert.equal(records.length, 2); // assistant + compaction
  assert.equal(records[0].model, "gpt-4o");
  assert.equal(records[0].sessionName, "My Session");
  assert.equal(records[1].model, "(compaction)");

  // merge：有 live 记录的会话跳过 scan
  const live = [{ ...records[0], key: "x", source: "live" as const }];
  const merged = mergeRecords(live, records);
  assert.equal(merged.length, 1);
});

test("config file load/save roundtrip keeps legacy fields", () => {
  const dir = tempAgentDir();
  const raw = {
    version: 3,
    deviceName: "my-pc",
    storageConnections: { old: { type: "webdav" } },
    activeSyncSetup: "old",
  };
  write(join(dir, "pi-sync.json"), JSON.stringify(raw));
  const cfg = loadConfig();
  assert.equal(cfg.deviceName, "my-pc");
  assert.ok(cfg.legacy?.storageConnections);
  assert.equal((cfg.legacy!.storageConnections as { old: { type: string } }).old.type, "webdav");
  // 保存后 legacy 仍在
  saveConfig(cfg);
  const reread = JSON.parse(readFileSync(join(dir, "pi-sync.json"), "utf8"));
  assert.equal(reread.storageConnections.old.type, "webdav");
});


test("auth.json: provider-level diff & v4 migration", () => {
  const dir = tempAgentDir();
  const cfg = loadConfig();
  // v4 迁移：includeConfigs 应包含 auth.json
  assert.ok(cfg.sync.includeConfigs.includes("auth.json"), "auth.json in defaults");
  assert.equal(cfg.version, 5);
  cfg.sync.includeConfigs = ["settings.json", "keybindings.json", "models.json", "auth.json"];
  saveConfig(cfg);

  const authPath = join(dir, "auth.json");
  write(authPath, JSON.stringify({ deepseek: { type: "api_key", key: "sk-1" }, openai: { type: "api_key", key: "sk-2" } }));

  const state = loadState();
  const changes = buildConfigChanges(cfg, state);
  const authChange = changes.find((c) => c.key === "config/auth.json");
  assert.ok(authChange);
  // 提供商级字段：2 个 provider，各 version 1
  assert.equal(authChange.jsonFields!.length, 2);
  assert.equal(authChange.jsonFields!.find((f) => f.path === "deepseek")!.version, 1);
  assert.deepEqual(JSON.parse(authChange.jsonFields!.find((f) => f.path === "openai")!.valueJson), { type: "api_key", key: "sk-2" });

  // 修改一个提供商 → 只 diff 该提供商，版本 +1
  write(authPath, JSON.stringify({ deepseek: { type: "api_key", key: "sk-new" }, openai: { type: "api_key", key: "sk-2" } }));
  const changes2 = buildConfigChanges(cfg, state);
  const authChange2 = changes2.find((c) => c.key === "config/auth.json");
  assert.ok(authChange2);
  assert.equal(authChange2.jsonFields!.length, 1);
  assert.equal(authChange2.jsonFields![0].path, "deepseek");
  assert.equal(authChange2.jsonFields![0].version, 2);
});

test("config: v3 -> v4 migration adds auth.json once", () => {
  const dir = tempAgentDir();
  // 模拟旧 v3 配置
  const old = {
    version: 3,
    deviceName: "old-dev",
    sync: {
      includeConfigs: ["settings.json", "keybindings.json", "models.json"],
    },
  };
  write(join(dir, "pi-sync.json"), JSON.stringify(old));
  const cfg = loadConfig();
  assert.ok(cfg.sync.includeConfigs.includes("auth.json"), "migration added auth.json");
  assert.equal(cfg.version, 5);
  // 已持久化
  const reread = JSON.parse(readFileSync(join(dir, "pi-sync.json"), "utf8"));
  assert.ok(reread.sync.includeConfigs.includes("auth.json"));
});


test("session: sanitize strips tool output, tool calls and thinking on push", () => {
  const dir = tempAgentDir();
  const cfg = loadConfig();
  cfg.sync.stripToolOutputs = true;
  cfg.sync.stripThinking = true;
  saveConfig(cfg);

  const toolEntry = JSON.stringify({
    type: "message", id: "t1", parentId: null, timestamp: "2024-01-01T00:00:00.000Z",
    message: { role: "toolResult", toolCallId: "c1", toolName: "bash",
      content: [{ type: "text", text: "HUGE OUTPUT ".repeat(100) }],
      details: { output: "huge".repeat(500), exitCode: 0, fullOutputPath: "/tmp/x" }, isError: false },
  });
  const thinkEntry = JSON.stringify({
    type: "message", id: "a1", parentId: "t1", timestamp: "2024-01-01T00:00:01.000Z",
    message: { role: "assistant", provider: "deepseek", model: "deepseek-v4",
      content: [{ type: "thinking", thinking: "secret reasoning ".repeat(50) },
                { type: "toolCall", id: "c1", name: "bash", arguments: { command: "secret" } },
                { type: "text", text: "final answer" }],
      usage: { input: 10, output: 5, totalTokens: 15 } },
  });
  const textEntry = JSON.stringify({
    type: "message", id: "u1", parentId: "a1", timestamp: "2024-01-01T00:00:02.000Z",
    message: { role: "user", content: "hello" },
  });

  // 本地文件保持完整
  const cwd = "/proj";
  const sessionDir = join(dir, "sessions", encodeCwdPath(cwd));
  mkdirSync(sessionDir, { recursive: true });
  const uuid = "sanitize-test";
  write(join(sessionDir, `1_${uuid}.jsonl`),
    JSON.stringify({ type: "session", version: 3, id: uuid, timestamp: "2024-01-01T00:00:00.000Z", cwd }) + "\n" +
    toolEntry + "\n" + thinkEntry + "\n" + textEntry + "\n");

  const state = loadState();
  const changes = buildSessionChanges(scanLocalSessions(), state, cfg);
  assert.equal(changes.length, 1);
  const lines = changes[0].entries.map((e) => JSON.parse(e.lineJson));

  const tool = lines.find((l) => l.id === "t1").message;
  assert.deepEqual(tool.content, []);
  assert.equal(tool.details, undefined);
  assert.equal(tool.toolCallId, "c1", "保留关联 id 以维持会话父子关系");
  assert.equal(tool.toolName, "bash");

  const assistant = lines.find((l) => l.id === "a1").message;
  assert.ok(!assistant.content.some((b) => b.type === "thinking"), "thinking 已剥离");
  assert.ok(!assistant.content.some((b) => b.type === "toolCall"), "toolCall 已剥离");
  assert.equal(assistant.content.length, 1);
  assert.equal(assistant.content[0].text, "final answer");
  assert.equal(assistant.model, "deepseek-v4");

  const user = lines.find((l) => l.id === "u1").message;
  assert.equal(user.content, "hello");

  // 本地文件仍是完整内容
  const local = scanLocalSessions()[0];
  assert.ok(local.entries.find((e) => e.id === "t1").lineJson.includes("HUGE OUTPUT"));
  assert.ok(local.entries.find((e) => e.id === "a1").lineJson.includes("secret reasoning"));

  // 关闭剥离 → 原样
  const cfg2 = loadConfig();
  cfg2.sync.stripToolOutputs = false;
  cfg2.sync.stripThinking = false;
  const changes2 = buildSessionChanges(scanLocalSessions(), loadState(), cfg2);
  const rawTool = JSON.parse(changes2[0].entries.find((e) => JSON.parse(e.lineJson).id === "t1").lineJson);
  assert.ok(rawTool.message.content[0].text.includes("HUGE OUTPUT"));
});
