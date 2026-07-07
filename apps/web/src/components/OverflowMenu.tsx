import { useState, useRef, useEffect, useLayoutEffect, type ReactNode } from 'react';
import { MoreIcon } from './icons';

export interface OverflowItem {
  icon: ReactNode;
  label: string;
  testid: string;
  onClick: () => void;
  disabled?: boolean;
}

interface Props {
  items: OverflowItem[];
}

/**
 * ⋯ dropdown — tucks low-frequency actions behind one trigger so the toolbar
 * stays uncluttered. Closes on outside-click, Escape, or item click.
 *
 * Auto-flips upward when there isn't enough room below (e.g. the last message
 * near the composer) so the menu isn't clipped or covered by the input bar.
 */
export function OverflowMenu({ items }: Props) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<'below' | 'above'>('below');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Measure after open (before paint) and flip up if the menu would be
  // clipped by its scroll container (e.g. .home-chat-log) — which happens
  // when the trigger is on the last message near the composer. Measuring
  // against the viewport doesn't work because the viewport still has room
  // below the chat-log (the composer area); the dropdown is clipped by the
  // chat-log's overflow box, not the viewport.
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const root = ref.current;
    const btn = root.querySelector<HTMLElement>('[data-testid="msg-overflow-btn"]');
    const dd = root.querySelector<HTMLElement>('.overflow-menu-dropdown');
    if (!btn || !dd) return;
    let scrollParent: HTMLElement | null = null;
    let node: HTMLElement | null = btn.parentElement;
    while (node && node !== document.body) {
      const ov = getComputedStyle(node).overflowY;
      if (ov === 'auto' || ov === 'scroll' || ov === 'overlay') {
        scrollParent = node;
        break;
      }
      node = node.parentElement;
    }
    const container = scrollParent ? scrollParent.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const btnRect = btn.getBoundingClientRect();
    const ddHeight = dd.offsetHeight;
    const spaceBelow = container.bottom - btnRect.bottom;
    const spaceAbove = btnRect.top - container.top;
    setPlacement(ddHeight > spaceBelow - 8 && spaceAbove > spaceBelow ? 'above' : 'below');
  }, [open]);

  return (
    <div className="overflow-menu" ref={ref}>
      <button
        type="button"
        className="icon-btn"
        data-testid="msg-overflow-btn"
        data-tip="更多"
        aria-label="更多"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreIcon />
      </button>
      {open && (
        <div
          className="overflow-menu-dropdown"
          data-placement={placement}
          role="menu"
          data-testid="overflow-menu"
        >
          {items.map((it) => (
            <button
              key={it.testid}
              type="button"
              role="menuitem"
              data-testid={it.testid}
              className="overflow-menu-item"
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              {it.icon}
              <span>{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
