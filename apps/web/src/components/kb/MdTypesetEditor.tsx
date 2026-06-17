/**
 * MdTypesetEditor — Three-column Markdown editor with live preview.
 *
 * Layout:
 * - Left: CodeMirror 6 Markdown editor (syntax highlighting, shortcuts)
 * - Center: Live preview with mobile/desktop width toggle
 * - Right: Embedded style panel (always visible)
 *
 * Uses vendored editor configs from @md/shared (doocs/md upstream).
 * Features synchronized scrolling between editor and preview.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { EditorState, Prec } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, undo, redo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { foldGutter, foldKeymap } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { MdRenderer } from './MdRenderer';
import { MdStylePanel, defaultThemeConfig, type ThemeConfig } from './MdStylePanel';
import { preprocessWikiEmbeds, proxyExternalImages } from '../../hooks/useKnowledge';

// ─── Markdown formatting helpers (from @md/shared/editor/format.ts) ───

function toggleFormat(
  view: EditorView,
  prefix: string,
  suffix: string,
  cursorOffset = 0,
): void {
  const sel = view.state.selection.main;
  const selected = view.state.doc.sliceString(sel.from, sel.to);
  const isFormatted = selected.startsWith(prefix) && selected.endsWith(suffix);

  if (isFormatted) {
    const inner = selected.slice(prefix.length, selected.length - suffix.length);
    view.dispatch(view.state.replaceSelection(inner));
  } else {
    const wrapped = `${prefix}${selected}${suffix}`;
    view.dispatch(view.state.replaceSelection(wrapped));
    if (cursorOffset !== 0) {
      const newPos = view.state.selection.main.head + cursorOffset;
      view.dispatch({ selection: { anchor: newPos } });
    }
  }
}

function applyHeading(view: EditorView, level: number): void {
  const prefix = `${'#'.repeat(level)} `;
  const range = view.state.selection.main;
  const line = view.state.doc.lineAt(range.from);
  const text = view.state.doc.sliceString(line.from, line.to);
  const cleaned = text.replace(/^#{1,6}\s+/, '').trimStart();
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: prefix + cleaned },
    selection: { anchor: line.from + prefix.length },
  });
}

const markdownKeymap = keymap.of([
  { key: 'Mod-b', run: (v) => { toggleFormat(v, '**', '**', -2); return true; } },
  { key: 'Mod-i', run: (v) => { toggleFormat(v, '*', '*', -1); return true; } },
  { key: 'Mod-k', run: (v) => { toggleFormat(v, '[', ']()', -1); return true; } },
  { key: 'Mod-e', run: (v) => { toggleFormat(v, '`', '`', -1); return true; } },
  { key: 'Mod-d', run: (v) => { toggleFormat(v, '~~', '~~', -2); return true; } },
  { key: 'Mod-1', run: (v) => { applyHeading(v, 1); return true; } },
  { key: 'Mod-2', run: (v) => { applyHeading(v, 2); return true; } },
  { key: 'Mod-3', run: (v) => { applyHeading(v, 3); return true; } },
  { key: 'Mod-z', run: (v) => undo(v) },
  { key: 'Mod-y', run: (v) => redo(v) },
]);

// ─── Editor theme (matches Claude design tokens) ───

const editorTheme = EditorView.theme({
  '&': {
    fontSize: '13px',
    fontFamily: 'var(--mono)',
    backgroundColor: 'var(--bg-panel)',
    color: 'var(--text)',
    height: '100%',
  },
  '.cm-content': {
    padding: '16px',
    lineHeight: '1.7',
    caretColor: 'var(--accent)',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--accent)',
  },
  '&.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--selected-soft)',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    borderRight: 'none',
    color: 'var(--text-faint)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--text-muted)',
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--bg-subtle)',
  },
  '.cm-foldGutter': {
    width: '10px',
    overflow: 'hidden',
  },
  '.cm-foldGutter .cm-gutterElement': {
    padding: '0',
    width: '10px',
  },
  '.cm-foldGutter .cm-gutterElement span': {
    opacity: '0',
    transition: 'opacity 0.15s ease',
  },
  '.cm-gutters:hover .cm-foldGutter .cm-gutterElement span': {
    opacity: '1',
  },
  // Markdown syntax highlighting
  '.cm-heading': { fontWeight: '600', color: 'var(--text-strong)' },
  '.cm-strong': { fontWeight: '600' },
  '.cm-emphasis': { fontStyle: 'italic' },
  '.cm-link': { color: 'var(--selected)', textDecoration: 'none' },
  '.cm-url': { color: 'var(--text-muted)' },
  '.cm-monospace': {
    fontFamily: 'var(--mono)',
    backgroundColor: 'var(--bg-subtle)',
    borderRadius: '4px',
    padding: '1px 3px',
  },
  '.cm-strikethrough': { textDecoration: 'line-through', color: 'var(--text-muted)' },
});

// ─── Component ───

export interface MdTypesetEditorProps {
  /** Initial Markdown content */
  initialContent: string;
  /** Callback when content changes */
  onContentChange?: (content: string) => void;
  /** Vault ID for wiki embed URL resolution */
  vaultId?: string;
}

export function MdTypesetEditor({
  initialContent,
  onContentChange,
  vaultId,
}: MdTypesetEditorProps) {
  const [content, setContent] = useState(initialContent);
  const [themeConfig, setThemeConfig] = useState<ThemeConfig>(defaultThemeConfig);

  const editorContainerRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const syncingRef = useRef(false);

  // Sync initial content when it changes (e.g., file switch)
  useEffect(() => {
    setContent(initialContent);
    // Also update the CodeMirror editor content
    const view = editorViewRef.current;
    if (view) {
      const currentContent = view.state.doc.toString();
      if (currentContent !== initialContent) {
        view.dispatch({
          changes: { from: 0, to: currentContent.length, insert: initialContent },
        });
      }
    }
  }, [initialContent]);

  // Initialize CodeMirror editor
  useEffect(() => {
    if (!editorContainerRef.current) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: initialContent,
        extensions: [
          // Markdown language support with code block highlighting
          markdown({
            base: markdownLanguage,
            codeLanguages: languages,
            addKeymap: true,
          }),

          // History (undo/redo)
          history(),
          highlightSelectionMatches(),
          closeBrackets(),

          // Fold gutter
          foldGutter(),

          // Custom Markdown shortcuts (high priority)
          Prec.high(markdownKeymap),

          // Default keymaps
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...closeBracketsKeymap,
            ...foldKeymap,
            ...searchKeymap,
          ]),

          // Editor config
          EditorView.lineWrapping,
          EditorState.allowMultipleSelections.of(true),
          placeholder('在此输入 Markdown...'),

          // Theme
          editorTheme,

          // Update listener for content changes
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const newContent = update.state.doc.toString();
              setContent(newContent);
              onContentChange?.(newContent);
            }
          }),
        ],
      }),
      parent: editorContainerRef.current,
    });

    editorViewRef.current = view;

    return () => {
      view.destroy();
      editorViewRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Synchronized scrolling between editor and preview
  useEffect(() => {
    const editorScroller = editorContainerRef.current?.querySelector('.cm-scroller') as HTMLElement | null;
    const preview = previewRef.current;
    if (!editorScroller || !preview) return;

    const syncScroll = (source: HTMLElement, target: HTMLElement) => {
      if (syncingRef.current) return;
      syncingRef.current = true;

      const sourceMax = source.scrollHeight - source.clientHeight;
      const targetMax = target.scrollHeight - target.clientHeight;
      if (sourceMax <= 0 || targetMax <= 0) {
        syncingRef.current = false;
        return;
      }

      const ratio = source.scrollTop / sourceMax;
      target.scrollTop = ratio * targetMax;

      requestAnimationFrame(() => {
        syncingRef.current = false;
      });
    };

    const handleEditorScroll = () => syncScroll(editorScroller, preview);
    const handlePreviewScroll = () => syncScroll(preview, editorScroller);

    editorScroller.addEventListener('scroll', handleEditorScroll);
    preview.addEventListener('scroll', handlePreviewScroll);

    return () => {
      editorScroller.removeEventListener('scroll', handleEditorScroll);
      preview.removeEventListener('scroll', handlePreviewScroll);
    };
  }, []);

  const handleThemeChange = useCallback((newConfig: ThemeConfig) => {
    setThemeConfig(newConfig);
  }, []);

  const isMobilePreview = themeConfig.previewWidth === 'mobile';

  return (
    <div className="kb-typeset-editor">
      {/* Left: CodeMirror Editor */}
      <div className="kb-typeset-left">
        <div ref={editorContainerRef} className="kb-typeset-cm" />
      </div>

      {/* Center: Preview */}
      <div className="kb-typeset-center">
        <div
          ref={previewRef}
          className={`kb-typeset-preview ${isMobilePreview ? 'is-mobile' : 'is-desktop'}`}
        >
          <MdRenderer content={vaultId ? proxyExternalImages(preprocessWikiEmbeds(content, vaultId)) : proxyExternalImages(content)} themeConfig={themeConfig} />
        </div>
      </div>

      {/* Right: Style Panel (embedded, always visible) */}
      <MdStylePanel
        config={themeConfig}
        onChange={handleThemeChange}
      />
    </div>
  );
}
