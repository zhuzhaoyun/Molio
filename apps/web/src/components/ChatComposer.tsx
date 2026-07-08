import { useState, useRef, useEffect, useCallback } from 'react';
import { useI18n } from '../i18n';
import type { ConversationHistoryItem } from '@molio/contracts';
import { vaultStore } from '../stores/vaultStore';
import { api } from '../api/client';
import { FilePicker } from './FilePicker';
import { FolderIcon, FileDocIcon } from './FileIcons';

export interface FileRef {
  vaultId: string;
  filePath: string;
  /** True when filePath points at a directory rather than a file. */
  isDirectory?: boolean;
}

export interface PastedImage {
  id: string;
  filePath: string;
  url: string;
  state: 'uploading' | 'done' | 'error';
  error?: string;
  /** Original File — retained so a failed upload can be retried. */
  file?: File;
}

/**
 * Build the markdown prefix for file refs + pasted images. Shared by every
 * ChatComposer host (home page, file-chat panel) so the message format — and
 * the agent's reading cues — stay consistent.
 *
 * Folders get a trailing slash plus a link title that tells the agent to
 * enumerate the directory; files stay plain `[📄 name](path)` links.
 */
export function buildAttachmentPrefix(fileRefs: FileRef[], pastedImages: PastedImage[]): string {
  const parts: string[] = [];

  const doneImages = pastedImages.filter((p) => p.state === 'done');
  if (doneImages.length > 0) {
    parts.push(doneImages.map((p) => `![image](${p.filePath})`).join('\n'));
  }

  if (fileRefs.length > 0) {
    parts.push(
      fileRefs
        .map((r) => {
          const name = r.filePath.split('/').pop() ?? r.filePath;
          if (r.isDirectory) {
            return `[📁 ${name}/](${r.filePath}/ "文件夹，请读取其下所有相关文件")`;
          }
          return `[📄 ${name}](${r.filePath})`;
        })
        .join(' '),
    );
  }

  return parts.length > 0 ? parts.join('\n\n') : '';
}

/** Module-level draft cache — survives component unmount during navigation. */
const drafts = new Map<string, string>();

interface Props {
  isRunning: boolean;
  onSend: (message: string, fileRefs: FileRef[], pastedImages: PastedImage[]) => void;
  onCancel: () => void;
  disabled?: boolean;
  disabledPlaceholder?: string;
  /** Pre-populated file refs (e.g. "ask about this file" shortcut). */
  initialFileRefs?: FileRef[];
  /** Callback when user selects a conversation from history. */
  onOpenConversation?: (conversationId: string) => void;
  /** Stable key for persisting draft text across navigation. */
  composerKey?: string;
}

export function ChatComposer({
  isRunning,
  onSend,
  onCancel,
  disabled,
  disabledPlaceholder,
  initialFileRefs,
  onOpenConversation,
  composerKey,
}: Props) {
  const { t } = useI18n();
  const [text, setText] = useState(() => (composerKey ? drafts.get(composerKey) ?? '' : ''));
  const [fileRefs, setFileRefs] = useState<FileRef[]>(initialFileRefs ?? []);
  const [pastedImages, setPastedImages] = useState<PastedImage[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // History picker state
  const [showHistory, setShowHistory] = useState(false);
  const [historyItems, setHistoryItems] = useState<ConversationHistoryItem[]>([]);

  // FilePicker trigger: @ start index in textarea value
  const [triggerStartIdx, setTriggerStartIdx] = useState<number | null>(null);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 184) + 'px';
    }
  }, [text]);

  // Persist draft text to module-level cache so it survives navigation
  useEffect(() => {
    if (!composerKey) return;
    if (text) {
      drafts.set(composerKey, text);
    } else {
      drafts.delete(composerKey);
    }
  }, [text, composerKey]);

  // Focus on mount and when run completes
  useEffect(() => {
    if (!isRunning) textareaRef.current?.focus();
  }, [isRunning]);

  // Detect @ trigger based on cursor position
  const checkTrigger = useCallback((value: string, cursorPos: number) => {
    const textBefore = value.slice(0, cursorPos);
    const match = textBefore.match(/(?:^|\s)@(\S*)$/);
    if (match) {
      const fullMatch = match[0];
      const startIdx = cursorPos - fullMatch.length + (fullMatch.startsWith(' ') ? 1 : 0);
      setTriggerStartIdx(startIdx);
      return;
    }
    setTriggerStartIdx(null);
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

  // Remove trigger text + @ from textarea
  const removeTrigger = useCallback(() => {
    if (triggerStartIdx === null) return;
    const currentCursor = textareaRef.current?.selectionStart ?? triggerStartIdx;
    setText((prev) => {
      const before = prev.slice(0, triggerStartIdx);
      const after = prev.slice(currentCursor);
      return before + after;
    });
    setTriggerStartIdx(null);
    textareaRef.current?.focus();
  }, [triggerStartIdx]);

  // FilePicker: on select
  const handleFileSelect = useCallback(
    (filePath: string, isDirectory: boolean) => {
      const vaultId = vaultStore.getActiveVaultId();
      if (!vaultId) return;
      // Avoid duplicates
      setFileRefs((prev) => {
        if (prev.some((r) => r.filePath === filePath)) return prev;
        return [...prev, { vaultId, filePath, isDirectory }];
      });
      removeTrigger();
    },
    [removeTrigger],
  );

  // FilePicker: on close (Escape) — clean up @ trigger text
  const handleFilePickerClose = useCallback(() => {
    removeTrigger();
  }, [removeTrigger]);

  // Remove a fileRef badge
  const removeFileRef = useCallback((idx: number) => {
    setFileRefs((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleSend = () => {
    const trimmed = text.trim();
    // Only include images that finished uploading successfully — uploading
    // entries have filePath:'' and error entries have invalid data, so sending
    // them would push broken markdown to the backend.
    const doneImages = pastedImages.filter((p) => p.state === 'done');
    const hasContent = trimmed || fileRefs.length > 0 || doneImages.length > 0;
    if (hasContent && !isRunning) {
      onSend(trimmed, fileRefs, doneImages);
      setText('');
      // Clear the draft cache synchronously *before* the parent re-renders.
      // On the home page, the first send flips HomePage from the landing
      // branch to the chat-active branch, which unmounts this ChatComposer
      // and mounts a fresh one. That unmount happens before the draft-sync
      // effect (which depends on `text`) can run for the just-queued
      // setText(''), so the new instance would otherwise rehydrate from the
      // stale draft and the input would not be cleared.
      if (composerKey) drafts.delete(composerKey);
      setFileRefs([]);
      // Revoke any remaining blob URLs (error/uploading thumbs) before clearing.
      for (const img of pastedImages) {
        if (img.url.startsWith('blob:')) URL.revokeObjectURL(img.url);
      }
      setPastedImages([]);
      setTriggerStartIdx(null);
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Don't send if FilePicker overlay is open — FilePicker handles Enter
      if (triggerStartIdx === null) {
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
    setPastedImages((prev) => [...prev, { id, filePath: '', url: tempUrl, state: 'uploading', file }]);

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

  // History picker
  const historyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showHistory) return;
    const handler = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setShowHistory(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showHistory]);

  // Keep a ref of the latest pastedImages so the unmount cleanup (registered
  // once) can revoke any still-pending blob URLs — otherwise images left in
  // 'uploading' or 'error' state on unmount leak their object URLs.
  const pastedImagesRef = useRef<PastedImage[]>([]);
  pastedImagesRef.current = pastedImages;
  useEffect(() => {
    return () => {
      for (const img of pastedImagesRef.current) {
        if (img.url.startsWith('blob:')) URL.revokeObjectURL(img.url);
      }
    };
  }, []);

  const handleHistoryClick = useCallback(async () => {
    if (showHistory) {
      setShowHistory(false);
      return;
    }
    try {
      const items = await api.listConversationHistory();
      setHistoryItems(items);
      setShowHistory(true);
    } catch {
      // silently fail
    }
  }, [showHistory]);

  const handleSelectConversation = useCallback(
    (convId: string) => {
      setShowHistory(false);
      onOpenConversation?.(convId);
    },
    [onOpenConversation],
  );

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

  // Retry failed upload by re-uploading the retained original File.
  const retryImage = useCallback(
    async (id: string) => {
      // Read the current file via the state updater (avoids stale closure).
      let fileToRetry: File | undefined;
      setPastedImages((prev) => {
        fileToRetry = prev.find((p) => p.id === id)?.file;
        return prev;
      });
      if (!fileToRetry) return; // nothing to retry — keep the error thumb
      removePastedImage(id);
      uploadImage(fileToRetry);
    },
    [uploadImage, removePastedImage],
  );

  // Block sending while any image is still uploading so incomplete image data
  // is never pushed to the backend.
  const isUploading = pastedImages.some((p) => p.state === 'uploading');
  const canSend =
    (text.trim().length > 0 || fileRefs.length > 0 || pastedImages.some((p) => p.state === 'done')) &&
    !isUploading &&
    !isRunning &&
    !disabled;
  const placeholder = disabled
    ? (disabledPlaceholder ?? t('composer.noAgent'))
    : isRunning
      ? t('composer.waiting')
      : t('composer.placeholder');

  // Get vaultId for FilePicker
  const activeVaultId = vaultStore.getActiveVaultId();

  // Extract filter text from @ trigger to cursor
  const filterText = triggerStartIdx !== null
    ? text.slice(triggerStartIdx + 1, textareaRef.current?.selectionStart ?? undefined)
    : '';

  return (
    <div className="composer">
      <div className="composer-shell">
        {/* FileRef badges + image thumbnails */}
        {(fileRefs.length > 0 || pastedImages.length > 0) && (
          <div className="composer-attachments" data-testid="composer-attachments">
            {fileRefs.map((ref, i) => (
              <span key={`file-${ref.filePath}-${i}`} className="composer-file-badge" data-testid="composer-file-badge">
                <span className="composer-file-badge-icon">
                  {ref.isDirectory ? <FolderIcon size={13} /> : <FileDocIcon size={12} />}
                </span>
                <span className="composer-file-badge-name" title={ref.filePath}>
                  {ref.filePath.split('/').pop() ?? ref.filePath}
                  {ref.isDirectory ? '/' : ''}
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
          {triggerStartIdx !== null && activeVaultId && (
            <FilePicker
              vaultId={activeVaultId}
              filterText={filterText}
              onSelect={handleFileSelect}
              onClose={handleFilePickerClose}
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
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="M21 15l-5-5-7 7" />
                </svg>
              </button>
              {onOpenConversation && (
                <>
                  <button
                    type="button"
                    className="composer-upload-btn"
                    data-testid="composer-history-btn"
                    onClick={handleHistoryClick}
                    title={t('composer.history')}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                  </button>
                  {/* History dropdown */}
                  {showHistory && (
                    <div className="composer-history-dropdown" data-testid="composer-history-dropdown" ref={historyRef}>
                      <div className="composer-history-header">
                        <span>{t('composer.history')}</span>
                      </div>
                      <div className="composer-history-list">
                        {historyItems.length === 0 ? (
                          <div className="composer-history-empty">{t('composer.noHistory')}</div>
                        ) : (
                          groupedHistory(historyItems).map((group) => (
                            <div key={group.label}>
                              <div className="composer-history-group">{group.label}</div>
                              {group.items.map((item) => (
                                <button
                                  key={item.conversation.id}
                                  type="button"
                                  className="composer-history-item"
                                  data-testid="composer-history-item"
                                  onClick={() => handleSelectConversation(item.conversation.id)}
                                >
                                  <div className="composer-history-item-body">
                                    <span className="composer-history-title">
                                      {item.conversation.title || t('composer.untitled')}
                                    </span>
                                    <span className="composer-history-meta">
                                      {item.messageCount} 条消息
                                      {item.conversation.channelType && item.conversation.channelType !== 'desktop' && (
                                        <span className="composer-history-channel">
                                          {item.conversation.channelType === 'weixin' ? '微信' : item.conversation.channelType}
                                        </span>
                                      )}
                                    </span>
                                  </div>
                                  <span className="composer-history-time">
                                    {formatHistoryTime(item.conversation.updatedAt)}
                                  </span>
                                </button>
                              ))}
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
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
      <div className="composer-hint">
        <span className="hint-item"><kbd>@</kbd> <span className="hint-desc">{t('composer.hintFileRef')}</span></span>
        <span className="hint-sep">·</span>
        <span className="hint-item"><kbd>Enter</kbd> <span className="hint-desc">{t('composer.hintSend')}</span></span>
        <span className="hint-sep">·</span>
        <span className="hint-item"><kbd>Shift</kbd><span className="hint-kbd-plus">+</span><kbd>Enter</kbd> <span className="hint-desc">{t('composer.hintNewline')}</span></span>
      </div>
    </div>
  );
}

interface HistoryGroup {
  label: string;
  items: ConversationHistoryItem[];
}

function groupedHistory(items: ConversationHistoryItem[]): HistoryGroup[] {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const weekStart = todayStart - 7 * 86400000;

  const groups: Record<string, ConversationHistoryItem[]> = {};

  for (const item of items) {
    const ts = item.conversation.updatedAt;
    let key: string;
    if (ts >= todayStart) {
      key = '今天';
    } else if (ts >= yesterdayStart) {
      key = '昨天';
    } else if (ts >= weekStart) {
      key = '本周';
    } else {
      key = '更早';
    }
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }

  const order = ['今天', '昨天', '本周', '更早'];
  return order.filter((k) => groups[k]).map((label) => ({ label, items: groups[label] }));
}

function formatHistoryTime(ts: number): string {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= todayStart) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const thisYearStart = new Date(now.getFullYear(), 0, 1).getTime();
  if (ts >= thisYearStart) {
    return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return new Date(ts).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}
