import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../src/index.js";
import type { ServerConfig } from "../src/config.js";
import type { FastifyInstance } from "fastify";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USD_CNY_REFERENCE, usageCostUsd } from "../src/pricing.js";

test("GLM-5.2 zero-cost usage falls back to the published token pricing", () => {
  const estimated = usageCostUsd(
    {
      provider: "zai-coding-cn",
      model: "glm-5.2-high",
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
    },
    0,
  );
  assert.equal(Math.round(estimated * USD_CNY_REFERENCE), 46);
  assert.equal(usageCostUsd({ provider: "zai", model: "glm-5.2", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, 0.25), 0.25);
  assert.equal(usageCostUsd({ provider: "test-provider", model: "glm-5.2", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 0), 0);
});

test("GLM-5.3 zero-cost usage estimated at the same published pricing as GLM-5.2", () => {
  // GLM-5.3 上线 GLM Coding Plan 后同样上报 0 费用，按 5.2 同价（8/28/缓存命中 2）估算
  const estimated = usageCostUsd(
    {
      provider: "zai-coding-cn",
      model: "glm-5.3-high",
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
    },
    0,
  );
  assert.equal(Math.round(estimated * USD_CNY_REFERENCE), 46);
  // 非零上报费用优先，不被 5.3 估算覆盖
  assert.equal(usageCostUsd({ provider: "zai", model: "glm-5.3", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, 0.25), 0.25);
  // 其他 GLM-5.x（无公开同价）不误匹配
  assert.equal(usageCostUsd({ provider: "zai", model: "glm-5.1", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 0), 0);
});

test("MiMo v2.5 / v2.5 Pro zero-cost usage falls back to published token pricing", () => {
  // 国内按量价（元/百万 tokens）：v2.5 in1/out2/cr0.02/cw0；pro in3/out6/cr0.025
  const v25 = usageCostUsd(
    { provider: "xiaomi-token-plan-cn", model: "mimo-v2.5", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
    0,
  );
  assert.ok(Math.abs(v25 * USD_CNY_REFERENCE - 3.02) < 1e-6);
  const pro = usageCostUsd(
    { provider: "xiaomi-token-plan-cn", model: "mimo-v2.5-pro", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
    0,
  );
  assert.ok(Math.abs(pro * USD_CNY_REFERENCE - 9.025) < 1e-6);
  // 渠道上报非零费用优先，不被估算覆盖
  assert.equal(usageCostUsd({ provider: "xiaomi", model: "mimo-v2.5", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, 0.5), 0.5);
  // 已下线的 mimo-v2-pro 不在估算表内 → 0
  assert.equal(usageCostUsd({ provider: "xiaomi", model: "mimo-v2-pro", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 0), 0);
});

test("GPT-5.6 Sol/Terra/Luna zero-cost usage estimated at official USD pricing", () => {
  // 官方 API Standard 短上下文价（美元/百万 tokens）：sol 5/30/0.5，terra 2/12/0.2，luna 0.2/1.2/0.02
  // USD 官方价直接返回，不经过 USD_CNY_REFERENCE 折算
  const sol = usageCostUsd(
    { provider: "openai", model: "gpt-5.6-sol", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 },
    0,
  );
  assert.ok(Math.abs(sol - 35.5) < 1e-9); // 5 + 30 + 0.5

  const terra = usageCostUsd(
    { provider: "openai", model: "gpt-5.6-terra", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 },
    0,
  );
  assert.ok(Math.abs(terra - 14.2) < 1e-9); // 2 + 12 + 0.2

  const luna = usageCostUsd(
    { provider: "openai", model: "gpt-5.6-luna", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 },
    0,
  );
  assert.ok(Math.abs(luna - 1.42) < 1e-9); // 0.2 + 1.2 + 0.02

  // 渠道上报非零费用优先，不被估算覆盖
  assert.equal(usageCostUsd({ provider: "openai", model: "gpt-5.6-sol", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, 0.1234), 0.1234);
  // 无后缀别名 gpt-5.6 不匹配任何变体 → 0
  assert.equal(usageCostUsd({ provider: "openai", model: "gpt-5.6", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 0), 0);
  // 按 model 匹配，provider 不同也认
  assert.ok(usageCostUsd({ provider: "codex", model: "gpt-5.6-luna", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 0) > 0);
});

interface TestCtx {
  app: FastifyInstance;
  base: string;
  token: string;
  deviceId: string;
  stop: () => Promise<void>;
}

async function boot(): Promise<TestCtx> {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-sync-test-"));
  const cfg: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    dbPath: ":memory:",
    tokens: ["test-token"],
    adminToken: "admin-token",
    maxBatchEntries: 5000,
    maxObjectBytes: 1024 * 1024,
    publicUrl: null,
  };
  // dbPath ":memory:" 会绕过配置文件；直接使用 startServer 加载
  const { app, dbs } = await startServer({ ...cfg });
  // 强制内存库（startServer 内已用 cfg.dbPath 构造）
  const addr = app.server.address() as { port: number };
  const base = `http://127.0.0.1:${addr.port}`;

  // 注册设备
  const hb = await fetch(`${base}/api/v1/devices/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify({ deviceId: "", name: "dev-a", platform: "win32", piVersion: "0.83.0", extensionVersion: "0.1.0" }),
  });
  const hbJson = (await hb.json()) as { data: { deviceId: string } };

  return {
    app,
    base,
    token: "test-token",
    deviceId: hbJson.data.deviceId,
    stop: async () => {
      dbs.close();
      await app.close();
    },
  };
}

function headers(ctx: TestCtx, extra?: Record<string, string>) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${ctx.token}`,
    "x-device-id": ctx.deviceId,
    "x-device-name": "dev-a",
    ...(extra ?? {}),
  };
}

function b64(s: string) {
  return Buffer.from(s, "utf8").toString("base64");
}

test("health check", async (t) => {
  const ctx = await boot();
  t.after(async () => { await ctx.stop(); });
  t.after(async () => { await ctx.stop(); });
  const res = await fetch(`${ctx.base}/api/v1/health`);
  assert.equal(res.status, 200);
  const j = (await res.json()) as { ok: boolean };
  assert.equal(j.ok, true);
});

test("web console serves the upgraded dashboard shell", async (t) => {
  const ctx = await boot();
  t.after(async () => { await ctx.stop(); });
  const res = await fetch(`${ctx.base}/web`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const html = await res.text();
  assert.match(html, /pi-cloud-sync · 控制台/);
  assert.match(html, /x-data="consoleApp"/);
  assert.match(html, /id="conflictDialog"/);
  assert.match(html, /@shoelace-style\/shoelace@2\.20\.1/);
  assert.match(html, /\/cdn\/shoelace-autoloader\.js/);
  assert.doesNotMatch(html, /\/dist\/shoelace\.js/);
  assert.match(html, /glyph: this\.currency === 'cny' \? 'japanese-yen' : 'circle-dollar-sign'/);
  assert.doesNotMatch(html, /\? 'yen' :/);
  assert.match(html, /:key="metric\.label \+ ':' \+ metric\.glyph"/);
  assert.match(html, /setCurrency\(v\).*this\.refreshIcons\(\).*this\.renderTrend\(\)/);
  assert.match(html, /sl-select::part\(combobox\)/);
  assert.doesNotMatch(html, /sl-select::part\(control\)/);
  assert.match(html, /sl-details\.breakdown::part\(base\) \{ border: 0; border-radius: 0;/);
  assert.match(html, /expanded: !!messageExpanded\[group\.key\]/);
  assert.match(html, /toggleMessageExpanded\(group\.key\)/);
  assert.match(html, /get trendTitle\(\).*每小时趋势.*每日趋势/);
  assert.match(html, /this\.stats\.byHour/);
  assert.match(html, /按 Tokens 展示占比/);
  assert.match(html, /conflict\.resolvedAt \? '已解决' : '待处理'/);
  assert.doesNotMatch(html, /conflict\.resolved\b/);
  assert.match(html, /:checked="allPageSessionsSelected" :indeterminate="somePageSessionsSelected"/);
  assert.match(html, /get allPageSessionsSelected\(\)/);
  assert.match(html, /if \(this\.deviceMergeTarget === id\) this\.deviceMergeTarget = ''/);
  assert.match(html, /:loading="merging"/);
  assert.match(html, /controller\.abort\(\), 8000/);
  assert.match(html, /return 'app-window'.*return 'shell'/);
  assert.doesNotMatch(html, /return 'windows'|return 'linux'/);
  assert.match(html, /:key="row\.deviceId"/);
  assert.doesNotMatch(html, /addEventListener\('popstate'/);
  assert.match(html, /FORBID_TAGS: \[[^\]]*'img'/);
  assert.match(html, /class="sidebar-settings"/);
  assert.equal((html.match(/data-setting-select="theme"[^>]*value="system"/g) || []).length, 2);
  assert.equal((html.match(/data-setting-select="currency"[^>]*value="cny"/g) || []).length, 2);
  assert.match(html, /syncSettingSelects\(\).*option\.updateComplete.*select\.updateComplete/s);
  assert.match(html, /Promise\.all\(\[customElements\.whenDefined\('sl-select'\), customElements\.whenDefined\('sl-option'\)\]\)/);
  assert.match(html, /this\.currency = localStorage.*this\.syncSettingSelects\(\)/s);
  assert.match(html, /key: 'sessionDetail'.*requestKey: 'sessionDetail'/);
  assert.match(html, /else if \(key === 'sessionDetail'\) this\.detail = r\.value/);
  assert.doesNotMatch(html, /:class="\[group\.kind, \{/);
  assert.match(html, /alpinejs@3\.15\.12/);
  assert.match(html, /chart\.js@4\.4\.7/);
  assert.match(html, /marked@15\.0\.7/);
  assert.match(html, /dompurify@3\.2\.6/);
  assert.match(html, /id="deleteSessionsDialog"/);
});

test("auth required", async (t) => {
  const ctx = await boot();
  t.after(async () => { await ctx.stop(); });
  t.after(async () => { await ctx.stop(); });
  const res = await fetch(`${ctx.base}/api/v1/sync/pull`, { method: "POST" });
  assert.equal(res.status, 401);
});

test("config push + fast-forward + pull", async (t) => {
  const ctx = await boot();
  t.after(async () => { await ctx.stop(); });
  t.after(async () => { await ctx.stop(); });
  const settings = JSON.stringify({ theme: "dark", defaultProvider: "deepseek" });

  const push1 = await fetch(`${ctx.base}/api/v1/sync/push`, {
    method: "POST",
    headers: headers(ctx),
    body: JSON.stringify({
      changes: [
        {
          kind: "config",
          key: "config/settings.json",
          baseSha256: null,
          sha256: "sha1",
          contentB64: b64(settings),
          mtime: Date.now(),
          jsonFields: [
            { path: "theme", valueJson: JSON.stringify("dark"), version: 1 },
            { path: "defaultProvider", valueJson: JSON.stringify("deepseek"), version: 1 },
          ],
        },
      ],
    }),
  });
  const push1Json = (await push1.json()) as {
    data: { objects: Array<{ key: string; version: number; sha256: string; fieldVersions: unknown[] }> };
  };
  assert.equal(push1Json.data.objects[0].version, 1);
  assert.equal(push1Json.data.objects[0].fieldVersions.length, 2);

  // 拉取
  const pull = await fetch(`${ctx.base}/api/v1/sync/pull`, {
    method: "POST",
    headers: headers(ctx),
    body: JSON.stringify({}),
  });
  const pullJson = (await pull.json()) as { data: { objects: Array<{ key: string; contentB64: string }> } };
  const obj = pullJson.data.objects.find((o) => o.key === "config/settings.json");
  assert.ok(obj);
  assert.equal(Buffer.from(obj.contentB64, "base64").toString("utf8"), settings);

  // 快速前进：baseSha256 == 服务器当前 sha
  const push2 = await fetch(`${ctx.base}/api/v1/sync/push`, {
    method: "POST",
    headers: headers(ctx),
    body: JSON.stringify({
      changes: [
        {
          kind: "config",
          key: "config/settings.json",
          baseSha256: "sha1",
          sha256: "sha2",
          contentB64: b64(JSON.stringify({ theme: "light", defaultProvider: "deepseek" })),
          jsonFields: [{ path: "theme", valueJson: JSON.stringify("light"), version: 2 }],
        },
      ],
    }),
  });
  const push2Json = (await push2.json()) as { data: { objects: Array<{ version: number }> } };
  assert.equal(push2Json.data.objects[0].version, 2);
});

test("config concurrent edit -> field-level merge + conflict", async (t) => {
  const ctx = await boot();
  t.after(async () => { await ctx.stop(); });
  t.after(async () => { await ctx.stop(); });
  const base = JSON.stringify({ theme: "dark", compaction: { enabled: true } });
  await fetch(`${ctx.base}/api/v1/sync/push`, {
    method: "POST",
    headers: headers(ctx),
    body: JSON.stringify({
      changes: [
        {
          kind: "config",
          key: "config/settings.json",
          baseSha256: null,
          sha256: "s0",
          contentB64: b64(base),
          jsonFields: [
            { path: "theme", valueJson: JSON.stringify("dark"), version: 1 },
            { path: "compaction.enabled", valueJson: "true", version: 1 },
          ],
        },
      ],
    }),
  });

  // 设备 A：改 theme（version 2）；设备 B：改 compaction.enabled（version 2）
  const hbB = await fetch(`${ctx.base}/api/v1/devices/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify({ deviceId: "", name: "dev-b", platform: "linux", piVersion: "0.83.0", extensionVersion: "0.1.0" }),
  });
  const hbBJson = (await hbB.json()) as { data: { deviceId: string } };
  const headersB = headers(ctx, { "x-device-id": hbBJson.data.deviceId, "x-device-name": "dev-b" });

  // B 推送（并发：baseSha256 用的是旧哈希 s0）
  const pushB = await fetch(`${ctx.base}/api/v1/sync/push`, {
    method: "POST",
    headers: headersB,
    body: JSON.stringify({
      changes: [
        {
          kind: "config",
          key: "config/settings.json",
          baseSha256: "s0",
          sha256: "sb",
          contentB64: b64(JSON.stringify({ theme: "dark", compaction: { enabled: false } })),
          jsonFields: [{ path: "compaction.enabled", valueJson: "false", version: 2 }],
        },
      ],
    }),
  });
  const pushBJson = (await pushB.json()) as { data: { objects: Array<{ contentB64: string; fieldVersions: unknown[] }>; conflicts: unknown[] } };
  const mergedB = JSON.parse(Buffer.from(pushBJson.data.objects[0].contentB64, "base64").toString("utf8"));
  assert.equal(mergedB.compaction.enabled, false);
  assert.equal(mergedB.theme, "dark");
  assert.equal(pushBJson.data.conflicts.length, 0);

  // A 推送（并发，改 theme）
  const pushA = await fetch(`${ctx.base}/api/v1/sync/push`, {
    method: "POST",
    headers: headers(ctx),
    body: JSON.stringify({
      changes: [
        {
          kind: "config",
          key: "config/settings.json",
          baseSha256: "s0",
          sha256: "sa",
          contentB64: b64(JSON.stringify({ theme: "light", compaction: { enabled: true } })),
          jsonFields: [{ path: "theme", valueJson: JSON.stringify("light"), version: 2 }],
        },
      ],
    }),
  });
  const pushAJson = (await pushA.json()) as { data: { objects: Array<{ contentB64: string }>; conflicts: Array<{ path: string }> } };
  const mergedA = JSON.parse(Buffer.from(pushAJson.data.objects[0].contentB64, "base64").toString("utf8"));
  assert.equal(mergedA.theme, "light");
  assert.equal(mergedA.compaction.enabled, false); // B 的修改被保留
  assert.equal(pushAJson.data.conflicts.length, 0);

});

test("same-field concurrent edit -> conflict recorded", async (t) => {
  const ctx = await boot();
  t.after(async () => { await ctx.stop(); });
  t.after(async () => { await ctx.stop(); });
  await fetch(`${ctx.base}/api/v1/sync/push`, {
    method: "POST",
    headers: headers(ctx),
    body: JSON.stringify({
      changes: [
        {
          kind: "config",
          key: "config/keybindings.json",
          baseSha256: null,
          sha256: "k0",
          contentB64: b64(JSON.stringify({ "quit": "ctrl+c" })),
          jsonFields: [{ path: "quit", valueJson: JSON.stringify("ctrl+c"), version: 1 }],
        },
      ],
    }),
  });

  // A 与 B 同时改 quit 字段（version 相同）
  const hbB = await fetch(`${ctx.base}/api/v1/devices/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify({ deviceId: "", name: "dev-b", platform: "linux", piVersion: "0.83.0", extensionVersion: "0.1.0" }),
  });
  const hbBJson = (await hbB.json()) as { data: { deviceId: string } };
  const headersB = headers(ctx, { "x-device-id": hbBJson.data.deviceId, "x-device-name": "dev-b" });

  await fetch(`${ctx.base}/api/v1/sync/push`, {
    method: "POST",
    headers: headersB,
    body: JSON.stringify({
      changes: [
        {
          kind: "config",
          key: "config/keybindings.json",
          baseSha256: "k0",
          sha256: "kb",
          contentB64: b64(JSON.stringify({ quit: "ctrl+d" })),
          jsonFields: [{ path: "quit", valueJson: JSON.stringify("ctrl+d"), version: 2 }],
        },
      ],
    }),
  });

  const pushA = await fetch(`${ctx.base}/api/v1/sync/push`, {
    method: "POST",
    headers: headers(ctx),
    body: JSON.stringify({
      changes: [
        {
          kind: "config",
          key: "config/keybindings.json",
          baseSha256: "k0",
          sha256: "ka",
          contentB64: b64(JSON.stringify({ quit: "ctrl+q" })),
          jsonFields: [{ path: "quit", valueJson: JSON.stringify("ctrl+q"), version: 2 }],
        },
      ],
    }),
  });
  const pushAJson = (await pushA.json()) as { data: { conflicts: Array<{ path: string; deviceA: string; deviceB: string }> } };
  assert.ok(pushAJson.data.conflicts.length >= 1);
  assert.equal(pushAJson.data.conflicts[0].path, "quit");

  // 冲突列表
  const list = await fetch(`${ctx.base}/api/v1/conflicts`, {
    headers: { authorization: "Bearer test-token" },
  });
  const listJson = (await list.json()) as { data: Array<{ id: number; resolution: string | null }> };
  assert.ok(listJson.data.length >= 1);

});

test("session push merge: two devices append entries, no duplicates", async (t) => {
  const ctx = await boot();
  t.after(async () => { await ctx.stop(); });
  t.after(async () => { await ctx.stop(); });
  const uuid = "sess-uuid-1";
  const entry = (id: string, parent: string | null, text: string) => ({
    id,
    parentId: parent,
    lineJson: JSON.stringify({
      type: "message",
      id,
      parentId: parent,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: text },
    }),
  });

  const push1 = await fetch(`${ctx.base}/api/v1/sessions/push`, {
    method: "POST",
    headers: headers(ctx),
    body: JSON.stringify({
      sessions: [
        {
          uuid,
          cwd: "/proj",
          baseVersion: 0,
          entries: [entry("e1", null, "hi from A")],
          mtime: Date.now(),
        },
      ],
    }),
  });
  const push1Json = (await push1.json()) as { data: { sessions: Array<{ acceptedEntries: number; entryIds: string[] }> } };
  assert.equal(push1Json.data.sessions[0].acceptedEntries, 1);

  // 设备 B 追加
  const hbB = await fetch(`${ctx.base}/api/v1/devices/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify({ deviceId: "", name: "dev-b", platform: "linux", piVersion: "0.83.0", extensionVersion: "0.1.0" }),
  });
  const hbBJson = (await hbB.json()) as { data: { deviceId: string } };
  const headersB = headers(ctx, { "x-device-id": hbBJson.data.deviceId, "x-device-name": "dev-b" });

  const push2 = await fetch(`${ctx.base}/api/v1/sessions/push`, {
    method: "POST",
    headers: headersB,
    body: JSON.stringify({
      sessions: [
        {
          uuid,
          cwd: "/proj",
          baseVersion: 1,
          entries: [entry("e2", "e1", "reply from B")],
          mtime: Date.now(),
        },
      ],
    }),
  });
  const push2Json = (await push2.json()) as { data: { sessions: Array<{ acceptedEntries: number; entryIds: string[] }> } };
  assert.equal(push2Json.data.sessions[0].acceptedEntries, 1);
  assert.deepEqual(push2Json.data.sessions[0].entryIds.sort(), ["e1", "e2"]);

  // 拉取完整会话
  const pull = await fetch(`${ctx.base}/api/v1/sessions/pull`, {
    method: "POST",
    headers: headers(ctx),
    body: JSON.stringify({}),
  });
  const pullJson = (await pull.json()) as { data: { sessions: Array<{ uuid: string; lines: string[] }> } };
  const sess = pullJson.data.sessions.find((s) => s.uuid === uuid);
  assert.ok(sess);
  assert.equal(sess.lines.length, 2);

});

test("session duplicate entry id with different content -> newer wins, no dup", async (t) => {
  const ctx = await boot();
  t.after(async () => { await ctx.stop(); });
  t.after(async () => { await ctx.stop(); });
  const uuid = "sess-uuid-2";
  const mk = (id: string, parent: string | null, ts: string, text: string) => ({
    id,
    parentId: parent,
    lineJson: JSON.stringify({
      type: "message",
      id,
      parentId: parent,
      timestamp: ts,
      message: { role: "user", content: text },
    }),
  });

  await fetch(`${ctx.base}/api/v1/sessions/push`, {
    method: "POST",
    headers: headers(ctx),
    body: JSON.stringify({
      sessions: [{ uuid, cwd: "/p", baseVersion: 0, entries: [mk("e1", null, "2024-01-01T00:00:00.000Z", "old")], mtime: 1 }],
    }),
  });

  const push2 = await fetch(`${ctx.base}/api/v1/sessions/push`, {
    method: "POST",
    headers: headers(ctx),
    body: JSON.stringify({
      sessions: [{ uuid, cwd: "/p", baseVersion: 0, entries: [mk("e1", null, "2024-01-02T00:00:00.000Z", "new")], mtime: 2 }],
    }),
  });
  const push2Json = (await push2.json()) as { data: { sessions: Array<{ entryIds: string[] }> } };
  assert.deepEqual(push2Json.data.sessions[0].entryIds, ["e1"]);

  const pull = await fetch(`${ctx.base}/api/v1/sessions/pull`, {
    method: "POST",
    headers: headers(ctx),
    body: JSON.stringify({}),
  });
  const pullJson = (await pull.json()) as { data: { sessions: Array<{ lines: string[] }> } };
  const line = pullJson.data.sessions[0].lines[0];
  assert.ok(line.includes("new"));

});

test("admin token management", async (t) => {
  const ctx = await boot();
  t.after(async () => { await ctx.stop(); });
  t.after(async () => { await ctx.stop(); });
  // 无管理令牌 → 401
  const denied = await fetch(`${ctx.base}/api/v1/admin/tokens`, {
    method: "GET",
    headers: { authorization: "Bearer test-token" },
  });
  assert.equal(denied.status, 401);

  // 创建令牌
  const created = await fetch(`${ctx.base}/api/v1/admin/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer admin-token" },
    body: JSON.stringify({ name: "laptop" }),
  });
  const createdJson = (await created.json()) as { data: { token: string } };
  assert.ok(createdJson.data.token.length > 20);

  // 新令牌可用
  const ok = await fetch(`${ctx.base}/api/v1/health`, {
    headers: { authorization: `Bearer ${createdJson.data.token}` },
  });
  assert.equal(ok.status, 200);

});


test("auth.json smart merge: different providers union", async (t) => {
  const ctx = await boot();
  t.after(async () => { await ctx.stop(); });

  const pushAuth = (devId: string, devName: string, content: unknown, fields: Array<{ path: string; valueJson: string; version: number }>) =>
    fetch(`${ctx.base}/api/v1/sync/push`, {
      method: "POST",
      headers: headers(ctx, { "x-device-id": devId, "x-device-name": devName }),
      body: JSON.stringify({
        changes: [{
          kind: "config",
          key: "config/auth.json",
          baseSha256: null,
          sha256: "a0",
          contentB64: b64(JSON.stringify(content)),
          jsonFields: fields,
        }],
      }),
    });

  const hbA = await fetch(`${ctx.base}/api/v1/devices/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify({ deviceId: "", name: "dev-a", platform: "linux", piVersion: "1", extensionVersion: "1" }),
  });
  const idA = ((await hbA.json()) as { data: { deviceId: string } }).data.deviceId;

  await pushAuth(idA, "dev-a", { deepseek: { type: "api_key", key: "sk-a" } }, [
    { path: "deepseek", valueJson: JSON.stringify({ type: "api_key", key: "sk-a" }), version: 1 },
  ]);

  const hbB = await fetch(`${ctx.base}/api/v1/devices/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify({ deviceId: "", name: "dev-b", platform: "linux", piVersion: "1", extensionVersion: "1" }),
  });
  const idB = ((await hbB.json()) as { data: { deviceId: string } }).data.deviceId;

  const pushB = await pushAuth(idB, "dev-b", { openai: { type: "api_key", key: "sk-b" } }, [
    { path: "openai", valueJson: JSON.stringify({ type: "api_key", key: "sk-b" }), version: 1 },
  ]);
  const mergedB = JSON.parse(Buffer.from(((await pushB.json()) as { data: { objects: Array<{ contentB64: string }> } }).data.objects[0].contentB64, "base64").toString("utf8"));
  assert.equal(mergedB.deepseek.key, "sk-a");
  assert.equal(mergedB.openai.key, "sk-b");

  const pullA = await fetch(`${ctx.base}/api/v1/sync/pull`, {
    method: "POST",
    headers: headers(ctx),
    body: JSON.stringify({ keys: ["config/auth.json"] }),
  });
  const pullAJson = (await pullA.json()) as { data: { objects: Array<{ contentB64: string }> } };
  const mergedA = JSON.parse(Buffer.from(pullAJson.data.objects[0].contentB64, "base64").toString("utf8"));
  assert.equal(mergedA.deepseek.key, "sk-a");
  assert.equal(mergedA.openai.key, "sk-b");
});

test("auth.json smart merge: same provider same version api_key -> conflict", async (t) => {
  const ctx = await boot();
  t.after(async () => { await ctx.stop(); });

  const pushAuth = (devId: string, devName: string, content: unknown, fields: Array<{ path: string; valueJson: string; version: number }>) =>
    fetch(`${ctx.base}/api/v1/sync/push`, {
      method: "POST",
      headers: headers(ctx, { "x-device-id": devId, "x-device-name": devName }),
      body: JSON.stringify({
        changes: [{
          kind: "config",
          key: "config/auth.json",
          baseSha256: null,
          sha256: "a0",
          contentB64: b64(JSON.stringify(content)),
          jsonFields: fields,
        }],
      }),
    });

  const hbA = await fetch(`${ctx.base}/api/v1/devices/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify({ deviceId: "", name: "dev-a", platform: "linux", piVersion: "1", extensionVersion: "1" }),
  });
  const idA = ((await hbA.json()) as { data: { deviceId: string } }).data.deviceId;
  const hbB = await fetch(`${ctx.base}/api/v1/devices/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify({ deviceId: "", name: "dev-b", platform: "linux", piVersion: "1", extensionVersion: "1" }),
  });
  const idB = ((await hbB.json()) as { data: { deviceId: string } }).data.deviceId;

  await pushAuth(idA, "dev-a", { deepseek: { type: "api_key", key: "sk-old" } }, [
    { path: "deepseek", valueJson: JSON.stringify({ type: "api_key", key: "sk-old" }), version: 1 },
  ]);

  const pushB = await pushAuth(idB, "dev-b", { deepseek: { type: "api_key", key: "sk-new" } }, [
    { path: "deepseek", valueJson: JSON.stringify({ type: "api_key", key: "sk-new" }), version: 1 },
  ]);
  const pushBJson = (await pushB.json()) as { data: { objects: Array<{ contentB64: string }>; conflicts: Array<{ path: string }> } };
  assert.ok(pushBJson.data.conflicts.length >= 1);
  assert.equal(pushBJson.data.conflicts[0].path, "deepseek");
  const merged = JSON.parse(Buffer.from(pushBJson.data.objects[0].contentB64, "base64").toString("utf8"));
  assert.equal(merged.deepseek.key, "sk-old");
});

test("auth.json smart merge: oauth later expires wins", async (t) => {
  const ctx = await boot();
  t.after(async () => { await ctx.stop(); });

  const pushAuth = (devId: string, devName: string, content: unknown, fields: Array<{ path: string; valueJson: string; version: number }>) =>
    fetch(`${ctx.base}/api/v1/sync/push`, {
      method: "POST",
      headers: headers(ctx, { "x-device-id": devId, "x-device-name": devName }),
      body: JSON.stringify({
        changes: [{
          kind: "config",
          key: "config/auth.json",
          baseSha256: null,
          sha256: "a0",
          contentB64: b64(JSON.stringify(content)),
          jsonFields: fields,
        }],
      }),
    });

  const hbA = await fetch(`${ctx.base}/api/v1/devices/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify({ deviceId: "", name: "dev-a", platform: "linux", piVersion: "1", extensionVersion: "1" }),
  });
  const idA = ((await hbA.json()) as { data: { deviceId: string } }).data.deviceId;
  const hbB = await fetch(`${ctx.base}/api/v1/devices/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify({ deviceId: "", name: "dev-b", platform: "linux", piVersion: "1", extensionVersion: "1" }),
  });
  const idB = ((await hbB.json()) as { data: { deviceId: string } }).data.deviceId;

  await pushAuth(idA, "dev-a", { codex: { type: "oauth", access: "a1", refresh: "r1", expires: 1000 } }, [
    { path: "codex", valueJson: JSON.stringify({ type: "oauth", access: "a1", refresh: "r1", expires: 1000 }), version: 1 },
  ]);

  const pushB = await pushAuth(idB, "dev-b", { codex: { type: "oauth", access: "a2", refresh: "r2", expires: 9999999 } }, [
    { path: "codex", valueJson: JSON.stringify({ type: "oauth", access: "a2", refresh: "r2", expires: 9999999 }), version: 1 },
  ]);
  const pushBJson = (await pushB.json()) as { data: { objects: Array<{ contentB64: string }>; conflicts: unknown[] } };
  assert.equal(pushBJson.data.conflicts.length, 0);
  const merged = JSON.parse(Buffer.from(pushBJson.data.objects[0].contentB64, "base64").toString("utf8"));
  assert.equal(merged.codex.access, "a2");

  const pushB2 = await pushAuth(idB, "dev-b", { codex: { type: "oauth", access: "a3", refresh: "r3", expires: 500 } }, [
    { path: "codex", valueJson: JSON.stringify({ type: "oauth", access: "a3", refresh: "r3", expires: 500 }), version: 2 },
  ]);
  const pushB2Json = (await pushB2.json()) as { data: { objects: Array<{ contentB64: string }>; conflicts: unknown[] } };
  assert.ok(pushB2Json.data.conflicts.length >= 1);
  const merged2 = JSON.parse(Buffer.from(pushB2Json.data.objects[0].contentB64, "base64").toString("utf8"));
  assert.equal(merged2.codex.access, "a2");
});


test("pull honors includeSessions flag (server load reduction)", async (t) => {
  const ctx = await boot();
  t.after(async () => { await ctx.stop(); });

  // 推送一个会话
  await fetch(`${ctx.base}/api/v1/sessions/push`, {
    method: "POST",
    headers: headers(ctx),
    body: JSON.stringify({
      sessions: [{
        uuid: "inc-sess",
        cwd: "/p",
        baseVersion: 0,
        entries: [{
          id: "e1",
          parentId: null,
          lineJson: JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "2024-01-01T00:00:00.000Z", message: { role: "user", content: "x" } }),
        }],
        mtime: 1,
      }],
    }),
  });

  // includeSessions=false → 不返回会话
  const pull1 = await fetch(`${ctx.base}/api/v1/sync/pull`, {
    method: "POST",
    headers: headers(ctx),
    body: JSON.stringify({ includeSessions: false }),
  });
  const j1 = (await pull1.json()) as { data: { sessions: unknown[] } };
  assert.equal(j1.data.sessions.length, 0);

  // includeSessions=true → 返回会话
  const pull2 = await fetch(`${ctx.base}/api/v1/sync/pull`, {
    method: "POST",
    headers: headers(ctx),
    body: JSON.stringify({ includeSessions: true }),
  });
  const j2 = (await pull2.json()) as { data: { sessions: Array<{ uuid: string }> } };
  assert.equal(j2.data.sessions.length, 1);
  assert.equal(j2.data.sessions[0].uuid, "inc-sess");

  // since 增量：只返回之后更新的
  const pull3 = await fetch(`${ctx.base}/api/v1/sync/pull`, {
    method: "POST",
    headers: headers(ctx),
    body: JSON.stringify({ includeSessions: true, since: Date.now() }),
  });
  const j3 = (await pull3.json()) as { data: { sessions: unknown[] } };
  assert.equal(j3.data.sessions.length, 0);
});

test("web stats: aggregate usage by day/model/device + filters", async (t) => {
  const ctx = await boot();
  t.after(async () => { await ctx.stop(); });

  const usageEntry = (id: string, ts: string, role: string, model: string, usage: unknown, provider = "test-provider") => ({
    id,
    parentId: null,
    lineJson: JSON.stringify({
      type: "message",
      id,
      parentId: null,
      timestamp: ts,
      message: { role, provider, model, content: "usage " + id, usage },
    }),
  });
  const pushSessions = async (deviceName: string, sessions: unknown[]) => {
    const heartbeat = await fetch(`${ctx.base}/api/v1/devices/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ deviceId: deviceName === "dev-a" ? ctx.deviceId : "", name: deviceName, platform: "linux", piVersion: "0.83.0", extensionVersion: "0.1.0" }),
    });
    const deviceId = ((await heartbeat.json()) as { data: { deviceId: string } }).data.deviceId;
    return fetch(`${ctx.base}/api/v1/sessions/push`, {
      method: "POST",
      headers: headers(ctx, { "x-device-id": deviceId, "x-device-name": deviceName }),
      body: JSON.stringify({ sessions }),
    });
  };

  await pushSessions("dev-a", [{
    uuid: "stats-sess-a",
    cwd: "/proj-a",
    baseVersion: 0,
    entries: [
      usageEntry("a1", "2025-06-01T10:00:00.000Z", "assistant", "model-x", { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 165, cost: { total: 0.001 } }),
      usageEntry("a2", "2025-06-02T10:00:00.000Z", "toolResult", "model-y", { input: 200, output: 100, cacheRead: 20, cacheWrite: 10, totalTokens: 330, cost: { total: 0.01 } }),
    ],
    mtime: Date.now(),
  }]);

  await pushSessions("dev-b", [{
    uuid: "stats-sess-b",
    cwd: "/proj-b",
    baseVersion: 0,
    entries: [
      usageEntry("b1", "2025-06-02T12:00:00.000Z", "assistant", "model-x", { input: 50, output: 25, cacheRead: 5, cacheWrite: 0, totalTokens: 80, cost: { total: 0.0005 } }),
    ],
    mtime: Date.now(),
  }]);

  // 聚合（全部客户端）
  const all = await fetch(`${ctx.base}/api/v1/web/stats?days=all`, {
    headers: { authorization: "Bearer test-token" },
  });
  const allJson = (await all.json()) as {
    data: {
      summary: { requests: number; input: number; output: number; totalTokens: number; cost: number; sessions: number; devices: number };
      byDay: Array<{ date: string; total: number }>;
      byModel: Array<{ model: string; total: number; cost: number }>;
      byDevice: Array<{ device: string; total: number }>;
      devices: Array<{ deviceId: string; name: string }>;
      models: string[];
    };
  };
  assert.equal(allJson.data.summary.requests, 3);
  assert.equal(allJson.data.summary.input, 350);
  assert.equal(allJson.data.summary.output, 175);
  assert.equal(allJson.data.summary.totalTokens, 575);
  assert.equal(Math.round(allJson.data.summary.cost * 100000) / 100000, 0.0115);
  assert.equal(allJson.data.summary.sessions, 2);
  assert.equal(allJson.data.summary.devices, 2);
  assert.deepEqual(allJson.data.byDay.map((d) => d.date), ["2025-06-01", "2025-06-02"]);
  assert.equal(allJson.data.byDay[1].total, 410);
  // 按总量降序：model-y(330) > model-x(245)
  assert.deepEqual(allJson.data.byModel.map((m) => m.model), ["model-y", "model-x"]);
  assert.deepEqual(allJson.data.byDevice.map((d) => d.device).sort(), ["dev-a", "dev-b"]);
  assert.ok(allJson.data.devices.some((device) => device.name === "dev-a"));
  assert.ok(allJson.data.models.includes("model-y"));

  // 按设备过滤
  const devA = await fetch(`${ctx.base}/api/v1/web/stats?days=all&device=dev-a`, {
    headers: { authorization: "Bearer test-token" },
  });
  const devAJson = (await devA.json()) as { data: { summary: { requests: number; totalTokens: number } } };
  assert.equal(devAJson.data.summary.requests, 2);
  assert.equal(devAJson.data.summary.totalTokens, 495);

  // 按模型过滤
  const modelX = await fetch(`${ctx.base}/api/v1/web/stats?days=all&model=model-x`, {
    headers: { authorization: "Bearer test-token" },
  });
  const modelXJson = (await modelX.json()) as { data: { summary: { requests: number; totalTokens: number; cost: number } } };
  assert.equal(modelXJson.data.summary.requests, 2);
  assert.equal(modelXJson.data.summary.totalTokens, 245);

  // 时间范围过滤（最近 1 天：无数据）
  const last1d = await fetch(`${ctx.base}/api/v1/web/stats?days=1`, {
    headers: { authorization: "Bearer test-token" },
  });
  const last1dJson = (await last1d.json()) as { data: { summary: { requests: number } } };
  assert.equal(last1dJson.data.summary.requests, 0);

  // 1 天范围按小时聚合；GLM-5.2 的零费用按官方价格估算。
  const now = Date.now();
  await pushSessions("dev-glm", [{
    uuid: "stats-sess-glm",
    cwd: "/proj-glm",
    baseVersion: 0,
    entries: [
      usageEntry("g1", new Date(now - 70 * 60_000).toISOString(), "assistant", "glm-5.2", { input: 1_000_000, output: 0, totalTokens: 1_000_000, cost: { total: 0 } }, "zai-coding-cn"),
      usageEntry("g2", new Date(now - 5 * 60_000).toISOString(), "assistant", "glm-5.2-high", { input: 0, output: 1_000_000, totalTokens: 1_000_000, cost: { total: 0 } }, "zai-coding-cn"),
      usageEntry("u1", new Date(now - 2 * 60_000).toISOString(), "assistant", "", { input: 10, output: 0, totalTokens: 10, cost: { total: 0 } }),
    ],
    mtime: now,
  }]);
  const hourly = await fetch(`${ctx.base}/api/v1/web/stats?days=1`, { headers: headers(ctx) });
  const hourlyJson = (await hourly.json()) as { data: { summary: { cost: number }; byHour: Array<{ date: string; total: number }> } };
  assert.equal(hourlyJson.data.byHour.length, 2);
  assert.match(hourlyJson.data.byHour[0].date, /^\d{4}-\d{2}-\d{2} \d{2}:00$/);
  assert.equal(Math.round(hourlyJson.data.summary.cost * USD_CNY_REFERENCE), 36);

  const unknown = await fetch(`${ctx.base}/api/v1/web/stats?days=1&model=${encodeURIComponent("(unknown)")}`, { headers: headers(ctx) });
  const unknownJson = (await unknown.json()) as { data: { summary: { requests: number; totalTokens: number } } };
  assert.equal(unknownJson.data.summary.requests, 1);
  assert.equal(unknownJson.data.summary.totalTokens, 10);

  const glmDetail = await fetch(`${ctx.base}/api/v1/web/sessions/stats-sess-glm`, { headers: headers(ctx) });
  const glmDetailJson = (await glmDetail.json()) as { data: { entries: Array<{ id: string; usage?: { cost: number } }> } };
  const glmEntry = glmDetailJson.data.entries.find((entry) => entry.id === "g1");
  assert.equal(Math.round((glmEntry?.usage?.cost ?? 0) * USD_CNY_REFERENCE), 8);

  // 未认证 → 401
  const denied = await fetch(`${ctx.base}/api/v1/web/stats`);
  assert.equal(denied.status, 401);
});

test("web sessions: server pagination, readable messages and bulk content pruning", async (t) => {
  const ctx = await boot();
  t.after(async () => { await ctx.stop(); });

  const push = (sessions: unknown[]) => fetch(`${ctx.base}/api/v1/sessions/push`, {
    method: "POST",
    headers: headers(ctx),
    body: JSON.stringify({ sessions }),
  });
  const message = (id: string, role: string, content: unknown, usage?: unknown) => ({
    id,
    parentId: null,
    lineJson: JSON.stringify({
      type: "message",
      id,
      parentId: null,
      timestamp: "2025-07-01T10:00:00.000Z",
      message: { role, provider: "provider-a", model: "model-a", content, usage },
    }),
  });

  await push([
    {
      uuid: "readable-a",
      cwd: "/secret/project-a",
      name: "Alpha",
      baseVersion: 0,
      entries: [
        message("u1", "user", "# 问题\n\n请给出答案"),
        message("a1", "assistant", [
          { type: "toolCall", name: "shell", arguments: { command: "secret" } },
          { type: "text", text: "**最终答案**" },
        ], { input: 10, output: 5, totalTokens: 15, cost: { total: 0.01 } }),
        message("t1", "toolResult", [{ type: "text", text: "HUGE TOOL OUTPUT" }], {
          input: 20, output: 5, totalTokens: 25, cost: { total: 0.02 },
        }),
        message("a2", "assistant", [{ type: "toolCall", name: "shell" }], {
          input: 3, output: 2, totalTokens: 5, cost: { total: 0.003 },
        }),
      ],
      mtime: Date.now(),
    },
    { uuid: "readable-b", cwd: "/b", name: "Beta", baseVersion: 0, entries: [message("u2", "user", "B")], mtime: Date.now() },
    { uuid: "readable-c", cwd: "/c", name: "Gamma", baseVersion: 0, entries: [message("u3", "user", "C")], mtime: Date.now() },
  ]);

  const page = await fetch(`${ctx.base}/api/v1/web/sessions?page=2&limit=2&status=active&sort=name-asc`, {
    headers: { authorization: `Bearer ${ctx.token}` },
  });
  const pageJson = (await page.json()) as {
    data: { items: Array<{ uuid: string }>; page: number; pageSize: number; total: number; totalPages: number };
  };
  assert.equal(pageJson.data.total, 3);
  assert.equal(pageJson.data.totalPages, 2);
  assert.equal(pageJson.data.page, 2);
  assert.deepEqual(pageJson.data.items.map((item) => item.uuid), ["readable-c"]);

  const detail = await fetch(`${ctx.base}/api/v1/web/sessions/readable-a?limit=1&offset=1`, {
    headers: { authorization: `Bearer ${ctx.token}` },
  });
  const detailJson = (await detail.json()) as {
    data: {
      total: number;
      rawTotal: number;
      entries: Array<{ role: string; text: string }>;
      byModel: Array<{ model: string; requests: number; input: number; output: number; total: number; cost: number }>;
    };
  };
  assert.equal(detailJson.data.rawTotal, 4);
  assert.equal(detailJson.data.total, 2);
  assert.equal(detailJson.data.entries.length, 1);
  assert.equal(detailJson.data.entries[0].role, "assistant");
  assert.equal(detailJson.data.entries[0].text, "**最终答案**");
  assert.ok(!JSON.stringify(detailJson.data).includes("HUGE TOOL OUTPUT"));
  assert.ok(!JSON.stringify(detailJson.data).includes("调用工具"));
  // byModel：本会话三条用量记录均为 model-a，按模型聚合
  assert.equal(detailJson.data.byModel.length, 1);
  assert.equal(detailJson.data.byModel[0].model, "model-a");
  assert.equal(detailJson.data.byModel[0].requests, 3);
  assert.equal(detailJson.data.byModel[0].input, 33);
  assert.equal(detailJson.data.byModel[0].output, 12);
  assert.equal(detailJson.data.byModel[0].total, 45);

  const beforeStats = await fetch(`${ctx.base}/api/v1/web/stats?days=all`, {
    headers: { authorization: `Bearer ${ctx.token}` },
  });
  const beforeStatsJson = (await beforeStats.json()) as { data: { summary: { requests: number; totalTokens: number; cost: number } } };
  assert.equal(beforeStatsJson.data.summary.requests, 3);
  assert.equal(beforeStatsJson.data.summary.totalTokens, 45);

  const deleted = await fetch(`${ctx.base}/api/v1/web/sessions/delete`, {
    method: "POST",
    headers: headers(ctx),
    body: JSON.stringify({ uuids: ["readable-a"], confirm: true }),
  });
  const deletedJson = (await deleted.json()) as { data: { pruned: number; usageRows: number } };
  assert.equal(deletedJson.data.pruned, 1);
  assert.equal(deletedJson.data.usageRows, 3);

  const prunedDetail = await fetch(`${ctx.base}/api/v1/web/sessions/readable-a`, {
    headers: { authorization: `Bearer ${ctx.token}` },
  });
  const prunedJson = (await prunedDetail.json()) as {
    data: {
      deleted: boolean;
      contentPruned: boolean;
      cwd: string;
      name: string | null;
      total: number;
      rawTotal: number;
      usageSummary: { requests: number; totalTokens: number; cost: number };
    };
  };
  assert.equal(prunedJson.data.deleted, true);
  assert.equal(prunedJson.data.contentPruned, true);
  assert.equal(prunedJson.data.cwd, "");
  assert.equal(prunedJson.data.name, null);
  assert.equal(prunedJson.data.total, 0);
  assert.equal(prunedJson.data.rawTotal, 0);
  assert.equal(prunedJson.data.usageSummary.requests, 3);
  assert.equal(prunedJson.data.usageSummary.totalTokens, 45);

  const afterStats = await fetch(`${ctx.base}/api/v1/web/stats?days=all`, {
    headers: { authorization: `Bearer ${ctx.token}` },
  });
  const afterStatsJson = (await afterStats.json()) as { data: { summary: { requests: number; totalTokens: number; cost: number } } };
  assert.deepEqual(afterStatsJson.data.summary, beforeStatsJson.data.summary);

  const stalePush = await push([{
    uuid: "readable-a",
    cwd: "/secret/revived",
    name: "Should not revive",
    baseVersion: 1,
    entries: [message("u-secret", "user", "must not return")],
    mtime: Date.now(),
  }]);
  const staleJson = (await stalePush.json()) as { data: { sessions: Array<{ deleted: boolean; acceptedEntries: number }> } };
  assert.equal(staleJson.data.sessions[0].deleted, true);
  assert.equal(staleJson.data.sessions[0].acceptedEntries, 0);

  const restore = await fetch(`${ctx.base}/api/v1/sessions/restore`, {
    method: "POST",
    headers: headers(ctx),
    body: JSON.stringify({ uuid: "readable-a" }),
  });
  const restoreJson = (await restore.json()) as { data: { restored: boolean } };
  assert.equal(restoreJson.data.restored, false, "正文已裁剪的会话不可伪恢复");
});

test("sync v2 and devices: cursor deltas, independent usage, permanent merge and reactivation", async (t) => {
  const ctx = await boot();
  t.after(async () => { await ctx.stop(); });

  const sourceHeartbeat = await fetch(`${ctx.base}/api/v1/devices/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ctx.token}` },
    body: JSON.stringify({
      deviceId: "",
      name: "old-laptop",
      platform: "win32",
      piVersion: "0.83.0",
      extensionVersion: "0.2.0",
    }),
  });
  const sourceDeviceId = ((await sourceHeartbeat.json()) as { data: { deviceId: string } }).data.deviceId;
  const sourceHeaders = headers(ctx, { "x-device-id": sourceDeviceId, "x-device-name": "old-laptop" });
  const lineJson = JSON.stringify({
    type: "message",
    id: "v2-entry-1",
    parentId: null,
    timestamp: "2026-08-06T00:00:00.000Z",
    message: {
      role: "assistant",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      content: [{ type: "text", text: "v2 result" }],
      usage: { input: 100, output: 20, totalTokens: 120, cost: { total: 0.01 } },
    },
  });

  const push = await fetch(`${ctx.base}/api/v2/sessions/push`, {
    method: "POST",
    headers: sourceHeaders,
    body: JSON.stringify({
      sessions: [{
        uuid: "v2-merge-session",
        cwd: "/old/device/project",
        name: "Incremental v2",
        headerJson: JSON.stringify({ type: "session", id: "v2-merge-session", cwd: "/old/device/project" }),
        createdAt: Date.now(),
        baseVersion: 0,
        entries: [{ id: "v2-entry-1", parentId: null, lineJson }],
        mtime: Date.now(),
      }],
      usageEvents: [{
        id: "auto-name-1",
        sessionUuid: "v2-merge-session",
        occurredAt: Date.now(),
        provider: "deepseek",
        model: "deepseek-v4-flash",
        input: 12,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 16,
        cost: 0.001,
      }],
    }),
  });
  assert.equal(push.status, 200);
  const pushJson = (await push.json()) as {
    data: { sessions: Array<Record<string, unknown> & { acceptedEntries: number }>; acceptedUsageEvents: number };
  };
  assert.equal(pushJson.data.sessions[0].acceptedEntries, 1);
  assert.equal(pushJson.data.acceptedUsageEvents, 1);
  assert.equal("entryIds" in pushJson.data.sessions[0], false, "v2 响应不得随历史返回 entryIds");

  const pull = await fetch(`${ctx.base}/api/v2/sessions/pull`, {
    method: "POST",
    headers: sourceHeaders,
    body: JSON.stringify({ cursor: 0, limit: 10, maxBytes: 1024 * 1024 }),
  });
  const pullJson = (await pull.json()) as {
    data: { changes: Array<{ seq: number; kind: string; uuid?: string }>; nextCursor: number; hasMore: boolean };
  };
  assert.ok(pullJson.data.changes.some((change) => change.kind === "header"));
  assert.ok(pullJson.data.changes.some((change) => change.kind === "entry" && change.uuid === "v2-merge-session"));
  assert.ok(pullJson.data.nextCursor > 0);
  assert.equal(pullJson.data.hasMore, false);

  const noChanges = await fetch(`${ctx.base}/api/v2/sessions/pull`, {
    method: "POST",
    headers: sourceHeaders,
    body: JSON.stringify({ cursor: pullJson.data.nextCursor, limit: 10 }),
  });
  const noChangesJson = (await noChanges.json()) as { data: { changes: unknown[]; nextCursor: number; hasMore: boolean } };
  assert.deepEqual(noChangesJson.data.changes, []);
  assert.equal(noChangesJson.data.nextCursor, pullJson.data.nextCursor);
  assert.equal(noChangesJson.data.hasMore, false);

  const rename = await fetch(`${ctx.base}/api/v1/devices/${ctx.deviceId}`, {
    method: "PATCH",
    headers: headers(ctx),
    body: JSON.stringify({ name: "new-desktop" }),
  });
  assert.equal(rename.status, 200);

  const preview = await fetch(`${ctx.base}/api/v1/devices/merge/preview`, {
    method: "POST",
    headers: headers(ctx),
    body: JSON.stringify({ sourceDeviceIds: [sourceDeviceId], targetDeviceId: ctx.deviceId }),
  });
  const previewJson = (await preview.json()) as {
    data: { affected: { sessions: number; entries: number; usageRows: number }; onlineWarning: boolean };
  };
  assert.equal(previewJson.data.affected.sessions, 1);
  assert.equal(previewJson.data.affected.entries, 1);
  assert.equal(previewJson.data.affected.usageRows, 2, "正文用量和 AI 命名用量均参与迁移");
  assert.equal(previewJson.data.onlineWarning, true);

  const wrongConfirm = await fetch(`${ctx.base}/api/v1/devices/merge`, {
    method: "POST",
    headers: headers(ctx),
    body: JSON.stringify({
      sourceDeviceIds: [sourceDeviceId],
      targetDeviceId: ctx.deviceId,
      confirmTargetName: "wrong-name",
    }),
  });
  assert.equal(wrongConfirm.status, 400);

  const merge = await fetch(`${ctx.base}/api/v1/devices/merge`, {
    method: "POST",
    headers: headers(ctx),
    body: JSON.stringify({
      sourceDeviceIds: [sourceDeviceId],
      targetDeviceId: ctx.deviceId,
      confirmTargetName: "new-desktop",
    }),
  });
  assert.equal(merge.status, 200);

  const devices = await fetch(`${ctx.base}/api/v1/devices`, { headers: headers(ctx) });
  const devicesJson = (await devices.json()) as {
    data: Array<{
      deviceId: string;
      name: string;
      status: string;
      mergedInto: string | null;
      entryCount: number;
      totalTokens: number;
    }>;
  };
  const sourceAfterMerge = devicesJson.data.find((device) => device.deviceId === sourceDeviceId)!;
  const targetAfterMerge = devicesJson.data.find((device) => device.deviceId === ctx.deviceId)!;
  assert.equal(sourceAfterMerge.status, "merged");
  assert.equal(sourceAfterMerge.mergedInto, ctx.deviceId);
  assert.equal(sourceAfterMerge.entryCount, 0);
  assert.equal(sourceAfterMerge.totalTokens, 0);
  assert.equal(targetAfterMerge.name, "new-desktop");
  assert.equal(targetAfterMerge.entryCount, 1);
  assert.equal(targetAfterMerge.totalTokens, 136);

  const reactivate = await fetch(`${ctx.base}/api/v1/devices/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ctx.token}` },
    body: JSON.stringify({
      deviceId: sourceDeviceId,
      name: "old-laptop-online-again",
      platform: "win32",
      piVersion: "0.84.0",
      extensionVersion: "0.2.1",
    }),
  });
  const reactivateJson = (await reactivate.json()) as { data: { deviceId: string; name: string; reactivated: boolean } };
  assert.equal(reactivateJson.data.deviceId, sourceDeviceId);
  assert.equal(reactivateJson.data.name, "old-laptop-online-again");
  assert.equal(reactivateJson.data.reactivated, true);

  const warmStats1 = await fetch(`${ctx.base}/api/v1/web/stats?days=all`, { headers: headers(ctx) });
  assert.equal(warmStats1.headers.get("x-pi-sync-cache"), null);
  const warmStats2 = await fetch(`${ctx.base}/api/v1/web/stats?days=all`, { headers: headers(ctx) });
  assert.equal(warmStats2.headers.get("x-pi-sync-cache"), "hit");

  const newUsage = await fetch(`${ctx.base}/api/v2/sessions/push`, {
    method: "POST",
    headers: headers(ctx, { "x-device-id": sourceDeviceId, "x-device-name": "old-laptop-online-again" }),
    body: JSON.stringify({
      sessions: [],
      usageEvents: [{
        id: "after-reactivation",
        sessionUuid: "new-session-after-reactivation",
        occurredAt: Date.now(),
        provider: "deepseek",
        model: "deepseek-v4-flash",
        input: 5,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 6,
        cost: 0.0001,
      }],
    }),
  });
  assert.equal(newUsage.status, 200);

  const invalidatedStats = await fetch(`${ctx.base}/api/v1/web/stats?days=all`, { headers: headers(ctx) });
  assert.equal(invalidatedStats.headers.get("x-pi-sync-cache"), null, "写入后热点缓存必须立即失效");

  const finalDevices = await fetch(`${ctx.base}/api/v1/devices`, { headers: headers(ctx) });
  const finalDevicesJson = (await finalDevices.json()) as { data: Array<{ deviceId: string; status: string; totalTokens: number }> };
  const reactivatedDevice = finalDevicesJson.data.find((device) => device.deviceId === sourceDeviceId)!;
  const historicalTarget = finalDevicesJson.data.find((device) => device.deviceId === ctx.deviceId)!;
  assert.equal(reactivatedDevice.status, "active");
  assert.equal(reactivatedDevice.totalTokens, 6, "重新上线后的新用量回到旧 deviceId");
  assert.equal(historicalTarget.totalTokens, 136, "已迁移历史不会自动回迁");
});
