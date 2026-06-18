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

export interface MdMilkdownEditorProps {
  initialContent: string;
  onContentChange?: (content: string) => void;
  vaultId?: string;
}

function MilkdownInner({
  initialContent,
  onContentChange,
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
        .use(listener),
    [],
  );

  return <Milkdown />;
}

export function MdMilkdownEditor(props: MdMilkdownEditorProps) {
  return (
    <MilkdownProvider>
      <MilkdownInner key={props.vaultId ?? 'no-vault'} {...props} />
    </MilkdownProvider>
  );
}
