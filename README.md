<div align="center">

# pi-cloud-sync

**Self-hosted cloud sync + usage statistics for the [pi coding agent](https://pi.dev)**

自托管云同步 + 用量统计插件（Server + Extension 一体）

</div>

---

## ✨ Features / 功能

| | 云同步 / Cloud Sync | 用量统计 / Usage Stats |
|---|---|---|
| 🔄 | 配置文件同步（settings / keybindings / models…）<br/>Config file sync (field-level smart merge) | 实时 Token/费用采集（事件驱动）<br/>Live token & cost collection (event-driven) |
| 💬 | 会话同步：跨设备合并、来源设备标注、软删除恢复<br/>Session sync: cross-device merge, provenance, tombstone restore | 会话文件扫描补齐历史数据<br/>Session file scan for historical backfill |
| 📦 | 插件信息：包清单并集合并 + 自动安装、自定义扩展文件同步<br/>Package manifest union-merge + auto install, custom extension files | 多维聚合：时间 / 模型 / 会话<br/>Aggregate by time / model / session |
| 🧠 | **智能冲突处理**：JSON 字段级合并 + 冲突记录与解决<br/>**Smart conflicts**: field-level JSON merge + record & resolve | 表格 / JSON / CSV / Markdown 导出<br/>Table / JSON / CSV / Markdown export |
| 🔐 | 自托管服务器（Node + SQLite）、Bearer Token、设备注册<br/>Self-hosted server, bearer token auth, device registry | 数据存本地 `pi-stats.jsonl`，无第三方<br/>Local `pi-stats.jsonl`, zero third-party |

---

## 🏗️ Architecture / 架构

```
┌─────────────┐   HTTPS + Bearer Token   ┌──────────────────┐
│  Device A   │ ───────────────────────► │   Sync Server    │
│  pi + ext   │ ◄─────────────────────── │  Node + SQLite   │
└─────────────┘    /api/v1/sync/*        └──────────────────┘
┌─────────────┐              ▲
│  Device B   │ ─────────────┘
│  pi + ext   │
└─────────────┘

repo/
├── extension/    # pi 扩展（零运行时依赖，自包含）
├── server/       # 自托管同步服务器（Fastify + better-sqlite3）
├── shared/       # 协议类型（server 使用）
└── docs/         # 架构 / 协议 / 部署文档
```

---

## 🚀 Quick Start / 快速开始

### 1. Deploy the server / 部署服务器

<details>
<summary><b>Docker (recommended / 推荐)</b></summary>

```bash
git clone https://github.com/<your-user>/pi-cloud-sync.git
cd pi-cloud-sync/server
# 编辑 docker-compose.yml，设置 SYNC_TOKEN 与 SYNC_ADMIN_TOKEN
docker compose up -d --build
```
</details>

<details>
<summary><b>pm2 (Node)</b></summary>

```bash
cd server
npm install && npm run build
cp .env.example .env        # 设置 SYNC_TOKEN / SYNC_ADMIN_TOKEN
npm run pm2:start           # pm2 托管：自动重启、内存保护、日志
```

Get your access token / 获取访问令牌：`cat data/token.txt`（自动生成）或管理 API 创建。
</details>

详见 [docs/deployment.md](docs/deployment.md)。

### 2. Install the extension / 安装插件

```bash
# Git 安装（推荐，便于更新） / via git (recommended)
pi install git:github.com/<your-user>/pi-cloud-sync

# 或本地路径 / or local path
pi install /path/to/pi-cloud-sync/extension

# 或临时试用 / quick test
pi -e ./extension/src/index.ts
```

### 3. Configure / 配置

```bash
# 交互式配置（服务器地址、令牌、设备名、自动同步开关）
/sync config

# 或命令行 / or CLI
/sync config import https://sync.example.com <TOKEN>
/sync config set deviceName my-laptop
```

配置保存在 `~/.pi/agent/pi-sync.json`：

```jsonc
{
  "deviceName": "my-laptop",                       // 当前设备名（来源标注）/ device name
  "server": { "url": "https://sync.example.com", "token": "..." },
  "sync": {
    "automatic": true,                             // 自动同步 / auto sync
    "onStartup": "pull",                           // 启动时拉取 / pull on start
    "onShutdown": "push",                          // 退出时推送 / push on exit
    "scopes": { "config": true, "sessions": true, "plugins": true },
    "includeConfigs": ["settings.json", "keybindings.json", "models.json"],
    "autoInstallPackages": true,                   // 自动安装缺失包 / auto-install packages
    "pruneTombstonesAfterDays": 30
  },
  "stats": { "collect": true }
}
```

### 4. Sync / 同步

```bash
/sync now          # 完整同步（先拉后推）full sync
/sync push         # 推送本地变更 push local changes
/sync pull         # 拉取远端变更 pull remote changes
/sync status       # 查看状态 view status
/sync conflicts    # 查看冲突 view conflicts
/sync conflicts resolve 3 keep-b   # 解决冲突 resolve conflict
/sync devices      # 设备列表 list devices
/sync find <query> # 跨项目搜索会话 search sessions across projects
/sync restore <uuid>  # 恢复已删除会话 restore deleted session
```

### 5. Web dashboard / 网页看板

部署好服务器后，浏览器访问 `https://<你的域名>/web`，输入访问令牌即可查看：

- 全部同步会话列表（名称 / 项目路径 / 消息数 / 来源设备 / 更新时间）
- 会话对话内容（用户 / 助手 / 工具调用，含模型与 token/费用）
- 搜索、已删除会话标记、分页浏览

令牌只保存在浏览器 localStorage，数据全部走服务器 API。

---

## 🧠 Conflict Resolution / 冲突处理

**JSON 配置文件**（如 `settings.json`）采用**字段级智能合并**：

- 每台设备记录每个 JSON 字段的版本号；推送时只发送变更字段。
- 服务器逐字段合并：版本高者胜；双方都改且同版本不同值 → 记录冲突，等待解决。
- 包清单（`packages` 数组）自动**并集合并**：多设备各自安装的包互不覆盖。

**非 JSON 文件**（如扩展 `.ts`）：按修改时间 LWW，旧版本存为冲突记录，不静默丢失。

**会话**：按 entry id 合并去重，每条记录来源设备；删除为软删除，可 `restore`。

---

## 📊 Usage Statistics / 用量统计

```bash
/usage                # 汇总：按天 / 按模型 / 按会话 Top
/usage 7d             # 近 7 天
/usage current        # 当前会话明细
/usage --json         # JSON 导出
/usage --csv          # CSV 导出
/usage --md           # Markdown 导出
/usage --save=report.md --top=20
/usage live           # 开关实时采集
```

```
═══ 用量统计 Usage Report ═══
总 Token: 1.2M  (输入 800.0k / 输出 350.0k / 缓存读 50.0k / 缓存写 10.0k)
总费用: $12.3456   请求数: 3,214   会话数: 87
数据来源: live 3,200 条 / session scan 1,500 条 (共 4,700 条使用)

─ 按模型 By Model ─
| Label          |  Input | Output | CacheR | CacheW | Total |    Cost | Req |
|----------------+--------+--------+--------+--------+-------+---------+-----|
| claude-sonnet  | 500.0k | 200.0k |  30.0k |   5.0k | 735k | $8.0000 | 1900|
| deepseek-v4    | 300.0k | 150.0k |  20.0k |   5.0k | 475k | $4.3000 | 1314|
```

数据双通道：**实时采集**（消息事件 → `~/.pi/agent/pi-stats.jsonl`，会话清理后仍完整）
+ **会话扫描**（解析历史 `.jsonl` 补齐，自动去重）。费用直接采用 pi 计算的成本。

---

## 🧪 Development / 开发

```bash
npm install
npm run typecheck     # 类型检查（shared / server / extension）
npm test              # 全部测试（server 8 + extension 7，含端到端双设备同步）
```

## 🔒 Security / 安全

- 服务器仅监听 HTTP，生产环境请使用反向代理 + TLS（见部署文档）。
- Bearer Token 认证；管理端点需要独立的 `SYNC_ADMIN_TOKEN`。
- 扩展文件同步含路径穿越防护；token 明文存库，请勿与公网共享数据库。

## 📄 Docs / 文档

- [docs/architecture.md](docs/architecture.md) — 架构设计
- [docs/protocol.md](docs/protocol.md) — 同步协议
- [docs/deployment.md](docs/deployment.md) — 部署指南（Docker / pm2）

## License

MIT
