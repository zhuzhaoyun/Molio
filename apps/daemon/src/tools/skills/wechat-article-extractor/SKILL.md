---
name: wechat-article-extractor
description: 提取微信公众号文章（mp.weixin.qq.com）内容为 Markdown。遇到 mp.weixin.qq.com 链接时使用此 skill，禁止使用 WebFetch。
---

# WeChat Article Extractor

提取微信公众号文章内容为结构化 Markdown，保留表格、代码块、图片占位。

## ⚠️ 重要：禁止使用 WebFetch

WebFetch 对 `mp.weixin.qq.com` 会被企业安全策略拦截。**必须**使用本 skill 的 `extract.js` 脚本提取文章内容。

## 使用方法

### 从 URL 提取

```bash
node "<skill_dir>/extract.js" "https://mp.weixin.qq.com/s?__biz=...&mid=...&idx=...&sn=..."
```

其中 `<skill_dir>` 是本 skill 所在目录的绝对路径（即包含此 SKILL.md 的目录）。

### 从本地 HTML 文件提取

```bash
node "<skill_dir>/extract.js" --html /path/to/article.html [source_url]
```

## 输出格式

### 成功（退出码 0）

- **stdout**: Markdown 格式的文章正文（保留表格、代码块、图片占位）
- **stderr**: 一行 JSON 元数据：

```json
{"title":"文章标题","author":"作者","account":"公众号名称","publishTime":"2024/01/15 10:30:00","url":"原始链接","type":"post","chars":12345}
```

### 失败（退出码非 0）

- **stderr**: `[wechat-extractor] ERROR <code>: <错误信息>`
- **退出码含义**：
  - `1`: 一般性错误（缺少输入、不支持的链接等）
  - `2`: 内容不可用（风控拦截、已删除、已过期、违规等）— **不要重试**，提示用户手动粘贴正文
  - `3`: 网络/HTTP 错误 — 可重试 1 次

## 错误码表

| 代码 | 错误信息 | 处理方式 |
|------|----------|----------|
| 1000 | 文章获取失败 | 检查 URL 是否正确 |
| 1001 | 无法获取文章信息 | 页面结构异常 |
| 1002 | 请求失败 | 网络问题，可重试 |
| 1003 | 响应为空 | 网络问题，可重试 |
| 1004 | 访问过于频繁 | 等待后重试或请用户手动粘贴 |
| 1006 | 公众号已迁移 | 自动跟随重定向 |
| 2001 | 请提供文章内容或链接 | 缺少输入 |
| 2002 | 链接已过期 | 请用户提供新链接 |
| 2003 | 内容涉嫌侵权 | 内容不可用 |
| 2005 | 内容已被发布者删除 | 内容不可用 |
| 2006 | 内容因违规无法查看 | 内容不可用 |
| 2009 | 不支持的链接 | 仅支持 mp.weixin.qq.com |
| 2012 | 帐号已被屏蔽 | 内容不可用 |
| 2013 | 帐号已自主注销 | 内容不可用 |

## 与知识库工作流集成

提取成功后，按以下步骤处理：

1. 将 Markdown 正文暂存到 `raw/wechat/YYYY-MM-DD/HHmm-简短标题.md`
2. 在暂存文件头部添加 frontmatter：

```yaml
---
title: "文章标题"
author: "作者"
source: "公众号名称"
url: "原始链接"
published: "YYYY/MM/DD HH:mm:ss"
extracted_at: "ISO时间戳"
---
```

3. 回复用户：已暂存到哪个路径，提示"回复入库/保存到知识库/归档后，我再整理进知识库"
4. 用户确认后，按增量导入流程整理进 wiki

## 失败兜底

当退出码为 2（内容不可用）时：
- **不要重试抓取**
- 回复用户："该文章无法自动提取（原因：xxx）。请在浏览器中打开文章，复制正文内容发给我，我来帮你保存。"
