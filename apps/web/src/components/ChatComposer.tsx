import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n';
import type { Command, CommandAction } from '../commands/types';
import { BUILTIN_COMMANDS } from '../commands/builtin';
import { vaultStore } from '../stores/vaultStore';
import { api } from '../api/client';
import { FilePicker } from './FilePicker';
import { CommandPalette } from './CommandPalette';

export interface FileRef {
  vaultId: string;
  filePath: string;
}

export interface PastedImage {
  id: string;
  filePath: string;
  url: string;
  state: 'uploading' | 'done' | 'error';
  error?: string;
}

interface Props {
  isRunning: boolean;
  onSend: (message: string, fileRefs: FileRef[], pastedImages: PastedImage[]) => void;
  onCancel: () => void;
  disabled?: boolean;
  disabledPlaceholder?: string;
  /** Callback for command actions that need host intervention (e.g. polish, outline, new-chat). */
  onCommand?: (key: string) => void;
  /** Commands to show in the palette. Defaults to BUILTIN_COMMANDS. */
  commands?: Command[];
}

export function ChatComposer({
  isRunning,
  onSend,
  onCancel,
  disabled,
  disabledPlaceholder,
  onCommand,
  commands = BUILTIN_COMMANDS,
}: Props) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [fileRefs, setFileRefs] = useState<FileRef[]>([]);
  const [pastedImages, setPastedImages] = useState<PastedImage[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Trigger overlay state
  const [trigger, setTrigger] = useState<{ type: 'file' | 'command'; startIdx: number } | null>(null);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 184) + 'px';
    }
  }, [text]);

  // Focus on mount and when run completes
  useEffect(() => {
    if (!isRunning) textareaRef.current?.focus();
  }, [isRunning]);

  // Detect @ and / triggers based on cursor position
  const checkTrigger = useCallback((value: string, cursorPos: number) => {
    // Find the @ or / that precedes the cursor
    const textBefore = value.slice(0, cursorPos);
    // Match @ or / at start of line or after a space
    const match = textBefore.match(/(?:^|\s)([@\/])(\S*)$/);
    if (match) {
      const fullMatch = match[0]; // includes leading space if any
      const prefix = match[1]; // @ or /
      // startIdx is the position of the trigger char itself
      const startIdx = cursorPos - fullMatch.length + (fullMatch.startsWith(' ') ? 1 : 0);
      if (prefix === '@') {
        setTrigger({ type: 'file', startIdx });
        return;
      }
      if (prefix === '/') {
        setTrigger({ type: 'command', startIdx });
        return;
      }
    }
    setTrigger(null);
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    setText(newValue);
    checkTrigger(newValue, e.target.selectionStart);
  };

  // Re-check trigger on cursor move (arrow keys)
  const handleKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    checkTrigger(el.value, el.selectionStart);
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    checkTrigger(el.value, el.selectionStart);
  };

  // Remove trigger text + trigger char from textarea
  const removeTrigger = useCallback(() => {
    if (!trigger) return;
    const currentCursor = textareaRef.current?.selectionStart ?? trigger.startIdx;
    setText((prev) => {
      const before = prev.slice(0, trigger.startIdx);
      const after = prev.slice(currentCursor);
      return before + after;
    });
    setTrigger(null);
    textareaRef.current?.focus();
  }, [trigger]);

  // FilePicker: on select
  const handleFileSelect = useCallback(
    (filePath: string) => {
      const vaultId = vaultStore.getActiveVaultId();
      if (!vaultId) return;
      // Avoid duplicates
      setFileRefs((prev) => {
        if (prev.some((r) => r.filePath === filePath)) return prev;
        return [...prev, { vaultId, filePath }];
      });
      removeTrigger();
    },
    [removeTrigger],
  );

  // FilePicker: on close (Escape) — clean up @ trigger text
  const handleFilePickerClose = useCallback(() => {
    if (trigger?.type === 'file') removeTrigger();
    else {
      setTrigger(null);
      textareaRef.current?.focus();
    }
  }, [trigger, removeTrigger]);

  // CommandPalette: on execute (Enter)
  const handleCommandExecute = useCallback(
    (action: CommandAction) => {
      removeTrigger();
      switch (action.type) {
        case 'navigate':
          navigate(action.route);
          break;
        case 'insert':
          setText((prev) => prev + action.text);
          break;
        case 'callback':
          onCommand?.(action.key);
          break;
        case 'none':
          break;
      }
    },
    [removeTrigger, navigate, onCommand],
  );

  // CommandPalette: Tab completion — insert completeText into textarea
  const handleCommandComplete = useCallback(
    (completeText: string) => {
      removeTrigger();
      setText((prev) => prev + completeText);
      textareaRef.current?.focus();
    },
    [removeTrigger],
  );

  // CommandPalette: on close (Escape) — clean up / trigger text
  const handleCommandClose = useCallback(() => {
    if (trigger?.type === 'command') removeTrigger();
    else {
      setTrigger(null);
      textareaRef.current?.focus();
    }
  }, [trigger, removeTrigger]);

  // Remove a fileRef badge
  const removeFileRef = useCallback((idx: number) => {
    setFileRefs((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleSend = () => {
    const trimmed = text.trim();
    const hasContent = trimmed || fileRefs.length > 0 || pastedImages.length > 0;
    if (hasContent && !isRunning) {
      onSend(trimmed, fileRefs, pastedImages);
      setText('');
      setFileRefs([]);
      setPastedImages([]);
      setTrigger(null);
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Don't send if a trigger overlay is open — FilePicker/CommandPalette handles Enter
      if (!trigger) {
        handleSend();
      }
    }
  };

  // Upload a single image file (from paste or file picker)
  const uploadImage = useCallback(async (file: File) => {
    const vaultId = vaultStore.getActiveVaultId();
    if (!vaultId) {
      return;
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempUrl = URL.createObjectURL(file);

    // Add with uploading state (show local preview immediately)
    setPastedImages((prev) => [...prev, { id, filePath: '', url: tempUrl, state: 'uploading' }]);

    try {
      const { filePath, url } = await api.uploadAsset(vaultId, file);
      // Update to done state with server URL
      setPastedImages((prev) =>
        prev.map((img) => (img.id === id ? { ...img, filePath, url, state: 'done' as const } : img)),
      );
      // Revoke local blob URL after server URL is set
      URL.revokeObjectURL(tempUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('composer.uploadError');
      setPastedImages((prev) =>
        prev.map((img) => (img.id === id ? { ...img, state: 'error' as const, error: message } : img)),
      );
    }
  }, [t]);

  // Handle image paste (Ctrl+V / Cmd+V)
  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item || !item.type.startsWith('image/')) continue;

        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        uploadImage(file);
      }
    },
    [uploadImage],
  );

  // Handle image selection from file input
  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files) return;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file && file.type.startsWith('image/')) {
          uploadImage(file);
        }
      }
      // Reset input so same file can be selected again
      e.target.value = '';
    },
    [uploadImage],
  );

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // Remove a pasted image
  const removePastedImage = useCallback((id: string) => {
    setPastedImages((prev) => {
      const img = prev.find((p) => p.id === id);
      if (img && img.url.startsWith('blob:')) {
        URL.revokeObjectURL(img.url);
      }
      return prev.filter((p) => p.id !== id);
    });
  }, []);

  // Retry failed upload
  const retryImage = useCallback(
    async (id: string) => {
      setPastedImages((prev) =>
        prev.map((img) => (img.id === id ? { ...img, state: 'uploading' as const, error: undefined } : img)),
      );
      // We can't re-upload without the original File object, so just remove and let user re-paste
      // For now, mark as error with message
      setPastedImages((prev) =>
        prev.map((img) =>
          img.id === id
            ? { ...img, state: 'error' as const, error: t('composer.uploadRetryHint') }
            : img,
        ),
      );
    },
    [t],
  );

  const canSend =
    (text.trim().length > 0 || fileRefs.length > 0 || pastedImages.some((p) => p.state === 'done')) &&
    !isRunning &&
    !disabled;
  const placeholder = disabled
    ? (disabledPlaceholder ?? t('composer.noAgent'))
    : isRunning
      ? t('composer.waiting')
      : t('composer.placeholder');

  // Get vaultId for FilePicker
  const activeVaultId = vaultStore.getActiveVaultId();

  // Extract filter text from trigger char to cursor
  const filterText = trigger
    ? text.slice(trigger.startIdx + 1, textareaRef.current?.selectionStart ?? undefined)
    : '';

  return (
    <div className="composer">
      <div className="composer-shell">
        {/* FileRef badges + image thumbnails */}
        {(fileRefs.length > 0 || pastedImages.length > 0) && (
          <div className="composer-attachments" data-testid="composer-attachments">
            {fileRefs.map((ref, i) => (
              <span key={`file-${ref.filePath}-${i}`} className="composer-file-badge" data-testid="composer-file-badge">
                <span className="composer-file-badge-name" title={ref.filePath}>
                  {'📄 '}
                  {ref.filePath.split('/').pop() ?? ref.filePath}
                </span>
                <button
                  type="button"
                  className="composer-file-badge-remove"
                  data-testid="composer-file-badge-remove"
                  onClick={() => removeFileRef(i)}
                  aria-label="移除引用"
                >
                  ×
                </button>
              </span>
            ))}
            {pastedImages.map((img) => (
              <div
                key={`img-${img.id}`}
                className={`composer-image-thumb${img.state === 'error' ? ' is-error' : ''}`}
                data-testid="composer-image-thumb"
              >
                {img.state === 'uploading' && (
                  <div className="composer-image-thumb-loading">
                    <div className="composer-image-thumb-spinner" />
                  </div>
                )}
                {img.state === 'error' && (
                  <button
                    type="button"
                    className="composer-image-thumb-retry"
                    onClick={() => retryImage(img.id)}
                    aria-label="重新上传"
                    title={img.error ?? t('composer.uploadError')}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="23 4 23 10 17 10" />
                      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                    </svg>
                  </button>
                )}
                <img
                  src={img.url}
                  alt={img.filePath || 'pasted image'}
                  className="composer-image-thumb-img"
                  onClick={() => {
                    if (img.state === 'done') window.open(img.url, '_blank');
                  }}
                  style={{ cursor: img.state === 'done' ? 'pointer' : 'default' }}
                />
                <button
                  type="button"
                  className="composer-image-thumb-remove"
                  onClick={() => removePastedImage(img.id)}
                  aria-label="移除图片"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Uploading indicator */}
        {/* Upload error */}

        {/* Textarea with trigger overlays */}
        <div className="composer-trigger-zone">
          <textarea
            ref={textareaRef}
            data-testid="composer-input"
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            onMouseUp={handleMouseUp}
            onPaste={handlePaste}
            placeholder={placeholder}
            disabled={isRunning || disabled}
            rows={1}
          />

          {/* FilePicker overlay */}
          {trigger?.type === 'file' && activeVaultId && (
            <FilePicker
              vaultId={activeVaultId}
              filterText={filterText}
              onSelect={handleFileSelect}
              onClose={handleFilePickerClose}
            />
          )}

          {/* CommandPalette overlay */}
          {trigger?.type === 'command' && (
            <CommandPalette
              filterText={filterText}
              commands={commands}
              onExecute={handleCommandExecute}
              onComplete={handleCommandComplete}
              onClose={handleCommandClose}
            />
          )}
        </div>

        <div className="composer-row">
          {isRunning ? (
            <>
              <span className="composer-spacer" />
              <button
                type="button"
                data-testid="composer-stop"
                className="composer-send stop"
                onClick={onCancel}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                </svg>
                {t('composer.stop')}
              </button>
            </>
          ) : (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                className="composer-file-input"
                data-testid="composer-file-input"
                onChange={handleFileInputChange}
              />
              <button
                type="button"
                className="composer-upload-btn"
                data-testid="composer-upload-btn"
                onClick={openFilePicker}
                disabled={disabled}
                title={t('composer.uploadImage')}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="M21 15l-5-5-7 7" />
                </svg>
              </button>
              <span className="composer-spacer" />
              <button
                type="button"
                data-testid="composer-send"
                className="composer-send"
                disabled={!canSend}
                onClick={handleSend}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
                {t('composer.send')}
              </button>
            </>
          )}
        </div>
      </div>
      <div className="composer-hint">@ 引用文件  / 命令  粘贴图片  Enter 发送  Shift+Enter 换行</div>
    </div>
  );
}
