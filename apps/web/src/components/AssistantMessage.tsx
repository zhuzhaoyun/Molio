import { useMemo, useCallback } from 'react';
import type { ChatMessage, ToolEvent } from '../hooks/useChat';
import { renderMarkdown, splitContent } from '../utils/markdown';
import { CodeBlock } from './CodeBlock';
import { useI18n } from '../i18n';
import { useActiveVaultId } from '../stores/vaultStore';
import { useFileNavigation } from '../hooks/useFileNavigation';
import { ToolCard } from './ToolCard';
import { ToolGroup, BatchGroup } from './ToolGroup';
import { ThinkingBlock } from './ThinkingBlock';
import { SaveToKbButton } from './SaveToKbButton';
import { MessageToolbar } from './MessageToolbar';
import { useSelectMode, useIsSelected } from '../stores/messageSelectionStore';
import { MessageCheckbox } from './MessageCheckbox';

// Tools that should never be grouped (always shown individually)
const UNGROUPABLE = new Set(['AskUserQuestion', 'ask_user_question']);

type ToolItem =
  | { kind: 'single'; tool: ToolEvent }
  | { kind: 'group'; toolName: string; tools: ToolEvent[] }
  | { kind: 'batch'; tools: ToolEvent[] };

/**
 * Group consecutive same-type tool calls (≥2 same name), then group
 * consecutive different-name singles into a batch when ≥3.
 */
function groupTools(tools: ToolEvent[]): ToolItem[] {
  // First pass: same-name grouping
  const pass1 = groupSameName(tools);

  // Second pass: merge consecutive different-name singles → batch when ≥3
  const result: ToolItem[] = [];
  let i = 0;
  while (i < pass1.length) {
    const item = pass1[i]!;
    if (item.kind !== 'single') {
      result.push(item);
      i++;
      continue;
    }

    // Collect consecutive singles with different names
    const batchTools: ToolEvent[] = [item.tool];
    let j = i + 1;
    while (j < pass1.length && pass1[j]!.kind === 'single') {
      const nextTool = (pass1[j] as { kind: 'single'; tool: ToolEvent }).tool;
      // Don't batch if same name as the previous tool (shouldn't happen after pass1,
      // but guard against edge cases)
      if (nextTool.name === batchTools[batchTools.length - 1]!.name) break;
      // Don't batch UNGROUPABLE tools — they need their interactive card
      if (UNGROUPABLE.has(nextTool.name)) break;
      batchTools.push(nextTool);
      j++;
    }

    if (batchTools.length >= 3) {
      result.push({ kind: 'batch', tools: batchTools });
    } else {
      for (const t of batchTools) {
        result.push({ kind: 'single', tool: t });
      }
    }
    i = j;
  }

  return result;
}

/**
 * Group consecutive same-name tool calls.
 * Only groups when ≥2 consecutive tools share the same name.
 */
function groupSameName(tools: ToolEvent[]): ToolItem[] {
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
}

export function AssistantMessage({ message, isLast, onAnswerToolUse, onSubmitForm, onRegenerate, onContinue, onRequestDelete }: Props) {
  const { t } = useI18n();
  const selectMode = useSelectMode();
  const selected = useIsSelected(message.id);

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

      {message.repairing && (
        <div className="repairing-status" data-testid="repairing-status">
          <span className="repairing-spinner" aria-hidden />
          <span>{message.repairing}</span>
        </div>
      )}

      {message.error && (
        <div className="assistant-error" data-testid="assistant-error" role="alert">
          <div className="assistant-error-header">
            <span className="assistant-error-label">错误</span>
          </div>
          <div className="assistant-error-body">
            {splitContent(message.error).map((seg, i) =>
              seg.type === 'text' ? (
                <div key={i} dangerouslySetInnerHTML={{ __html: renderMarkdown(seg.content) }} />
              ) : (
                <CodeBlock key={i} lang={seg.lang} code={seg.code} streaming={false} />
              ),
            )}
          </div>
        </div>
      )}

      {toolItems.length > 0 && (
        <div className="tool-cards">
          {toolItems.map((item, idx) =>
            item.kind === 'batch' ? (
              <BatchGroup key={`batch-${idx}`} tools={item.tools} />
            ) : item.kind === 'group' ? (
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
                allTools={message.tools}
              />
            )
          )}
        </div>
      )}

      {displayContent && (
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
          overflow={onRequestDelete ? [{
            key: 'delete', label: '删除', testid: 'overflow-item-delete',
            text: '', onClick: () => onRequestDelete(message.id),
          }] : undefined}
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

