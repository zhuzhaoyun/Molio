# Image Paste in ChatComposer — Design Spec

**Date**: 2026-06-24  
**Branch**: `feat/ui-interaction-optimization` (Phase 3 remaining)  
**Status**: Design ✅

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
| 粘贴后展示 | markdown 文本插入 textarea（上传中显示 loading 指示） | 最简单，与 B 方案一致，onSend 零改动。上传成功在光标处插入 `![image](path)`，用户可编辑删除 |
| 上传时机 | 粘贴后立即上传 | 发送无需等待；错误提前暴露 |
| 存储路径 | `{vault}/.molio/assets/` | 与用户文件隔离，放在 `.molio/` 隐藏目录下 |
| 文件命名 | `YYYY-MM-DD-HHmmss-{序号}.png` | 可读、无碰撞（同秒序号递增） |
| 消息传图 | markdown `![image](path)` 拼入 message | 零接口改动；CLI 自动识别文本中的图片路径 |

## Key Insight: Claude Code CLI Image Recognition

Claude Code CLI 会自动扫描用户输入中出现的图片文件路径（`.png`、`.jpg`、`.jpeg` 等），读取文件并作为 vision context 发送给 API。不需要特殊语法，不需要 daemon 做 base64 编码。

**对 Molio 的影响**：图片只需写入 vault 目录下（CLI 运行 `cwd`），消息中包含图片相对路径即可。daemon 零架构改动。

## Architecture

```
User Ctrl+V
    │
    ▼
ChatComposer.onPaste(event)
    │
    ├── 从 clipboardData.items 检测 image/png 或 image/jpeg
    │
    ▼
api.uploadAsset(vaultId, file)
    │  POST /api/knowledge/vaults/:id/assets/upload
    │  multipart/form-data { file }
    │
    ▼
Daemon knowledge route
    │
    ├── 读取 uploaded file buffer
    ├── 生成文件名: {timestamp}-{seq}.{ext}
    ├── 写入 {vaultPath}/.molio/assets/{filename}
    ├── 确保 .molio/ 和 .molio/assets/ 目录存在
    └── 返回 { filePath, url }
    │
    ▼
ChatComposer
    │
    ├── 上传中: textarea 上方显示 "📎 上传中..." 文字提示
    ├── 成功: 在 textarea 光标处插入 `![image](.molio/assets/{filename})`，提示消失
    └── 失败: toast "图片上传失败"，提示消失，不插入内容
    │
    ▼
用户点发送 → onSend(message)
    │
    ▼
POST /api/runs { message: "...\n![image](.molio/assets/xxx.png)" }
    │
    ▼
RunManager spawn CLI → CLI 读图片 → 编码 → API
```

## Files to Create / Modify

### New Files

| File | Purpose |
|------|---------|
| — | 无新增文件（改动收敛到现有模块） |

### Modified Files

#### Daemon

| File | Change |
|------|--------|
| `apps/daemon/src/routes/knowledge.ts` | 新增 `POST /api/knowledge/vaults/:id/assets/upload` 路由：接收 multipart/form-data 单文件，校验类型（image/png, image/jpeg, image/gif, image/webp），限制大小（默认 50MB），写入 `{vaultPath}/.molio/assets/{filename}`，返回 `{ filePath, url }` |

#### Web API Client

| File | Change |
|------|--------|
| `apps/web/src/api/client.ts` | 新增 `uploadAsset(vaultId: string, file: File): Promise<{ filePath: string; url: string }>` — `POST /api/knowledge/vaults/:id/assets/upload`，FormData 包装 |

#### Web UI

| File | Change |
|------|--------|
| `apps/web/src/components/ChatComposer.tsx` | 新增 `onPaste` handler：检测 clipboard items 中 image 类型 → 调用 `api.uploadAsset` → 在光标处插入 `![image](path)`。上传中在 textarea 上方显示 "📎 上传中..." 文字提示。失败 toast + 允许重试。onSend 签名不变。 |
| `apps/web/src/components/ChatComposer.css` | "上传中..." 提示样式 |

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
