# Learnings

## [LRN-20260603-001] correction

**Logged**: 2026-06-03T13:18:38+08:00
**Priority**: high
**Status**: promoted
**Promoted**: CLAUDE.md (added "Runtime Context Loading" section)
**Area**: backend

### Summary
过度设计了"动态上下文注入"方案。用户只需要让 agent CLI 以项目目录为 `cwd` 启动，就能自动加载 CLAUDE.md 等上下文文件。

### Details
在 ZHU-28 调研中，我建议 KGE 为每次 run 在隔离目录动态生成 CLAUDE.md（拼接项目原有 CLAUDE.md + run 上下文 + 对话摘要）。用户纠正：对于本地知识库应用，他们只需要像"在 CMD 中 cd 到知识库目录然后运行 claude"一样的效果——即把项目的 `localPath` 作为 spawn 时的 `cwd` 传入即可。

查了代码，KGE daemon 的 `RunManager.ts` 已经支持 `cwd` 参数：
```typescript
cwd: opts.cwd || agentConfig.env?.['KGE_CWD'] || process.cwd()
```

Claude Code / Codex 启动时会自动读取 `cwd` 下的 `CLAUDE.md`、`.claude/` 配置、markdown 文件等。

**根本原因**：我看到 Multica 的 `execenv` 动态生成上下文，就直接套用了它的模式，没有考虑 KGE 的使用场景差异（本地知识库 vs 云端任务调度）。

### Suggested Action
Web UI 创建 run 时，从当前 project 取出 `localPath` 作为 `cwd` 传给 daemon API（`POST /api/runs`）。改动量很小，不需要动态生成上下文文件。

### Metadata
- Source: user_feedback
- Related Files: apps/daemon/src/core/RunManager.ts, apps/web/src/api/client.ts
- Tags: over-engineering, simplicity, cwd, context-loading

---

## [LRN-20260603-002] correction

**Logged**: 2026-06-03T14:45:00+08:00
**Priority**: high
**Status**: resolved
**Area**: frontend

### Summary
自动选择默认 agent 时，不应在用户已配置 `defaultAgentId` 的情况下静默回退到"第一个可用 agent"。应尊重用户选择，只在无任何默认配置时才自动选择并持久化。

### Details
在 ZHU-32 开发运行时页面时，我实现了自动选择逻辑：如果用户配置了 `defaultAgentId` 且该 agent 可用则使用它，否则回退到第一个可用 agent。用户指出这是错误的：

- 如果用户已通过 Runtime 页面双击设置了默认运行时，应该始终使用该设置，而不是随机选择其他 agent
- "第一个可用 agent 为默认运行时" 只在用户从未设置过默认运行时才应触发（一次性初始化）
- 如果配置的默认运行时变得不可用（比如用户卸载了），应该明确告知用户，而不是静默切换到另一个 agent

**错误根因**：我把"fallback"当作了"always-safe default"，实际上用户已经显式表达过偏好（通过双击设置），覆盖它等于无视用户意图。

**正确逻辑**：
```typescript
// 只在 selectedAgent 为空时运行
if (defaultAgentId) {
  // 用户已配置默认运行时
  if (agents.some((a) => a.id === defaultAgentId && a.available)) {
    setSelectedAgent(defaultAgentId);  // 尊重用户选择
  }
  // 如果配置的默认不可用，保持 null，让 UI 显示"no agent"引导
  return;
}

// 用户从未配置默认运行时（首次启动）
const firstAvailable = agents.find((a) => a.available);
if (firstAvailable) {
  setSelectedAgent(firstAvailable.id);
  setDefaultAgentId(firstAvailable.id);
  api.updateConfig({ defaultAgentId: firstAvailable.id }).catch(() => {});
  // 持久化到 config，下次启动时走上面的分支
}
```

### Suggested Action
修改 `App.tsx` 中的自动选择逻辑，区分"用户已配置默认"和"用户从未配置默认"两种情况。已提交修复 commit `71030c4`。

### Resolution
- **Resolved**: 2026-06-03T14:45:00+08:00
- **Commit**: 71030c4
- **Notes**: 已修复并构建验证通过

### Metadata
- Source: user_feedback
- Related Files: apps/web/src/App.tsx
- Tags: default-value, user-preference, fallback-logic, auto-selection
- See Also: LRN-20260603-001 (都是关于过度设计/忽略用户意图的纠正)

---
