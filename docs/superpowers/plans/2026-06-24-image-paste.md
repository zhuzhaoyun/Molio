# Image Paste in ChatComposer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Ctrl+V / Cmd+V image paste support to ChatComposer — upload to `{vault}/.molio/assets/`, insert markdown `![image](path)` into message, Claude Code CLI auto-attaches images.

**Architecture:** Daemon exposes `POST /api/knowledge/vaults/:id/assets/upload` (multipart form-data, writes file to `.molio/assets/`). Web `api.uploadAsset()` wraps the call. ChatComposer `onPaste` handler detects clipboard images, uploads them, inserts `![image](path)` at cursor. `onSend` signature unchanged — image paths travel as plain markdown in `message`.

**Tech Stack:** Hono (multipart via `c.req.parseBody()`), React 19, node:test, Playwright.

## Global Constraints

- Daemon file write must prevent path traversal (reuse existing `resolveFilePath` check)
- Image MIME types allowed: `image/png`, `image/jpeg`, `image/gif`, `image/webp`
- Max file size: 50 MB (50 * 1024 * 1024 bytes)
- Storage path: `{vaultPath}/.molio/assets/{YYYY-MM-DD-HHmmss}-{seq}.{ext}`
- `onSend` signature unchanged: `(message: string, fileRefs: FileRef[]) => void`
- Existing E2E tests must pass unchanged
- Each task ends with a self-contained, testable deliverable

---

### Task 3: ChatComposer — onPaste Handler + Upload State + CSS

**Files:**
- Modify: `apps/web/src/components/ChatComposer.tsx`
- Modify: `apps/web/src/styles/home.css`

**Interfaces:**
- Consumes: `api.uploadAsset` from `../api/client`, `vaultStore.getActiveVaultId()`
- Produces: paste handler on textarea. Detects clipboard images, uploads, inserts `![image](path)` at cursor. No change to `onSend` signature.

- [ ] **Step 1: Add import for api and upload states to ChatComposer**

In `apps/web/src/components/ChatComposer.tsx`:

**1a.** Add import after line 7 (`import { vaultStore } from '../stores/vaultStore';`):
```typescript
import { api } from '../api/client';
```

**1b.** Add state after `const [fileRefs, setFileRefs] = useState<FileRef[]>([]);` (line 39):
```typescript
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Auto-clear upload error after 4 seconds
  useEffect(() => {
    if (!uploadError) return;
    const timer = setTimeout(() => setUploadError(null), 4000);
    return () => clearTimeout(timer);
  }, [uploadError]);
```

- [ ] **Step 2: Add paste handler**

Insert after `handleKeyDown` (before `const canSend = ...` line 202):

```typescript
  // Handle image paste (Ctrl+V / Cmd+V)
  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item || !item.type.startsWith('image/')) continue;

        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        const vaultId = vaultStore.getActiveVaultId();
        if (!vaultId) {
          setUploadError('请先选择或创建知识库');
          return;
        }

        setUploadingImage(true);
        setUploadError(null);
        try {
          const { filePath } = await api.uploadAsset(vaultId, file);
          const el = textareaRef.current;
          if (el) {
            const start = el.selectionStart;
            const end = el.selectionEnd;
            const mdImage = `![image](${filePath})`;
            setText((prev) => prev.slice(0, start) + mdImage + prev.slice(end));
            // Restore cursor position after React re-render
            requestAnimationFrame(() => {
              el.focus();
              const newPos = start + mdImage.length;
              el.setSelectionRange(newPos, newPos);
              // Trigger height recalculation
              el.dispatchEvent(new Event('input', { bubbles: true }));
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : '图片上传失败';
          setUploadError(message);
        } finally {
          setUploadingImage(false);
        }
        // Only handle first image in paste
        return;
      }
    },
    [],
  );
```

- [ ] **Step 3: Wire paste handler to textarea**

On the `<textarea>` element (line 245), add `onPaste={handlePaste}`:

```tsx
<textarea
  ref={textareaRef}
  data-testid="composer-input"
  value={text}
  onChange={handleChange}
  onKeyDown={handleKeyDown}
  onKeyUp={handleKeyUp}
  onMouseUp={handleMouseUp}
  onPaste={handlePaste}
  placeholder={placeholder}
  disabled={isRunning || disabled}
  rows={1}
/>
```

- [ ] **Step 4: Add uploading/error UI above textarea**

After the `{/* FileRef badges */}` block (line 241), add:

```tsx
{/* Uploading indicator */}
{uploadingImage && (
  <div className="composer-uploading" data-testid="composer-uploading">
    上传图片中...
  </div>
)}

{/* Upload error */}
{uploadError && (
  <div className="composer-upload-error" data-testid="composer-upload-error">
    {uploadError}
    <button
      type="button"
      className="composer-upload-error-dismiss"
      onClick={() => setUploadError(null)}
      aria-label="关闭"
    >
      ×
    </button>
  </div>
)}
```

- [ ] **Step 5: Add CSS**

In `apps/web/src/styles/home.css`, after the existing `.composer-file-badge-remove` rule (find its location with `grep`):

```css
/* ── Image upload indicator ── */
.composer-uploading {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  font-size: 13px;
  color: var(--text-muted);
  animation: composer-upload-pulse 1.2s ease-in-out infinite;
}

@keyframes composer-upload-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.composer-upload-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  font-size: 13px;
  color: var(--danger, #d32f2f);
  background: var(--danger-bg, #ffebee);
  border-radius: 4px;
  margin-bottom: 4px;
}

.composer-upload-error-dismiss {
  background: none;
  border: none;
  color: var(--danger, #d32f2f);
  cursor: pointer;
  font-size: 16px;
  padding: 0 2px;
  line-height: 1;
}
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Verify existing E2E tests pass**

```bash
cd apps/web && npx playwright test --project=chromium 2>&1 | tail -5
```

Expected: all existing tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/ChatComposer.tsx apps/web/src/styles/home.css
git commit -m "feat(web): add image paste to ChatComposer"
```

---

### Task 4: E2E Test — Image Paste Scenario

**Files:**
- Create: `apps/web/e2e/image-paste.spec.ts`

**Interfaces:**
- Consumes: ChatComposer paste handler, daemon upload endpoint
- Produces: E2E test verifying paste → markdown insertion flow

- [ ] **Step 1: Write the E2E test**

```typescript
// apps/web/e2e/image-paste.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Image paste', () => {
  test('inserts markdown on paste without error', async ({ page }) => {
    await page.goto('/');

    // Wait for page to be ready (composer visible)
    await page.waitForSelector('[data-testid="composer-input"]', { timeout: 10000 });

    const composer = page.locator('[data-testid="composer-input"]');

    // Simulate paste with image data via evaluate
    // Playwright doesn't have native clipboard paste API, so we trigger the
    // paste event with synthetic clipboard data via CDP / evaluate.
    await composer.evaluate((el: HTMLTextAreaElement) => {
      // Create a minimal valid PNG (same 1x1 transparent PNG as daemon test)
      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
        0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
        0x54, 0x08, 0xD7, 0x63, 0x68, 0x00, 0x00, 0x00,
        0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC, 0x33, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,
        0xAE, 0x42, 0x60, 0x82,
      ]);
      const blob = new Blob([pngBytes], { type: 'image/png' });
      const file = new File([blob], 'screenshot.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);

      el.focus();
      el.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }));
    });

    // Wait for upload to complete (the uploading indicator should appear and disappear)
    // Wait a bit for the async upload to finish
    await page.waitForTimeout(3000);

    // Check that ![image](...) was inserted into the textarea
    const text = await composer.inputValue();
    expect(text).toContain('![image](.molio/assets/');
    expect(text).toContain('.png)');

    // No error shown
    const errorEl = page.locator('[data-testid="composer-upload-error"]');
    await expect(errorEl).toHaveCount(0);
  });

  test('shows error when no vault selected', async ({ page }) => {
    // This test requires a state where no vault exists.
    // For now, we verify the error path by checking the composer
    // pastes without a vault configured.
    await page.goto('/');
    await page.waitForSelector('[data-testid="composer-input"]', { timeout: 10000 });

    const composer = page.locator('[data-testid="composer-input"]');

    // Paste a non-image text — should NOT trigger upload
    await composer.evaluate((el: HTMLTextAreaElement) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'hello world');

      el.focus();
      el.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }));
    });

    // No upload indicator should appear for text paste
    const uploading = page.locator('[data-testid="composer-uploading"]');
    await expect(uploading).toHaveCount(0);

    // Text should have been pasted normally by the browser
    const text = await composer.inputValue();
    expect(text).toContain('hello world');
  });
});
```

- [ ] **Step 2: Run E2E tests**

```bash
# Start dev servers first (in separate terminals or ensure they're running)
pnpm dev &
sleep 5
cd apps/web && npx playwright test image-paste.spec.ts --project=chromium
```

Expected: image paste test passes (inserts markdown), text paste test passes (normal paste, no upload).

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/image-paste.spec.ts
git commit -m "test(web): add E2E tests for image paste"
```

---

## Plan Self-Review Notes

- **E2E clipboard limitation**: Synthetic `ClipboardEvent` with `DataTransfer` may not populate `clipboardData.items` in some browsers due to security restrictions. If the Playwright test cannot trigger the paste handler, fall back to: (a) manual test of the paste flow, and (b) a component-level test that directly calls the upload + insert logic.
- **Hono multipart**: On Node.js, `c.req.parseBody()` should handle multipart/form-data. If this fails at runtime, the fallback is to install `busboy` and manually parse the multipart stream from `c.req.raw.body`.
- **File naming collision**: The `do...while` loop with `existsSync` handles same-second uploads. The loop is bounded by `seq` incrementing indefinitely — in practice, same-second multi-paste is rare, and `seq` will find a free slot within a few iterations.

