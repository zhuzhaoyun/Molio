# LLM Wiki Remotion Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and render a 150-second, 1920×1080 Remotion video that explains LLM Wiki in Chinese and shows how Molio implements the workflow.

**Architecture:** Add an isolated Remotion package at `apps/llm-wiki-video`. Keep narration, captions, scene timing, and visual beats in one typed content module. Compose six frame-driven React scenes, layer generated Mandarin narration and deterministic audio, then verify representative stills and the final MP4.

**Tech Stack:** React 19, TypeScript, Remotion, `@remotion/media`, `@remotion/captions`, `@remotion/transitions`, node:test, Edge neural TTS, FFmpeg.

---

## File map

- `apps/llm-wiki-video/package.json`: package scripts and Remotion dependencies.
- `apps/llm-wiki-video/tsconfig.json`: strict TypeScript configuration.
- `apps/llm-wiki-video/remotion.config.ts`: output and image-format defaults.
- `apps/llm-wiki-video/src/index.ts`: Remotion entry point.
- `apps/llm-wiki-video/src/Root.tsx`: Composition registration.
- `apps/llm-wiki-video/src/content.ts`: scene timing, narration, captions, and visual beats.
- `apps/llm-wiki-video/src/theme.ts`: palette, typography, spacing, and easing constants.
- `apps/llm-wiki-video/src/LlmWikiVideo.tsx`: scene, caption, and audio orchestration.
- `apps/llm-wiki-video/src/components/`: reusable cards, graph, Wiki page, Molio shell, captions, and scene chrome.
- `apps/llm-wiki-video/src/scenes/`: six scene components with one narrative responsibility each.
- `apps/llm-wiki-video/test/content.test.ts`: timing and caption invariants.
- `apps/llm-wiki-video/scripts/generate-audio.ps1`: voiceover, background music, and cue generation.
- `apps/llm-wiki-video/public/audio/`: generated narration, music, and cues.
- `apps/llm-wiki-video/out/`: rendered stills and final MP4.

### Task 1: Scaffold the isolated Remotion package

**Files:**
- Create: `apps/llm-wiki-video/package.json`
- Create: `apps/llm-wiki-video/tsconfig.json`
- Create: `apps/llm-wiki-video/remotion.config.ts`
- Create: `apps/llm-wiki-video/src/index.ts`

- [ ] **Step 1: Add package metadata and scripts**

Use package name `@molio/llm-wiki-video`. Add scripts `studio`, `test`, `typecheck`, `still`, and `render`. Pin every Remotion package to the same version. The render command must target composition `LlmWikiExplainer` and output `out/llm-wiki-explainer.mp4` with H.264.

- [ ] **Step 2: Register the Remotion entry point**

```ts
import {registerRoot} from 'remotion';
import {RemotionRoot} from './Root';

registerRoot(RemotionRoot);
```

- [ ] **Step 3: Install workspace dependencies**

Run: `pnpm install`

Expected: pnpm recognizes six workspace projects and updates `pnpm-lock.yaml` without peer-version conflicts.

- [ ] **Step 4: Verify the intentionally incomplete scaffold**

Run: `pnpm --filter @molio/llm-wiki-video typecheck`

Expected: FAIL because `src/Root.tsx` does not exist yet.

- [ ] **Step 5: Commit the scaffold**

```bash
git add apps/llm-wiki-video/package.json apps/llm-wiki-video/tsconfig.json apps/llm-wiki-video/remotion.config.ts apps/llm-wiki-video/src/index.ts pnpm-lock.yaml
git commit -m "chore(video): scaffold Remotion explainer"
```

### Task 2: Define the narration and validated timeline

**Files:**
- Create: `apps/llm-wiki-video/src/content.ts`
- Create: `apps/llm-wiki-video/test/content.test.ts`

- [ ] **Step 1: Write failing timeline tests**

The tests must assert:

```ts
assert.equal(FPS, 30);
assert.equal(TOTAL_FRAMES, 4500);
assert.deepEqual(SCENES.map((scene) => scene.id), [
  'problem', 'definition', 'build', 'comparison', 'molio', 'summary',
]);
assert.equal(SCENES.at(-1)!.endFrame, TOTAL_FRAMES);
assert.ok(SCENES.every((scene, index) => index === 0 || scene.startFrame === SCENES[index - 1]!.endFrame));
assert.ok(CAPTIONS.every((caption, index) => caption.startMs < caption.endMs && (index === 0 || caption.startMs >= CAPTIONS[index - 1]!.endMs)));
assert.ok(CAPTIONS.every((caption) => caption.text.replace(/\s/g, '').length <= 24));
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `pnpm --filter @molio/llm-wiki-video test`

Expected: FAIL because `src/content.ts` does not exist.

- [ ] **Step 3: Implement the content model**

Define `FPS = 30`, `TOTAL_FRAMES = 4500`, and six contiguous scenes at frames `0`, `540`, `1350`, `2340`, `3150`, `4080`, and `4500`. Export:

```ts
export type SceneId = 'problem' | 'definition' | 'build' | 'comparison' | 'molio' | 'summary';
export type SceneSpec = {
  id: SceneId;
  startFrame: number;
  endFrame: number;
  title: string;
  narration: string;
};
```

Use direct Mandarin narration. Cover the file-hoarding problem, the explicit Wiki layer, the build-and-update loop, RAG comparison, Molio implementation, and the closing idea “从保存资料，到维护认知”. Build `CAPTIONS` as `Caption[]` with hand-authored phrase timing derived from the same scene boundaries.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @molio/llm-wiki-video test && pnpm --filter @molio/llm-wiki-video typecheck`

Expected: timeline tests PASS; typecheck still fails only because `Root.tsx` is not implemented.

- [ ] **Step 5: Commit content and tests**

```bash
git add apps/llm-wiki-video/src/content.ts apps/llm-wiki-video/test/content.test.ts
git commit -m "feat(video): define LLM Wiki narrative timeline"
```

### Task 3: Build the visual system and reusable components

**Files:**
- Create: `apps/llm-wiki-video/src/theme.ts`
- Create: `apps/llm-wiki-video/src/components/SceneLayout.tsx`
- Create: `apps/llm-wiki-video/src/components/KnowledgeCard.tsx`
- Create: `apps/llm-wiki-video/src/components/KnowledgeGraph.tsx`
- Create: `apps/llm-wiki-video/src/components/WikiPage.tsx`
- Create: `apps/llm-wiki-video/src/components/MolioShell.tsx`
- Create: `apps/llm-wiki-video/src/components/Captions.tsx`

- [ ] **Step 1: Add theme constants**

Export the Molio-aligned palette `background: #0F1117`, `surface: #1A1D2A`, `text: #F5F3FF`, `muted: #9CA3AF`, `accent: #8B5CF6`, `accentStrong: #7C3AED`, and `edge: rgba(255,255,255,0.12)`. Export `easeOut = Easing.bezier(0.16, 1, 0.3, 1)` and a Chinese system font stack.

- [ ] **Step 2: Implement frame-driven primitives**

Every component reads local time with `useCurrentFrame()` and `useVideoConfig()`. Use `interpolate()` with clamped ranges. Do not add CSS animation or transition declarations. `KnowledgeGraph` must derive deterministic node positions from props; it must not call `Math.random()`.

- [ ] **Step 3: Implement captions from JSON**

`Captions.tsx` accepts `Caption[]`, groups them with `createTikTokStyleCaptions({combineTokensWithinMilliseconds: 1800})`, and renders each page in a premounted `<Sequence>`. Keep the caption block inside a 120-pixel bottom safe area, cap it at two lines, preserve whitespace, and color only the active token purple.

- [ ] **Step 4: Typecheck the components**

Run: `pnpm --filter @molio/llm-wiki-video typecheck`

Expected: errors may only reference the still-missing scenes or Root, not component types.

- [ ] **Step 5: Commit reusable visuals**

```bash
git add apps/llm-wiki-video/src/theme.ts apps/llm-wiki-video/src/components
git commit -m "feat(video): add LLM Wiki visual system"
```

### Task 4: Implement the six narrative scenes

**Files:**
- Create: `apps/llm-wiki-video/src/scenes/ProblemScene.tsx`
- Create: `apps/llm-wiki-video/src/scenes/DefinitionScene.tsx`
- Create: `apps/llm-wiki-video/src/scenes/BuildScene.tsx`
- Create: `apps/llm-wiki-video/src/scenes/ComparisonScene.tsx`
- Create: `apps/llm-wiki-video/src/scenes/MolioScene.tsx`
- Create: `apps/llm-wiki-video/src/scenes/SummaryScene.tsx`

- [ ] **Step 1: Implement problem and definition scenes**

Animate six source cards into a scattered layout, highlight the failed search state, then extract four concepts and connect them into a graph. Use string slicing for the single search-query typewriter effect.

- [ ] **Step 2: Implement the build scene**

Show the five-state loop “读取 → 提取 → 关联 → 生成 → 更新”. Light each state from the scene frame, route a document card through the stages, then assemble a Wiki page with a visible source reference.

- [ ] **Step 3: Implement the comparison scene**

Use a stable split-screen. On the left, animate question → retrieved chunks → answer. On the right, animate sources → linked pages → reusable knowledge. End with a shared connector labeled “组合使用”.

- [ ] **Step 4: Implement Molio and summary scenes**

Build a code-native Molio shell with a file tree, pending/clean/modified ingest states, Wiki page, graph, and query panel. The summary collapses the graph into one Wiki page and reveals the closing line and Molio name.

- [ ] **Step 5: Commit scenes**

```bash
git add apps/llm-wiki-video/src/scenes
git commit -m "feat(video): animate six LLM Wiki scenes"
```

### Task 5: Compose scenes, transitions, captions, and audio

**Files:**
- Create: `apps/llm-wiki-video/src/LlmWikiVideo.tsx`
- Create: `apps/llm-wiki-video/src/Root.tsx`

- [ ] **Step 1: Compose the exact 4500-frame timeline**

Use six premounted `<Sequence>` elements with the scene boundaries from `content.ts`. Keep the duration exact; use frame-driven line wipes layered over cuts instead of `TransitionSeries` overlaps that would shorten the composition.

- [ ] **Step 2: Add media layers**

Use `<Audio>` from `@remotion/media` and `staticFile()` for `audio/voiceover.mp3`, `audio/music.wav`, and cue files. Set voiceover volume to `1`, music to `0.11` with one-second fade-in/out, and cues between `0.16` and `0.24`.

- [ ] **Step 3: Register the Composition**

```tsx
<Composition
  id="LlmWikiExplainer"
  component={LlmWikiVideo}
  durationInFrames={TOTAL_FRAMES}
  fps={FPS}
  width={1920}
  height={1080}
/>
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @molio/llm-wiki-video test && pnpm --filter @molio/llm-wiki-video typecheck`

Expected: all tests and TypeScript checks PASS.

- [ ] **Step 5: Commit composition wiring**

```bash
git add apps/llm-wiki-video/src/LlmWikiVideo.tsx apps/llm-wiki-video/src/Root.tsx
git commit -m "feat(video): compose narrated LLM Wiki explainer"
```

### Task 6: Generate the Mandarin narration and deterministic sound bed

**Files:**
- Create: `apps/llm-wiki-video/scripts/generate-audio.ps1`
- Create: `apps/llm-wiki-video/public/audio/voiceover.mp3`
- Create: `apps/llm-wiki-video/public/audio/music.wav`
- Create: `apps/llm-wiki-video/public/audio/connect.wav`
- Create: `apps/llm-wiki-video/public/audio/complete.wav`

- [ ] **Step 1: Export narration text from `SCENES`**

The script joins the six narration strings with 450-millisecond pauses. Generate `voiceover.mp3` with a neutral Mandarin neural voice, preferring `zh-CN-YunxiNeural`. Keep the generated file in `public/audio` so Remotion references it with `staticFile()`.

- [ ] **Step 2: Generate music and cues with FFmpeg**

Create a 150-second stereo WAV from quiet sine layers at 110 Hz, 220 Hz, and 330 Hz with slow volume modulation. Create short connect and completion cues from sine sweeps. These files are deterministic and contain no licensed samples.

- [ ] **Step 3: Measure audio**

Run `ffprobe` for every file. Expected: voiceover is shorter than 150 seconds; music is 150 seconds; cue files are shorter than one second. If voiceover exceeds its scene timing, regenerate at a faster neural-voice rate before changing the approved scene boundaries.

- [ ] **Step 4: Commit scripts and final audio assets**

```bash
git add apps/llm-wiki-video/scripts apps/llm-wiki-video/public/audio
git commit -m "feat(video): add Mandarin narration and sound design"
```

### Task 7: Render, inspect, and package the final video

**Files:**
- Create: `apps/llm-wiki-video/out/check-0015.png`
- Create: `apps/llm-wiki-video/out/check-0030.png`
- Create: `apps/llm-wiki-video/out/check-0088.png`
- Create: `apps/llm-wiki-video/out/check-0120.png`
- Create: `apps/llm-wiki-video/out/check-0146.png`
- Create: `apps/llm-wiki-video/out/llm-wiki-explainer.mp4`

- [ ] **Step 1: Render five representative stills**

Render frames 450, 900, 2640, 3600, and 4380. Inspect all five for clipping, subtitle safe area, graph legibility, and product hierarchy. Fix the source, then rerender any failed frame.

- [ ] **Step 2: Render the complete MP4**

Run: `pnpm --filter @molio/llm-wiki-video render`

Expected: `out/llm-wiki-explainer.mp4` renders at 1920×1080, 30 fps, H.264 with audio.

- [ ] **Step 3: Verify media metadata**

Use `ffprobe` to assert width `1920`, height `1080`, frame rate `30/1`, duration close to `150`, and both video and audio streams present.

- [ ] **Step 4: Run final repository checks**

Run:

```bash
pnpm --filter @molio/llm-wiki-video test
pnpm --filter @molio/llm-wiki-video typecheck
git diff --check
```

Expected: all commands PASS with no whitespace errors.

- [ ] **Step 5: Commit final render and verification artifacts**

```bash
git add apps/llm-wiki-video/out
git commit -m "feat(video): render LLM Wiki explainer"
```

- [ ] **Step 6: Push and create a pull request**

Push `feat/llm-wiki-video`, then create a PR against `main` titled `feat: add LLM Wiki Remotion explainer video`. Include the final MP4 path, validation commands, and the baseline-test sandbox limitation in the PR body.
