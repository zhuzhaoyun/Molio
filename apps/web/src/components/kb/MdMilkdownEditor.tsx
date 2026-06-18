/**
 * MdMilkdownEditor — WYSIWYG Markdown editor powered by Milkdown (ProseMirror).
 */
import { useRef } from 'react';
import { Editor, rootCtx, defaultValueCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { nord } from '@milkdown/theme-nord';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { wikiEmbedPlugin } from './plugins/wikiEmbedPlugin';
import { imageProxyPlugin } from './plugins/imageProxyPlugin';

export interface MdMilkdownEditorProps {
  initialContent: string;
  onContentChange?: (content: string) => void;
  vaultId?: string;
  /** Changing fileKey forces remount — used to switch between files in the same vault */
  fileKey?: string | null;
}

function MilkdownInner({
  initialContent,
  onContentChange,
  vaultId,
}: MdMilkdownEditorProps) {
  const callbackRef = useRef(onContentChange);
  callbackRef.current = onContentChange;

  useEditor(
    (root) =>
      Editor.make()
        .config(nord)
        .config((ctx) => {
          ctx.set(rootCtx, root);
          ctx.set(defaultValueCtx, initialContent);
          ctx.get(listenerCtx).markdownUpdated((_, markdown) => {
            callbackRef.current?.(markdown);
          });
        })
        .use(commonmark)
        .use(gfm)
        .use(listener)
        .use(wikiEmbedPlugin({ vaultId }))
        .use(imageProxyPlugin()),
    [],
  );

  return <Milkdown />;
}

export function MdMilkdownEditor(props: MdMilkdownEditorProps) {
  return (
    <MilkdownProvider>
      <MilkdownInner key={props.fileKey ?? props.vaultId ?? 'no-vault'} {...props} />
    </MilkdownProvider>
  );
}
