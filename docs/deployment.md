# 部署指南 / Deployment Guide

自托管同步服务器支持两种部署方式：直接 Node 运行或 Docker（推荐）。服务器只需一个进程 + 一个 SQLite 文件，资源占用极低。

## 方式一：Docker + docker compose（推荐）

```bash
cd server
# 编辑 docker-compose.yml，设置 SYNC_TOKEN（访问令牌）与 SYNC_ADMIN_TOKEN（管理令牌）
docker compose up -d --build
docker compose logs -f sync-server   # 查看日志
```

> 不设置 `SYNC_TOKEN` 时，首次启动会自动生成令牌并打印/保存到 `data/token.txt`。

## 方式二：Node 直接运行

```bash
cd server
npm install
npm run build
cp .env.example .env   # 编辑 .env 设置令牌
npm start
```

## 方式三：pm2 进程管理（推荐生产环境）

```bash
cd server
npm install && npm run build

# 配置 .env（SYNC_TOKEN / SYNC_ADMIN_TOKEN）
cp .env.example .env

# 启动（pm2 生态配置：自动重启、内存保护、日志轮转）
npm run pm2:start          # 等价 pm2 start ecosystem.config.cjs

# 常用管理命令
npm run pm2:status         # pm2 status
npm run pm2:logs           # pm2 logs pi-cloud-sync
npm run pm2:restart        # 重启
npm run pm2:stop           # 停止
npm run pm2:delete         # 删除进程
pm2 save                   # 保存进程列表
pm2 startup                # 开机自启（按提示执行生成的命令）
```

日志输出到 `server/logs/{out,error}.log`，数据（SQLite + token）在 `server/data/`。

## 反向代理 + TLS（可选但推荐）

服务器只监听 HTTP；生产环境建议用 Caddy / Nginx 加 TLS：

```bash
# Caddyfile 示例（自动 HTTPS）
sync.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

部署后浏览器访问 `https://sync.example.com/web` 即可打开内置 **Web 控制台**（会话浏览 / 用量趋势 / 设备管理 / 冲突解决），输入访问令牌登录。

## 令牌管理

访问令牌是客户端连接凭证。两种方式获取：

1. 启动时设置 `SYNC_TOKEN`（或读取 `data/token.txt`）。
2. 通过管理 API 创建/撤销多个客户端令牌（需 `SYNC_ADMIN_TOKEN`）：

```bash
# 创建令牌（每个设备一个，便于审计）
curl -X POST http://localhost:8787/api/v1/admin/tokens \
  -H "Authorization: Bearer <SYNC_ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-laptop"}'
# => {"ok":true,"data":{"name":"my-laptop","token":"<TOKEN>"}}

curl http://localhost:8787/api/v1/admin/tokens \
  -H "Authorization: Bearer <SYNC_ADMIN_TOKEN>"   # 令牌列表
curl -X DELETE http://localhost:8787/api/v1/admin/tokens/<id> \
  -H "Authorization: Bearer <SYNC_ADMIN_TOKEN>"   # 撤销令牌
```

## 健康检查 / 统计

```bash
curl http://localhost:8787/api/v1/health            # 健康
curl http://localhost:8787/api/v1/admin/stats \
  -H "Authorization: Bearer <SYNC_ADMIN_TOKEN>"     # 对象/会话/冲突/设备数量
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `SYNC_HOST` | `0.0.0.0` | 监听地址 |
| `SYNC_PORT` | `8787` | 监听端口 |
| `SYNC_DATA_DIR` | `./data` | 数据目录（sync.db、token.txt） |
| `SYNC_TOKEN` | 自动生成 | 访问令牌（逗号分隔可多个） |
| `SYNC_ADMIN_TOKEN` | 空 | 管理令牌（不设则管理 API 不可用） |
| `SYNC_MAX_BATCH` | `5000` | 单会话最大条目数 |
| `SYNC_MAX_OBJECT_BYTES` | `10485760` | 单对象最大字节 |
| `SYNC_PUBLIC_URL` | 空 | 对外 URL（仅用于文档展示） |
| `SYNC_LOG_LEVEL` | `info` | 日志级别 |

> **运行环境**：Node.js 20+（fastify 5 要求）；服务器依赖 `better-sqlite3` 原生模块，首次安装需要编译工具链（或使用 Docker 镜像）。

## 常见问题

- **客户端 401**：检查令牌是否一致（服务器 `data/token.txt` vs 客户端 `~/.pi/agent/pi-sync.json`）。
- **端口占用**：修改 `SYNC_PORT` 并同步更新反向代理。
- **数据库迁移**：SQLite 文件自动迁移，升级无需手工操作；升级前建议备份 `data/sync.db`。
- **Web 控制台打不开**：确认使用域名/HTTPS 访问 `/web`，且反向代理未拦截 `/api/v1/web/*`。
- **升级服务器依赖**：fastify 5 需配套 `@fastify/compress` v8+，`npm install` 时请勿降级。
