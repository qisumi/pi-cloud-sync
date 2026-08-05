/** 会话自动命名：独立调用同渠道低价模型，不修改主会话模型。 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai/compat";
import { uuidv7, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { SyncConfig } from "./config.js";

export interface AutoNameUsage {
  sessionId: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

/** 从用户消息文本生成稳定的本地兜底标题。 */
export function summarizeName(text: string, max = 32): string {
  let t = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~#>`]/g, "")
    .replace(/[=\-+[\](){}|\\/]/g, " ")
    .replace(/\s*([：:，,。.、；;！!？?）)])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "（未命名会话）";
  if (t.length > max) t = t.slice(0, Math.max(1, max - 1)) + "…";
  return t;
}

function titleFromResponse(message: AssistantMessage, max: number): string | null {
  if (message.stopReason === "error" || message.stopReason === "aborted") return null;
  const raw = message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  if (!raw || raw.includes("\n") || raw.length > Math.max(80, max * 2)) return null;
  const clean = raw
    .replace(/^[\s"'“”‘’`#*_~-]+|[\s"'“”‘’`#*_~-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || clean.length > max || /^(标题|title)\s*[:：]/i.test(clean)) return null;
  return clean;
}

type CompleteFn = typeof complete;

/** 独立执行一次命名请求；导出便于覆盖超时、无凭据和无效输出测试。 */
export async function generateAiSessionName(
  ctx: ExtensionContext,
  sessionId: string,
  text: string,
  cfg: SyncConfig,
  completeFn: CompleteFn = complete,
): Promise<{ title: string; usage?: AutoNameUsage }> {
  const fallback = summarizeName(text, cfg.session.autoNameMax ?? 32);
  const provider = ctx.model?.provider;
  const modelId = provider ? cfg.session.autoNameModelByProvider?.[provider] : undefined;
  if (!provider || !modelId) return { title: fallback };

  const model = ctx.modelRegistry.find(provider, modelId) as Model<Api> | undefined;
  if (!model) return { title: fallback };
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || (!auth.apiKey && !auth.headers)) return { title: fallback };

  try {
    const message = await completeFn(
      model,
      {
        systemPrompt:
          "为编程助手会话生成一个简短标题。只输出一行、与用户语言一致的标题；不要引号、Markdown、前缀或解释。",
        messages: [{ role: "user", content: text.slice(0, 4000), timestamp: Date.now() }],
        tools: [],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        maxTokens: 64,
        temperature: 0.2,
        cacheRetention: "none",
        sessionId: `pi-sync-autoname-${uuidv7()}`,
        signal: AbortSignal.timeout(12_000),
        timeoutMs: 12_000,
        maxRetries: 0,
      },
    );
    const title = titleFromResponse(message, cfg.session.autoNameMax ?? 32) ?? fallback;
    return {
      title,
      usage: {
        sessionId,
        provider,
        model: model.id,
        input: message.usage.input,
        output: message.usage.output,
        cacheRead: message.usage.cacheRead,
        cacheWrite: message.usage.cacheWrite,
        totalTokens: message.usage.totalTokens,
        cost: message.usage.cost.total,
      },
    };
  } catch {
    return { title: fallback };
  }
}

export function registerSessionHooks(
  pi: ExtensionAPI,
  getCfg: () => SyncConfig,
  onUsage?: (usage: AutoNameUsage) => void,
): void {
  const attempted = new Set<string>();

  pi.on("input", (event, ctx) => {
    const cfg = getCfg();
    if (!cfg.session?.autoName || event.source !== "interactive") return;
    const text = event.text.trim();
    if (!text || text.startsWith("/")) return;

    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId || attempted.has(sessionId)) return;
    if (ctx.sessionManager.getSessionName()) {
      attempted.add(sessionId);
      return;
    }
    attempted.add(sessionId);

    void generateAiSessionName(ctx, sessionId, text, cfg).then((result) => {
      // 请求已经产生的用量必须统计，即使标题因手动命名/会话切换被丢弃。
      if (result.usage) onUsage?.(result.usage);
      // 请求期间会话切换、用户手动命名或其他插件命名时均放弃写入。
      if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getSessionName()) return;
      try {
        pi.setSessionName(result.title);
      } catch {
        // 命名失败不能影响主对话。
      }
    });
  });
}

export function sessionStatus(cfg: SyncConfig, ctx: ExtensionCommandContext): string {
  const cur = ctx.model;
  const mapping = cfg.session?.autoNameModelByProvider ?? {};
  return [
    "═══ 会话 Session ═══",
    `会话 ID: ${ctx.sessionManager.getSessionId() ?? "-"}`,
    `会话名称: ${ctx.sessionManager.getSessionName() ?? "（未命名）"}`,
    `当前模型: ${cur ? `${cur.provider}/${cur.id}` : "-"}`,
    `AI 自动命名: ${cfg.session?.autoName ? "开" : "关"}（首条消息，最长 ${cfg.session?.autoNameMax ?? 32} 字）`,
    "命名专用低价模型:",
    ...Object.entries(mapping).map(([provider, model]) => `  ${provider} → ${model}`),
    "主会话模型不会被自动切换。",
  ].join("\n");
}

export function cmdSessionRename(pi: ExtensionAPI, args: string): string {
  const name = args.trim();
  if (!name) return "用法: /qisumi-session-rename <名称>";
  pi.setSessionName(name);
  return `当前会话已命名为: ${name}`;
}
