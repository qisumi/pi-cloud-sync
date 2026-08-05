import type { FastifyInstance } from "fastify";
import type { SyncDb } from "../db.js";
import { now } from "../db.js";
import { SYNC_PROTOCOL_VERSION } from "@pi-cloud-sync/shared";

export function registerHealthRoute(app: FastifyInstance, dbs: SyncDb, startedAt: number) {
  app.get("/api/v1/health", async () => ({
    ok: true,
    data: {
      status: "healthy",
      version: "0.1.0",
      protocol: SYNC_PROTOCOL_VERSION,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      time: now(),
    },
  }));

  app.get("/health", async () => ({ status: "ok" }));
}
