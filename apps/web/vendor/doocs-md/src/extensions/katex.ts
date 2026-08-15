import type { MarkedExtension } from 'marked'
import { escapeHtml } from '../utils/basicHelpers'

export interface MarkedKatexOptions {
  nonStandard?: boolean
}

const inlineRule = /^(\${1,2})(?!\$)((?:\\.|[^\\\n])*?(?:\\.|[^\\\n$]))\1(?=[\s?!.,:？！。，：]|$)/
const inlineRuleNonStandard = /^(\${1,2})(?!\$)((?:\\.|[^\\\n])*?(?:\\.|[^\\\n$]))\1/ // Non-standard, even if there are no spaces before and after $ or $$, try to parse

const blockRule = /^\s{0,3}(\${1,2})[ \t]*\n([\s\S]+?)\n\s{0,3}\1[ \t]*(?:\n|$)/

// LaTeX style rules for \( ... \) and \[ ... \]
const inlineLatexRule = /^\\\(([^\\]*(?:\\.[^\\]*)*?)\\\)/
const blockLatexRule = /^\\\[([^\\]*(?:\\.[^\\]*)*?)\\\]/

/**
 * [MOLIO] Raw-text fallback used when MathJax is unavailable or a typeset
 * throws. Renders as standard markdown would: strip the backslash before
 * brackets / parens so `\[1\]` → `[1]` and `\(x\)` → `(x)` (these are escaped
 * brackets in CommonMark, which is how WeChat clippings use them as citation
 * markers). `$...$` / `$$...$$` are kept literal.
 */
function fallbackHtml(token: any, display: boolean): string {
  const raw = escapeHtml((token.raw ?? token.text).replace(/\\([()\[\]])/g, `$1`))
  return display
    ? `<section class="katex-block" data-math-display="true" data-math-raw="${raw}">${raw}</section>`
    : `<span class="katex-inline" data-math-display="false" data-math-raw="${raw}">${raw}</span>`
}

/**
 * [MOLIO] WeChat clippings use `\[N\]` / `\[12-15\]` as citation markers
 * (escaped brackets in CommonMark), which collide with the LaTeX block/inline
 * rules. Only treat `\[ ... \]` / `\( ... \)` as math when the content is not a
 * bare citation — i.e. contains something beyond digits, commas, spaces and
 * dashes. This keeps citation markers rendering as literal `[1]` even once
 * MathJax is loaded (see katex.ts guard history / #113).
 */
function isCitationLike(text: string): boolean {
  return /^[\d,\s–-]*$/.test(text)
}

function createRenderer(defaultDisplay: boolean, withStyle: boolean = true) {
  return (token: any) => {
    const display = token.displayMode ?? defaultDisplay

    // [MOLIO] Guard: MathJax is loaded lazily and may be absent (not yet
    // loaded, offline, asset failure, SSR/test env). Without this guard any
    // `\[ ... \]` / `$ ... $` token reaching the renderer crashes with
    // "Cannot read properties of undefined (reading 'texReset')". Fall back to
    // raw text so the document still renders.
    // @ts-expect-error MathJax is a global variable
    const mathjax = window.MathJax
    if (!mathjax?.texReset || !mathjax?.tex2svg) {
      return fallbackHtml(token, display)
    }

    try {
      mathjax.texReset()
      const mjxContainer = mathjax.tex2svg(token.text, { display })
      const svg = mjxContainer.firstChild
      const width = svg.style[`min-width`] || svg.getAttribute(`width`)
      svg.removeAttribute(`width`)

      // 行内公式对齐 https://groups.google.com/g/mathjax-users/c/zThKffrrCvE?pli=1
      // 直接覆盖 style 会覆盖 MathJax 的样式，需要手动设置
      // svg.style = `max-width: 300vw !important; display: initial; flex-shrink: 0;`

      if (withStyle) {
        svg.style.display = `initial`
        svg.style.setProperty(`max-width`, `300vw`, `important`)
        svg.style.flexShrink = `0`
        svg.style.width = width
      }

      if (!display) {
        // 新主题系统：使用 class 而非内联样式
        return `<span class="katex-inline" data-math-display="false" data-math-raw="${escapeHtml(token.raw ?? token.text)}">${svg.outerHTML}</span>`
      }

      return `<section class="katex-block" data-math-display="true" data-math-raw="${escapeHtml(token.raw ?? token.text)}">${svg.outerHTML}</section>`
    }
    catch (error) {
      // [MOLIO] Invalid / unsupported TeX (or a MathJax hiccup) must not take
      // down the whole document — fall back to raw text for this one token.
      console.error(`[MOLIO] MathJax typeset failed, falling back to raw text:`, error)
      return fallbackHtml(token, display)
    }
  }
}

function inlineKatex(options: MarkedKatexOptions | undefined, renderer: any) {
  const nonStandard = options && options.nonStandard
  const ruleReg = nonStandard ? inlineRuleNonStandard : inlineRule
  return {
    name: `inlineKatex`,
    level: `inline`,
    start(src: string) {
      let index
      let indexSrc = src

      while (indexSrc) {
        index = indexSrc.indexOf(`$`)
        if (index === -1) {
          return
        }
        const f = nonStandard ? index > -1 : index === 0 || indexSrc.charAt(index - 1) === ` `
        if (f) {
          const possibleKatex = indexSrc.substring(index)

          if (possibleKatex.match(ruleReg)) {
            return index
          }
        }

        indexSrc = indexSrc.substring(index + 1).replace(/^\$+/, ``)
      }
    },
    tokenizer(src: string) {
      const match = src.match(ruleReg)
      if (match) {
        return {
          type: `inlineKatex`,
          raw: match[0],
          text: match[2].trim(),
          displayMode: match[1].length === 2,
        }
      }
    },
    renderer,
  }
}

function blockKatex(_options: MarkedKatexOptions | undefined, renderer: any) {
  return {
    name: `blockKatex`,
    level: `block`,
    tokenizer(src: string) {
      const match = src.match(blockRule)
      if (match) {
        return {
          type: `blockKatex`,
          raw: match[0],
          text: match[2].trim(),
          displayMode: true,
        }
      }
    },
    renderer,
  }
}

function inlineLatexKatex(_options: MarkedKatexOptions | undefined, renderer: any) {
  return {
    name: `inlineLatexKatex`,
    level: `inline`,
    start(src: string) {
      const index = src.indexOf(`\\(`)
      return index !== -1 ? index : undefined
    },
    tokenizer(src: string) {
      const match = src.match(inlineLatexRule)
      if (match) {
        // [MOLIO] Skip citation-like content so it renders as literal text
        if (isCitationLike(match[1])) return undefined
        return {
          type: `inlineLatexKatex`,
          raw: match[0],
          text: match[1].trim(),
          displayMode: false,
        }
      }
    },
    renderer,
  }
}

function blockLatexKatex(_options: MarkedKatexOptions | undefined, renderer: any) {
  return {
    name: `blockLatexKatex`,
    level: `block`,
    start(src: string) {
      const index = src.indexOf(`\\[`)
      return index !== -1 ? index : undefined
    },
    tokenizer(src: string) {
      const match = src.match(blockLatexRule)
      if (match) {
        // [MOLIO] Skip citation-like content (e.g. `\[1\]`, `\[12-15\]`) so it
        // renders as literal `[1]` instead of being typeset as display math.
        if (isCitationLike(match[1])) return undefined
        return {
          type: `blockLatexKatex`,
          raw: match[0],
          text: match[1].trim(),
          displayMode: true,
        }
      }
    },
    renderer,
  }
}

export function MDKatex(options: MarkedKatexOptions | undefined, withStyle: boolean = true): MarkedExtension {
  return {
    extensions: [
      inlineKatex(options, createRenderer(false, withStyle)),
      blockKatex(options, createRenderer(true, withStyle)),
      inlineLatexKatex(options, createRenderer(false, withStyle)),
      blockLatexKatex(options, createRenderer(true, withStyle)),
    ],
  }
}
