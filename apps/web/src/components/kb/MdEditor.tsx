/**
 * MdEditor — Lightweight CodeMirror Markdown editor (no preview, no style panel).
 * Used for simple edit mode in KbMainContent.
 */

import { useEffect, useRef } from 'react';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { EditorState, Prec } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, undo, redo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { foldGutter, foldKeymap } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';

// ─── Markdown formatting helpers ───

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

// ─── Editor theme ───

const editorTheme = EditorView.theme({
  '&': {
    fontSize: '13px',
    fontFamily: 'var(--mono)',
    backgroundColor: 'var(--bg)',
    color: 'var(--text)',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
  },
  '.cm-scroller': {
    flex: 1,
    overflow: 'auto',
  },
  '.cm-content': {
    padding: '16px 24px',
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

export interface MdEditorProps {
  /** Initial Markdown content */
  initialContent: string;
  /** Callback when content changes */
  onContentChange?: (content: string) => void;
}

export function MdEditor({
  initialContent,
  onContentChange,
}: MdEditorProps) {
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);

  // Sync initial content when it changes (e.g., file switch)
  useEffect(() => {
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
              onContentChange?.(newContent);
            }
          }),
        ],
      }),
      parent: editorContainerRef.current,
    });

    editorViewRef.current = view;

    // Ensure the editor container takes full height
    if (editorContainerRef.current) {
      editorContainerRef.current.style.height = '100%';
      editorContainerRef.current.style.minHeight = '0';
    }

    // Force CodeMirror editor to fill container height
    const cmEditor = editorContainerRef.current?.querySelector('.cm-editor') as HTMLElement | null;
    if (cmEditor) {
      cmEditor.style.height = '100%';
      cmEditor.style.display = 'flex';
      cmEditor.style.flexDirection = 'column';
    }

    // Force scroller to be scrollable
    const cmScroller = editorContainerRef.current?.querySelector('.cm-scroller') as HTMLElement | null;
    if (cmScroller) {
      cmScroller.style.flex = '1';
      cmScroller.style.overflow = 'auto';
    }

    return () => {
      view.destroy();
      editorViewRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="kb-edit-mode">
      <div ref={editorContainerRef} className="kb-edit-cm" />
    </div>
  );
}
