import { useMemo, useCallback } from 'react';
import type { ChatMessage } from '../hooks/useChat';
import { renderMarkdown, splitContent } from '../utils/markdown';
import { groupTools, isInteractive } from '../utils/toolGroups';
import { CodeBlock } from './CodeBlock';
import { useI18n } from '../i18n';
import { useActiveVaultId } from '../stores/vaultStore';
import { useFileNavigation } from '../hooks/useFileNavigation';
import { ToolCard } from './ToolCard';
import { WorkBlock } from './WorkBlock';
import { WorkCompleteBanner } from './WorkCompleteBanner';
import { SourceChips } from './SourceChips';
import { SaveToKbButton } from './SaveToKbButton';
import { SaveAsSkillButton } from './SaveAsSkillButton';
import { MessageToolbar } from './MessageToolbar';
import { useSelectMode, useIsSelected } from '../stores/messageSelectionStore';
import { MessageCheckbox } from './MessageCheckbox';

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

  // 交互卡（AskUserQuestion）必须常显，不进 WorkBlock 折叠；其余工具收进工作块。
  const interactiveItems = useMemo(() => toolItems.filter(isInteractive), [toolItems]);
  const workItems = useMemo(() => toolItems.filter((it) => !isInteractive(it)), [toolItems]);

  // 有工作痕迹（思考 / 工具 / 运行中）时整块渲染；纯问答降级为独立 usage-footer。
  const hasWorkBlock = !!message.streaming || workItems.length > 0 || !!message.thinking;

  const activeVaultId = useActiveVaultId();
  const { openFile } = useFileNavigation();

  const handleProseClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      const link = target.closest('.kb-wiki-link') as HTMLAnchorElement | null;
      if (!link || !activeVaultId) return;

      e.preventDefault();
      const filePath = link.getAttribute('data-file-path') || link.textContent?.trim();
      if (!filePath) return;

      // Check if file exists before navigating (dead link handling)
      const encoded = encodeURIComponent(filePath).replace(/%2F/g, '/');
      fetch(`/api/knowledge/vaults/${activeVaultId}/resolve/${encoded}`)
        .then((res) => {
          if (res.status === 404) {
            window.alert(`文件 "${filePath}" 不存在`);
            return;
          }
          openFile(activeVaultId, filePath);
        })
        .catch(() => openFile(activeVaultId, filePath));
    },
    [openFile, activeVaultId],
  );

  return (
    <div
      className={`msg assistant${selectMode ? ' select-mode' : ''}${selected ? ' selected' : ''}`}
      data-testid="assistant-message"
      data-message-id={message.id}
    >
      <div className="role">
        <span>{t('assistant.label')}</span>
        <span className="msg-time">{formatTime(message.timestamp)}</span>
      </div>

      {hasWorkBlock && (
        <WorkBlock
          message={message}
          toolItems={workItems}
          isLast={isLast}
          onAnswerToolUse={onAnswerToolUse}
          onSubmitForm={onSubmitForm}
        />
      )}

      {selectMode && !message.streaming && (
        <MessageCheckbox id={message.id} />
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

      {/* 交互式问题卡：始终可见，不随工作块折叠 */}
      {interactiveItems.length > 0 && (
        <div className="tool-cards">
          {interactiveItems.map((item) => (
            <ToolCard
              key={item.tool.id}
              tool={item.tool}
              isLast={isLast}
              onAnswerToolUse={onAnswerToolUse}
              onSubmitForm={onSubmitForm}
              allTools={message.tools}
            />
          ))}
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

      {/* 产物卡：移入消息内，逐消息 provenance */}
      <WorkCompleteBanner tools={message.tools ?? []} />

      <SourceChips tools={message.tools ?? []} />
      {message.streaming && <span className="streaming-cursor" />}

      {!hasWorkBlock && message.usage && (
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
          extra={
            <>
              <SaveToKbButton content={message.content} />
              <SaveAsSkillButton content={message.content} />
            </>
          }
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
