# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**知识增长引擎 (Knowledge Growth Engine)** — an AI-Native content creation platform that integrates local knowledge base browsing, AI-assisted writing (with Claude Code as runtime), and multi-platform publishing (WeChat, Zhihu, Juejin, Twitter/X).

The UI design references multica and open-design: dark, warm, editorial aesthetic with an AI-native workflow where humans curate and AI agents execute.

## Architecture


### Knowledge Architecture (LLM-Wiki Pattern)

Three-layer vault model (inspired by Obsidian + Claude Code):

- **raw/** — immutable source materials. User imports files here. "Ingest" processes them into wiki.
- **wiki/** — LLM-maintained pages organized by domain (写作/开发/跨域). Page types: `concept`, `entity`, `draft`, `article`, `overview`.
- **CLAUDE.md** — operational specs defining page types, agent behaviors, and rules.

### AI Writing Workflow

通过与 claude code runtime 对话进行创建

### Publishing Workflow

打开文档后，右上角有个发布按钮，点击发布按钮，弹出弹窗，选择要发布的平台，然后发布

## External Dependencies (Planned Integration)

### doocs/md — Markdown 排版引擎

**仓库**: https://github.com/doocs/md  
**用途**: 文档排版与编辑，提供 Markdown → 多平台格式化 HTML 的渲染能力。

**技术栈**: Vue 3 + Vite + TypeScript monorepo。核心渲染引擎 `@md/core` 是框架无关的。

**关键能力**:
- `marked` v18 + 12 个自定义扩展（KaTeX 数学公式、Mermaid 图表、PlantUML、脚注、目录等）
- `highlight.js` 代码高亮（懒加载语言包）
- CSS 变量主题系统：3 套内置主题（经典/优雅/简洁）+ 自定义 CSS 支持
- CSS 处理器：运行时解析 `var(--xxx)` 和 `calc()` 表达式，输出自包含 HTML（微信公众号兼容）
- `juice` CSS 内联：将样式内联到 HTML 元素，确保微信编辑器粘贴兼容
- 剪贴板双格式写入：`text/html` + `text/plain` 同时写入

**集成方式**: `@md/core` 是 workspace 私有包，未发布 npm。需要 vendor 核心渲染代码（`marked` + 扩展 + 主题系统 + CSS 处理），或基于 `marked` + `highlight.js` 自建并参考其主题架构。

**当前状态**: 项目使用手写正则 Markdown 渲染器（`renderMarkdown()` 函数），待替换为 doocs/md 渲染引擎。

### doocs/cose — 全平台分发

**仓库**: https://github.com/doocs/cose  
**用途**: 将文章一键发布到 30+ 内容平台。

**类型**: Chrome 扩展（Manifest V3），**不是** npm 包或 SDK。

**支持平台 (33个)**:
- 自媒体：微信公众号、今日头条、知乎、抖音、小红书、百家号、网易号、搜狐号、微博、B站、豆瓣、少数派、Twitter/X
- 博客/技术社区：CSDN、博客园、掘金、Medium、思否、InfoQ、简书、开源中国、51CTO
- 云平台：腾讯云、阿里云、华为云、百度千帆、支付宝开放平台、ModelScope、火山引擎

**架构**: 
- `@cose/core` — 平台适配器层，每个平台一个 adapter 文件
- `@cose/detection` — 登录状态检测（通过 offscreen document + cookie-aware fetch）
- 两种内容注入策略：Markdown 直注（Markdown 编辑器平台）和 HTML 剪贴板模拟（富文本编辑器平台如微信）

**集成方式**: 作为 Chrome 扩展配合使用，不能作为库导入。如需自定义集成，可 fork 平台适配器的 DOM 操作逻辑，结合 Puppeteer/Playwright 实现无浏览器自动化。

**当前状态**: 项目使用剪贴板复制方式手动分发，待集成 cose 扩展实现自动发布。
