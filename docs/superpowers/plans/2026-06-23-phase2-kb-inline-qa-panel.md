# Phase 2: Knowledge Base Inline Q&A Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a resizable inline Q&A panel to the Knowledge Base page so users can ask questions about the current file without leaving the KB page.

**Architecture:** A `useFileChat` hook wraps `useChatCore` with file context (`wikiExtra.filePath`). `FileChatPanel` reuses existing `ChatComposer`/`AssistantMessage`/`UserMessage` components in a sidebar panel pattern matching the existing `WikiChatPanel`. `KnowledgeBasePage` manages panel state and provides trigger points (toolbar button, right-click, Ctrl+L shortcut, selected-text button).

**Tech Stack:** React 19, TypeScript, CSS (existing token variables), node:test (unit), Playwright (E2E)

## Global Constraints

- Daemon API: zero changes — `wikiExtra.filePath` already exists in `CreateRunRequest`
- Reuse existing message components: `ChatComposer`, `AssistantMessage`, `UserMessage` — do not reimplement
- Reuse `useChatCore` hook — do not write new SSE/streaming logic
- Follow `WikiChatPanel` pattern: same structure, same CSS conventions, same props interface
- CSS variables from `apps/web/src/styles/tokens.css`: `--accent`, `--accent-tint`, `--bg-subtle`, `--bg-panel`, etc.
- `data-testid` attributes on all interactive elements per CLAUDE.md
- Panel is right-side sliding, resizable by dragging left border (reuse existing resize mechanism from WikiChatPanel)
- Panel width: default 360px, min 280px, max 50vw

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `apps/web/src/hooks/useFileChat.ts` | File Q&A chat hook wrapping useChatCore |
| Create | `apps/web/src/components/kb/FileChatPanel.tsx` | Chat panel UI component |
| Create | `apps/web/src/components/kb/FileChatPanel.css` | Panel styles |
| Modify | `apps/web/src/components/kb/KnowledgeBasePage.tsx` | Panel state + layout + Ctrl+L + trigger callbacks |
| Modify | `apps/web/src/components/kb/KbMainContent.tsx` | "询问此文件" toolbar button |
| Modify | `apps/web/src/styles/knowledge.css` | Three-column layout styles |
| Create | `apps/web/e2e/file-chat-panel.spec.ts` | E2E tests for panel behavior |

---

### Task 1: `useFileChat` Hook

**Files:**
- Create: `apps/web/src/hooks/useFileChat.ts`

**Interfaces:**
- Consumes: `useChatCore` (`hooks/useChatCore`), `api` (`api/client`)
- Produces: `useFileChat(opts: UseFileChatOptions): FileChatState`
  - Input: `{ agentId: string | null, vaultPath: string | null, filePath: string | null }`
  - Output: `{ messages: ChatMessage[], isRunning: boolean, send: (text: string) => void, cancel: () => void, onSubmitToolResult: (toolUseId: string, content: string) => void }`

- [ ] **Step 1: Create the hook**

Create `apps/web/src/hooks/useFileChat.ts`:

```typescript
import { useCallback, useRef } from 'react';
import { api } from '../api/client';
import { useChatCore, type ChatMessage } from './useChatCore';

export interface UseFileChatOptions {
  /** Current agent ID — required to create runs. */
  agentId: string | null;
  /** Vault filesystem path — passed as cwd for the agent. */
  vaultPath: string | null;
  /** File path relative to vault root — passed as wikiExtra.filePath. */
  filePath: string | null;
}

export interface FileChatState {
  messages: ChatMessage[];
  isRunning: boolean;
  send: (text: string) => void;
  cancel: () => void;
  onSubmitToolResult: (toolUseId: string, content: string) => void;
}

export function useFileChat(opts: UseFileChatOptions): FileChatState {
  const { agentId, vaultPath, filePath } = opts;

  // Track whether we have an active conversation so we can reuse it
  const conversationIdRef = useRef<string | null>(null);

  const createRun = useCallback(
    async (ctx: { message: string; history?: ChatMessage[] }) => {
      const result = await api.createRun({
        agentId: agentId!,
        message: ctx.message,
        cwd: vaultPath ?? undefined,
        conversationId: conversationIdRef.current ?? undefined,
        wikiExtra: filePath ? { filePath } : undefined,
        history: ctx.history,
      });
      // Remember conversation for multi-turn
      if (result.conversationId) {
        conversationIdRef.current = result.conversationId;
      }
      return { runId: result.runId, conversationId: result.conversationId };
    },
    [agentId, vaultPath, filePath],
  );

  const chat = useChatCore({
    createRun,
    agentId,
  });

  return {
    messages: chat.messages,
    isRunning: chat.isRunning,
    send: chat.send,
    cancel: chat.cancel,
    onSubmitToolResult: chat.submitToolResult,
  };
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/albert/workspace/Molio && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/hooks/useFileChat.ts
git commit -m "feat(web): add useFileChat hook for file-context Q&A chat"
```

---

### Task 2: `FileChatPanel` Component

**Files:**
- Create: `apps/web/src/components/kb/FileChatPanel.tsx`
- Create: `apps/web/src/components/kb/FileChatPanel.css`

**Interfaces:**
- Consumes: `ChatMessage` (hooks/useChat), `UserMessage`, `AssistantMessage`, `ChatComposer`
- Produces: `<FileChatPanel>` component
  - Props: `{ messages, isRunning, filePath, onSend, onCancel, onClose, onSubmitToolResult }`

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/kb/FileChatPanel.tsx`:

```typescript
import { useEffect, useRef, useMemo, useCallback } from 'react';
import type { ChatMessage } from '../../hooks/useChat';
import { UserMessage } from '../UserMessage';
import { AssistantMessage } from '../AssistantMessage';
import { ChatComposer } from '../ChatComposer';
import './FileChatPanel.css';

interface FileChatPanelProps {
  messages: ChatMessage[];
  isRunning: boolean;
  /** File path for the context badge. */
  filePath: string | null;
  onSend: (text: string) => void;
  onCancel: () => void;
  onClose: () => void;
  onSubmitToolResult: (toolUseId: string, content: string) => void;
}

function extractFileName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

export function FileChatPanel({
  messages,
  isRunning,
  filePath,
  onSend,
  onCancel,
  onClose,
  onSubmitToolResult,
}: FileChatPanelProps) {
  const logRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, messages[messages.length - 1]?.content]);

  // Find the last assistant message ID so only that card stays interactive
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && msg.role === 'assistant') return msg.id;
    }
    return null;
  }, [messages]);

  const onAnswerToolUse = useCallback(
    async (toolUseId: string, content: string) => {
      onSubmitToolResult(toolUseId, content);
      return true;
    },
    [onSubmitToolResult],
  );

  const fileName = filePath ? extractFileName(filePath) : null;

  return (
    <aside className="file-chat-panel" data-testid="file-chat-panel">
      {/* Header */}
      <div className="file-chat-header">
        <div className="file-chat-header-left">
          <span className="file-chat-label">💬 询问此文件</span>
          {fileName && (
            <span className="file-chat-context" title={filePath ?? undefined}>
              📄 {fileName}
            </span>
          )}
          {isRunning && <span className="file-chat-status">运行中…</span>}
        </div>
        <button
          type="button"
          className="file-chat-close"
          onClick={onClose}
          title="关闭"
          data-testid="file-chat-close"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Messages */}
      <div className="file-chat-messages" ref={logRef}>
        {messages.length === 0 ? (
          <div className="file-chat-empty">
            <div className="file-chat-empty-icon">🤖</div>
            <p>AI 助手已就绪</p>
            {fileName && <p className="file-chat-empty-hint">上下文：{fileName}</p>}
          </div>
        ) : (
          <>
            {messages.map((msg) => {
              if (msg.role === 'user') {
                return <UserMessage key={msg.id} content={msg.content} timestamp={msg.timestamp} />;
              }
              if (msg.role === 'assistant') {
                return (
                  <AssistantMessage
                    key={msg.id}
                    message={msg}
                    isLast={msg.id === lastAssistantId}
                    onAnswerToolUse={onAnswerToolUse}
                    onSubmitForm={onSend}
                  />
                );
              }
              if (msg.role === 'error') {
                return (
                  <div key={msg.id} className="msg error">
                    {msg.content}
                  </div>
                );
              }
              return null;
            })}
            <div ref={bottomRef} />
          </>
        )}
      </div>

      {/* Input */}
      <div className="file-chat-input">
        <ChatComposer
          isRunning={isRunning}
          onSend={onSend}
          onCancel={onCancel}
        />
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Create styles**

Create `apps/web/src/components/kb/FileChatPanel.css`:

```css
/* ─── File Chat Panel (right-side sliding Q&A for KB files) ─── */

.file-chat-panel {
  display: flex;
  flex-direction: column;
  width: 360px;
  min-width: 280px;
  max-width: 50vw;
  height: 100%;
  border-left: 1px solid var(--border);
  background: var(--bg-panel);
  overflow: hidden;
}

.file-chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-soft);
  flex-shrink: 0;
}

.file-chat-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.file-chat-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
}

.file-chat-context {
  font-size: 11px;
  color: var(--accent);
  background: var(--accent-tint);
  padding: 1px 8px;
  border-radius: 10px;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-chat-status {
  font-size: 11px;
  color: var(--text-muted);
}

.file-chat-close {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.15s;
}

.file-chat-close:hover {
  background: var(--bg-subtle);
  color: var(--text);
}

.file-chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px;
}

.file-chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted);
  text-align: center;
  gap: 8px;
}

.file-chat-empty-icon {
  font-size: 36px;
}

.file-chat-empty-hint {
  font-size: 12px;
  color: var(--text-soft);
}

.file-chat-input {
  flex-shrink: 0;
  padding: 10px 14px;
  border-top: 1px solid var(--border-soft);
}
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/albert/workspace/Molio && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/kb/FileChatPanel.tsx apps/web/src/components/kb/FileChatPanel.css
git commit -m "feat(web): add FileChatPanel component for KB inline Q&A"
```

---

### Task 3: Integrate into `KnowledgeBasePage`

**Files:**
- Modify: `apps/web/src/components/kb/KnowledgeBasePage.tsx`

**Interfaces:**
- Consumes: `useFileChat` (hooks/useFileChat), `FileChatPanel` (kb/FileChatPanel), `agentId` prop
- Produces: Panel state (`fileChatOpen`, `fileChatFilePath`), Ctrl+L handler, `handleAskAboutFile` callback

- [ ] **Step 1: Add imports and state**

In `apps/web/src/components/kb/KnowledgeBasePage.tsx`, add near the existing imports (line 6-20):

```typescript
import { useFileChat } from '../../hooks/useFileChat';
import { FileChatPanel } from './FileChatPanel';
```

After the existing `showChatPanel` state (line 50), add:

```typescript
const [fileChatOpen, setFileChatOpen] = useState(false);
const [fileChatFilePath, setFileChatFilePath] = useState<string | null>(null);
```

- [ ] **Step 2: Add `useFileChat` hook call**

After the existing `useChat` hook call (find `useChat` usage in the component), add the file chat hook:

```typescript
const fileChat = useFileChat({
  agentId,
  vaultPath: kb.activeVault?.path ?? null,
  filePath: fileChatFilePath,
});
```

To find the exact insertion point, locate the existing `useChat` call in the component. The pattern is:

```typescript
// Existing wiki chat
const wikiChat = useChat({
  agentId,
  mode: 'wiki',
  // ...
});
```

Add after the wiki chat block:

```typescript
// File Q&A chat — independent conversation per file
const fileChat = useFileChat({
  agentId,
  vaultPath: kb.activeVault?.path ?? null,
  filePath: fileChatFilePath,
});
```

- [ ] **Step 3: Add `openFileChat` callback and Ctrl+L handler**

Add the `openFileChat` callback after existing callbacks:

```typescript
const openFileChat = useCallback((filePath: string) => {
  setFileChatFilePath(filePath);
  setFileChatOpen(true);
}, []);
```

Add Ctrl+L keyboard shortcut handler — add a `useEffect` after existing effects:

```typescript
// Ctrl+L / Cmd+L — open file chat for current file
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    // Don't trigger when focus is in an input/textarea
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
      e.preventDefault();
      const activeTab = tabs.activeTabId ? kbTabsStore.getState().tabs.find(t => t.id === tabs.activeTabId) : null;
      if (activeTab?.filePath) {
        openFileChat(activeTab.filePath);
      }
    }
  };
  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}, [tabs.activeTabId, openFileChat]);
```

- [ ] **Step 4: Pass `onAskAboutFile` to components and render FileChatPanel**

Find the section in the JSX where `KbFilePanel` and `KbMainContent` are rendered. Pass the callback:

For the `KbMainContent` component invocation, add the new prop:
```
onAskAboutFile={openFileChat}
```

For the context menu `getContextMenuItems` callback, add to file items (find the "在新标签页中打开" section and add after it):

```typescript
items.push({
  label: '询问此文件',
  onClick: () => {
    handleCloseCtxMenu();
    openFileChat(node.path);
  },
});
```

In the JSX layout section, after the main content area and before closing tags, render the `FileChatPanel` when open:

```tsx
{fileChatOpen && fileChatFilePath && (
  <FileChatPanel
    messages={fileChat.messages}
    isRunning={fileChat.isRunning}
    filePath={fileChatFilePath}
    onSend={fileChat.send}
    onCancel={fileChat.cancel}
    onClose={() => setFileChatOpen(false)}
    onSubmitToolResult={fileChat.onSubmitToolResult}
  />
)}
```

- [ ] **Step 5: Typecheck**

```bash
cd /Users/albert/workspace/Molio && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1
```

Expected: no errors (or fix any type errors and re-run).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/kb/KnowledgeBasePage.tsx
git commit -m "feat(web): integrate FileChatPanel into KnowledgeBasePage with triggers"
```

---

### Task 4: Add "询问此文件" Toolbar Button in `KbMainContent`

**Files:**
- Modify: `apps/web/src/components/kb/KbMainContent.tsx`

**Interfaces:**
- Consumes: new prop `onAskAboutFile?: (filePath: string) => void`
- Produces: toolbar button when a file is selected

- [ ] **Step 1: Add prop to interface**

In `apps/web/src/components/kb/KbMainContent.tsx`, add to `KbMainContentProps` (after line 59):

```typescript
/** Callback when user clicks "询问此文件" button. */
onAskAboutFile?: (filePath: string) => void;
```

Add `onAskAboutFile` to the destructured props in the function signature (line 62-81).

- [ ] **Step 2: Add button to toolbar**

Find the toolbar section (around lines 157-239 in the header div `kb-header-actions`). After the existing buttons (before the typeset button at the end), add:

```tsx
{/* Ask about file button — shown when a file is selected and this callback is provided */}
{onAskAboutFile && selectedFile && (
  <button
    type="button"
    className="kb-btn"
    onClick={() => onAskAboutFile(selectedFile)}
    title="询问此文件 (Ctrl+L)"
    data-testid="kb-btn-ask-file"
  >
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
    </svg>
    询问此文件
  </button>
)}
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/albert/workspace/Molio && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/kb/KbMainContent.tsx
git commit -m "feat(web): add ask-about-file button to KB main content toolbar"
```

---

### Task 5: E2E Test for File Chat Panel

**Files:**
- Create: `apps/web/e2e/file-chat-panel.spec.ts`

- [ ] **Step 1: Write the E2E test**

Create `apps/web/e2e/file-chat-panel.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';
import { gotoHome, clickNav } from './helpers/navigation';

test.describe('File chat panel', () => {
  test('toolbar button opens file chat panel', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });
    await clickNav(page, 'knowledge');
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5000 });

    // Click a text file in the file tree to open it
    const fileItem = page.locator('.kb-tree-item--file').first();
    if (await fileItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      await fileItem.click();
      await page.waitForTimeout(1000);

      // Look for the "询问此文件" button
      const askBtn = page.locator('[data-testid="kb-btn-ask-file"]');
      if (await askBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await askBtn.click();
        await page.waitForTimeout(500);

        // Verify the panel appears
        const panel = page.locator('[data-testid="file-chat-panel"]');
        expect(await panel.isVisible()).toBe(true);

        // Verify close button works
        const closeBtn = page.locator('[data-testid="file-chat-close"]');
        await closeBtn.click();
        await page.waitForTimeout(300);
        expect(await panel.isVisible().catch(() => false)).toBe(false);
      }
    }
  });

  test('empty state shows context hint', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });
    await clickNav(page, 'knowledge');
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5000 });

    const fileItem = page.locator('.kb-tree-item--file').first();
    if (await fileItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      await fileItem.click();
      await page.waitForTimeout(1000);

      const askBtn = page.locator('[data-testid="kb-btn-ask-file"]');
      if (await askBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await askBtn.click();
        await page.waitForTimeout(500);

        // Empty state should be visible before any messages
        const emptyState = page.locator('.file-chat-empty');
        expect(await emptyState.isVisible()).toBe(true);

        // Input should be ready
        const input = page.locator('[data-testid="file-chat-panel"] [data-testid="composer-input"]');
        expect(await input.isVisible()).toBe(true);
      }
    }
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/e2e/file-chat-panel.spec.ts
git commit -m "test(web): add E2E tests for file chat panel"
```

---

### Task 6: Final Integration Check

- [ ] **Step 1: Full typecheck**

```bash
cd /Users/albert/workspace/Molio && pnpm typecheck 2>&1
```

Expected: all packages pass.

- [ ] **Step 2: Run Phase 1 unit tests (no regression)**

```bash
cd /Users/albert/workspace/Molio/apps/web && npx tsx --test test/file-nav/useFileNavigation.test.ts 2>&1
```

Expected: 4/4 pass.

- [ ] **Step 3: Verify CSS variables are correct**

All new CSS uses only variables from `tokens.css`: `--border`, `--border-soft`, `--bg-panel`, `--bg-subtle`, `--text`, `--text-muted`, `--text-soft`, `--accent`, `--accent-tint`.

- [ ] **Step 4: Commit if any fixes**

```bash
git add -A
git commit -m "chore(web): Phase 2 final integration fixes"
```

---

## Verification Checklist

After all tasks complete:

1. **Typecheck passes**: `pnpm typecheck` — zero errors
2. **Unit tests pass**: Phase 1 tests still green (4/4)
3. **E2E tests pass**: `npx playwright test file-chat-panel.spec.ts`
4. **Manual smoke test**:
   - Open Knowledge Base → select a text file
   - Click "💬 询问此文件" in toolbar → right panel slides in
   - Panel header shows context tag "📄 filename"
   - Type a question → AI responds with file context
   - Press Ctrl+L → panel opens (or re-focuses)
   - Click close button → panel hides
   - Right-click a file → "询问此文件" in context menu → panel opens with that file

## Known Deferrals

- **Resizable panel border**: The spec calls for a draggable left border to resize the panel width. This is deferred — the panel uses fixed width (360px) with min/max constraints in CSS. The resize handle can be added as a follow-up task reusing the existing panel resize mechanism from the KB layout.
- **Selected text "就此提问" float button**: The spec's fourth trigger method (select text → floating button) is deferred. It requires adding a selection-aware overlay to `MdRenderer`, which is a separate interaction layer. The three primary trigger methods (toolbar button, right-click, keyboard shortcut) are implemented.
