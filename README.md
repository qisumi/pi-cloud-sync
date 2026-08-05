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
/qisumi-sync-config

# 或命令行 / or CLI
/qisumi-sync-config-import https://sync.example.com <TOKEN>
/qisumi-sync-config-set deviceName my-laptop
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

所有命令以 `/qisumi-sync-` 开头，输入 `/qisumi-` 可自动补全：

```bash
/qisumi-sync-now        # 完整同步（先拉后推）full sync
/qisumi-sync-push       # 推送本地变更 push local changes
/qisumi-sync-pull       # 拉取远端变更 pull remote changes
/qisumi-sync-status     # 查看状态 view status
/qisumi-sync            # 状态（同 status）；help 查看子命令列表
/qisumi-sync-conflicts  # 查看冲突 view conflicts
/qisumi-sync-conflicts-resolve 3 keep-b   # 解决冲突 resolve conflict
/qisumi-sync-devices    # 设备列表 list devices
/qisumi-sync-find <query> # 跨项目搜索会话 search sessions across projects
/qisumi-sync-list       # 列出本地会话
/qisumi-sync-restore <uuid>  # 恢复已删除会话 restore deleted session
/qisumi-sync-config-show    # 查看配置
/qisumi-sync-config-set <key> <value>  # 设置配置项
/qisumi-sync-config-import <url> <token>  # 导入服务器配置
/qisumi-sync-config-reset   # 清除服务器配置
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

**负担优化**：会话同步默认**剥离工具输出与思考过程**（本地文件保持完整，仅同步副本精简，
配置项 `sync.stripToolOutputs` / `sync.stripThinking` 可关）；拉取为增量 + 按需（`includeSessions`）。

---

## 📊 Usage Statistics / 用量统计

默认直接展示**两张表**（近 7 天：分日 + 分模型），非交互直接输出；价格默认人民币 ¥（`stats.currency`，可 `--cny` / `--usd` 临时切换）。
USD→CNY 汇率**运行时自动拉取 [Exchangerate-API](https://www.exchangerate-api.com) 实时汇率**（6 小时缓存），失败回退配置 `stats.usdCnyRate`（默认 6.76）。

```bash
/qisumi-usage            # 默认：近 7 天 · 分日 + 分模型两表 · 非交互直接展示
/qisumi-usage full       # 完整视图：概要 + 按天 + 按模型 + 按会话 Top
/qisumi-usage current    # 当前会话明细
/qisumi-usage 30d        # 近 30 天（today / 7d / 30d / all / Nd）
/qisumi-usage --cny      # 人民币 ¥ 显示（默认）  --usd 美元 $ 显示
/qisumi-usage --json     # JSON 导出
/qisumi-usage --csv      # CSV 导出
/qisumi-usage --md       # Markdown 导出
/qisumi-usage --save=report.md --top=20
/qisumi-usage live       # 开关实时采集
```

```
═══ 用量统计 Usage (近 7 天) ═══
─ 按天 By Day ─
------------+--------+--------+--------+--------+--------+-------+-----
 Label      | Input  | Output | CacheR | CacheW | Total  | Cost  | Req
------------+--------+--------+--------+--------+--------+-------+-----
 2026-08-04 | 181.0k |  90.0k |  25.0k |   1.5k | 296.5k | ¥6.94 |   5
 2026-08-05 | 180.0k |  90.0k |  25.0k |   1.5k | 296.5k | ¥6.58 |   5
------------+--------+--------+--------+--------+--------+-------+-----

─ 按模型 By Model ─
---------+--------+--------+--------+--------+--------+--------+-----
 Label   | Input  | Output | CacheR | CacheW | Total  | Cost   | Req
---------+--------+--------+--------+--------+--------+--------+-----
 glm-4.6 | 721.0k | 350.0k | 140.0k |   7.0k |  1.20M |  ¥1.15 |  21
 gpt-4o  | 560.0k | 280.0k |  35.0k |   3.5k | 878.5k | ¥52.55 |  14
---------+--------+--------+--------+--------+--------+--------+-----
```

---

## 🎚️ Quota Probe / 额度探测

实时探测各 AI 渠道的剩余额度，TUI 模式弹出简洁面板（进度条 + 剩余百分比 + 重置时间 +
与上次探测的消耗对比）。快照记录在本地 `~/.pi/agent/pi-quota.jsonl`。

```bash
/qisumi-quota         # 探测全部渠道（TUI 面板展示）
/qisumi-quota --json  # 输出 JSON（供脚本/自动化）
```

支持渠道与凭据来源：

| 渠道 | 探测内容 | 凭据来源 | 说明 |
| --- | --- | --- | --- |
| **DeepSeek** | 账户余额（金额 ¥/$） | `~/.pi/agent/auth.json` 的 `deepseek`，或 `DEEPSEEK_API_KEY` | 官方 `GET /user/balance` |
| **Z.AI 智谱 GLM Coding Plan** | 5 小时额度 + 周额度（tokens） | auth.json 的 `zai` / `zai-coding-cn` / `z-ai` / `zhipu` / `glm` 等（默认优先），或 `ZAI_CODING_CN_API_KEY` / `ZAI_API_KEY` / `ZHIPU_API_KEY` / `GLM_API_KEY` | 中国区 `open.bigmodel.cn`，全球区可用 `ZAI_BASE_URL` 覆盖 |
| **Codex（OpenAI 订阅）** | 5 小时 + 周额度（% + 重置时间） | `~/.codex/auth.json`（`codex login` 生成） | 访问 ChatGPT 失败（如无 VPN）时**仅标记不可用，不影响其他渠道** |

> 额度面板示例（TUI，紧凑单屏）：
>
> ```
> 额度 Quota · 8月5日 23:26
>  DeepSeek              ● 余额 ¥65.96
>  Z.AI GLM 编程套餐      ████░░░░░░ 剩 60% 3.20M/8.00M · 1时10分后重置
>                        ██████░░░░ 剩 38% 5.00M/8.00M · 3天后重置
>  Codex (OpenAI 订阅)   ✕ network error
>  参考价(¥/百万tokens): DeepSeek V4-Pro 入3/出6/缓存0.025 · Z.AI 智谱 GLM-4.7 入2/出8/缓存0.4
>  对比上次: Z.AI 5h +5%
> ```

---

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
+ **会话扫描**（解析历史 `.jsonl` 补齐，自动去重）。费用直接采用 pi 计算的成本（USD），
显示时优先用 **Exchangerate-API 实时汇率**换算为人民币 ¥，失败回退 `stats.usdCnyRate`（默认 6.76），可用 `--usd` 查看美元原值。

### 💱 参考价格（¥/百万 tokens）

`/quota` 面板会显示一行当前参考价（取各渠道主推模型，官网公开价，仅供估算）：

```
参考价(¥/百万tokens): DeepSeek V4-Pro 入3/出6/缓存0.025 · Z.AI 智谱 GLM-4.7 入2/出8/缓存0.4
```

| 渠道 | 模型 | 输入 ¥/M | 输出 ¥/M | 缓存命中 ¥/M | 备注 |
| --- | --- | --- | --- | --- | --- |
| **DeepSeek**（官方开放平台，2026-05 永久降价） | V4-Pro | 3 | 6 | 0.025 | 高峰时段(9-12/14-18) ×2 |
| | V4-Flash | 1 | 2 | 0.02 | |
| **Z.AI 智谱**（[bigmodel.cn/pricing](https://bigmodel.cn/pricing)，2026-08） | GLM-4.7 | 2 | 8 | 0.4 | ≤32k；32-200k: 入4/出16/缓存0.8 |
| | GLM-5 | 4 | 18 | 1 | ≤32k |
| | GLM-5-Turbo | 5 | 22 | 1.2 | ≤32k |
| | GLM-5.1 | 6 | 24 | 1.3 | ≤32k；32k+: 入8/出28 |
| | GLM-5.2 | 8 | 28 | 2 | 1M 上下文新品 |
| | GLM-4.5-Air | 0.8 | 2 | 0.16 | |
| | GLM-4.7-FlashX | 0.5 | 3 | 0.1 | |
| | GLM-4.7-Flash | 免费 | 免费 | 免费 | |

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
