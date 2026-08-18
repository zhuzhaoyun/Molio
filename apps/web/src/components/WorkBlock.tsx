// apps/web/src/components/WorkBlock.tsx
// 统一「工作块」：把 工作时间线 + 思考过程 + 工具卡 收进最后一条回复的一张可折叠卡片。
// 运行中 = 当前动作 + 静态底条 + 思考 + 工具行 + meta（模型·时间）；完成后 = 折叠成摘要头 + meta，
// 展开可看思考与工具行。旧的步骤列表（work-timeline-step）已删除 —— 工具行本身就地渲染，杜绝与时间线容余。
import { useEffect, useMemo, useState } from 'react';
import type { ChatMessage } from '../hooks/useChat';
import { deriveStepsForMessage } from '../utils/workSteps';
import type { ToolItem } from '../utils/toolGroups';
import { useI18n } from '../i18n';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCard } from './ToolCard';
import { ToolGroup, BatchGroup } from './ToolGroup';

interface Props {
  message: ChatMessage;
  /** 非交互工具项（AskUserQuestion 已被 AssistantMessage 拆分到卡片外常显） */
  toolItems: ToolItem[];
  /** True only for the most recent assistant message — locks AskUserQuestion cards. */
  isLast?: boolean;
  onAnswerToolUse?: (toolUseId: string, content: string) => Promise<boolean | void> | boolean | void;
  onSubmitForm?: (text: string) => void;
}

export function WorkBlock({ message, toolItems, isLast, onAnswerToolUse, onSubmitForm }: Props) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());

  const isRunning = !!message.streaming;

  // 新 run 开始 → 完成态折叠重置（不跨 run 记忆展开态）。
  useEffect(() => {
    if (isRunning) setExpanded(false);
  }, [isRunning]);

  // 运行中实时计时（200ms，与 RunStatusBar 同节奏）
  useEffect(() => {
    if (!isRunning) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [isRunning]);

  const steps = useMemo(() => deriveStepsForMessage(message), [message]);
  const hasThinking = !!message.thinking;
  const hasTools = toolItems.length > 0;

  // 没有任何工作痕迹时整块不渲染（纯问答、无工具无思考）。
  if (!isRunning && !hasThinking && !hasTools) return null;

  const hasError = !!message.error || (message.tools ?? []).some((tl) => tl.isError);

  // ── 耗时：运行中实时算，完成后用 finishedAt（消息创建时刻为起点） ──
  const elapsedMs = isRunning
    ? now - message.timestamp
    : (message.finishedAt ?? now) - message.timestamp;
  const elapsed = elapsedMs > 0 ? Math.round(elapsedMs / 1000) : 0;

  const renderTools = () => (
    toolItems.map((item, idx) =>
      item.kind === 'batch' ? (
        <BatchGroup key={`batch-${idx}`} tools={item.tools} />
      ) : item.kind === 'group' ? (
        <ToolGroup key={`group-${idx}`} tools={item.tools} toolName={item.toolName} />
      ) : (
        <ToolCard
          key={item.tool.id}
          tool={item.tool}
          isLast={isLast}
          onAnswerToolUse={onAnswerToolUse}
          onSubmitForm={onSubmitForm}
          allTools={message.tools ?? []}
        />
      ),
    )
  );

  // ── meta 行：模型 · token 进出 · 花费 · 耗时（辅助信息，用户点名的"模型/预估token/时间"） ──
  const hasUsage = !!message.usage;
  const metaLine = (
    <div
      className="work-block-meta"
      data-testid={hasUsage ? 'usage-footer' : undefined}
    >
      {message.model && <span className="work-block-meta-model">{message.model}</span>}
      {message.usage?.input != null && <span>{message.usage.input} in</span>}
      {message.usage?.output != null && <span>{message.usage.output} out</span>}
      {message.usage?.cost != null && <span>${message.usage.cost.toFixed(4)}</span>}
      {elapsed > 0 && <span>⏱ {elapsed}s</span>}
    </div>
  );

  // ── 运行中：当前动作 + 静态底条 + 思考 + 工具行 + meta ──
  if (isRunning) {
    // 新 run 首帧 steps 可能为空（尚无 thinking/tool/content）——回退到「生成回复」。
    const current = [...steps].reverse().find((s) => s.status === 'running') ?? steps[0];
    const label = current ? t(current.label) : t('workTimeline.generating');
    const detail = current?.detail;
    const count = current?.count;
    return (
      <div className="work-block running" data-testid="work-timeline">
        <div className="work-block-current" data-testid="work-timeline-current">
          <span className="work-block-spinner" aria-hidden>⟳</span>
          <span className="work-block-label">{label}</span>
          {detail && <span className="work-block-sub">· {detail}</span>}
          {count && count > 1 && <span className="work-block-count">×{count}</span>}
        </div>
        <div className="work-block-track" aria-hidden />
        {hasThinking && <ThinkingBlock content={message.thinking!} streaming={true} />}
        {renderTools()}
        {metaLine}
      </div>
    );
  }

  // ── 完成后：折叠摘要头 + meta，展开看思考与工具行 ──
  return (
    <div className="work-block" data-testid="work-timeline">
      <button
        type="button"
        className="work-block-summary"
        data-testid="work-timeline-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={`work-block-summary-icon${hasError ? ' error' : ''}`} aria-hidden>
          {hasError ? '✗' : '✓'}
        </span>
        <span className="work-block-summary-text">
          {hasError ? t('workTimeline.failed') : t('workTimeline.done')}
        </span>
        <span className="work-block-summary-chevron" aria-hidden>{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="work-block-detail">
          {hasThinking && <ThinkingBlock content={message.thinking!} streaming={false} />}
          {renderTools()}
        </div>
      )}
      {metaLine}
    </div>
  );
}
