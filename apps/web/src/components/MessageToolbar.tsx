import { useState, useCallback, useRef, useEffect } from 'react';
import { CopyIcon, RegenerateIcon, EditIcon, CheckIcon } from './icons';

export type ToolbarActionKey = 'copy' | 'regenerate' | 'edit';

export interface ToolbarAction {
  key: ToolbarActionKey;
  /** Short Chinese label — shown only as a hover tooltip, never inline. */
  label: string;
  testid: string;
  /** Content to copy for the copy action; ignored by other actions. */
  text: string;
  onClick: () => void;
  disabled?: boolean;
}

/** The icon shown for an action in its default (non-copied) state. */
function ActionIcon({ k }: { k: ToolbarActionKey }) {
  switch (k) {
    case 'copy': return <CopyIcon />;
    case 'regenerate': return <RegenerateIcon />;
    case 'edit': return <EditIcon />;
  }
}

interface Props {
  actions: ToolbarAction[];
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Hover-revealed action bar for chat messages. The copy action has a transient
 * "copied" state; regenerate/edit delegate to the parent.
 */
export function MessageToolbar({ actions }: Props) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending reset timer on unmount to avoid setting state on an
  // unmounted component.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleClick = useCallback(async (a: ToolbarAction) => {
    if (a.key === 'copy') {
      const ok = await copyText(a.text);
      if (ok) {
        setCopied(true);
        setFailed(false);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1500);
      } else {
        setFailed(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setFailed(false), 1500);
      }
    } else {
      a.onClick();
    }
  }, []);

  return (
    <div className="message-toolbar" data-testid="message-toolbar">
      {actions.map((a) => {
        const showCopied = a.key === 'copy' && copied;
        const tip = a.key === 'copy' && failed ? '复制失败' : showCopied ? '已复制' : a.label;
        return (
          <button
            key={a.key}
            type="button"
            data-testid={a.testid}
            className={`icon-btn${showCopied ? ' copied' : ''}`}
            data-tip={tip}
            disabled={a.disabled}
            onClick={() => handleClick(a)}
            aria-label={tip}
          >
            {showCopied ? <CheckIcon /> : <ActionIcon k={a.key} />}
          </button>
        );
      })}
    </div>
  );
}
