import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

/**
 * 命令输出助手：
 * - TUI 模式：短文本走 notify toast；长文本用 SelectList 对话框展示（↑↓ 滚动，Esc 关闭）。
 * - print/json/rpc 模式：直接 console.log（可被脚本捕获）。
 */
export async function output(ctx: ExtensionCommandContext, text: string, title = "pi-cloud-sync"): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    console.log(text);
    return;
  }

  const lines = text.split("\n");
  if (lines.length <= 6) {
    ctx.ui.notify(lines.filter(Boolean).join(" | "), "info");
    return;
  }

  const items: SelectItem[] = lines.map((l) => ({
    value: l,
    label: l || " ",
    description: l.length > 120 ? l.slice(0, 120) + "…" : undefined,
  }));

  await ctx.ui.custom<null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(new Text(theme.fg("dim", "↑↓ 滚动  •  Enter 选择  •  Esc 关闭"), 1, 0));

    const selectList = new SelectList(items, Math.min(items.length, 15), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    selectList.onSelect = () => done(null);
    selectList.onCancel = () => done(null);
    container.addChild(selectList);
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

/** 对话框类交互：确认对话框封装 */
export async function confirm(ctx: ExtensionCommandContext, title: string, message: string): Promise<boolean> {
  if (!ctx.hasUI) return true;
  return ctx.ui.confirm(title, message);
}
