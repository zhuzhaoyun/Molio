# 聊天气泡 h4–h6 标题不渲染修复

日期：2026-10-05
范围：`apps/web`（聊天轻量 Markdown 渲染器 + 样式 + E2E）

## 现象

对话框里助手回复中的四级标题（如 `#### 方案 A：最小清理`）原样显示为文本，
`####` 井号泄漏在气泡中；一～三级标题正常。

## 原因

聊天消息用的是轻量渲染器 `src/utils/markdown.ts`（`renderMarkdown`，
供 `AssistantMessage` 经 `dangerouslySetInnerHTML` 上屏，与知识库的 doocs/md
流水线是两套）。其 Headers 段只处理了 `###` / `##` / `#` 三级：

```ts
html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
```

`^### ` 要求第四个字符是空格，`#### ` 第四位是 `#`，匹配不上任何一条规则，
于是整行落入段落包装，井号原样输出。同时 `chat.css` 的
`.assistant-prose` 也只给 h1–h3 定义了字号。

## 修复

1. `src/utils/markdown.ts`：Headers 段按「标记最长者优先」补 h4–h6 规则
   （`######`→h6、`#####`→h5、`####`→h4），放在 `###` 之前。
   段落包装的块级判定 `/^<[hupbolt]/` 已含 `h`，`<h4>` 等自动视为块，无需改动。
2. `src/styles/chat.css`：`.assistant-prose` 标题组选择器扩到 h4–h6。
   正文为 14px；h1–h4 字号 18/17/16/15 逐级递减（h2 +1、h3 +2，为保住
   阶梯做的小幅调整），h5/h6 与正文同 14px、靠加粗 + 颜色递减区分层级
   （h5 正文色、h6 muted 色）——聊天气泡里字号排不下六级阶梯，
   颜色是常规替代手段。

## 回归测试

新增 `e2e/chat-markdown.spec.ts`（@area chat, P1）。注意 area-map 登记要**两处**
都写才算数：`areas.chat.specs` 数组加名字，顶层 `specs` 表加
`{ priority, file }` 条目——后者才是 `select-specs.mjs` 实际读取 priority 和
文件名的来源，缺了它 PR CI 的 affected-E2E 选择会静默跳过该 spec
（已用 fake diff 验证：补齐后改动 `markdown.ts` 会选中 `chat-markdown.spec.ts`）。

- `#### 方案 A/B` 场景：断言渲染出 2 个 `<h4>`、无 `####` 字面量泄漏、
  同行的加粗与列表不受影响；
- h1–h6 全级别：断言六级标题各自成元素、无 `#` 泄漏。

验证：不修复时 2 个用例均失败（复现 bug），修复后通过；
既有 `chat-single` / `chat-codeblock` 共 12 个 P0 用例全绿，`tsc --noEmit` 通过。

## 顺带修复：本地 E2E 数据目录 EPERM（Windows）

`playwright.config.ts` 原先把 E2E daemon 数据目录固定为
`molio-e2e-daemon-<port>`，并在文件顶层 `rmSync` 清理。但本文件会被测试
worker 二次加载，Windows 下第二次执行删除时 daemon 已启动并占用该目录
（sqlite 文件锁定），必抛 EPERM，整个 spec 未跑即败。

修复思路从「先删旧目录」改为「每次用新目录」：不再删除，EPERM 根除。

**演进说明**：本分支最初实现为「pid 命名目录 + 历史目录清扫（主进程 env
标记 + pid 存活探测双护栏）」；rebase 时发现上游 #291 已用更简洁的
`mkdtempSync` + `process.env.MOLIO_E2E_DATA_DIR ??=` 同修此问题（worker
经环境变量继承主进程目录，连 pid 不一致问题都不存在），遂采用上游实现，
本 PR 在该文件上仅保留注释语义化补充（说明 `??=` 共享目录的作用）。

测试豁免说明：Playwright config 的加载逻辑位于测试框架自身的引导层，
无法被本框架的 E2E 覆盖；行为约定以注释 + 本文档记录作为替代。
