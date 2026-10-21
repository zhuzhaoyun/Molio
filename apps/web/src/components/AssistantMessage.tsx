import { useMemo, useState } from 'react';
import type { ChatMessage } from '../hooks/useChatCore';
import { renderMarkdown, splitContent } from '../utils/markdown';
import { groupTools, isInteractive } from '../utils/toolGroups';
import { splitMessageParts } from '../utils/messageText';
import { extractSandboxSuggest } from '../utils/ruleSandbox';
import { CodeBlock } from './CodeBlock';
import { QuizCard } from './QuizCard';
import { SandboxCard } from './SandboxCard';
import { useWikiLinkClick } from '../hooks/useWikiLinkClick';
import { useI18n } from '../i18n';
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
  /** Conversation id — scopes quiz localStorage keys. */
  conversationId?: string | null;
}

export function AssistantMessage({ message, isLast, onAnswerToolUse, onSubmitForm, onRegenerate, onContinue, onRequestDelete, conversationId }: Props) {
  const { t } = useI18n();
  const selectMode = useSelectMode();
  const selected = useIsSelected(message.id);

  // Check if the message has an AskUserQuestion tool — suppress the markdown
  // fallback text that duplicates the interactive card.
  const hasAskUserQuestion = message.tools?.some(
    (t) => t.name === 'AskUserQuestion' || t.name === 'ask_user_question'
  );
  // 正文只显示最终答案（最后一个工具之后的文本）；执行中的叙事进工作块过程流。
  // 运行中（streaming）拆分为 { process: 全文, answer: '' } —— 全部文本在工作卡片内渐进。
  const { processSegs, process, answer } = useMemo(() => splitMessageParts(message), [message]);
  const displayAnswer = hasAskUserQuestion ? suppressAskUserQuestionFallback(answer) : answer;
  const displayProcess = hasAskUserQuestion ? suppressAskUserQuestionFallback(process) : process;
  // AskUserQuestion 场景：fallback 抑制只对拼接文本有效，分段不传（工作块退回整块叙事）。
  const displayProcessSegs = hasAskUserQuestion ? undefined : processSegs;

  // sandbox-suggest 标记是协议内容（常驻规则约定模型在回答末尾追加），
  // 从展示/复制/存库的正文里剥掉，末尾转成「做成可拖动演示」建议 chip。
  const { text: answerText, suggest: sandboxSuggest } = useMemo(
    () => extractSandboxSuggest(displayAnswer, !!message.streaming),
    [displayAnswer, message.streaming],
  );
  const [suggestUsed, setSuggestUsed] = useState(false);

  const segments = useMemo(() => splitContent(answerText), [answerText]);
  // quiz / rule-sandbox 围栏可能出现在最后一个工具之前（模型出题/演示后又读了
  // 一次文件）：splitMessageParts 会把这段归入过程叙事，WorkBlock 又把闭合围栏
  // 剥掉 —— 不在这里捞出来，卡片就从活动会话里消失，直到整页刷新才回来。
  // 运行中不捞（此围栏还在流式增长，WorkBlock 显示占位），结束后一次性提升为
  // 消息级卡片。
  const processQuizSegments = useMemo(
    () => (message.streaming
      ? []
      : splitContent(displayProcess).filter(
        (seg): seg is Extract<ReturnType<typeof splitContent>[number], { type: 'quiz' }> =>
          seg.type === 'quiz' && seg.complete,
      )),
    [message.streaming, displayProcess],
  );
  const processSandboxSegments = useMemo(
    () => (message.streaming
      ? []
      : splitContent(displayProcess).filter(
        (seg): seg is Extract<ReturnType<typeof splitContent>[number], { type: 'sandbox' }> =>
          seg.type === 'sandbox' && seg.complete,
      )),
    [message.streaming, displayProcess],
  );
  const toolItems = useMemo(
    () => groupTools(message.tools || []),
    [message.tools]
  );

  // 交互卡（AskUserQuestion）必须常显，不进 WorkBlock 折叠；其余工具收进工作块。
  const interactiveItems = useMemo(() => toolItems.filter(isInteractive), [toolItems]);
  const workItems = useMemo(() => toolItems.filter((it) => !isInteractive(it)), [toolItems]);

  // 有工作痕迹（思考 / 工具 / 运行中）时整块渲染；纯问答降级为独立 usage-footer。
  const hasWorkBlock = !!message.streaming || workItems.length > 0 || !!message.thinking;

  const handleProseClick = useWikiLinkClick();

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
          processText={displayProcess}
          processSegments={displayProcessSegs}
          isLast={isLast}
          onAnswerToolUse={onAnswerToolUse}
          onSubmitForm={onSubmitForm}
        />
      )}

      {processQuizSegments.map((seg, i) => (
        <QuizCard
          key={`process-quiz-${i}`}
          raw={seg.raw}
          complete
          streaming={false}
          conversationId={conversationId}
        />
      ))}

      {processSandboxSegments.map((seg, i) => (
        <SandboxCard
          key={`process-sandbox-${i}`}
          raw={seg.raw}
          complete
          streaming={false}
        />
      ))}

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
            {splitContent(message.error).map((seg, i) => {
              if (seg.type === 'text') {
                return <div key={i} dangerouslySetInnerHTML={{ __html: renderMarkdown(seg.content) }} />;
              }
              const code = seg.type === 'code' ? seg.code : seg.raw;
              const lang = seg.type === 'code' ? seg.lang : seg.type === 'quiz' ? 'quiz' : 'rule-sandbox';
              return <CodeBlock key={i} lang={lang} code={code} streaming={false} />;
            })}
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

      {answerText && (
        <div
          className="assistant-prose"
          data-testid="assistant-prose"
          onClick={handleProseClick}
          role="presentation"
        >
          {segments.map((seg, i) => {
            if (seg.type === 'text') {
              return <div key={i} dangerouslySetInnerHTML={{ __html: renderMarkdown(seg.content) }} />;
            }
            if (seg.type === 'quiz') {
              return (
                <QuizCard
                  key={i}
                  raw={seg.raw}
                  complete={seg.complete}
                  streaming={message.streaming}
                  conversationId={conversationId}
                />
              );
            }
            if (seg.type === 'sandbox') {
              return (
                <SandboxCard
                  key={i}
                  raw={seg.raw}
                  complete={seg.complete}
                  streaming={message.streaming}
                />
              );
            }
            return <CodeBlock key={i} lang={seg.lang} code={seg.code} streaming={message.streaming} />;
          })}
        </div>
      )}

      {/* 演示建议 chip：模型判定回答依赖某个明确边界、而用户没有要求演示时，
          常驻规则让它在回答末尾追加 sandbox-suggest 标记 —— 原始标记不可见，
          这里转成一键生成入口。点击后消失（后续回复里会出真卡）。 */}
      {sandboxSuggest && !message.streaming && !selectMode && !suggestUsed && (
        <button
          type="button"
          className="sandbox-suggest-chip"
          data-testid="sandbox-suggest-chip"
          onClick={() => {
            setSuggestUsed(true);
            onSubmitForm?.(`给我演示一下：${sandboxSuggest}`);
          }}
        >
          {t('sandbox.suggest')}
        </button>
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
              text: answerText, onClick: () => {},
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
              <SaveToKbButton content={answerText} />
              <SaveAsSkillButton content={answerText} />
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
