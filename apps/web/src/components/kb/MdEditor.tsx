/**
 * MdEditor — WYSIWYG Markdown editor (thin Milkdown wrapper).
 * Used for simple edit mode in KbMainContent.
 */
import { MdMilkdownEditor } from './MdMilkdownEditor';

export interface MdEditorProps {
  initialContent: string;
  onContentChange?: (content: string) => void;
}

export function MdEditor({ initialContent, onContentChange }: MdEditorProps) {
  return (
    <div className="kb-edit-mode">
      <div className="kb-edit-cm">
        <MdMilkdownEditor
          initialContent={initialContent}
          onContentChange={onContentChange}
        />
      </div>
    </div>
  );
}
