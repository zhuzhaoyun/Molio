# Image Paste in ChatComposer — Design Spec

**Date**: 2026-06-24  
**Branch**: `feat/ui-interaction-optimization` (Phase 3 remaining)  
**Status**: ✅ Complete

## Overview

支持用户在 ChatComposer 中用 Ctrl+V / Cmd+V 粘贴剪贴板图片，图片上传到 vault `.molio/assets/` 目录，以 markdown 图片引用拼入消息文本，由 Claude Code CLI 自动识别并作为 vision context 发送给模型。

### 使用场景

| 场景 | 入口 | 典型用例 |
|------|------|---------|
| **首页对话** | HomePage → ChatComposer | 截图直接问 AI，无上文文件上下文 |
| **知识库就地问答** | KnowledgeBasePage → FileChatPanel → ChatComposer | 看着文档截图 → "根据文档内容评审这个架构图" |

两个场景共用同一个 `ChatComposer` 组件，`onPaste` 改造一次生效，两端自动支持。`vaultStore.getActiveVaultId()` 在两种页面下均能返回当前活跃 vault。

## Motivation

Molio 作为 AI 写作工具，截图问 AI（"帮我根据这个表格写报告"）是高频场景。ChatGPT、Claude.ai 均已支持图片粘贴，用户在 Molio 中也有同样预期。当前 ChatComposer 不支持任何图片输入方式——这是交互链路中最大的缺失。

## Design Decisions

| 决策 | 选择 | 理由 |
|------|------|------|
| 粘贴后展示 | 缩略图徽章（56px 高）在 textarea 上方 | 与 FileRef 徽章视觉一致，支持多张预览、点击查看原图、删除。上传中显示本地 blob 预览 + spinner，失败显示红色边框 + 重试 |
| 上传时机 | 粘贴/选择后立即上传 | 发送无需等待；错误提前暴露 |
| 存储路径 | `{vault}/.molio/assets/` | 与用户文件隔离，放在 `.molio/` 隐藏目录下 |
| 文件命名 | `YYYY-MM-DD-HHmmss-{序号}.png` | 可读、无碰撞（同秒序号递增） |
| 消息传图 | `onSend` 扩展为 `(message, fileRefs, pastedImages)` | HomePage 将 `pastedImages` 转换为 markdown `![image](path)` 拼入消息，前端聊天消息渲染实际图片（非文本） |
| 上传入口 | Ctrl+V 粘贴 + 🖼 按钮选择文件 | 双入口覆盖快捷键用户和鼠标用户，按钮位于输入框左下角（spacer 左侧），与发送按钮对称 |

## Key Insight: Claude Code CLI Image Recognition

Claude Code CLI 会自动扫描用户输入中出现的图片文件路径（`.png`、`.jpg`、`.jpeg` 等），读取文件并作为 vision context 发送给 API。不需要特殊语法，不需要 daemon 做 base64 编码。

**对 Molio 的影响**：图片只需写入 vault 目录下（CLI 运行 `cwd`），消息中包含图片相对路径即可。daemon 零架构改动。

## Architecture

```
User Ctrl+V / 点击🖼按钮
    │
    ▼
ChatComposer (onPaste / file input)
    │
    ├── 从 clipboardData.items 检测 image/* 类型
    ├── 上传中: 添加 PastedImage{state:'uploading'} → 显示本地 blob 缩略图 + spinner
    │
    ▼
api.uploadAsset(vaultId, file)
    │  POST /api/knowledge/vaults/:id/assets/upload
    │  multipart/form-data { file }
    │
    ▼
Daemon knowledge route
    │
    ├── 校验 MIME 类型 (image/png,jpeg,gif,webp) + 大小（50MB）
    ├── 写入 {vaultPath}/.molio/assets/{timestamp}-{seq}.{ext}
    └── 返回 { filePath, url }
    │
    ▼
ChatComposer
    │
    ├── 成功: PastedImage → state:'done', 替换 blob URL 为 server URL
    ├── 失败: PastedImage → state:'error', 红色边框 + 重试图标
    └── 点击缩略图 → 新标签打开原图
    │
    ▼
用户点发送 → onSend(message, fileRefs, pastedImages)
    │
    ▼
HomePage.handleSend: pastedImages → `![image](path)` 拼入消息文本
    │
    ▼
POST /api/runs { message: "帮我看看\n\n![image](.molio/assets/xxx.png)" }
    │
    ▼
RunManager spawn CLI → CLI 读图片 → 编码 → API
```

### 聊天消息渲染

```
UserMessage 收到 content: "帮我看看\n\n![image](.molio/assets/xxx.png)"
    │
    ├── 正则解析 ![image](path) → 提取路径
    ├── api.rawFileUrl(vaultId, path) → 构建完整 URL
    └── 渲染: 文字 + <img> 缩略图 (max-width 320px) + "查看原图 ↗"
```

## Implementation

### Created Files

| File | Purpose |
|------|---------|
| `apps/daemon/test/routes/asset-upload.test.ts` | Daemon 上传端点单元测试（5 项） |
| `apps/web/e2e/image-paste.spec.ts` | 图片粘贴 E2E 测试（3 项） |

### Modified Files

| File | Change |
|------|--------|
| **Daemon** | |
| `apps/daemon/src/routes/knowledge.ts` | 新增 `POST /api/knowledge/vaults/:id/assets/upload` 路由 |
| **Web API** | |
| `apps/web/src/api/client.ts` | 新增 `uploadAsset(vaultId, file)` 方法 |
| **Web UI** | |
| `apps/web/src/components/ChatComposer.tsx` | `PastedImage` 接口 + `pastedImages` 状态 + `uploadImage` + `onPaste` + 文件选择 input + 上传按钮 + 缩略图徽章渲染 + 扩展 `onSend` 签名 |
| `apps/web/src/components/HomePage.tsx` | `handleSend` 将 `pastedImages` 转换为 markdown 前缀 |
| `apps/web/src/components/UserMessage.tsx` | 正则解析 `![image](path)`，渲染为 `<img>` + "查看原图" |
| `apps/web/src/styles/chat.css` | 缩略图徽章、上传按钮、加载动画、消息内图片样式 |
| `apps/web/src/i18n/locales/zh.ts` | 新增 `composer.uploadImage`, `composer.uploadRetryHint` |
| `apps/web/src/i18n/locales/en.ts` | 新增 `composer.uploadImage`, `composer.uploadRetryHint` |

### Commits (image paste feature)

| Commit | Description |
|--------|-------------|
| `034e6be` | docs(spec): image paste design spec |
| `d37e58b` | docs(plan): image paste implementation plan |
| `5a7f349` | feat(daemon): add asset upload endpoint |
| `ac0bf30` | feat(web): add api.uploadAsset |
| `e90e654` | feat(web): add image paste to ChatComposer |
| `e0c24b1` | fix(web): i18n + CSS tokens |
| `96be82c` | test(web): add E2E tests |
| `4fa27b3` | fix(test): retry-based assertion |
| `edb3abf` | fix(daemon): English error messages |
| `e0f5e1f` | feat(web): thumbnails + upload button + inline image rendering |
| `8896939`~`9e6e305` | fix(web): upload button position, style, icon iterations |

## Data Flow

```typescript
// Daemon: POST /api/knowledge/vaults/:id/assets/upload
Request:  multipart/form-data { file: File }
Response: { filePath: ".molio/assets/2026-06-24-143052-1.png", url: "/api/knowledge/vaults/:id/raw/.molio/assets/2026-06-24-143052-1.png" }

// Web: api.uploadAsset()
const formData = new FormData();
formData.append('file', file);
const res = await fetch(`${BASE}/knowledge/vaults/${vaultId}/assets/upload`, {
  method: 'POST',
  body: formData,
});
return res.json(); // { filePath, url }

// ChatComposer: onPaste handler
const onPaste = useCallback(async (e: React.ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;

      try {
        const { filePath } = await api.uploadAsset(vaultId, file);
        insertAtCursor(`![image](${filePath})`);
      } catch (err) {
        // toast error, allow retry
      }
    }
  }
}, [vaultId]);
```

## Error Handling

| 场景 | 处理 |
|------|------|
| 非图片类型剪贴板 | 忽略，正常处理文本粘贴 |
| 图片超过 50MB | Daemon 返回 413，前端 toast "图片过大（最大 50MB）" |
| 上传网络错误 | Toast "图片上传失败"，textarea 中不插入内容，不污染消息 |
| Vault 不存在 | Daemon 返回 404，前端 toast "请先选择知识库" |
| 同时粘贴多张图片 | 支持，逐一上传，逐一插入 |

## Testing Strategy

### Unit Tests (node:test)

| Test | Scope |
|------|-------|
| `test/knowledge/asset-upload.test.ts` | Daemon upload 路由：缺少 vault、无效文件类型、超大文件、正常上传 → 文件存在校验 |

### E2E Tests (Playwright)

| Test | Scope |
|------|-------|
| `e2e/image-paste.spec.ts` | 粘贴图片 → 文本中插入 markdown；上传成功 → 图片文件存在于 `.molio/assets/`；非图片粘贴 → 不触发上传 |

## Backward Compatibility

- **Daemon API**: 新增一个端点，不影响现有路由
- **ChatComposer onSend**: 签名不变，仍为 `(message: string, fileRefs?: FileRef[])`
- **RunManager / CLI spawn**: 零改动，CLI 已有图片识别能力
- **现有 E2E**: 不受影响

## Open Questions

1. **Markdown 渲染**：MdRenderer 是否需要能渲染 `.molio/assets/` 路径的图片？当前 raw file API 已支持通过 `GET /api/knowledge/vaults/:id/raw/{path}` 提供图片。用户消息中的 `![image](.molio/assets/xxx.png)` 需要能被渲染器解析出正确的 URL。
2. **历史对话中的图片**：图片文件如果被用户手动删除，历史消息中的 markdown 图片引用会失效——需要降级显示（类似 FileRef 的失效态）。

## Relations

- Parent spec: [2026-06-23-ui-interaction-optimization-design.md](2026-06-23-ui-interaction-optimization-design.md) — Phase 3 Deferred 中的图片粘贴项
- Cut from scope: KB 文件树拖拽（`@` 搜索已覆盖）、外部文件拖入（格式兼容复杂，收益不明确）
