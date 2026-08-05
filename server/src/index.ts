import Fastify from "fastify";
import { SyncDb } from "./db.js";
import { loadConfig } from "./config.js";
import { verifyToken, verifyAdminToken, type TokenRecord } from "./auth.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerSyncRoutes } from "./routes/sync.js";
import { registerConflictRoutes } from "./routes/conflicts.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerAdminRoutes } from "./routes/admin.js";

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
    docs: "see docs/protocol.md",
    time: Date.now(),
  }));

  registerHealthRoute(app, dbs, startedAt);
  registerDeviceRoutes(app, dbs);
  registerSyncRoutes(app, dbs, cfg);
  registerConflictRoutes(app, dbs);
  registerAdminRoutes(app, dbs);

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

// 直接运行时启动（node dist/index.js）
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("dist/index.js")) {
  startServer().catch((err) => {
    console.error("failed to start server:", err);
    process.exit(1);
  });
}
