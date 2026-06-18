/**
 * MdEditor — Raw markdown text editor.
 * Used for simple edit mode in KbMainContent.
 *
 * Pure textarea, no WYSIWYG — editing is about content, not presentation.
 * Formatted rendering is the responsibility of Read / Typeset modes.
 */
import { useState, useEffect, useCallback, useRef } from 'react';

export interface MdEditorProps {
  initialContent: string;
  onContentChange?: (content: string) => void;
  selectedFile?: string | null;
}

export function MdEditor({ initialContent, onContentChange }: MdEditorProps) {
  const [content, setContent] = useState(initialContent);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setContent(initialContent);
  }, [initialContent]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newContent = e.target.value;
      setContent(newContent);
      onContentChange?.(newContent);
    },
    [onContentChange],
  );

  // Tab key inserts spaces instead of moving focus
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const textarea = e.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newValue = textarea.value.slice(0, start) + '  ' + textarea.value.slice(end);
      setContent(newValue);
      onContentChange?.(newValue);
      // Restore cursor after React re-render
      requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 2;
      });
    }
  }, [onContentChange]);

  return (
    <div className="kb-edit-mode">
      <textarea
        ref={textareaRef}
        className="kb-edit-textarea"
        value={content}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        spellCheck={false}
        placeholder="输入 Markdown..."
      />
    </div>
  );
}
