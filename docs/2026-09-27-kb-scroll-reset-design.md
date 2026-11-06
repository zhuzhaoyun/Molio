# KB 阅读视窗：切换文档时滚动位置重置 — 设计说明

日期：2026-09-27
关联改动：`apps/web/src/components/kb/KbMainContent.tsx`、`apps/web/e2e/kb-scroll-reset.spec.ts`

## 问题现象

在小 .md 阅读路径下，文档 A 中翻到中间/底部后，切换到文档 B，阅读视窗仍停留在原滚动位置（若 B 比 A 短则被 clamp 到底部），而不是从 B 的首行开始。

## 根因

`.kb-content-area` 是 `overflow-y: auto` 的滚动容器（`knowledge.css`）。小 .md 阅读分支为：

```tsx
<div className="kb-content-area" ref={contentRef}>
  <MdRenderer content={renderedContent} ... />
</div>
```

容器本身没有 `key`，切换文件时 React 在同位置复用同一个 DOM 节点、只替换 children —— **DOM 节点的 `scrollTop` 不在 React 管理范围内**，因此残留上一篇的位置。加载期的 "Loading..." 短暂内容也不会改变这一行为（新内容渲染后浏览器维持原 scrollTop）。

对照：排版编辑器路径有 `key={selectedFile}` 会整体重挂载；CodeMirror 路径每个文件重建 `EditorView`；PDF 路径各文件重建 viewer —— 都天然回顶。只有 doocs 小 .md 阅读路径缺失重置。

## 修复

`KbMainContent` 新增一个以 `selectedFile` 为依赖的 effect，把容器滚回顶部：

```tsx
useEffect(() => {
  contentRef.current?.scrollTo({ top: 0 });
}, [selectedFile]);
```

- 时序：`selectedFile` 变更的同一帧即归零，早于新内容异步到达，之后内容增长时 scrollTop 保持 0。
- 对 CM/PDF 分支是 no-op（它们的滚动在内部视图里），不会互相干扰。
- 刻意不做「记住每篇文档的滚动位置」：用户对「切换到新文档」的心智预期是从头开始（与 Obsidian 默认行为一致）；如未来需要阅读位置记忆，应作为独立功能按 vault+path 持久化设计。

## 测试

`apps/web/e2e/kb-scroll-reset.spec.ts`（@area kb, P1）：

1. 临时 vault 写入两篇 200 段长文档；
2. 打开 A 滚到底（断言 scrollTop > 0）→ 切 B → 断言 scrollTop === 0；
3. 反向 B → A 再验一次。

本机用等价手动脚本跑过同一流程验证：修复前复现（切 B 后 scrollTop 残留），修复后归零。spec 本身的首次 Playwright 执行为 CI。
