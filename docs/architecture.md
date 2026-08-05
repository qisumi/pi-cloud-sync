# pi-cloud-sync 架构设计

一个合并的 pi 扩展包，包含 **云同步** 与 **使用统计** 两大功能。Server 端为自托管 Node.js 服务，插件端为 pi 扩展（TypeScript，零运行时依赖）。

## 整体结构

```
┌─────────────┐   HTTPS + Bearer Token   ┌──────────────────┐
│  Device A   │ ───────────────────────► │   Sync Server    │
│  pi + ext   │ ◄─────────────────────── │  Node + SQLite   │
└─────────────┘      /api/v1/sync/*      └──────────────────┘
┌─────────────┐              ▲
│  Device B   │ ─────────────┘
│  pi + ext   │
└─────────────┘
```

## 同步的数据类型（三种 scope）

| Scope | 内容 | 冲突策略 |
|-------|------|----------|
| `config` | settings.json、keybindings.json、models.json 等配置文件 | JSON 字段级智能合并 + 冲突记录；非 JSON 文件 LWW + 冲突副本 |
| `session` | `~/.pi/agent/sessions/**/*.jsonl` 全部会话 | 按 entry id 去重合并，保留来源设备；软删除 tombstone |
| `plugin` | settings.json 中 `packages` 清单 + 本地自定义扩展 `.ts` 文件 | 包清单按 source 合并；扩展文件 LWW |

## 冲突解决：字段级智能合并

### JSON 配置（如 settings.json）

- 每个配置对象有全局版本号 `version` 与内容哈希 `sha256`。
- 每个 JSON 字段路径维护独立的 `fieldVersion` 与来源设备（`config_field_versions` 表）。
- 客户端在 push 时携带 `baseSha256`（它上次看到的服务器内容哈希）与本地变更字段列表。
- 服务器判断：
  - `baseSha256 == server.sha256` → 快速前进（fast-forward），直接应用。
  - 否则 → 并发修改：逐字段比较 `fieldVersion`，版本高者胜出（field-level LWW）；双方都改过且版本相同但值不同 → 记录为冲突，等待用户解决。
- 失败方内容保留在 `conflicts` 表中，可通过 `/sync conflicts` 查看和解决。

### 非 JSON 文件

整体 LWW（按版本号），旧版本自动保存为 `<name>.conflict-<device>` 副本，不静默丢弃。

## 会话合并

- 会话以 header 中的 `uuid` 为主键，跨设备、跨路径可识别。
- 条目以 `(uuid, entryId)` 去重：来自多设备的条目取并集；相同 entryId 内容不同时保留 timestamp 较新者并记录来源。
- 每条 entry 记录 `sourceDevice`，会话文件顶部信息记录 `syncedFrom`。
- 删除采用 tombstone（软删除），其他设备可 `restore`。
- 客户端本地记录每个会话的上次同步游标（已推送的 entryId 集合），push 时只发送增量。

## 设备注册

- 每次同步自动注册/心跳设备（`devices` 表）：设备名、平台、pi 版本、last_seen。
- 设备名在插件配置 `deviceName` 中指定，参与冲突记录与来源标注。

## 同步触发

- 自动：`session_start` 时自动 pull（可配置），`session_shutdown` 时自动 push。
- 手动：`/sync push`、`/sync pull`、`/sync now`。

## 统计功能

### 数据来源（双通道）

1. **实时采集**（主）：`message_end` / `turn_end` / `tool_result` 事件中提取 `usage`，追加写入
   `~/.pi/agent/pi-stats.jsonl`：`{ ts, sessionId, sessionName, project, provider, model, input,
   output, cacheRead, cacheWrite, cost, device }`。会话被清理后统计仍完整。
2. **会话扫描**（补）：解析 `sessions/**/*.jsonl` 中 assistant 消息的 usage、tool result 的嵌套
   usage、compaction 的 usage，用于历史回溯与对账。

### 聚合维度

- 时间：今天 / 近 7 天 / 近 30 天 / 按月，按天分组
- 模型：按 provider/model 汇总 token 与 cost
- 会话：按 session 汇总（Top N），支持当前会话明细
- 汇总：总量、日均、平均每次请求

### 展示

- `/usage` 命令，ASCII 表格输出；支持 `--json` / `--csv` 导出
- `/usage live` 切换实时采集
- footer status：当前会话 token/cost 实时显示（`ctx.ui.setStatus`）

### 计价

通过 `ctx.modelRegistry` 读取模型 `cost`（每百万 token 单价），未知模型按 0 计。

## Server 数据模型（SQLite）

```sql
devices(id TEXT PK, name TEXT, platform TEXT, pi_version TEXT, last_seen INTEGER, created_at INTEGER)
objects(key TEXT PK, kind TEXT, version INTEGER, sha256 TEXT, data TEXT,          -- 非 JSON 文件内容 / JSON 合并结果
        updated_by TEXT, updated_at INTEGER, deleted INTEGER)
config_field_versions(object_key TEXT, path TEXT, version INTEGER, value TEXT,
                      updated_by TEXT, updated_at INTEGER, PK(object_key, path))
session_headers(uuid TEXT PK, cwd TEXT, name TEXT, version INTEGER, deleted INTEGER,
                updated_by TEXT, updated_at INTEGER)
session_entries(session_uuid TEXT, entry_id TEXT, line TEXT, source_device TEXT,
                received_at INTEGER, PRIMARY KEY(session_uuid, entry_id))
conflicts(id INTEGER PK AUTOINCREMENT, object_key TEXT, path TEXT, kind TEXT,
          device_a TEXT, device_b TEXT, content_a TEXT, content_b TEXT,
          resolution TEXT, resolved_at INTEGER, created_at INTEGER)
tokens(id INTEGER PK AUTOINCREMENT, name TEXT, token TEXT UNIQUE, created_at INTEGER)
```

## 同步 API（/api/v1）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/sync/push` | 推送配置/包清单/扩展文件变更，返回合并结果与冲突 |
| POST | `/sync/pull` | 拉取配置对象（含字段版本映射） |
| POST | `/sessions/push` | 推送会话增量条目 |
| POST | `/sessions/pull` | 拉取会话增量（entryId 去重） |
| GET  | `/conflicts` | 冲突列表 |
| POST | `/conflicts/:id/resolve` | 解决冲突（保留 a / 保留 b / 手动内容） |
| GET  | `/devices` | 设备列表 |
| POST | `/devices/heartbeat` | 心跳（push/pull 自动附带） |
| GET  | `/health` | 健康检查 |
| POST | `/admin/tokens` | 创建访问令牌（`ADMIN_TOKEN` 保护） |
| GET  | `/admin/tokens` | 令牌列表 |

## 插件配置（~/.pi/agent/pi-sync.json）

```jsonc
{
  "version": 3,
  "deviceName": "desktop-1",                    // 当前设备名称（来源标注）
  "server": { "url": "https://sync.example.com", "token": "…" },
  "sync": {
    "automatic": true,
    "onStartup": "pull",                        // none | pull
    "onShutdown": "push",                       // none | push
    "scopes": { "config": true, "sessions": true, "plugins": true },
    "includeConfigs": ["settings.json", "keybindings.json", "models.json"],
    "autoInstallPackages": true,
    "pruneTombstonesAfterDays": 30
  },
  "stats": { "collect": true }
}
```
