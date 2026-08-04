/**
 * 文档大纲：解析 ## / ### 标题，列表展示，点击滚动到对应渲染标题。
 * 依赖 doocs/md 渲染出的 [data-heading="true"] 节点（h2/h3），按文本匹配定位。
 */
import { useMemo, useCallback, useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import './OutlinePanel.css';

interface Heading {
  level: 2 | 3;
  text: string;
}

interface OutlinePanelProps {
  content: string;
  onClose: () => void;
}

const HEADING_RE = /^(#{2,3})\s+(.+?)\s*$/;

function parseHeadings(content: string): Heading[] {
  const headings: Heading[] = [];
  let inFence = false;
  for (const line of content.split('\n')) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(HEADING_RE);
    if (!m) continue;
    const level = (m[1].length as 2 | 3); // ## →2, ### →3
    headings.push({ level, text: m[2].replace(/[#*_`]/g, '').trim() });
  }
  return headings;
}

export function OutlinePanel({ content, onClose }: OutlinePanelProps) {
  const { t } = useI18n();
  const headings = useMemo(() => parseHeadings(content), [content]);

  // 让浮层从 KB 头栏底部开始（不遮挡头栏按钮），与 PDF 侧栏的高度定位一致。
  // 头栏高度会随 frontmatter badge 变化，故挂载时动态测量而非固定偏移。
  const [top, setTop] = useState(80);
  useEffect(() => {
    const header = document.querySelector('.kb-main-header');
    if (header) setTop(Math.round(header.getBoundingClientRect().bottom));
  }, []);

  const scrollTo = useCallback((text: string, level: number) => {
    const area = document.querySelector('.kb-content-area');
    if (!area) return;
    const candidates = Array.from(area.querySelectorAll('[data-heading="true"]'));
    // 找文本匹配且 tag 层级一致
    const target = candidates.find((el) => {
      const tag = el.tagName.toLowerCase();
      return tag === `h${level}` && (el.textContent || '').trim() === text;
    }) ?? candidates.find((el) => (el.textContent || '').trim() === text);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  return (
    <aside className="kb-outline-panel" data-testid="kb-outline-panel" style={{ top }}>
      <div className="kb-outline-header">
        <span>📋 {t('kb.outlineTitle')}</span>
        <button type="button" className="kb-outline-close" data-testid="kb-outline-close"
          onClick={onClose} aria-label={t('kb.close')}>✕</button>
      </div>
      <div className="kb-outline-body">
        {headings.length === 0 ? (
          <p className="kb-outline-empty">{t('kb.outlineEmpty')}</p>
        ) : (
          headings.map((h, i) => (
            <button
              key={i}
              type="button"
              className={`kb-outline-item indent-${h.level}`}
              data-testid="outline-item"
              onClick={() => scrollTo(h.text, h.level)}
            >
              {h.text}
            </button>
          ))
        )}
      </div>
    </aside>
  );
}
