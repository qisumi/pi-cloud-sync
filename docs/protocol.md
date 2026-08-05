# 同步协议 / Sync Protocol (v1)

所有请求使用 JSON；除 `/api/v1/health` 外均需 `Authorization: Bearer <token>`。
推送会话/对象时需携带 `X-Device-Id` 与 `X-Device-Name` 请求头（设备注册与来源标注）。

## 数据模型

- **objects**：配置/扩展文件/包清单，key 如 `config/settings.json`、`plugin/extension/foo.ts`、`plugin/package-manifest`。
- **config_field_versions**：JSON 对象的字段级版本表（`object_key, path, version, value, updated_by`）。
- **session_headers / session_entries**：会话头与条目（entry id 去重，来源设备标注）。
- **conflicts**：未解决/已解决的冲突记录。

## 字段级合并规则（JSON 配置）

1. 客户端保存每个对象的上次推送哈希 `baseSha256` 与字段版本表。
2. 推送时携带 `baseSha256` 与变更字段 `jsonFields: [{path, valueJson, version}]`。
3. 服务器判断：
   - `baseSha256 == 服务器 sha256` → 快速前进，整体应用。
   - 否则逐字段比较 `version`：版本高者胜；数组字段版本相同 → 并集合并（如包清单）；同版本不同值 → 记入 `conflicts`，服务器值保留。
4. 拉取响应包含合并后内容与完整字段版本映射，客户端持久化用于下次 diff。

## 端到端示例

```
POST /api/v1/devices/heartbeat          # 注册/心跳 → { deviceId }
POST /api/v1/sync/push                  # { changes: [{kind,key,baseSha256,jsonFields?,contentB64?,sha256?,mtime?}] }
POST /api/v1/sync/pull                  # { since?, keys? } → { objects, sessions, packageManifest, serverTime }
POST /api/v1/sessions/push              # { sessions: [{uuid,cwd,name?,headerJson?,createdAt?,baseVersion,entries,mtime,deleted?}] }
POST /api/v1/sessions/pull              # { since? } → { sessions: [{uuid,cwd,name,headerJson,createdAt,version,deleted,lines[]}] }
GET  /api/v1/conflicts                  # 冲突列表
POST /api/v1/conflicts/:id/resolve      # { resolution: keep-a|keep-b|manual, content? }
POST /api/v1/sessions/restore           # { uuid }
GET  /api/v1/devices                    # 设备列表
GET  /api/v1/health                     # 健康检查
```

## 会话条目格式

服务器按 `(uuid, entryId)` 存储 JSONL 行原文；相同 entryId 内容不同时保留
`received_at` 较新者并记录冲突。客户端合并时以本地条目优先，服务器条目补齐缺口。

## 兼容性与扩展

- 协议版本号 `SYNC_PROTOCOL_VERSION = 1`，扩展端与服务器端校验。
- 新增字段使用 optional 语义，向后兼容。
