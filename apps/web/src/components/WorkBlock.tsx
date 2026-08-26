// apps/web/src/components/WorkBlock.tsx
// 统一「工作块」：把 工作时间线 + 思考过程 + 工具卡 收进最后一条回复的一张可折叠卡片。
// 运行中 = 当前动作 + 静态底条 + 思考 + 工具行 + meta（模型·时间）；完成后 = 折叠成摘要头 + meta，
// 展开可看思考与工具行。旧的步骤列表（work-timeline-step）已删除 —— 工具行本身就地渲染，杜绝与时间线容余。
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { ChatMessage } from '../hooks/useChat';
import { deriveStepsForMessage } from '../utils/workSteps';
import { bucketSegmentsByDone, type MessageSegment } from '../utils/messageText';
import { UNGROUPABLE, type ToolItem } from '../utils/toolGroups';
import { useI18n } from '../i18n';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCard } from './ToolCard';
import { ToolGroup, BatchGroup } from './ToolGroup';
import { TypingText } from './TypingText';

interface Props {
  message: ChatMessage;
  /** 非交互工具项（AskUserQuestion 已被 AssistantMessage 拆分到卡片外常显） */
  toolItems: ToolItem[];
  /** 过程叙事文本：运行中 = 全部实时文本流；完成后 = 拆出的叙事（finalTools 前）。
   *  无分段（segments 缺失/AskUserQuestion 抑制）时整块落在工具行之后。 */
  processText?: string;
  /** 叙事分段（含 done 锚点）：存在时按锚点穿插进工具行之间（Codex 式交错） */
  processSegments?: MessageSegment[];
  /** True only for the most recent assistant message — locks AskUserQuestion cards. */
  isLast?: boolean;
  onAnswerToolUse?: (toolUseId: string, content: string) => Promise<boolean | void> | boolean | void;
  onSubmitForm?: (text: string) => void;
}

export function WorkBlock({ message, toolItems, processText, processSegments, isLast, onAnswerToolUse, onSubmitForm }: Props) {
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
  const hasOps = hasTools || !!processText;

  // 流式操作日志：运行中逐个展示工具（不分组，Codex 进行时模型），过滤交互工具
  const liveTools = useMemo(
    () => (message.tools ?? []).filter((t) => !UNGROUPABLE.has(t.name)),
    [message.tools],
  );

  // ── 叙事交错（Codex 式）：seg.done = 到达时已完成的工具数（message.tools 全序，
  //    含被过滤/分组的工具）→ 插在 fullIdx >= done 的第一个渲染条目之前。 ──
  const fullIndexById = useMemo(() => {
    const m = new Map<string, number>();
    (message.tools ?? []).forEach((t, i) => m.set(t.id, i));
    return m;
  }, [message.tools]);

  const liveNarrative = useMemo(() => {
    if (!processSegments || processSegments.length === 0) return null;
    const anchors = liveTools.map((t) => fullIndexById.get(t.id) ?? 0);
    return bucketSegmentsByDone(processSegments, anchors);
  }, [processSegments, liveTools, fullIndexById]);

  // 完成态条目：组/批内若落了叙事锚点（startFullIdx < done <= endFullIdx），拆成单行 ——
  // 时间线保真优先于事后归纳（组内无处安放叙述，会把多段挤成组前的一坨）；
  // 无叙事锚点的连发仍保持分组。无叙事时不拆（纯工具连发维持归纳视图）。
  const doneItems = useMemo(() => {
    if (!processSegments || processSegments.length === 0) return toolItems;
    const out: ToolItem[] = [];
    for (const item of toolItems) {
      if (item.kind === 'single') {
        out.push(item);
        continue;
      }
      const s = fullIndexById.get(item.tools[0]!.id) ?? 0;
      const e = fullIndexById.get(item.tools[item.tools.length - 1]!.id) ?? s;
      const hasInnerAnchor = processSegments.some((seg) => seg.done > s && seg.done <= e);
      if (hasInnerAnchor) {
        for (const tl of item.tools) out.push({ kind: 'single', tool: tl });
      } else {
        out.push(item);
      }
    }
    return out;
  }, [toolItems, processSegments, fullIndexById]);

  const itemNarrative = useMemo(() => {
    if (!processSegments || processSegments.length === 0) return null;
    const anchors = doneItems.map((item) => {
      const first = item.kind === 'single' ? item.tool : item.tools[0];
      return (first && fullIndexById.get(first.id)) ?? 0;
    });
    return bucketSegmentsByDone(processSegments, anchors);
  }, [processSegments, doneItems, fullIndexById]);

  // 过程叙事块：live = 正在打字（仅流式视图最后一块；其余静态，避免多光标闪烁）
  const renderProcessBlock = (text: string, live: boolean, key: string) => (
    <div className="work-block-process" data-testid="work-block-process" data-typing={live} key={key}>
      <TypingText text={text} active={live} />
    </div>
  );

  // 没有任何工作痕迹时整块不渲染（纯问答、无工具无思考）。
  if (!isRunning && !hasThinking && !hasTools) return null;

  const hasError = !!message.error || (message.tools ?? []).some((tl) => tl.isError);

  // ── 耗时：运行中实时算，完成后用 finishedAt（消息创建时刻为起点） ──
  const elapsedMs = isRunning
    ? now - message.timestamp
    : (message.finishedAt ?? now) - message.timestamp;
  const elapsed = elapsedMs > 0 ? Math.round(elapsedMs / 1000) : 0;

  const renderItem = (item: ToolItem, idx: number) =>
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
    );

  const renderTools = () => doneItems.map((item, idx) => renderItem(item, idx));

  // ── 执行区（操作 eyebrow + 工具行 + 过程叙事）：完成态展开详情 ──
  const renderOps = () => {
    const nar = itemNarrative;
    return (
      <div className="work-block-zone zone-ops">
        <div className="work-block-zone-label" data-testid="work-block-zone-ops-label">
          <span>{t('workBlock.opsLabel')}</span>
        </div>
        {nar
          ? doneItems.map((item, idx) => (
              <Fragment key={`item-${idx}`}>
                {nar.buckets[idx].trim() && renderProcessBlock(nar.buckets[idx], false, `nb-${idx}`)}
                {renderItem(item, idx)}
              </Fragment>
            ))
          : renderTools()}
        {nar
          ? nar.trailing.trim() && renderProcessBlock(nar.trailing, false, 'nb-trailing')
          : processText && renderProcessBlock(processText, false, 'nb-trailing')}
      </div>
    );
  };

  // ── 流式操作日志：逐个工具（不分组，Codex 进行时模型）+ 累计读数 + 叙事穿插 ──
  const renderLiveOps = () => {
    const nar = liveNarrative;
    // 最后一块叙事 = 正在打字的那块（增量只落在最高 done 桶 / 末尾，前面的桶已完成）
    const lastKey = !nar
      ? 'nb-trailing'
      : nar.trailing.trim() ? 'nb-trailing' : `nb-${nar.buckets.map((b) => b.trim() !== '').lastIndexOf(true)}`;
    const renderTool = (tool: (typeof liveTools)[number], idx: number) => (
      <ToolCard
        key={tool.id}
        tool={tool}
        isLast={isLast}
        open={idx === liveTools.length - 1}
        step={idx + 1}
        totalSteps={liveTools.length}
        onAnswerToolUse={onAnswerToolUse}
        onSubmitForm={onSubmitForm}
        allTools={message.tools ?? []}
      />
    );
    return (
      <div className="work-block-zone zone-ops">
        <div className="work-block-zone-label" data-testid="work-block-zone-ops-label">
          <span>{t('workBlock.opsLabel')}</span>
          {liveTools.length > 0 && (
            <span className="work-block-zone-meta">⏱ {elapsed}s · {liveTools.length} {t('workBlock.steps')}</span>
          )}
        </div>
        {nar
          ? liveTools.map((tool, idx) => (
              <Fragment key={tool.id}>
                {nar.buckets[idx].trim()
                  && renderProcessBlock(nar.buckets[idx], isRunning && lastKey === `nb-${idx}`, `nb-${idx}`)}
                {renderTool(tool, idx)}
              </Fragment>
            ))
          : liveTools.map(renderTool)}
        {nar
          ? nar.trailing.trim()
            && renderProcessBlock(nar.trailing, isRunning && lastKey === 'nb-trailing', 'nb-trailing')
          : processText && renderProcessBlock(processText, isRunning, 'nb-trailing')}
      </div>
    );
  };

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
        {hasThinking && (
          <div className="work-block-zone zone-thinking">
            <ThinkingBlock
              content={message.thinking!}
              streaming={true}
              autoExpand={liveTools.length === 0}
            />
          </div>
        )}
        {hasOps && renderLiveOps()}
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
          {hasThinking && (
            <div className="work-block-zone zone-thinking">
              <ThinkingBlock content={message.thinking!} streaming={false} />
            </div>
          )}
          {hasOps && renderOps()}
        </div>
      )}
      {metaLine}
    </div>
  );
}
