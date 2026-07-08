import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { EditorState, EditorSelection, Compartment } from '@codemirror/state';
import { MAX_ASK_SELECTION } from './kb-constants';
import {
  EditorView, lineNumbers, highlightActiveLine, drawSelection, keymap,
} from '@codemirror/view';
import {
  syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter, codeFolding,
} from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { defaultKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';

export interface KbCodeMirrorViewerHandle {
  /** Scroll to a 1-based line number. */
  gotoLine: (n: number) => void;
  /** Scroll to the end of the document. */
  scrollToBottom: () => void;
  /** Current selection text (empty if none). */
  getSelectionText: () => string;
  /** Select the entire document. */
  selectAll: () => void;
}

interface Props {
  content: string;
  fileName: string;
  wrap: boolean;
  onRequestContextMenu: (e: { x: number; y: number; selectedText: string; source: 'codemirror' }) => void;
}

function languageFor(fileName: string) {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return markdown();
  if (ext === '.json') return json();
  if (ext === '.html' || ext === '.htm') return html();
  return []; // .txt/.log/.csv/.yaml → plain
}

const molioTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--bg-subtle)',
    color: 'var(--text)',
    fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
    fontSize: '13px',
    height: '100%',
  },
  '.cm-scroller': { lineHeight: '1.5', overflow: 'auto' },
  '.cm-gutters': { backgroundColor: 'var(--bg-subtle)', color: 'var(--text-muted)', border: 'none' },
  '.cm-content': { caretColor: 'var(--text)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--selection-bg, rgba(128,128,128,0.25))',
  },
});

export const KbCodeMirrorViewer = forwardRef<KbCodeMirrorViewerHandle, Props>(function KbCodeMirrorViewer(
  { content, fileName, wrap, onRequestContextMenu },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const wrapCompartment = useRef(new Compartment());

  // Create the editor once per file.
  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [
          EditorState.readOnly.of(true),
          lineNumbers(),
          highlightActiveLine(),
          drawSelection(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          bracketMatching(),
          foldGutter(),
          codeFolding(),
          highlightSelectionMatches(),
          keymap.of([...defaultKeymap, ...searchKeymap]),
          languageFor(fileName),
          wrapCompartment.current.of(wrap ? EditorView.lineWrapping : []),
          molioTheme,
          EditorView.domEventHandlers({
            contextmenu(event) {
              const sel = view.state.selection.main;
              const text = sel.from === sel.to ? '' : view.state.sliceDoc(sel.from, sel.to);
              onRequestContextMenu({ x: event.clientX, y: event.clientY, selectedText: text, source: 'codemirror' });
              return true;
            },
          }),
        ],
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, fileName]);

  // Reconfigure wrap on toggle.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: wrapCompartment.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap]);

  useImperativeHandle(ref, () => ({
    gotoLine(n: number) {
      const v = viewRef.current; if (!v) return;
      const line = v.state.doc.line(Math.max(1, Math.min(n, v.state.doc.lines)));
      v.dispatch({ selection: EditorSelection.cursor(line.from), scrollIntoView: true });
    },
    scrollToBottom() {
      const v = viewRef.current; if (!v) return;
      v.scrollDOM.scrollTop = v.scrollDOM.scrollHeight;
    },
    getSelectionText() {
      const v = viewRef.current; if (!v) return '';
      const sel = v.state.selection.main;
      return sel.from === sel.to ? '' : v.state.sliceDoc(sel.from, sel.to);
    },
    selectAll() {
      const v = viewRef.current; if (!v) return;
      v.dispatch({ selection: EditorSelection.range(0, v.state.doc.length) });
    },
  }));

  return <div ref={hostRef} className="kb-codemirror-viewer" data-testid="kb-codemirror-viewer" />;
});
