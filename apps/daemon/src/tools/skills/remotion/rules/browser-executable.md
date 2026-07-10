---
name: browser-executable
description: Reuse the user's local Chrome/Edge instead of downloading Chrome Headless Shell — avoids a slow first-render download.
metadata:
  tags: browser, chrome, edge, render, first-run, offline
---

# Reuse a local browser instead of downloading Chrome Headless Shell

## Why this matters

By default, Remotion downloads **Chrome Headless Shell** from `storage.googleapis.com` on the first `render` / `still` call. That download:

- Is large (~150 MB) and runs once per machine, but on a slow or restricted network (common in China — `storage.googleapis.com` is often unreachable or throttled) it can hang for minutes or fail entirely.
- Adds a long, confusing pause before the very first frame appears.

Always prefer the user's **already-installed** Chrome or Edge for rendering. Pass its path via `--browser-executable`.

## Find the local browser

**Windows** (check in this order — use the first path that exists):

```
C:\Program Files\Google\Chrome\Application\chrome.exe
C:\Program Files (x86)\Google\Chrome\Application\chrome.exe
C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
C:\Program Files\Microsoft\Edge\Application\msedge.exe
```

**macOS:**

```
/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge
```

**Linux:**

```
/usr/bin/google-chrome
/usr/bin/google-chrome-stable
/usr/bin/microsoft-edge
/usr/bin/chromium
```

In bash, probe with `ls` and pick the first hit — don't hardcode a path without checking.

## Use it on the CLI

Pass `--browser-executable` to every `render` / `still` command:

```bash
# Windows (Git Bash — note the quoted path with spaces)
npx remotion still MolioIntro --frame=30 --scale=0.25 \
  --browser-executable="/c/Program Files/Google/Chrome/Application/chrome.exe" out/frame.png

# macOS / Linux
npx remotion render MolioIntro out/video.mp4 \
  --browser-executable="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

## Set it once for the whole project (optional)

To avoid repeating the flag, set it in `remotion.config.ts`:

```ts
import { Config } from '@remotion/cli/config';

Config.setBrowserExecutable(
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
);
```

The CLI `--browser-executable` flag overrides this, so the config is a safe default and the flag is an override.

## When you DO want the bundled headless shell

Only let Remotion download Chrome Headless Shell when:

- The user explicitly wants an isolated, version-pinned browser (reproducible CI renders).
- No local Chrome/Edge is installed (rare — probe the paths above first).

If you fall back to the download, warn the user it may take a while on a slow network, and offer `--browser-executable` as the faster path.
