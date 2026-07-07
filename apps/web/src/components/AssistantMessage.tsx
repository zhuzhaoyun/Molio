import { useMemo, useCallback, useState } from 'react';
import type { ChatMessage, ToolEvent } from '../hooks/useChat';
import { renderMarkdown, splitContent } from '../utils/markdown';
import { CodeBlock } from './CodeBlock';
import { useI18n } from '../i18n';
import { useActiveVaultId } from '../stores/vaultStore';
import { useFileNavigation } from '../hooks/useFileNavigation';
import { ToolCard } from './ToolCard';
import { ToolGroup } from './ToolGroup';
import { ThinkingBlock } from './ThinkingBlock';
import { SaveToKbButton } from './SaveToKbButton';
import { MessageToolbar } from './MessageToolbar';
import { useSelectMode, useIsSelected } from '../stores/messageSelectionStore';
import { MessageCheckbox } from './MessageCheckbox';

// Tools that should never be grouped (always shown individually)
const UNGROUPABLE = new Set(['AskUserQuestion', 'ask_user_question']);

type ToolItem =
  | { kind: 'single'; tool: ToolEvent }
  | { kind: 'group'; toolName: string; tools: ToolEvent[] };

/**
 * Group consecutive same-type tool calls.
 * Only groups when ≥2 consecutive tools share the same name.
 */
function groupTools(tools: ToolEvent[]): ToolItem[] {
  const result: ToolItem[] = [];
  let i = 0;

  while (i < tools.length) {
    const tool = tools[i]!;

    // AskUserQuestion is always single
    if (UNGROUPABLE.has(tool.name)) {
      result.push({ kind: 'single', tool });
      i++;
      continue;
    }

    // Count consecutive same-type tools
    let j = i + 1;
    while (j < tools.length && tools[j]!.name === tool.name && !UNGROUPABLE.has(tools[j]!.name)) {
      j++;
    }
    const count = j - i;

    if (count >= 2) {
      // Group them
      result.push({ kind: 'group', toolName: tool.name, tools: tools.slice(i, j) });
    } else {
      // Single tool
      result.push({ kind: 'single', tool });
    }
    i = j;
  }

  return result;
}

interface Props {
  message: ChatMessage;
  /** True only for the most recent assistant message — locks older AskUserQuestion cards. */
  isLast?: boolean;
  /** Route tool_result back to the open stream-json child via daemon. */
  onAnswerToolUse?: (toolUseId: string, content: string) => Promise<boolean | void> | boolean | void;
  /** Fallback: send the answer as a fresh user message. */
  onSubmitForm?: (text: string) => void;
  /** Regenerate the last assistant reply. */
  onRegenerate?: () => void;
  /** Continue generating on the last assistant reply (sends a "继续" follow-up). */
  onContinue?: () => void;
  /** Request to delete (opens selection mode with this message's pair). */
  onRequestDelete?: (id: string) => void;
  /** Manually edit this assistant reply's content (no rerun). */
  onEditAssistant?: (msgId: string, content: string) => void;
}

export function AssistantMessage({ message, isLast, onAnswerToolUse, onSubmitForm, onRegenerate, onContinue, onRequestDelete, onEditAssistant }: Props) {
  const { t } = useI18n();
  const selectMode = useSelectMode();
  const selected = useIsSelected(message.id);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);

  const startEdit = useCallback(() => {
    setDraft(message.content);
    setEditing(true);
  }, [message.content]);

  const cancelEdit = useCallback(() => {
    setDraft(message.content);
    setEditing(false);
  }, [message.content]);

  const saveEdit = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setEditing(false);
    onEditAssistant?.(message.id, trimmed);
  }, [draft, onEditAssistant, message.id]);

  // Check if the message has an AskUserQuestion tool — suppress the markdown
  // fallback text that duplicates the interactive card.
  const hasAskUserQuestion = message.tools?.some(
    (t) => t.name === 'AskUserQuestion' || t.name === 'ask_user_question'
  );
  const displayContent = hasAskUserQuestion
    ? suppressAskUserQuestionFallback(message.content)
    : message.content;

  const segments = useMemo(() => splitContent(displayContent), [displayContent]);
  const toolItems = useMemo(
    () => groupTools(message.tools || []),
    [message.tools]
  );

  const activeVaultId = useActiveVaultId();
  const { openFile } = useFileNavigation();

  const handleProseClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      const link = target.closest('.kb-wiki-link') as HTMLAnchorElement | null;
      if (!link || !activeVaultId) return;

      e.preventDefault();
      const filePath = link.getAttribute('data-file-path') || link.textContent?.trim();
      if (filePath) {
        openFile(activeVaultId, filePath);
      }
    },
    [openFile, activeVaultId],
  );

  return (
    <div
      className={`msg assistant${selectMode ? ' select-mode' : ''}${selected ? ' selected' : ''}`}
      data-testid="assistant-message"
    >
      <div className="role">
        <span>{t('assistant.label')}</span>
        <span className="msg-time">{formatTime(message.timestamp)}</span>
      </div>

      {selectMode && !message.streaming && (
        <MessageCheckbox id={message.id} />
      )}

      {message.thinking && (
        <ThinkingBlock content={message.thinking} streaming={message.streaming && !message.content} />
      )}

      {toolItems.length > 0 && (
        <div className="tool-cards">
          {toolItems.map((item, idx) =>
            item.kind === 'group' ? (
              <ToolGroup
                key={`group-${idx}`}
                tools={item.tools}
                toolName={item.toolName}
              />
            ) : (
              <ToolCard
                key={item.tool.id}
                tool={item.tool}
                isLast={isLast}
                onAnswerToolUse={onAnswerToolUse}
                onSubmitForm={onSubmitForm}
              />
            )
          )}
        </div>
      )}

      {editing && !selectMode && !message.streaming ? (
        <div className="user-edit">
          <textarea
            data-testid="msg-edit-assistant-textarea"
            className="user-edit-input"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(16, Math.max(4, draft.split('\n').length))}
          />
          <div className="user-edit-actions">
            <button data-testid="msg-edit-assistant-cancel" className="user-edit-cancel" onClick={cancelEdit}>
              取消
            </button>
            <button
              data-testid="msg-edit-assistant-save"
              className="user-edit-save"
              onClick={saveEdit}
              disabled={!draft.trim()}
            >
              保存
            </button>
          </div>
        </div>
      ) : (
        displayContent && (
          <div
            className="assistant-prose"
            data-testid="assistant-prose"
            onClick={handleProseClick}
            role="presentation"
          >
            {segments.map((seg, i) =>
              seg.type === 'text' ? (
                <div key={i} dangerouslySetInnerHTML={{ __html: renderMarkdown(seg.content) }} />
              ) : (
                <CodeBlock key={i} lang={seg.lang} code={seg.code} streaming={message.streaming} />
              ),
            )}
          </div>
        )
      )}

      {message.streaming && <span className="streaming-cursor" />}

      {message.usage && (
        <div className="usage-footer" data-testid="usage-footer">
          {message.usage.input != null && <span>{message.usage.input} in</span>}
          {message.usage.output != null && <span>{message.usage.output} out</span>}
          {message.usage.cost != null && <span>${message.usage.cost.toFixed(4)}</span>}
        </div>
      )}

      {!message.streaming && !selectMode && (
        <MessageToolbar
          actions={[
            {
              key: 'copy', label: '复制', testid: 'msg-copy-btn',
              text: message.content, onClick: () => {},
            },
            ...(isLast && onContinue
              ? [{
                  key: 'continue' as const, label: '继续生成', testid: 'msg-continue-btn',
                  text: '', onClick: onContinue,
                }]
              : []),
            ...(isLast && onRegenerate
              ? [{
                  key: 'regenerate' as const, label: '重新生成', testid: 'msg-regenerate-btn',
                  text: '', onClick: onRegenerate,
                }]
              : []),
          ]}
          extra={<SaveToKbButton content={message.content} />}
          overflow={(onRequestDelete || onEditAssistant) ? [
            ...(onEditAssistant ? [{
              key: 'edit-assistant' as const, label: '编辑', testid: 'overflow-item-edit',
              text: '', onClick: startEdit,
            }] : []),
            ...(onRequestDelete ? [{
              key: 'delete' as const, label: '删除', testid: 'overflow-item-delete',
              text: '', onClick: () => onRequestDelete(message.id),
            }] : []),
          ] : undefined}
        />
      )}
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Strip the markdown fallback text that Claude generates for AskUserQuestion
 * (the model writes the same question/options as markdown when it cannot
 * prompt the user interactively). The interactive card already renders this
 * content, so showing it again as prose is duplicative noise.
 */
function suppressAskUserQuestionFallback(text: string): string {
  if (!text) return text;
  // Remove <question-form>...</question-form> blocks
  let cleaned = text.replace(/<question-form>[\s\S]*?<\/question-form>/g, '');
  // Remove common markdown fallback patterns: lines starting with "question"
  // followed by option bullets like "- **Option A**: description"
  // This is a best-effort heuristic; the interactive card is authoritative.
  return cleaned.trim();
}

