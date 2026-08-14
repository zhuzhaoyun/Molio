/**
 * Lazy MathJax v3 loader for the doocs/md KaTeX extension.
 *
 * The vendored doocs/md `katex.ts` extension renders formulas via the global
 * `window.MathJax` object (`tex2svg` / `texReset`). Molio never loaded MathJax,
 * so every `$...$` / `$$...$$` / `\(...\)` / `\[...\]` formula fell through to
 * a raw-LaTeX fallback and displayed as source text.
 *
 * Here we load the self-contained `tex-svg-full.js` combined component as a
 * local Vite asset — no CDN, so it works offline and behind restrictive
 * networks (see memory: network-env-github-access). MdRenderer gates rendering
 * on `mathJaxReady()` and re-renders once `ensureMathJax()` resolves, so
 * formulas upgrade from raw text to real SVG without a crash.
 *
 * Loaded at most once; concurrent callers share a single promise.
 */

import texSvgFullUrl from 'mathjax/es5/tex-svg-full.js?url';

let readyPromise: Promise<void> | null = null;

/** True once `window.MathJax.tex2svg` / `texReset` are available. */
export function mathJaxReady(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { MathJax?: { tex2svg?: unknown; texReset?: unknown } }).MathJax?.tex2svg ===
      'function' &&
    typeof (window as unknown as { MathJax?: { texReset?: unknown } }).MathJax?.texReset === 'function'
  );
}

/**
 * Ensure MathJax is loaded and ready. Resolves once `tex2svg` / `texReset` are
 * callable; rejects only if the local asset fails to load. On failure the
 * cached promise is cleared so a later render retries.
 */
export function ensureMathJax(): Promise<void> {
  if (mathJaxReady()) return Promise.resolve();
  if (!readyPromise) {
    readyPromise = injectMathJax().catch((err: unknown) => {
      readyPromise = null; // allow a later retry
      throw err;
    });
  }
  return readyPromise;
}

function injectMathJax(): Promise<void> {
  return new Promise((resolve, reject) => {
    // Configure BEFORE the component script runs (MathJax v3 merges this into
    // its startup). Safety measures:
    //  - `startup.typeset: false` — never auto-scan the app DOM for math, so
    //    unrelated content (e.g. chat messages containing `\(...\)` text) is
    //    not silently typeset. We only ever call `tex2svg` explicitly.
    //  - `enableMenu` / `enableAssistiveMml` off — avoid the lazy jsdelivr
    //    loads (speech-rule-engine, mathmaps) that those features trigger;
    //    core SVG typesetting is fully self-contained.
    (window as unknown as { MathJax: object }).MathJax = {
      startup: { typeset: false },
      options: { enableMenu: false, enableAssistiveMml: false },
    };

    const script = document.createElement('script');
    script.src = texSvgFullUrl;
    script.async = true;
    script.onload = () => {
      // `tex2svg` / `texReset` are wired at the end of the bundle, but wait for
      // the startup promise to settle before declaring readiness.
      Promise.resolve((window as unknown as { MathJax?: { startup?: { promise?: Promise<unknown> } } }).MathJax?.startup?.promise)
        .then(() => {
          if (!mathJaxReady()) {
            reject(new Error('MathJax loaded but tex2svg/texReset unavailable'));
            return;
          }
          resolve();
        })
        .catch((err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
    };
    script.onerror = () => reject(new Error('Failed to load local MathJax asset'));
    document.head.appendChild(script);
  });
}
