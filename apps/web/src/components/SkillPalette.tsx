import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import type { SkillManifestEntry } from '@molio/contracts';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import './SkillPalette.css';

interface Props {
  /** Filter text — everything after the leading "/" in the composer input. */
  filterText: string;
  onSelect: (skill: SkillManifestEntry) => void;
  onClose: () => void;
}

/**
 * Explicit skill invocation palette for the composer's leading "/" trigger
 * (Claude Code-style slash menu). Lists enabled library skills plus the
 * app-shipped bundled ones (read-only via GET /api/skills?includeBundled=1),
 * filtered by name/description as the user keeps typing in the textarea.
 *
 * Keyboard lives at document level (mirrors FilePicker) so ArrowUp/ArrowDown/
 * Enter/Escape never reach the textarea while the palette is open — Enter must
 * SELECT, not send. Item selection uses onMouseDown+preventDefault so the
 * textarea keeps focus throughout.
 */
export function SkillPalette({ filterText, onSelect, onClose }: Props) {
  const { t } = useI18n();
  const [skills, setSkills] = useState<SkillManifestEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const activeIdxRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Keep activeIdxRef in sync so the keydown handler reads the latest index
  // without re-binding the document listener on every ArrowUp/ArrowDown press.
  useEffect(() => { activeIdxRef.current = activeIdx; }, [activeIdx]);

  // Fetch once on mount — the palette mounts fresh on every "/" trigger.
  useEffect(() => {
    let cancelled = false;
    api.listSkills({ includeBundled: true })
      .then((list) => {
        if (!cancelled) { setSkills(list); setLoading(false); }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load skills');
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, []);

  // Enabled library skills first (stable createdAt order), bundled after —
  // bundled rows ignore the master switch (always effective), so they never
  // get filtered out.
  const filtered = useMemo(() => {
    const usable = skills.filter((s) => s.kind === 'bundled' || s.enabled);
    const library = usable
      .filter((s) => s.kind !== 'bundled')
      .sort((a, b) => a.createdAt - b.createdAt);
    const bundled = usable
      .filter((s) => s.kind === 'bundled')
      .sort((a, b) => a.name.localeCompare(b.name));
    const all = [...library, ...bundled];
    const q = filterText.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [skills, filterText]);

  // Reset active index when the filtered list changes
  useEffect(() => { setActiveIdx(0); }, [filtered]);

  // Keyboard navigation (document-level for Arrow/Enter/Escape — the textarea
  // keeps focus, but these keys must drive the palette, not the input).
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((prev) => Math.min(prev + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const skill = filtered[activeIdxRef.current];
        if (skill) onSelect(skill);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [filtered, onSelect, onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  if (loading) {
    return (
      <div className="skill-palette-overlay" data-testid="skill-palette">
        <div className="skill-palette-empty">{t('skillPalette.loading')}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="skill-palette-overlay" data-testid="skill-palette">
        <div className="skill-palette-empty">{t('skillPalette.loadError')}</div>
      </div>
    );
  }

  return (
    <div className="skill-palette-overlay" data-testid="skill-palette">
      <div ref={listRef}>
        {filtered.length === 0 ? (
          <div className="skill-palette-empty">{t('skillPalette.empty')}</div>
        ) : (
          filtered.map((s, i) => (
            <div
              key={s.id}
              className={`skill-palette-item${i === activeIdx ? ' active' : ''}`}
              data-testid="skill-palette-item"
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(s);
              }}
            >
              <span className="skill-palette-item-icon" aria-hidden="true">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
                </svg>
              </span>
              <div className="skill-palette-item-text">
                <span className="skill-palette-item-name">
                  {s.name}
                  {s.kind === 'bundled' && (
                    <span className="skill-palette-badge">{t('skillPalette.bundled')}</span>
                  )}
                </span>
                {s.description && (
                  <span className="skill-palette-item-desc" title={s.description}>
                    {s.description}
                  </span>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
