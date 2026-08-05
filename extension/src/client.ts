import type {
  ApiEnvelope,
  ConflictRecord,
  DeviceInfo,
  HeartbeatRequest,
  PullRequest,
  PullResponse,
  PushChange,
  PushResponse,
  SessionChange,
  SessionPullRequestV2,
  SessionPullResponseV2,
  SessionPushResponseV2,
  UsageEventChange,
} from "./types.js";
import type { SyncConfig } from "./config.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export class SyncClient {
  constructor(
    private cfg: SyncConfig,
    private deviceId: string,
  ) {}

  /** 设备注册后更新本实例的 deviceId */
  setDeviceId(deviceId: string): void {
    this.deviceId = deviceId;
  }
  private get baseUrl(): string {
    return this.cfg.server?.url.replace(/\/+$/, "") ?? "";
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.cfg.server?.token ?? ""}`,
      "x-device-id": this.deviceId,
      "x-device-name": this.cfg.deviceName || "unknown",
      ...extra,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    if (!this.cfg.server?.url) throw new ApiError("server not configured", 0);
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 30_000),
    });
    let json: ApiEnvelope<T> | null = null;
    try {
      json = (await res.json()) as ApiEnvelope<T>;
    } catch {
      // non-JSON response
    }
    if (!res.ok || !json?.ok) {
      throw new ApiError(json?.error ?? `HTTP ${res.status}`, res.status, json?.error);
    }
    return json.data as T;
  }

  async heartbeat(info: Omit<HeartbeatRequest, "deviceId">): Promise<{ deviceId: string }> {
    return this.request<{ deviceId: string }>("POST", "/api/v1/devices/heartbeat", {
      deviceId: this.deviceId,
      ...info,
    } satisfies HeartbeatRequest);
  }

  async pushObjects(changes: PushChange[]): Promise<PushResponse> {
    if (changes.length === 0) return { objects: [], conflicts: [], sessions: [] };
    return this.request<PushResponse>("POST", "/api/v1/sync/push", { changes });
  }

  async pull(body: PullRequest, opts?: { timeoutMs?: number }): Promise<PullResponse> {
    return this.request<PullResponse>("POST", "/api/v1/sync/pull", body, opts);
  }

  async pushSessionsV2(sessions: SessionChange[], usageEvents: UsageEventChange[] = []): Promise<SessionPushResponseV2> {
    if (sessions.length === 0 && usageEvents.length === 0) {
      return { sessions: [], conflicts: [], acceptedUsageEvents: 0 };
    }
    return this.request<SessionPushResponseV2>("POST", "/api/v2/sessions/push", { sessions, usageEvents }, {
      timeoutMs: 120_000,
    });
  }

  async pullSessionsV2(body: SessionPullRequestV2): Promise<SessionPullResponseV2> {
    return this.request<SessionPullResponseV2>("POST", "/api/v2/sessions/pull", body, { timeoutMs: 120_000 });
  }

  async restoreSession(uuid: string): Promise<boolean> {
    const r = await this.request<{ restored: boolean }>("POST", "/api/v1/sessions/restore", { uuid });
    return r.restored;
  }

  async listConflicts(): Promise<ConflictRecord[]> {
    return this.request<ConflictRecord[]>("GET", "/api/v1/conflicts");
  }

  async resolveConflict(id: number, resolution: "keep-a" | "keep-b" | "manual", content?: string): Promise<void> {
    await this.request("POST", `/api/v1/conflicts/${id}/resolve`, { resolution, content });
  }

  async listDevices(): Promise<DeviceInfo[]> {
    return this.request<DeviceInfo[]>("GET", "/api/v1/devices");
  }

  async renameDevice(deviceId: string, name: string): Promise<DeviceInfo> {
    return this.request<DeviceInfo>("PATCH", `/api/v1/devices/${encodeURIComponent(deviceId)}`, { name });
  }

  async health(): Promise<{ status: string; version: string; protocol: number }> {
    return this.request<{ status: string; version: string; protocol: number }>("GET", "/api/v1/health");
  }
}
