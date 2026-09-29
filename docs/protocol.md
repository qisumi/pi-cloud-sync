# 同步协议 / Sync Protocol (v2)

所有请求使用 JSON；除 `/api/v1/health` 外，`/api/v1/*` 与 `/api/v2/*` 均需 `Authorization: Bearer <token>`。
推送会话/对象时需携带 `X-Device-Id` 与 `X-Device-Name` 请求头（设备注册与来源标注）。

## 数据模型

- **objects**：配置/扩展文件/包清单，key 如 `config/settings.json`、`plugin/extension/foo.ts`、`plugin/package-manifest`。
- **config_field_versions**：JSON 对象的字段级版本表（`object_key, path, version, value, updated_by`）。
- **session_headers / session_entries / session_usage**：会话头、条目和预聚合用量（entry id 去重，稳定 deviceId 来源标注）。
- **session_change_index**：会话 header / entry / tombstone 的单调变更游标。
- **devices / device_merge_history**：稳定设备身份、历史来源与永久合并审计。
- **conflicts**：未解决/已解决的冲突记录。

## 字段级合并规则（JSON 配置）

1. 客户端保存每个对象的上次推送哈希 `baseSha256` 与字段版本表。
2. 推送时携带 `baseSha256` 与变更字段 `jsonFields: [{path, valueJson, version}]`。
3. **字段删除**：本地删除某字段时，`valueJson` 传 `null`（JSON null）作为删除标记；
   真实的 JSON null 值传字符串 `"null"`，二者无歧义（`valueJson: undefined` 会在
   JSON 序列化时被丢弃，严禁使用）。服务器按版本规则采纳删除或记冲突，
   已删除字段不再出现在响应 `fieldVersions` 中。
4. 服务器判断：
   - `baseSha256 == 服务器 sha256` → 快速前进，整体应用。
   - 否则逐字段比较 `version`：版本高者胜；数组字段版本相同 → 并集合并（如包清单）；同版本不同值 → 记入 `conflicts`，服务器值保留。
5. 拉取响应包含合并后内容与完整字段版本映射，客户端持久化用于下次 diff。

## 设备删除（退役）

不再使用的设备（如卖掉的笔记本）可删除：`DELETE /api/v1/devices/:id`（body `confirmName` 必须与设备名一致）。

- 会话/条目/用量行**不迁移、不删除**，保留原 `device_id`；
- 设备置为 `retired` 并记录 `retired_at`，从「当前设备」列表与统计筛选中隐藏；
- `/api/v1/web/stats` 的设备分布把退役设备（含无主用量行）归并为虚拟桶 `__other__`（显示名「其他设备」），可用 `deviceId=__other__` 筛选；
- 已退役设备再次心跳不会复活（不占用合并语义的 reactivated），需要时在 Web 控制台「已删除」筛选中 `POST /api/v1/devices/:id/restore` 恢复；
- 已合并（merged）设备也可退役：其历史已迁移到目标设备，退役仅清理设备列表展示；
- 与 merge 的区别：merge 把历史永久改写到目标设备；retire 保留原归属，仅展示层归并，可随时恢复。

## 端到端示例

```
POST /api/v1/devices/heartbeat          # 注册/心跳 → { deviceId }
POST /api/v1/sync/push                  # { changes: [{kind,key,baseSha256,jsonFields?,contentB64?,sha256?,mtime?}] }
POST /api/v1/sync/pull                  # { since?, keys? } → { objects, sessions, packageManifest, serverTime }
POST /api/v2/sessions/push              # { sessions, usageEvents? } → { sessions, conflicts, acceptedUsageEvents }
POST /api/v2/sessions/pull              # { cursor, limit, maxBytes } → { changes, nextCursor, hasMore }
GET  /api/v1/conflicts                  # 冲突列表
POST /api/v1/conflicts/:id/resolve      # { resolution: keep-a|keep-b|manual, content? }
POST /api/v1/sessions/restore           # { uuid }
GET  /api/v1/devices                    # 设备列表
PATCH /api/v1/devices/:id               # { name } 重命名
DELETE /api/v1/devices/:id              # { confirmName } 删除（退役）设备，统计归并到「其他设备」
POST /api/v1/devices/:id/restore        # 恢复已退役设备
POST /api/v1/devices/merge/preview      # { sourceDeviceIds, targetDeviceId }
POST /api/v1/devices/merge              # 上述字段 + confirmTargetName，事务化永久合并
GET  /api/v1/health                     # 健康检查
GET  /api/v1/web/sessions               # 网页端会话列表（分页/筛选/搜索）
GET  /api/v1/web/sessions/:uuid         # 会话详情（过滤 tool 消息）
POST /api/v1/web/sessions/delete        # 批量删除会话正文（用量转存独立摘要）
GET  /api/v1/web/stats                  # 用量趋势与模型/设备分布
GET  /api/v1/admin/stats                # 对象/会话/冲突/设备数量
```

`/api/v1/sessions/push|pull` 暂时保留给旧客户端；新客户端必须使用 v2。服务端健康响应的 `protocol` 必须与插件一致，
不匹配时插件停止同步并提示同时升级。

> Web 控制台端点（`/api/v1/web/*`）与同步协议共用 Bearer Token 认证，供浏览器端调用，详见 `docs/architecture.md`。

`/api/v1/web/stats?days=1` 除 `byDay` 外还返回 `byHour`（本地时区的 `YYYY-MM-DD HH:00` 分桶），
供控制台绘制最近 24 小时趋势。Z.AI/智谱渠道上报为零费用的 GLM-5.2/5.3 系列记录按公开按量价估算；
渠道已经上报的非零费用始终优先。

`/api/v1/web/sessions/:uuid` 除分页的 `entries` 与汇总 `usageSummary`（requests/totalTokens/cost/models）外，
还返回 `byModel`（按 model 分组的 requests/input/output/total/cost 明细，按 total 降序），
供会话详情页展示模型分布统计表；即使会话正文被删除（`contentPruned`）该明细仍保留。

## 会话增量与确认

- 客户端按 JSONL 文件保存 `size + mtime + offset + boundaryHash`。未变化文件只执行 `stat`；追加文件只读新增完整行。
- 文件截断、覆盖或边界指纹异常时，客户端从头全量对账；条目仍按 `(uuid, entryId)` 幂等合并。
- 单次推送最多 250 条或约 2 MiB；只有服务端完整确认后才推进文件偏移。
- 拉取按 `session_change_index.seq` 分页。`nextCursor` 只在本地安全写入或进入 `pi-sync-inbox` 后保存。
- `usageEvents` 用于 AI 自动命名等不进入正文的独立用量，服务端按事件 id 幂等写入 `session_usage`。

## 会话条目格式

服务器按 `(uuid, entryId)` 存储精简后的 JSONL 行；相同 entryId 内容不同时保留
`received_at` 较新者并记录冲突。客户端已有的完整本地行优先，远端只补齐缺失条目，避免精简副本覆盖工具输出。

## 设备身份与合并

- `deviceId` 是稳定身份，设备名只是可修改展示属性；统计筛选使用 deviceId。
- 迁移旧库时，唯一名称自动关联现有设备；无匹配或同名歧义会生成 `legacy` 历史来源。
- 合并必须先预览并精确确认目标设备名；服务端在单事务中改写会话、用量、对象、字段版本和冲突来源。
- 源设备标记 `merged`。同一旧 deviceId 再次心跳时恢复为独立设备，但已合并历史不回迁。

## 兼容性与扩展

- 协议版本号 `SYNC_PROTOCOL_VERSION = 2`，扩展端与服务器端强校验。
- 数据库与插件状态自动迁移；旧的 `pushed: entryId[]` 在加载时丢弃，不再随历史增长。
