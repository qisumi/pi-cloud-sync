import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, loadState, saveState } from "../src/config.js";
import { buildConfigChanges, applyMergedConfig, sha256 } from "../src/sync/configs.js";
import { scanLocalSessions, buildSessionChanges, applyPulledSessions, encodeCwdPath, searchLocalSessions } from "../src/sync/sessions.js";
import { UsageCollector } from "../src/stats/collector.js";
import { scanSessionFile, mergeRecords, buildReport } from "../src/stats/analyzer.js";
import { formatReport } from "../src/stats/report.js";
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
  assert.equal(state.sessions[uuid].pushed.length, 2);

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
  assert.ok(text.includes("Total"));
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
  assert.equal(cfg.version, 4);
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
  assert.equal(cfg.version, 4);
  // 已持久化
  const reread = JSON.parse(readFileSync(join(dir, "pi-sync.json"), "utf8"));
  assert.ok(reread.sync.includeConfigs.includes("auth.json"));
});
