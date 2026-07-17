/**
 * KbFrontmatterCard — expanded YAML frontmatter property card.
 *
 * Renders all frontmatter fields in a card below the document header.
 * Supports clickable [[wikilinks]] for `related` and `sources` fields
 * (and any other field containing wikilinks).
 *
 * Renders nothing when data is empty (no frontmatter in the document).
 */

import { useMemo } from 'react';
import { useI18n } from '../../i18n';

interface KbFrontmatterCardProps {
  data: Record<string, unknown>;
  /** Called when a [[wikilink]] is clicked. Receives the raw page name (stripped of brackets). */
  onNavigate?: (pageName: string) => void;
  /** Called to collapse the card. */
  onCollapse: () => void;
}

// ── helpers ──

const WIKILINK_REGEX = /\[\[([^\]]+)\]\]/g;

function isURL(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function formatDate(value: unknown): string {
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return '';
    return value.toLocaleDateString();
  }
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const s = typeof value === 'number' ? String(value) : value;
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString();
}

function normalizeTags(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((t) => String(t)).filter(Boolean);
  if (typeof raw === 'string') return raw.split(/,\s*/).filter(Boolean);
  return [];
}

function normalizeString(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  // YAML parser may convert dates to Date objects
  if (raw instanceof Date) return formatDate(raw);
  if (Array.isArray(raw)) {
    return raw.map((a) => String(a).trim()).filter(Boolean).join(', ');
  }
  const s = String(raw).replace(/^["']|["']$/g, '');
  return s || null;
}

function normalizeSource(raw: unknown): { url: string; label: string } | null {
  const s = normalizeString(raw);
  if (!s) return null;
  if (isURL(s)) {
    try {
      const u = new URL(s);
      const short = u.pathname.length > 30 ? u.pathname.slice(0, 30) + '…' : u.pathname;
      return { url: s, label: u.hostname + short };
    } catch {
      return { url: s, label: s };
    }
  }
  return { url: '', label: s };
}

// ── wikilink-aware value renderer ──

interface WikilinkSegment {
  type: 'text' | 'wikilink';
  value: string;
}

function parseWikilinkText(text: string): WikilinkSegment[] {
  const segments: WikilinkSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(WIKILINK_REGEX)) {
    if (m.index! > last) {
      segments.push({ type: 'text', value: text.slice(last, m.index!) });
    }
    segments.push({ type: 'wikilink', value: m[1]!.trim() });
    last = m.index! + m[0].length;
  }
  if (last < text.length) {
    segments.push({ type: 'text', value: text.slice(last) });
  }
  return segments;
}

function RenderValue({
  rawValue,
  fieldKey,
  onNavigate,
}: {
  rawValue: unknown;
  fieldKey: string;
  onNavigate?: (pageName: string) => void;
}) {
  const tags = useMemo(() => normalizeTags(rawValue), [rawValue]);
  const sourceInfo = useMemo(() => normalizeSource(rawValue), [rawValue]);
  const text = useMemo(() => normalizeString(rawValue), [rawValue]);
  const segments = useMemo(() => (text ? parseWikilinkText(text) : []), [text]);

  // source field with URL
  if (fieldKey === 'source' && sourceInfo?.url) {
    return (
      <a href={sourceInfo.url} target="_blank" rel="noopener noreferrer">
        {sourceInfo.label}
      </a>
    );
  }

  // tags field
  if (fieldKey === 'tags') {
    return (
      <span className="kb-fm-tags">
        {tags.length > 0
          ? tags.map((tag) => <span key={tag} className="kb-fm-tag-pill">{tag}</span>)
          : text}
      </span>
    );
  }

  // Fields with wikilinks — render [[link]] as clickable buttons.
  // This handles related, sources, and any other field with wikilinks.
  if (onNavigate && segments.some((s) => s.type === 'wikilink')) {
    return (
      <>
        {segments.map((seg, i) =>
          seg.type === 'wikilink' ? (
            <button
              key={i}
              type="button"
              className="kb-fm-wikilink"
              onClick={() => onNavigate?.(seg.value)}
              title={`${fieldKey}: ${seg.value}`}
            >
              {seg.value}
            </button>
          ) : (
            <span key={i}>{seg.value}</span>
          ),
        )}
      </>
    );
  }

  // fallback — plain text
  return <>{text}</>;
}

/** Frontmatter property keys that have well-known display treatment. */
const KNOWN_KEYS = new Set([
  'title', 'source', 'author', 'description',
  'created', 'updated', 'published', 'category', 'tags',
  'related', 'sources',
]);

export function KbFrontmatterCard({ data, onNavigate, onCollapse }: KbFrontmatterCardProps) {
  const { t } = useI18n();

  // Empty state
  if (Object.keys(data).length === 0) return null;

  // Build ordered field list
  const fields: Array<{ key: string; i18nKey: string; icon: string }> = [];

  const add = (key: string, icon: string) => {
    if (data[key] !== undefined && data[key] !== null) {
      fields.push({ key, i18nKey: `kb.frontmatter.${key}`, icon });
    }
  };

  add('title', '📝');        // 📝
  add('source', '🔗');       // 🔗
  add('author', '✍️');       // ✍️
  add('description', '📋');  // 📋
  add('created', '📅');      // 📅
  add('updated', '🔄');      // 🔄
  add('published', '📰');    // 📰
  add('category', '📂');     // 📂
  add('tags', '🏷');         // 🏷
  add('related', '🔗');      // 🔗
  add('sources', '📄');      // 📄

  // Any remaining unknown keys
  for (const key of Object.keys(data)) {
    if (!KNOWN_KEYS.has(key) && data[key] !== undefined && data[key] !== null) {
      fields.push({ key, i18nKey: '', icon: '📌' }); // 📌
    }
  }

  return (
    <div className="kb-frontmatter" data-testid="kb-fm-expanded">
      <div className="kb-frontmatter-header" onClick={onCollapse}>
        <span>{t('kb.frontmatter.properties')}</span>
        <button
          type="button"
          className="kb-fm-collapse-btn"
          onClick={(e) => { e.stopPropagation(); onCollapse(); }}
          title={t('kb.frontmatter.collapse')}
        >
          {t('kb.frontmatter.collapse')} ▴
        </button>
      </div>
      <div className="kb-frontmatter-body">
        {fields.map((field) => (
          <div key={field.key} className="kb-fm-line">
            <span className="kb-fm-key">
              <span aria-hidden="true">{field.icon}</span> {field.i18nKey ? t(field.i18nKey) : field.key}
            </span>
            <span className="kb-fm-val">
              <RenderValue
                rawValue={data[field.key]}
                fieldKey={field.key}
                onNavigate={onNavigate}
              />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
