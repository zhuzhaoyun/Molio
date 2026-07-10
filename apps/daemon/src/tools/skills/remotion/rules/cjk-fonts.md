---
name: cjk-fonts
description: Loading Chinese / Japanese / Korean fonts in Remotion — CJK fonts have huge character sets and need different handling than Latin fonts.
metadata:
  tags: fonts, cjk, chinese, japanese, korean, typography, i18n
---

# CJK fonts (Chinese / Japanese / Korean)

CJK fonts cover tens of thousands of glyphs, so Google Fonts serves them as **many unicode-range subset files** rather than one big file. This breaks the usual `@remotion/google-fonts` flow (which is designed for Latin fonts) and makes naive `@font-face` URLs fetch a lot of data. Handle CJK explicitly.

## Recommended: bundle the font file locally

The most reliable, cross-platform approach for CJK is to ship the `.ttf` / `.otf` in `public/` and load it via `@font-face` + `staticFile()`, blocking the render until the font is ready with `delayRender` / `continueRender`.

```tsx
import { continueRender, delayRender, staticFile, useCurrentFrame } from 'remotion';
import { useEffect, useState } from 'react';

// Load once at module scope so the delay is registered before first render.
const fontDelay = delayRender('Loading CJK font');

const FONT_FAMILY = 'MolioCJK';

const FontFace: React.FC = () => {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const face = new FontFace(
      FONT_FAMILY,
      `url('${staticFile('fonts/NotoSansSC-Regular.otf')}')`,
    );
    face.load().then((loaded) => {
      document.fonts.add(loaded);
      setReady(true);
      continueRender(fontDelay);
    }).catch(() => {
      // Don't block the whole render on a font failure — fall back.
      continueRender(fontDelay);
      setReady(true);
    });
  }, []);

  if (!ready) return null;
  return null;
};

export const MyScene: React.FC = () => {
  return (
    <>
      <FontFace />
      <div style={{ fontFamily: FONT_FAMILY, fontSize: 80 }}>知识管理新方式</div>
    </>
  );
};
```

Put the font file at `public/fonts/NotoSansSC-Regular.otf`. Common free CJK fonts:

- **Noto Sans SC / Noto Serif SC** (Google, OFL) — simplified Chinese
- **Noto Sans TC / Noto Serif TC** — traditional Chinese
- **Noto Sans JP / Noto Sans KR** — Japanese / Korean
- **Source Han Sans / Source Han Serif** (Adobe, OFL) — pan-CJK

Download from Google Fonts (https://fonts.google.com/noto) or the GitHub releases of `notofonts` / `adobe-fonts`.

## `@remotion/google-fonts` for CJK — caveats

Some CJK families ARE available via `@remotion/google-fonts` (e.g. `NotoSansSC`), but:

- Loading all weights pulls many subset files — slow first render and large bundle.
- Subset coverage can be incomplete for rare characters.
- Pin to the weights and subsets you actually use:

```tsx
import { loadFont } from '@remotion/google-fonts/NotoSansSC';

const { fontFamily } = loadFont('normal', {
  weights: ['400', '700'],
  // Let the loader pick the unicode-range subsets you need; avoid loading all.
});
```

If the loader produces a slow/flaky render, fall back to the local-file approach above.

## Avoid: relying on system CJK fonts

Do NOT rely on `fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif"` for renders that will be produced on a different OS than the one you author on. Headless Chrome on a Linux CI runner has neither PingFang nor YaHei — CJK text will fall back to a default sans and look wrong (or show tofu boxes). System fonts are fine for Studio preview on your own machine, but **bundled font files are the only guarantee for rendered output**.

## Mixed Latin + CJK

For mixed Latin/CJK text, you usually want a single CJK font that also covers Latin (Noto Sans SC does), rather than stacking a Latin font + CJK fallback. Stacking causes inconsistent baseline/spacing when the browser switches fonts mid-string. If you must stack, put the CJK font first so it owns the CJK glyphs and Latin falls through:

```tsx
fontFamily: "'Noto Sans SC', 'Inter', sans-serif"
```
