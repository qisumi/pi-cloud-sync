import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../src/index.js";
import type { ServerConfig } from "../src/config.js";
import type { FastifyInstance } from "fastify";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
