# Wiki Build Acceptance Test Runbook

This document records the acceptance test results for the scalable wiki-build feature on the `articles-1` vault.

## Prerequisites

- Branch: `codex/wiki-build-scalable`
- Latest commit: (fill in after all tasks complete)
- All automated tests passing: `pnpm test` in `apps/daemon`
- Typecheck passing: `pnpm typecheck` in `apps/daemon`

## Test Environment

- Vault: `D:\work\articles-1`
- CLI: `apps/daemon/src/tools/skills/wiki-build/scripts/wiki-build.mjs`

## Step 1: Pre-scan articles-1

Run the scan command to verify inventory generation:

```powershell
$cli = "D:\work\02-code\Molio-wiki-build-scalable\apps\daemon\src\tools\skills\wiki-build\scripts\wiki-build.mjs"
$vault = "D:\work\articles-1"
node $cli scan --vault $vault --json
```

**Expected results:**
- [ ] Exit status 0
- [ ] JSON output shows `ok: true` and `command: "scan"`
- [ ] `inventory.jsonl` created at `D:\work\articles-1\.molio\wiki-build\inventory.jsonl`
- [ ] Record total file count: ___
- [ ] Record supported/needs-confirmation/scan-error counts: ___
- [ ] Record total bytes by extension: ___

Verify inventory contents:

```powershell
node $cli status --vault $vault --json
```

**Expected results:**
- [ ] Exit status 0
- [ ] Phase shows `"scanned"`

## Step 2: Launch Molio desktop

```powershell
cd D:\work\02-code\Molio-wiki-build-scalable
pnpm dev:desktop
```

**Expected results:**
- [ ] Electron window opens
- [ ] Web UI loads at http://localhost:3100 (or 5173 in dev mode)
- [ ] Daemon starts without errors

## Step 3: Trigger wiki-build via Molio UI

In the Molio web UI:
1. Open the `articles-1` vault
2. Click "构建 Wiki" button (or type "构建 wiki" in chat)
3. The runtime agent should invoke the `wiki-build` skill

**Expected results:**
- [ ] Agent calls `scan --json` and reads `inventory.jsonl`
- [ ] Agent generates a candidate plan with topic hierarchy
- [ ] Agent calls `plan --input <candidate> --mode validate --json`
- [ ] **Critical:** Agent displays the plan to the user and WAITS for approval
- [ ] Agent does NOT call `approve` until user explicitly approves
- [ ] Agent does NOT write to `wiki/` until plan is approved

## Step 4: Approve and run build

After reviewing the plan:
1. User approves the plan in the chat
2. Agent calls `plan --input <candidate> --mode approve --json`
3. Agent loops: `next -> prepare -> checkpoint`

**Expected results:**
- [ ] `state.json` created after approval
- [ ] Batches processed one at a time
- [ ] Each batch: `next` returns claim, `prepare` returns work items, `checkpoint` commits
- [ ] Source pages written to `wiki/<topic>/sources/`
- [ ] Wiki pages written to `wiki/<topic>/<type>/`

## Step 5: Test crash recovery

After at least one batch completes:
1. Cancel the run in Molio UI
2. Click "构建 Wiki" again
3. Agent should detect pending batches and offer to recover

**Expected results:**
- [ ] Agent calls `status --json` and shows remaining work
- [ ] Agent asks for confirmation before calling `status --recover`
- [ ] After recovery, agent re-claims the interrupted batch
- [ ] New `attemptToken` generated
- [ ] Already-completed batches are NOT re-claimed

## Step 6: Finalize and verify indexes

After all batches complete:
1. Agent calls `finalize --summaries <path> --json`
2. Recursive indexes generated

**Expected results:**
- [ ] `wiki/INDEX.md` lists all top-level topics
- [ ] `wiki/<topic>/INDEX.md` lists child topics or pages
- [ ] Leaf topics with >200 pages or >12000 tokens have `index-shards/`
- [ ] All wikilinks resolve correctly
- [ ] State phase shows `"completed"` or `"completed_with_errors"` (if any files failed/skipped)

## Step 7: Query the recursive wiki

In the Molio chat, ask questions about the vault content:

**Expected results:**
- [ ] Agent reads `wiki/INDEX.md` first
- [ ] Agent navigates to relevant topic INDEX
- [ ] Agent reads leaf pages or index-shards
- [ ] Agent falls back to source files only when wiki evidence is insufficient
- [ ] Agent uses path-qualified wikilinks: `[[topic/subtopic/page|display]]`

## Summary

Record final metrics:
- Total files scanned: ___
- Total batches: ___
- Total wiki pages generated: ___
- Total index files generated: ___
- Build time: ___
- Any errors or skipped files: ___

## Sign-off

- [ ] All automated tests passing
- [ ] Pre-scan successful
- [ ] Molio UI workflow functional
- [ ] User approval gate works (no auto-approve)
- [ ] Crash recovery works
- [ ] Recursive indexes generated correctly
- [ ] Query navigation works

**Tester:** ___
**Date:** ___
**Commit SHA:** ___
