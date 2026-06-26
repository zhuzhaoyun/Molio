# FileOperationCard + DiffView Retrospective

> 2026-06-26 | 已移除，待重做后再上

## 功能回顾

当 agent 调用 Write / Edit 工具改文件时，在助手消息里渲染一张"文件操作卡片"：
- 显示文件名
- "查看本次修改"按钮 → 展开 DiffView 显示 old_string/new_string 的增删行
- "打开文件"按钮 → 跳转知识库
- "讨论这个文件"按钮 → 跳首页、预填该文件为 @、新开对话

## 为什么移除

复测后发现体验未达预期，且交互脆弱：

| 问题 | 说明 |
|------|------|
| **diff 太弱** | Edit 只显示 old_string/new_string 两个片段，无周边上下文，不是文件级 diff；Write 把全文标成"新增"，等同文件内容本身。都不如直接打开文件 |
| **与 prose 冗余** | agent 回复通常已解释改了什么，卡片重复 |
| **交互脆弱** | 上线后连踩 3 个 bug：①"打开文件"404（工具报绝对路径，KB 路由期望相对路径）；②"讨论这个文件"无反应（HomePage 未接收 askAboutFile state）；③修②时引入死循环（onNewChat 未 memoize，effect 反复触发 chat.reset） |
| **"打开文件"已够用** | 文件就在知识库里、随时可打开，文件本身是最新真相。卡片的内联 diff 是"比直接打开文件更差的视图" |

**核心判断**：透明性是个真需求，但当前实现没交付价值，反而增加维护面和 bug 面。属于 YAGNI——先砍，等想清楚再做。

## 已删除的内容

```
删除：  apps/web/src/components/FileOperationCard.tsx
        apps/web/src/components/FileOperationCard.css
        apps/web/src/components/DiffView.tsx
        apps/web/src/components/DiffView.css
        apps/web/e2e/operation-cards.spec.ts

修改：  apps/web/src/components/AssistantMessage.tsx
          — 去掉 FileOperationCard 渲染块；Write/Edit 不再从工具列表过滤，回归普通 ToolCard
        apps/web/src/hooks/useFileNavigation.ts
          — 删除 askAboutFile / buildAskAboutState / AskAboutState（仅 FileOpCard 使用）
        apps/web/src/i18n/locales/{zh,en}.ts
          — 删除 fileOp.* 和 diff.noChanges 键
```

Write/Edit 工具现在和 Read/Bash 等一样，渲染为普通工具卡片（显示工具名 + 参数），不再特殊处理。

## 未来重做方向

如果将来要重新做"agent 文件操作可视化"，建议方向：

1. **文件级 diff**：Edit 时读旧文件内容，算真正的行级 diff（带上下文，像 git diff），而非只展示 old/new 片段。这是当前版本最大的短板。
2. **轻量入口而非重型卡片**：或许只在普通工具卡片上加一个"查看改动"小链接，点开才是 diff，而非一整张独立卡片 + 多个按钮。
3. **审计视角**：考虑做成"本次对话改了哪些文件"的汇总视图（侧边栏 / 折叠面板），而非每条消息里塞卡片。更适合"agent 做完一批操作后回看"的真实场景。
4. **交互先验证再上**：任何跳转/预填交互上线前，用 E2E 覆盖完整路径（点击 → 跳转 → 目标页状态），避免再踩"绝对路径 404""state 无人接""effect 死循环"这类坑。

## 相关文档

- [[2026-06-23-ui-interaction-optimization-design]] — 原 UI 交互优化设计（Phase 3 含此功能）
- [[2026-06-25-slash-commands-retrospective]] — 同样"先移除、待重做"的先例
