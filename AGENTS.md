# AGENTS.md

pi-cloud-sync（自托管云同步 + 用量统计插件）的开发注意事项。

## 项目结构

```
extension/    pi 插件（TypeScript，运行在 pi 进程内）
  src/index.ts       命令注册（/qisumi-*）与事件钩子
  src/ui.ts          TUI 输出助手：弹窗面板 / toast / 进度反馈
  src/quota/         额度探测（DeepSeek / Z.AI / Codex）与格式化
  src/stats/         用量采集与报告格式化（report.ts 产出纯文本）
  src/sync/          云同步（push / pull / sessions / plugins / configs）
  src/session.ts     会话命名 / 低价模型配置
server/      自托管同步服务器（Node + SQLite），静态控制台在 server/static/web.html
shared/      协议与类型（server / extension 共享）
docs/        架构、部署、协议文档
```

## 常用命令

```bash
npm run typecheck            # 全仓 TS 检查（extension）
npm test                     # extension 单测（tests/*.test.ts）
npm run test:server          # server 单测
```

## Git 提交规范

commit message 必须以 **gitmoji 开头**（中文或英文描述皆可），例如：

```
✨ 新增增量同步并优化设备与会话管理
♻️ 重构 usage/quota 排版为宽松分组版
🐛 修复 /qisumi-quota 弹窗全屏抢占问题
📝 补充 docs/protocol.md 增量拉取说明
```

常用 gitmoji：`✨` 新功能、`🐛` 修复、`♻️` 重构、`📝` 文档、`✅` 测试、`⚡` 性能、`🔧` 配置。

## ⚠️ 弹窗（TUI overlay）使用要点 —— 踩过的坑，禁止回退

usage / quota 面板此前两次显示 bug 的根因，均已修复并在此固化规则：

### 1. `ctx.ui.custom()` 必须传 `overlay: true`，否则是"全屏替换"而非弹窗

```ts
// ✅ 正确：居中弹窗，叠加在聊天界面之上，不清屏
await ctx.ui.custom<null>((tui, theme, _kb, done) => { /* ... */ }, {
  overlay: true,
  overlayOptions: { anchor: "center", width: "90%", maxHeight: 24 },
});

// ❌ 错误：不传 overlay —— 整个屏幕被自定义视图替换，关闭后主界面重绘
await ctx.ui.custom<null>((tui, theme, _kb, done) => { /* ... */ });
```

- 修复 commit：`deaf0da`（`ui.ts` 中 `output()` / `showTextPane()` / `quotaDialog()` 三处一并补上）。
- `overlayOptions` 用 `anchor: "center"` + `width` / `maxHeight`（数值或百分比），`maxHeight` 必须用 `Math.min(行数 + 头部, 上限)` 防止超出终端高度。
- **quota / usage 面板宽度贴合内容**：宽度用 `panelWidthFor(lines)` 计算（内容最大显示宽度 + 4，下限 44 列），不要写死 `"90%"`；TUI 内部会自动 clamp 到终端宽度，超宽内容自动换行退化。
- **内容用 `CenteredBlock` 组件整块居中**：取所有行最大宽度作为块宽整体平移，行内保持左对齐（表格列对齐 / 缩进不变）；需要居中时用它，不要逐行居中。
- 文档依据：pi 包内 `docs/tui.md` 的 Overlays 章节。

### 2. 面板内容用「单个 `Text` / `CenteredBlock` + `\n`」渲染，不要逐行 `addChild(new Text(...))`

```ts
// ✅ 正确：所有数据行 join("\n") 成一个组件（需居中用 CenteredBlock，否则 Text）
container.addChild(new CenteredBlock(rows.join("\n"), 1));
container.addChild(new CenteredBlock(theme.fg("dim", " Esc 关闭"), 1));

// ❌ 错误：每行一个 Text 组件 —— 逐行累积垂直留白，内容被顶出可视区 → 空屏
rows.forEach((row, i) => container.addChild(new Text(row, 1, i + 1)));
```

- 修复 commit：`4342e61`（`showTextPane` / `quotaDialog` 同时修正）。
- 组件垂直 padding 会逐行累积，行数一多就把内容挤出面板。

### 3. CJK / 全角字符按「显示宽度 2」对齐

纯文本表格对齐必须用「显示宽度」而非 `string.length`：

```ts
const charWidth = (c: string) => (c.codePointAt(0) ?? 0) > 0xff ? 2 : 1;  // 简化版
const visLen = (s: string) => [...s].reduce((n, c) => n + charWidth(c), 0);
const padVisible = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visLen(s)));
```

`stats/report.ts` 里已有完整版 `charWidth` / `displayWidth` / `pad` / `truncate`，`ui.ts` 与 `quota/index.ts` 各有一份简化版，新增表格时直接复用，不要用 `String.padEnd`。

### 4. 输出分层（`ui.ts` 的 `output()`）

| 场景 | 方式 |
|---|---|
| 非 TUI（print / json / rpc） | `console.log(text)`，可被脚本捕获 |
| TUI 且 ≤6 行 | `ctx.ui.notify(text, "info")` toast |
| TUI 长文本、`static: true`（如 /qisumi-usage） | `showTextPane` 非交互静态弹窗 |
| TUI 长文本、非 static | `SelectList` 交互弹窗（Enter 选中） |
| /qisumi-quota（TUI） | `quotaDialog` 专用面板 |

- 面板内容超 50 行必须折叠为提示行（"… 还有 N 行，完整内容请用 --save=file"）。
- 长任务进度：`startProgress()`（toast + 底部状态栏，节流 1.5s），结束记得 `done()` / `error()` 清除状态栏。
- 交互弹窗在 `onSelect` / `onCancel` 都要 `done(null)`，否则卡死。

## 其他约定

- 命令注册统一走 `index.ts` 的 `reg()` 包装（自动带输出助手），`title` 用于弹窗标题。
- 并发额度探测：`probeAllQuotas()` 用 `Promise.allSettled`，Codex 失败不抛错，每个渠道独立报错。
- 数据格式：tokens 用 `fmtNum`（k/M/B），费用用 `fmtCost`（cny=¥ / usd=$）；金额展示保留 4 位小数（`$0.1234`）。
- 服务器 API 改动需同步更新 `shared/src/index.ts` 协议类型与 `docs/protocol.md`。
- 服务器依赖：fastify 5 必须配套 `@fastify/compress` v8+（v7 只支持 fastify 4，会导致启动报 `FST_ERR_PLUGIN_VERSION_MISMATCH`）。
- 改完记得跑 `npm run typecheck && npm test`（extension）与 server 测试。

## 网页端（server/static/web.html）约定

- 图标统一用 **Lucide**（jsdelivr UMD，`<script defer src="…/lucide@0.469.0/dist/umd/lucide.min.js">`），**禁止新增自绘 Unicode 字符当图标**（⌁◫⌘◇ 等历史遗留已替换）。
  - 写法：`<i data-lucide="icon-name" aria-hidden="true">fallback字符</i>`，字符作为 CDN 加载失败的兑底。
  - 动态 innerHTML 生成图标后必须调 `refreshIcons()`（封装 `window.lucide.createIcons()`）；静态图标在初始化时调一次。
  - 图标尺寸用 CSS 控制（`svg.lucide { width: 1em; height: 1em }` + 各容器单独尺寸）。
- 货币：**默认人民币 ¥**（`fmtCost`），顶部 topbar 的 `currencySelect` 可切 USD；汇率来自 `open.er-api.com`（localStorage 6h 缓存，失败保留旧缓存）；**fallback 用构建时从 API 获取的真实汇率（`USD_CNY_FALLBACK`），不要写死 7.15**。
- 模型/设备分布条（`.bar-row`）是纯展示，无点击筛选交互；如需筛选用顶部 `deviceSelect` / `modelSelect`。
- 会话浏览页：消息正文超长用滚动条（`.message-body { overflow: auto }`）而不是截断遮罩；连续的助手消息会合并为一张卡片（虚线分隔正文、用量/时间汇总、整体展开/复制），仅在无筛选/无搜索时合并；`.bar-track`/`.bar-fill` 必须 `display: block`（span 默认 inline 会使宽高失效，分布条不显示）。
- 新增 CDN 依赖与 chart.js / marked / dompurify / lucide 并列在 head，版本号固定（不用 latest）。
