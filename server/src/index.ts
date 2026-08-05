import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SyncDb } from "./db.js";
import { loadConfig } from "./config.js";
import { verifyToken, verifyAdminToken, type TokenRecord } from "./auth.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerSyncRoutes } from "./routes/sync.js";
import { registerConflictRoutes } from "./routes/conflicts.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerWebRoutes } from "./routes/web.js";

export async function startServer(cfg = loadConfig()) {
  const app = Fastify({
    logger: { level: process.env.SYNC_LOG_LEVEL ?? "info" },
    bodyLimit: 64 * 1024 * 1024, // 64MB
  });
  const dbs = new SyncDb(cfg.dbPath);
  const startedAt = Date.now();

  const tokenProvider = (): TokenRecord[] =>
    dbs.db
      .prepare(`SELECT id, name, token_hash, created_at FROM tokens`)
      .all() as unknown as TokenRecord[];

  // 认证中间件：/api/v1/* 需要 Bearer token；/api/v1/admin/* 需要管理令牌
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/api/v1/")) {
      if (req.url.startsWith("/api/v1/admin/")) {
        if (!verifyAdminToken(cfg.adminToken, req.headers.authorization)) {
          return reply
            .code(401)
            .send({ ok: false, error: "UNAUTHORIZED", message: "admin token required" });
        }
        return;
      }
      if (req.url === "/api/v1/health") return;
      if (!verifyToken(tokenProvider, cfg.tokens, req.headers.authorization)) {
        return reply
          .code(401)
          .send({ ok: false, error: "UNAUTHORIZED", message: "invalid or missing token" });
      }
    }
  });

  app.get("/", async () => ({
    name: "pi-cloud-sync server",
    health: "/api/v1/health",
    dashboard: "/web",
    docs: "see docs/protocol.md",
    time: Date.now(),
  }));

  // 网页看板（静态页面）
  let webHtml = "";
  try {
    const moduleDir = fileURLToPath(new URL(".", import.meta.url));
    webHtml = readFileSync(join(moduleDir, "..", "static", "web.html"), "utf8");
  } catch {
    try {
      webHtml = readFileSync(join(process.cwd(), "static", "web.html"), "utf8");
    } catch {
      // ignore
    }
  }
  app.get("/web", async (_req, reply) => {
    reply.type("text/html; charset=utf-8");
    if (!webHtml) {
      return reply.code(404).send("web.html not found — rebuild the server");
    }
    return reply.send(webHtml);
  });

  registerHealthRoute(app, dbs, startedAt);
  registerDeviceRoutes(app, dbs);
  registerSyncRoutes(app, dbs, cfg);
  registerConflictRoutes(app, dbs);
  registerAdminRoutes(app, dbs);
  registerWebRoutes(app, dbs);

  await app.listen({ host: cfg.host, port: cfg.port });
  app.log.info(
    `pi-cloud-sync server listening on http://${cfg.host}:${cfg.port} (data: ${cfg.dataDir})`,
  );
  if (cfg.adminToken) {
    app.log.info(`Admin API protected (SYNC_ADMIN_TOKEN set)`);
  }

  const shutdown = async () => {
    app.log.info("shutting down...");
    dbs.close();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { app, dbs, cfg };
}

/**
 * 判断当前模块是否作为应用入口被直接运行。
 * - node dist/index.js：argv[1] 是本文件 → 匹配
 * - pm2 fork 模式：pm2 通过 ProcessContainerFork 包装器加载本模块，argv[1] 是包装器路径，
 *   但 PM2_HOME 环境变量存在，且本模块就是被托管的应用入口 → 也应启动
 * - 被测试/其他模块 import：两者都不成立 → 不启动
 */
function isMainEntry(): boolean {
  const a1 = process.argv[1];
  if (!a1) return false;
  if (import.meta.url === pathToFileURL(a1).href) return true;
  if (a1.endsWith("dist/index.js")) return true;
  if (process.env.PM2_HOME) return true;
  return false;
}

// 直接运行时启动（node dist/index.js / pm2 托管）
if (isMainEntry()) {
  startServer().catch((err) => {
    console.error("failed to start server:", err);
    process.exit(1);
  });
}
