/**
 * MdEditor — WYSIWYG Markdown editor (thin Milkdown wrapper).
 * Used for simple edit mode in KbMainContent.
 */
import { MdMilkdownEditor } from './MdMilkdownEditor';

export interface MdEditorProps {
  initialContent: string;
  onContentChange?: (content: string) => void;
  selectedFile?: string | null;
}

export function MdEditor({ initialContent, onContentChange, selectedFile }: MdEditorProps) {
  return (
    <div className="kb-edit-mode">
      <div className="kb-edit-cm">
        <MdMilkdownEditor
          initialContent={initialContent}
          onContentChange={onContentChange}
          fileKey={selectedFile}
        />
      </div>
    </div>
  );
}
