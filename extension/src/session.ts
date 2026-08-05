/**
 * 会话自动命名 + 新会话低价默认模型。
 *
 * - 自动命名：新会话收到第一条用户输入（interactive、非命令）时，取消息摘要设为会话名。
 * - 低价默认模型：session_start(reason=new) 时，若当前模型所属 provider 在映射中有更低价模型，
 *   自动切换到该模型（仅在全新会话应用一次，不打扰已选择模型的会话）。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SyncConfig } from "./config.js";

/** 从用户消息文本生成简短会话名（去代码/去 markdown/压缩空白/截断） */
export function summarizeName(text: string, max = 32): string {
  let t = text
    .replace(/```[\s\S]*?```/g, " ") // 代码块整体去掉
    .replace(/`[^`]*`/g, " ") // 行内代码
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // markdown 链接 → 链接文字
    .replace(/[*_~#>`]/g, "") // 强调/标题符号直接去除
    .replace(/[=\-+[\](){}|\\/]/g, " ") // 其余符号 → 空格
    .replace(/\s*([：:，,。.、；;！!？?）)])/g, "$1") // 去掉中文标点前的空格
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "（未命名会话）";
  if (t.length > max) t = t.slice(0, Math.max(1, max - 1)) + "…";
  return t;
}

/** 注册会话相关事件钩子（自动命名 / 低价默认模型） */
export function registerSessionHooks(pi: ExtensionAPI, getCfg: () => SyncConfig): void {
  const named = new Set<string>();
  const cheapApplied = new Set<string>();

  // 自动命名：每个会话第一条用户输入时生成名字（仅一次）
  pi.on("input", (event, ctx) => {
    const cfg = getCfg();
    if (!cfg.session?.autoName) return;
    if (event.source !== "interactive") return;
    const text = event.text.trim();
    if (!text || text.startsWith("/")) return; // 命令/空输入不算

    const sm = ctx.sessionManager;
    const sid = sm.getSessionId();
    if (!sid || named.has(sid)) return;
    if (sm.getSessionName()) {
      named.add(sid); // 已有名字（用户手动设置过），不再自动覆盖
      return;
    }
    named.add(sid);
    try {
      pi.setSessionName(summarizeName(text, cfg.session.autoNameMax ?? 32));
    } catch {
      // 忽略：命名失败不影响主流程
    }
  });

  // 低价默认模型：仅对全新会话（reason=new）应用一次
  pi.on("session_start", async (event, ctx) => {
    const cfg = getCfg();
    if (!cfg.session?.defaultCheapModel) return;
    if (event.reason !== "new") return;

    const sm = ctx.sessionManager;
    const sid = sm.getSessionId();
    if (!sid || cheapApplied.has(sid)) return;
    cheapApplied.add(sid);

    const cur = ctx.model;
    if (!cur?.provider) return;
    const targetId = cfg.session.cheapModelByProvider?.[cur.provider];
    if (!targetId || targetId === cur.id) return;

    const target = ctx.modelRegistry.find(cur.provider, targetId);
    if (!target) return;
    try {
      const ok = await pi.setModel(target);
      if (ok && ctx.hasUI) {
        ctx.ui.notify(`${cur.provider} 新会话默认使用低价模型 ${target.id}`, "info");
      }
    } catch {
      // 忽略：模型切换失败不影响会话
    }
  });
}

/** 当前会话信息 + 命名/低价模型配置 */
export function sessionStatus(cfg: SyncConfig, ctx: ExtensionCommandContext): string {
  const sm = ctx.sessionManager;
  const cur = ctx.model;
  const cheap = cfg.session?.cheapModelByProvider ?? {};
  const cheapLines = Object.keys(cheap).length
    ? Object.entries(cheap)
        .map(([p, m]) => `  ${p} → ${m}`)
        .join("\n")
    : "  无";
  return [
    "═══ 会话 Session ═══",
    `会话 ID: ${sm.getSessionId() ?? "-"}`,
    `会话名称: ${sm.getSessionName() ?? "（未命名）"}`,
    `当前模型: ${cur ? `${cur.provider}/${cur.id}` : "-"}`,
    `自动命名: ${cfg.session?.autoName ? "开" : "关"}（最长 ${cfg.session?.autoNameMax ?? 32} 字，取首条消息摘要）`,
    `新会话低价模型: ${cfg.session?.defaultCheapModel ? "开" : "关"}`,
    `低价模型映射:`,
    cheapLines,
  ].join("\n");
}

/** 手动重命名当前会话 */
export function cmdSessionRename(pi: ExtensionAPI, args: string): string {
  const name = args.trim();
  if (!name) return "用法: /qisumi-session-rename <名称>";
  pi.setSessionName(name);
  return `当前会话已命名为: ${name}`;
}
