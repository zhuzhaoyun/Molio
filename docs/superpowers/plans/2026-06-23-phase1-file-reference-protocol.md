# Phase 1: File Reference Protocol — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make file paths (wikilinks) clickable everywhere — chat messages, history, knowledge base — establishing the foundation for cross-page file navigation.

**Architecture:** A `useFileNavigation` hook provides context-aware file navigation (tab-open on KB page, route-navigate elsewhere). `AssistantMessage` uses event delegation on existing wikilink `<a>` tags to trigger navigation. `<FileRef>` is a standalone React component for future inline use.

**Tech Stack:** React 19, React Router v6, TypeScript, node:test (unit), Playwright (E2E)

## Global Constraints

- Daemon API: zero changes required
- CSS: use existing CSS variables from `apps/web/src/styles/tokens.css`
- `data-testid` attributes on all interactive elements per CLAUDE.md
- Wikilinks already rendered as `<a class="kb-wiki-link">` by `renderMarkdown` in `utils/markdown.ts` — leverage, don't rewrite
- File navigation uses existing `navigate('/knowledge', { state: { openFile, vaultId } })` pattern from GraphPage
- `KnowledgeBasePage` already handles `state.openFile` in its `useEffect` (line 67-74)

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `apps/web/src/hooks/useFileNavigation.ts` | Context-aware file navigation logic |
| Create | `apps/web/test/file-nav/useFileNavigation.test.ts` | Unit tests for navigation hook |
| Create | `apps/web/src/components/FileRef.tsx` | Inline file reference component |
| Create | `apps/web/src/components/FileRef.css` | FileRef badge styles |
| Modify | `apps/web/src/components/AssistantMessage.tsx` | Add wikilink click handler + event delegation |
| Modify | `apps/web/src/utils/markdown.ts` | Add `data-file-path` attr to wikilinks |
| Create | `apps/web/e2e/file-ref-navigation.spec.ts` | E2E tests for clickable file links |
| Modify | `apps/web/src/styles/chat.css` | `.kb-wiki-link` cursor + hover styles |

---

### Task 1: `useFileNavigation` Hook

**Files:**
- Create: `apps/web/src/hooks/useFileNavigation.ts`
- Create: `apps/web/test/file-nav/useFileNavigation.test.ts`

**Interfaces:**
- Consumes: `useLocation`, `useNavigate` (react-router-dom), `vaultStore` (stores/vaultStore), `kbTabsStore` (stores/kbTabsStore)
- Produces: `useFileNavigation(): { openFile, askAboutFile }`
  - `openFile(vaultId: string, filePath: string): void`
  - `askAboutFile(vaultId: string, filePath: string): void`

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/file-nav/useFileNavigation.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildNavState, buildAskAboutState } from '../../src/hooks/useFileNavigation';

describe('buildNavState — file navigation state builder', () => {
  it('should produce correct nav state from home page', () => {
    const result = buildNavState('vault-1', 'notes/test.md');
    assert.strictEqual(result.route, '/knowledge');
    assert.deepStrictEqual(result.state, { openFile: 'notes/test.md', vaultId: 'vault-1' });
  });

  it('should produce correct nav state from history page', () => {
    const result = buildNavState('vault-2', 'docs/api.md');
    assert.strictEqual(result.route, '/knowledge');
    assert.deepStrictEqual(result.state, { openFile: 'docs/api.md', vaultId: 'vault-2' });
  });

  it('should return null when vaultId is null', () => {
    const result = buildNavState(null, 'notes/test.md');
    assert.strictEqual(result, null);
  });

  it('should produce ask-about-file nav state', () => {
    const result = buildAskAboutState('vault-1', 'notes/test.md');
    assert.strictEqual(result.route, '/');
    assert.deepStrictEqual(result.state, { askAboutFile: 'notes/test.md', vaultId: 'vault-1' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/albert/workspace/Molio/apps/web && npx tsx --test test/file-nav/useFileNavigation.test.ts
```

Expected: FAIL — `buildNavState is not defined`

- [ ] **Step 3: Implement the hook**

Create `apps/web/src/hooks/useFileNavigation.ts`:

```typescript
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { vaultStore } from '../stores/vaultStore';

export interface NavState {
  route: string;
  state: { openFile: string; vaultId: string };
}

/**
 * Build the navigation target for opening a file.
 * Returns null if vaultId is missing (file navigation impossible).
 *
 * Always navigates to /knowledge with state. The KnowledgeBasePage
 * useEffect already watches location.state.openFile — it opens the file
 * whether arriving fresh or already on the page.
 */
export function buildNavState(
  vaultId: string | null,
  filePath: string,
): NavState | null {
  if (!vaultId) return null;

  return {
    route: '/knowledge',
    state: { openFile: filePath, vaultId },
  };
}

export interface AskAboutState {
  route: string;
  state: { askAboutFile: string; vaultId: string };
}

/**
 * Build the navigation target for "ask about this file".
 * Navigates to home page with file context for a new chat.
 */
export function buildAskAboutState(
  vaultId: string,
  filePath: string,
): AskAboutState {
  return {
    route: '/',
    state: { askAboutFile: filePath, vaultId },
  };
}

/**
 * React hook for file navigation.
 *
 * openFile: navigate to /knowledge with openFile state.
 *   Works regardless of current page — React Router triggers
 *   the KB page's useEffect even when already on /knowledge
 *   because location.state changes.
 *
 * askAboutFile: navigate to / with askAboutFile state.
 *   HomePage can use this to start a new conversation with
 *   file context pre-loaded.
 */
export function useFileNavigation() {
  const navigate = useNavigate();

  const getActiveVaultId = useCallback((): string | null => {
    return vaultStore.getActiveVaultId();
  }, []);

  const openFile = useCallback(
    (vaultId: string, filePath: string) => {
      const nav = buildNavState(vaultId, filePath);
      if (nav) {
        navigate(nav.route, { state: nav.state });
      }
    },
    [navigate],
  );

  const askAboutFile = useCallback(
    (vaultId: string, filePath: string) => {
      const nav = buildAskAboutState(vaultId, filePath);
      navigate(nav.route, { state: nav.state });
    },
    [navigate],
  );

  return { openFile, askAboutFile, getActiveVaultId };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/albert/workspace/Molio/apps/web && npx tsx --test test/file-nav/useFileNavigation.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hooks/useFileNavigation.ts apps/web/test/file-nav/useFileNavigation.test.ts
git commit -m "feat(web): add useFileNavigation hook with context-aware file routing"
```

---

### Task 2: `<FileRef>` Component

**Files:**
- Create: `apps/web/src/components/FileRef.tsx`
- Create: `apps/web/src/components/FileRef.css`

**Interfaces:**
- Consumes: `useFileNavigation` (hooks/useFileNavigation)
- Produces: `<FileRef vaultId filePath displayName? />`

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/FileRef.tsx`:

```typescript
import { useCallback } from 'react';
import { useFileNavigation } from '../hooks/useFileNavigation';
import './FileRef.css';

export interface FileRefProps {
  vaultId: string;
  filePath: string;
  /** Display name — defaults to filename extracted from path. */
  displayName?: string;
  /** CSS class override. */
  className?: string;
}

function extractFileName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function getFileIcon(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  if (ext === 'md') return '📄';
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'webp') return '🖼️';
  if (ext === 'pdf') return '📕';
  return '📄';
}

export function FileRef({ vaultId, filePath, displayName, className }: FileRefProps) {
  const { openFile } = useFileNavigation();
  const name = displayName || extractFileName(filePath);
  const icon = getFileIcon(filePath);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      openFile(vaultId, filePath);
    },
    [openFile, vaultId, filePath],
  );

  return (
    <a
      className={`file-ref ${className ?? ''}`}
      data-testid="file-ref"
      data-file-path={filePath}
      data-file-vault={vaultId}
      title={`${filePath}\n点击打开文件`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
    >
      <span className="file-ref__icon">{icon}</span>
      <span className="file-ref__name">{name}</span>
    </a>
  );
}
```

- [ ] **Step 2: Create styles**

Create `apps/web/src/components/FileRef.css`:

```css
.file-ref {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--color-surface-2);
  color: var(--color-accent);
  text-decoration: none;
  font-size: 0.9em;
  cursor: pointer;
  transition: background 0.15s;
  vertical-align: baseline;
}

.file-ref:hover {
  background: var(--color-accent-light);
  text-decoration: none;
}

.file-ref__icon {
  font-size: 1em;
  line-height: 1;
}

.file-ref__name {
  line-height: 1.4;
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/FileRef.tsx apps/web/src/components/FileRef.css
git commit -m "feat(web): add FileRef component for inline file references"
```

---

### Task 3: Modify `renderMarkdown` to Preserve File Path in Data Attribute

**Files:**
- Modify: `apps/web/src/utils/markdown.ts:42-50`

**Interfaces:**
- Consumes: nothing new
- Produces: wikilinks now have `data-file-path` attribute

- [ ] **Step 1: Update the wikilink regex replacements**

Modify `apps/web/src/utils/markdown.ts`. The current wikilink replacements at lines 42-50 generate plain `<a class="kb-wiki-link">`. Update them to preserve the path in a `data-file-path` attribute.

The challenge: wikilinks have already been through `escapeHtml()` at line 18. The path inside `$1` is escaped. However, since `escapeHtml` only escapes `&`, `<`, `>`, these characters rarely appear in file paths. The `data-file-path` attribute value will be safe because it's already HTML-entity-escaped.

Edit the two wikilink replacements:

Replace lines 42-50:
```typescript
  // Wiki-links: [[Page Name]] or [[Page Name|display text]]
  html = html.replace(
    /\[\[([^\]|]+)\|([^\]]+)\]\]/g,
    '<a class="kb-wiki-link">$2</a>'
  );
  html = html.replace(
    /\[\[([^\]]+)\]\]/g,
    '<a class="kb-wiki-link">$1</a>'
  );
```

With:
```typescript
  // Wiki-links: [[Page Name]] or [[Page Name|display text]]
  // data-file-path stores the raw path for click-navigation.
  html = html.replace(
    /\[\[([^\]|]+)\|([^\]]+)\]\]/g,
    (_m: string, path: string, display: string) =>
      `<a class="kb-wiki-link" data-file-path="${path}">${display}</a>`
  );
  html = html.replace(
    /\[\[([^\]]+)\]\]/g,
    (_m: string, path: string) =>
      `<a class="kb-wiki-link" data-file-path="${path}">${path}</a>`
  );
```

- [ ] **Step 2: Verify existing markdown tests still pass**

```bash
cd /Users/albert/workspace/Molio && grep -r "renderMarkdown\|markdown" apps/web/test/ --include='*.ts' -l
```

If no existing tests exist for `renderMarkdown`, verify manually that `pnpm typecheck` passes.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/utils/markdown.ts
git commit -m "feat(web): add data-file-path attribute to wikilinks in markdown renderer"
```

---

### Task 4: Integrate Click Handler into `AssistantMessage`

**Files:**
- Modify: `apps/web/src/components/AssistantMessage.tsx`
- Modify: `apps/web/src/styles/chat.css`

**Interfaces:**
- Consumes: `useActiveVaultId` (stores/vaultStore), `useFileNavigation` (hooks/useFileNavigation), `renderMarkdown` with new `data-file-path` attr
- Produces: clickable wikilinks in assistant messages

- [ ] **Step 1: Add imports and hook usage**

In `apps/web/src/components/AssistantMessage.tsx`, add to the imports at the top:

```typescript
import { useCallback } from 'react';
import { useActiveVaultId } from '../stores/vaultStore';
import { useFileNavigation } from '../hooks/useFileNavigation';
```

Inside the `AssistantMessage` function component, add after the existing hooks:

```typescript
  const activeVaultId = useActiveVaultId();
  const { openFile } = useFileNavigation();
```

- [ ] **Step 2: Add event delegation click handler**

Add a click handler function inside `AssistantMessage`, before the `return`:

```typescript
  const handleProseClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      const link = target.closest('.kb-wiki-link') as HTMLAnchorElement | null;
      if (!link || !activeVaultId) return;

      e.preventDefault();
      const filePath = link.getAttribute('data-file-path') || link.textContent?.trim();
      if (filePath) {
        openFile(activeVaultId, filePath);
      }
    },
    [openFile, activeVaultId],
  );
```

- [ ] **Step 3: Attach handler to prose container**

In the JSX, modify the `assistant-prose` div (line 116-120) to include the click handler and a role:

```tsx
      {displayContent && (
        <div
          className="assistant-prose"
          data-testid="assistant-prose"
          onClick={handleProseClick}
          role="presentation"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
```

- [ ] **Step 4: Add wikilink hover styles**

In `apps/web/src/styles/chat.css`, add (or find the appropriate section and append):

```css
.assistant-prose .kb-wiki-link {
  cursor: pointer;
  color: var(--color-accent);
  text-decoration: none;
  border-bottom: 1px dashed var(--color-accent);
  transition: background 0.15s;
}

.assistant-prose .kb-wiki-link:hover {
  background: var(--color-accent-light);
  border-bottom-style: solid;
}
```

- [ ] **Step 5: Typecheck and verify**

```bash
cd /Users/albert/workspace/Molio && pnpm typecheck
```

Expected: PASS with no new errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/AssistantMessage.tsx apps/web/src/styles/chat.css
git commit -m "feat(web): make wikilinks clickable in assistant messages via event delegation"
```

---

### Task 5: E2E Test for Clickable File Links

**Files:**
- Create: `apps/web/e2e/file-ref-navigation.spec.ts`

- [ ] **Step 1: Write the E2E test**

Create `apps/web/e2e/file-ref-navigation.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';

test.describe('File reference navigation', () => {
  test('wikilink in assistant message navigates to knowledge page', async ({ page }) => {
    // Navigate to home page
    await page.goto('http://localhost:5173');

    // Ensure a vault exists (the test environment should have one)
    // If no vault, skip the test gracefully
    const vaultExists = await page.locator('[data-testid="composer-input"]').isVisible({ timeout: 5000 }).catch(() => false);
    if (!vaultExists) {
      test.skip(true, 'No agent or vault available — skipping file ref test');
      return;
    }

    // Send a message that will produce a wikilink response
    // We ask about creating a file so the AI references it with a wikilink
    const input = page.locator('[data-testid="composer-input"]');
    await input.fill('请在你的回复中引用一个不存在的虚拟文件路径 [[test/example-doc.md]]，并说"这个文件在 test/example-doc.md"');
    await page.locator('[data-testid="composer-submit"]').click();

    // Wait for the assistant response
    const assistantMsg = page.locator('[data-testid="assistant-message"]').last();
    await assistantMsg.waitFor({ state: 'visible', timeout: 30000 });

    // Wait for response to finish streaming
    await page.waitForTimeout(2000);

    // Find the wikilink
    const wikiLink = assistantMsg.locator('.kb-wiki-link').first();
    if (await wikiLink.isVisible().catch(() => false)) {
      // Click the wikilink
      await wikiLink.click();

      // Should navigate to /knowledge
      await page.waitForURL(/\/knowledge/, { timeout: 5000 });
      expect(page.url()).toContain('/knowledge');
    }
  });

  test('wikilinks have proper styling and cursor', async ({ page }) => {
    await page.goto('http://localhost:5173');

    const input = page.locator('[data-testid="composer-input"]');
    await input.fill('请回复一个包含 [[notes/test.md]] 的简单确认消息');
    await page.locator('[data-testid="composer-submit"]').click();

    // Wait for assistant message
    const assistantMsg = page.locator('[data-testid="assistant-message"]').last();
    await assistantMsg.waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForTimeout(2000);

    const wikiLink = assistantMsg.locator('.kb-wiki-link').first();
    if (await wikiLink.isVisible().catch(() => false)) {
      // Verify the link has the data attribute
      const dataPath = await wikiLink.getAttribute('data-file-path');
      expect(dataPath).toBeTruthy();

      // Verify cursor is pointer
      const cursor = await wikiLink.evaluate(el => window.getComputedStyle(el).cursor);
      expect(cursor).toBe('pointer');
    }
  });
});
```

- [ ] **Step 2: Run E2E tests**

```bash
cd /Users/albert/workspace/Molio/apps/web && npx playwright test file-ref-navigation.spec.ts --headed
```

Expected: Tests pass (wikilinks clickable, navigate correctly).

If the dev server isn't running, start it first:
```bash
cd /Users/albert/workspace/Molio && pnpm dev &
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/file-ref-navigation.spec.ts
git commit -m "test(web): add E2E tests for wikilink click navigation"
```

---

### Task 6: Final Integration Check

- [ ] **Step 1: Run full typecheck**

```bash
cd /Users/albert/workspace/Molio && pnpm typecheck
```

- [ ] **Step 2: Run all unit tests**

```bash
cd /Users/albert/workspace/Molio && pnpm test
```

- [ ] **Step 3: Run existing E2E tests to confirm no regressions**

```bash
cd /Users/albert/workspace/Molio/apps/web && npx playwright test
```

- [ ] **Step 4: Run the new E2E tests one final time**

```bash
cd /Users/albert/workspace/Molio/apps/web && npx playwright test file-ref-navigation.spec.ts
```

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "chore(web): final integration check for Phase 1 file reference protocol"
```

---

## Verification Checklist

After all tasks complete, verify:

1. **Typecheck passes**: `pnpm typecheck` — zero errors
2. **Unit tests pass**: `cd apps/web && npx tsx --test test/file-nav/useFileNavigation.test.ts` — all green  
3. **E2E tests pass**: `npx playwright test` in `apps/web` — all green including new file-ref-navigation
4. **Manual smoke test**:
   - Send a chat message that produces a wikilink in the AI response
   - Click the wikilink → should navigate to `/knowledge`
   - The KB page should open with that file path resolved
5. **History page check**: Load a past conversation containing wikilinks → the messages render via `AssistantMessage`, wikilinks are clickable
6. **No CSS regression**: Wikilinks in chat look like links (accent color, dashed underline, pointer cursor)

## Known Deferrals

- **MdRenderer wikilink handling**: The KB page uses `doocs/md` rendering pipeline (marked v18), not `renderMarkdown` from `utils/markdown.ts`. Making wikilinks clickable in KB preview content requires modifying doocs/md's marked extensions — deferred to a follow-up task. Chat message wikilinks are the primary deliverable for Phase 1.
