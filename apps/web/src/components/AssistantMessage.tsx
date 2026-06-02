import { useMemo } from 'react';
import type { ChatMessage } from '../hooks/useChat';
import { ToolCard } from './ToolCard';
import { ThinkingBlock } from './ThinkingBlock';

interface Props {
  message: ChatMessage;
  /** True only for the most recent assistant message — locks older AskUserQuestion cards. */
  isLast?: boolean;
  /** Route tool_result back to the open stream-json child via daemon. */
  onAnswerToolUse?: (toolUseId: string, content: string) => Promise<boolean> | boolean;
  /** Fallback: send the answer as a fresh user message. */
  onSubmitForm?: (text: string) => void;
}

export function AssistantMessage({ message, isLast, onAnswerToolUse, onSubmitForm }: Props) {
  // Check if the message has an AskUserQuestion tool — suppress the markdown
  // fallback text that duplicates the interactive card.
  const hasAskUserQuestion = message.tools?.some(
    (t) => t.name === 'AskUserQuestion' || t.name === 'ask_user_question'
  );
  const displayContent = hasAskUserQuestion
    ? suppressAskUserQuestionFallback(message.content)
    : message.content;

  const html = useMemo(() => renderMarkdown(displayContent), [displayContent]);

  return (
    <div className="msg assistant">
      <div className="role">
        <span>Assistant</span>
        <span className="msg-time">{formatTime(message.timestamp)}</span>
      </div>

      {message.thinking && (
        <ThinkingBlock content={message.thinking} streaming={message.streaming && !message.content} />
      )}

      {message.tools && message.tools.length > 0 && (
        <div className="tool-cards">
          {message.tools.map((tool) => (
            <ToolCard
              key={tool.id}
              tool={tool}
              isLast={isLast}
              onAnswerToolUse={onAnswerToolUse}
              onSubmitForm={onSubmitForm}
            />
          ))}
        </div>
      )}

      {displayContent && (
        <div
          className="assistant-prose"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}

      {message.streaming && <span className="streaming-cursor" />}

      {message.usage && (
        <div className="usage-footer">
          {message.usage.input != null && <span>{message.usage.input} in</span>}
          {message.usage.output != null && <span>{message.usage.output} out</span>}
          {message.usage.cost != null && <span>${message.usage.cost.toFixed(4)}</span>}
        </div>
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

/**
 * Lightweight Markdown renderer — handles common patterns without a full library.
 * Renders: paragraphs, code blocks, inline code, bold, italic, links, lists, headers, blockquotes, tables.
 */
function renderMarkdown(text: string): string {
  if (!text) return '';

  // Escape HTML
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Fenced code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    return `<pre><code>${code.trim()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold and italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>');

  // Tables (basic)
  html = html.replace(/^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/gm, (_m, headerRow, _sepRow, bodyRows) => {
    const headers = headerRow.split('|').filter(Boolean).map((h: string) => `<th>${h.trim()}</th>`).join('');
    const rows = bodyRows.trim().split('\n').map((row: string) => {
      const cells = row.split('|').filter(Boolean).map((c: string) => `<td>${c.trim()}</td>`).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
    return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
  });

  // Paragraphs — wrap remaining text blocks
  html = html
    .split(/\n\n+/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      if (/^<[hupbolt]|^<hr|^<table|^<blockquote/.test(trimmed)) return trimmed;
      return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');

  return html;
}
