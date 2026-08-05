import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../server/src/index.js";
import { loadConfig, saveConfig, loadState, saveState } from "../src/config.js";
import { SyncClient } from "../src/client.js";
import { push, pull } from "../src/sync/index.js";
import { encodeCwdPath } from "../src/sync/sessions.js";
import type { ServerConfig } from "../../server/src/config.js";

test("end-to-end: two devices sync config + sessions through real server", async (t) => {
  // --- 启动 server ---
  const dataDir = mkdtempSync(join(tmpdir(), "pi-sync-e2e-"));
  const cfgSrv: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    dbPath: ":memory:",
    tokens: ["e2e-token"],
    adminToken: "admin",
    maxBatchEntries: 5000,
    maxObjectBytes: 1024 * 1024,
    publicUrl: null,
  };
  const { app, dbs } = await startServer({ ...cfgSrv });
  t.after(async () => {
    dbs.close();
    await app.close();
  });
  const addr = app.server.address() as { port: number };
  const base = `http://127.0.0.1:${addr.port}`;

  // --- 设备 A ---
  const dirA = mkdtempSync(join(tmpdir(), "pi-sync-dev-a-"));
  process.env.PI_CODING_AGENT_DIR = dirA;
  const cfgA = loadConfig();
  cfgA.deviceName = "device-a";
  cfgA.server = { url: base, token: "e2e-token", verifyTls: true };
  cfgA.sync.includeConfigs = ["settings.json"];
  saveConfig(cfgA);

  const stateA = loadState();
  stateA.deviceId = "dev-a-id";
  saveState(stateA);

  const clientA = new SyncClient(cfgA, "dev-a-id");
  // 注册设备
  await clientA.heartbeat({ name: "device-a", platform: "win32", piVersion: "0.83.0", extensionVersion: "0.1.0" });

  // 写配置文件 + 一个会话
  mkdirSync(join(dirA, "sessions", encodeCwdPath("C:/proj-a")), { recursive: true });
  const uuid = "e2e-sess";
  const header = JSON.stringify({ type: "session", version: 3, id: uuid, timestamp: "2024-02-01T00:00:00.000Z", cwd: "C:/proj-a" });
  const e1 = JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "2024-02-01T00:00:01.000Z", message: { role: "user", content: "hello from A" } });
  writeFileSync(join(dirA, "settings.json"), JSON.stringify({ theme: "dark" }));
  writeFileSync(join(dirA, "sessions", encodeCwdPath("C:/proj-a"), `100_${uuid}.jsonl`), `${header}\n${e1}\n`);

  // 设备 A 推送
  const reportA = await push(cfgA, loadState(), clientA, "0.83.0", "0.1.0");
  assert.equal(reportA.errors.length, 0, reportA.errors.join("; "));
  assert.ok(reportA.pushed.configs >= 1, "pushed configs");
  assert.ok(reportA.pushed.sessions >= 1, "pushed sessions");

  // --- 设备 B ---
  const dirB = mkdtempSync(join(tmpdir(), "pi-sync-dev-b-"));
  process.env.PI_CODING_AGENT_DIR = dirB;
  const cfgB = loadConfig();
  cfgB.deviceName = "device-b";
  cfgB.server = { url: base, token: "e2e-token", verifyTls: true };
  cfgB.sync.includeConfigs = ["settings.json"];
  saveConfig(cfgB);

  const stateB = loadState();
  stateB.deviceId = "dev-b-id";
  saveState(stateB);
  const clientB = new SyncClient(cfgB, "dev-b-id");
  await clientB.heartbeat({ name: "device-b", platform: "linux", piVersion: "0.83.0", extensionVersion: "0.1.0" });

  // 设备 B 拉取
  const reportB = await pull(cfgB, loadState(), clientB, {});
  assert.equal(reportB.errors.length, 0, reportB.errors.join("; "));
  assert.ok(reportB.pulled.objects >= 1, "pulled objects");
  assert.ok(reportB.pulled.sessions >= 1, "pulled sessions");

  // B 本地应有配置与会话文件
  const settingsB = JSON.parse(readFileSync(join(dirB, "settings.json"), "utf8"));
  assert.equal(settingsB.theme, "dark", "theme synced");
  const sessFilesB = readdirSync(join(dirB, "sessions", encodeCwdPath("C:/proj-a")));
  assert.ok(sessFilesB.some((f) => f.includes(uuid)), "session file on B");

  // --- 设备 B 追加消息，A 拉取 ---
  const sessPathB = join(dirB, "sessions", encodeCwdPath("C:/proj-a"), sessFilesB.find((f) => f.includes(uuid))!);
  const existingB = readFileSync(sessPathB, "utf8");
  const e2 = JSON.stringify({ type: "message", id: "e2", parentId: "e1", timestamp: "2024-02-01T00:00:02.000Z", message: { role: "user", content: "reply from B" } });
  writeFileSync(sessPathB, existingB + e2 + "\n");

  const reportB2 = await push(cfgB, loadState(), clientB, "0.83.0", "0.1.0");
  const confList = await fetch(`${base}/api/v1/conflicts`, { headers: { authorization: "Bearer e2e-token" } }).then((r) => r.json());
  assert.equal(reportB2.errors.length, 0, "B2 errors");

  // A 拉取：会话应包含 e2（且条目数正确，不重复）
  process.env.PI_CODING_AGENT_DIR = dirA; // 切回设备 A 目录
  const reportA2 = await pull(cfgA, loadState(), clientA, {});
  assert.equal(reportA2.errors.length, 0, "A2 errors");
  const sessFileA = join(dirA, "sessions", encodeCwdPath("C:/proj-a"), `100_${uuid}.jsonl`);
  const contentA = readFileSync(sessFileA, "utf8");
  assert.ok(contentA.includes("reply from B"), "B reply merged");
  // 条目不重复：e1 只出现一次（统计 "id":"e1" 而非 parentId 引用）
  const e1Count = contentA.split('"id":"e1"').length - 1;
  assert.equal(e1Count, 1, "no duplicate e1");

  // --- 并发配置修改：A 改 theme，B 改 defaultProvider（同一 base） ---
  // 重置两设备对 settings.json 的本地基线，模拟并发
  process.env.PI_CODING_AGENT_DIR = dirA;
  const stA2 = loadState();
  const key = "config/settings.json";
  if (stA2.objects[key]) stA2.objects[key].baseSha256 = null;
  saveState(stA2);
  process.env.PI_CODING_AGENT_DIR = dirB;
  const stB2 = loadState();
  if (stB2.objects[key]) stB2.objects[key].baseSha256 = null;
  saveState(stB2);

  // B 先推（改 defaultProvider），A 后推（改 theme，base 已过期）→ 字段级合并
  process.env.PI_CODING_AGENT_DIR = dirB;
  writeFileSync(join(dirB, "settings.json"), JSON.stringify({ theme: "dark", defaultProvider: "openai" }));
  const pb = await push(cfgB, loadState(), clientB, "0.83.0", "0.1.0");
  assert.equal(pb.errors.length, 0, "pb errors");

  process.env.PI_CODING_AGENT_DIR = dirA;
  writeFileSync(join(dirA, "settings.json"), JSON.stringify({ theme: "light", defaultProvider: "deepseek" }));
  const pa = await push(cfgA, loadState(), clientA, "0.83.0", "0.1.0");
  // theme 字段 A 版本更高 → A 胜出；defaultProvider 同版本不同值 → 记录冲突（服务器保留 B 的值）
  assert.equal(pa.conflicts, 1, "pa should report 1 conflict");

  // 拉取合并结果：A 的 theme=light 与 B 的 defaultProvider=openai 应同时存在
  process.env.PI_CODING_AGENT_DIR = dirA;
  const finalA = await pull(cfgA, loadState(), clientA, {});
  const pullObj = await fetch(`${base}/api/v1/sync/pull`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer e2e-token", "x-device-id": "dev-a-id" }, body: "{}" }).then((r) => r.json());
  const mergedSettings = JSON.parse(readFileSync(join(dirA, "settings.json"), "utf8"));
  assert.equal(mergedSettings.theme, "light", "theme merged");
  assert.equal(mergedSettings.defaultProvider, "openai", "provider merged");
});
