---
name: wiki-save
description: 将当前对话中有价值的内容归档为 wiki 页面，使知识持续积累。回顾对话，判断哪些内容值得归档（concept/comparison/question/session/entity），创建带完整 frontmatter 和交叉链接的归档页面，更新 INDEX/log/hot。Triggers on: 归档, 保存为 wiki 页面, save, 归档当前对话, 把这段对话存下来, archive this conversation, save this to wiki.
---

# wiki-save: 归档对话为 wiki 页面

将当前对话中有价值的内容归档为 wiki 页面，使知识持续积累。

## 核心原则

- **源文件不可变**：只能读取源文件，绝对不能修改或删除。
- **价值筛选**：不是所有对话都值得归档，只保存有长期参考价值的内容。
- **密集交叉链接**：归档页面要大量链接到已有 wiki 页面，形成知识网络。

## Vault 结构

vault 根目录就是当前工作目录。源文件在子目录中（如 raw/、notes/、docs/）。
wiki 相关内容的目录结构：
- `wiki/` — 所有 wiki 页面的根目录
- `wiki/INDEX.md` — 主索引
- `wiki/log.md` — 操作日志（最新条目在最上面）
- `wiki/hot.md` — 近期上下文缓存
- `wiki/concepts/` — 概念、模式、框架等
- `wiki/comparisons/` — 对比分析页
- `wiki/questions/` — 归档的问答页
- `wiki/entities/` — 人物、组织、工具等

页面路径规则：
- 默认使用单文件页面，例如 `wiki/concepts/agent-routing.md`
- 只有当某个主题需要拆成多个稳定页面时，才建立同名目录，并用 `index.md` 作为入口

## Frontmatter 规范

每个 wiki 页面必须包含以下 YAML frontmatter：

```yaml
---
type: source | entity | concept | comparison | overview | question | session
title: "人类可读的标题"
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags:
  - 领域标签
related:
  - "[[相关页面]]"
sources:
  - "[[源文件名]]"
---
```

字段说明：
- `type`：页面类型，必须是以上值之一
- `title`：人类可读标题
- `created` / `updated`：创建和最后更新日期
- `tags`：领域标签列表（至少一个）
- `related`：相关页面的 [[wiki 链接]] 列表（尽量多填）
- `sources`：信息来源的 [[wiki 链接]] 列表

## Hot Cache

`wiki/hot.md` 是近期上下文缓存。每次归档后**完全重写** hot.md（不是追加），内容控制在 ~500 字以内，重点是让下次会话能快速理解 wiki 当前状态。格式：

```markdown
# 近期上下文

> 最后更新：YYYY-MM-DD HH:MM

## 最近操作
- [操作描述]

## 关键页面
- [[页面名]] — 为什么重要

## 开放问题
- 尚未解决的问题或待跟进的事项
```

## 操作步骤

1. **分析对话内容**：回顾当前对话，判断哪些内容值得归档
2. **确定笔记类型**：
   - **concept** — 讨论了一个概念、模式或框架
   - **comparison** — 对比了多个方案、工具或方法
   - **question** — 回答了一个有价值的问题
   - **session** — 一次有主题的工作会话记录
   - **entity** — 讨论了某个人物、组织或工具
3. **读取现有 wiki**：读 `wiki/INDEX.md`，了解已有结构，避免重复创建
4. **创建归档页面**：
   - 写入 `wiki/` 对应的子目录
   - 带完整 frontmatter
   - 用 `[[wiki 链接]]` 大量引用相关已有页面
   - 内容要精炼、有结构、有长期参考价值（不是对话记录的简单复制）
5. **更新已有页面的交叉链接**：如果归档页面与已有页面相关，在已有页面中也添加链接
6. **更新 wiki/INDEX.md**：添加新页面条目
7. **追加 wiki/log.md**（最新条目在最上面）：
   ```
   ## YYYY-MM-DD HH:MM | save | 页面标题
   - 类型：笔记类型
   - 来源：对话归档
   - 关联页面：N 个
   ```
8. **刷新 wiki/hot.md**：完全重写，包含本次归档的摘要
9. **汇报**：创建了什么页面，链接了哪些已有页面

如果对话内容没有长期参考价值（如简单的事实查询、临时操作），告知用户不需要归档，并说明原因。
