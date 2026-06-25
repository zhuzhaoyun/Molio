# Slash Commands Retrospective & Future Design

> 2026-06-25 | 已移除，待重新设计后实现

## 为什么移除

2026-06-23 的 UI 交互优化中引入了 `/` 命令功能（Phase 3），包含 4 个内置命令：

| 命令 | 行为 | 问题 |
|------|------|------|
| `/browse-kb` | 跳转知识库页面 | 与 NavRail 入口冗余 |
| `/polish` | 发送"优化文字" prompt | 可用但 prompt 模板编辑不便 |
| `/outline` | 发送"生成大纲" prompt | 可用但 prompt 模板编辑不便 |
| `/new-chat` | 清空对话 | 与顶部 + 按钮冗余 |

**核心问题**：
1. 4 个命令中 2 个是 UI 操作快捷方式，与已有 UI 冗余，用户输入 `/` 时的心理预期是"AI 帮我做事"
2. 命令无法扩展——用户不能自定义 prompt 模板，也不能调用已安装的 skill
3. 命令数量少，用户记忆成本高于直接打字

## 已删除的内容

```
删除：  apps/web/src/components/CommandPalette.tsx
        apps/web/src/components/CommandPalette.css
        apps/web/src/commands/types.ts
        apps/web/src/commands/builtin.ts
        apps/web/e2e/composer-slash-commands.spec.ts

修改：  apps/web/src/components/ChatComposer.tsx          (去除 / 触发检测、CommandPalette、相关 props)
        apps/web/src/components/HomePage.tsx              (去除 handleCommand)
        apps/web/src/components/kb/FileChatPanel.tsx      (去除 KB_CHAT_COMMANDS)
        apps/web/src/components/kb/WikiChatPanel.tsx      (去除 KB_CHAT_COMMANDS)
```

## 未来重新设计方向

### 设计原则

1. **命令 = 对 AI 的显式指令**，不是 UI 操作的快捷方式
2. **用户可自定义** prompt 模板（或至少可编辑内置模板）
3. **与 Skill 系统打通**——已安装的 skill 自动出现在命令面板中
4. **上下文感知**——在知识库页面和首页可显示不同的命令集

### 推荐命令体系

```
── 写作辅助 ──
  /polish      优化文字表达（可配置 prompt 模板）
  /outline     生成结构化大纲
  /translate   翻译（中→英 / 英→中，可配置目标语言）
  /summarize   总结要点
  /continue    继续写

── Skills ──
  /pdf         PDF 文档处理
  /docx        Word 文档处理
  /pptx        PPT 处理
  /xlsx        Excel 处理
  /wechat      微信文章提取
  （用户自定义 skill 自动发现）
```

### 实现方案

**方案 A：静态配置 + 用户自定义**
- daemon 端提供技能发现 API（读取 `.claude/skills/` + 用户配置）
- Web 端动态生成命令列表
- 用户可在设置页面编辑 prompt 模板

**方案 B：Agent 端透传**
- `/` 触发的文本直接作为 prompt 前缀发送给 agent
- agent 自行解析 `/command` 语义
- 最灵活但对用户不友好（无提示、无可发现性）

### 参考平台

| 平台 | 命令定位 | 典型命令 |
|------|---------|---------|
| Claude Code | 开发者工具 | `/help`, `/clear`, `/compact`, `/review`, `/test` |
| Cursor | 代码操作 | `/explain`, `/fix`, `/test`, `/doc`, `/edit` |
| Notion AI | 写作辅助 | `/draft`, `/summarize`, `/translate`, `/fix` |
| Obsidian | 块插入（非 AI） | 标题、表格、代码块 |

**Molio 定位**：最接近 Notion AI，但需要额外支持知识库 skill 的显式调用。

## 相关文档

- [[2026-06-23-ui-interaction-optimization-design]] — 原始 UI 交互优化设计
- [[2026-06-25-kb-interaction-enhancement-design]] — KB 交互增强（包含 skill 相关设计）
