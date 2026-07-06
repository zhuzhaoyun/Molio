import { useState, useMemo, useCallback } from 'react';

const FOLD_THRESHOLD = 20;

interface Props {
  lang: string;
  code: string;
  streaming?: boolean;
}

export function CodeBlock({ lang, code, streaming }: Props) {
  const [folded, setFolded] = useState(() => code.split('\n').length > FOLD_THRESHOLD);
  const [copied, setCopied] = useState(false);

  const lines = useMemo(() => code.split('\n'), [code]);
  const isLong = lines.length > FOLD_THRESHOLD;

  const copy = useCallback(async () => {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
        ok = true;
      }
    } catch {
      /* fall through */
    }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = code;
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [code]);

  const shownCode = isLong && folded ? lines.slice(0, FOLD_THRESHOLD).join('\n') : code;

  return (
    <div className={`codeblock${streaming ? ' streaming' : ''}`} data-testid="codeblock">
      <div className="codeblock-header">
        <span className="codeblock-lang" data-testid="codeblock-lang">
          {lang || 'text'}
        </span>
        <button
          type="button"
          className={`codeblock-copy${copied ? ' copied' : ''}`}
          data-testid="codeblock-copy-btn"
          onClick={copy}
          title={copied ? '已复制' : '复制代码'}
        >
          {copied ? '✓ 已复制' : '📋 复制'}
        </button>
      </div>
      <pre>
        <code>{shownCode}</code>
      </pre>
      {isLong && (
        <button
          type="button"
          className="codeblock-fold"
          data-testid="codeblock-expand-btn"
          onClick={() => setFolded((f) => !f)}
        >
          {folded ? `展开(共 ${lines.length} 行)` : '收起'}
        </button>
      )}
    </div>
  );
}
