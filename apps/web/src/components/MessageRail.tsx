// apps/web/src/components/MessageRail.tsx
// 消息导航 rail：消息区右缘一条竖排刻度，一刻度 = 一次提问（问答对）。
// 纯表现 + 自订阅几何：滚动/内容变更/尺寸变化都汇到 rAF 去抖的重测量，
// 状态留在本组件内——ChatSessionView 不因 rail 重渲整个消息列表。
// 几何口径与滚动记忆同源（复用 ChatSessionView 的 measureMessages，浮标剔除一致）。
// 交互：点击/拖动刷选（scrub）跳转 + hover/focus 预览（序号 + 提问文本）+ 键盘 ↑↓ 走格。
import {
  memo, useEffect, useRef, useState,
  type NamedExoticComponent, type RefObject,
} from 'react';
import { useI18n } from '../i18n';
import { measureMessages } from './ChatSessionView';
import { findActivePair, isRailVisible, railTickLayout, type RailPair } from '../utils/messageRail';

export interface MessageRailProps {
  /** 日志区（滚动容器）——ChatSessionView 的 logRef */
  logRef: RefObject<HTMLDivElement | null>;
  /** 问答对序列（ChatSessionView 的 useMemo 产物） */
  pairs: RailPair[];
  /** 跳转：父级负责写滚动位置并脱离贴底跟随；smooth=false 用于拖动刷选的即时跟手 */
  onJumpScroll: (targetScrollTop: number, smooth?: boolean) => void;
}

interface RailGeom {
  tops: number[];
  heights: number[];
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

const EMPTY_GEOM: RailGeom = { tops: [], heights: [], scrollTop: 0, clientHeight: 0, scrollHeight: 0 };
/** 容器在 wrapper 内 top/bottom 各让 8px */
const RAIL_INSET = 8;

function MessageRailImpl({ logRef, pairs, onJumpScroll }: MessageRailProps) {
  const { t } = useI18n();
  const [geom, setGeom] = useState<RailGeom>(EMPTY_GEOM);
  const [hover, setHover] = useState<number | null>(null);
  const rafRef = useRef(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef(false);
  const dragJumpRafRef = useRef(0);

  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const measure = () => {
      rafRef.current = 0;
      // display:none 的后台标签几何恒 0——不量不写（同 chatScrollMemory 的约束）。
      if (el.clientHeight === 0) return;
      const { tops, heights } = measureMessages(el);
      setGeom({
        tops, heights,
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      });
    };
    const scheduleMeasure = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(measure);
    };
    // 滚动路径也走全量重量（rAF 去抖后每帧一次 O(n) rect 读）而非「缓存几何做算术」：
    // ① 成本与既有 handleLogScroll 每 scroll 事件量一次同级（ChatSessionView 本就如此）；
    // ② 图片/字体加载完成引起的 reflow 不产生 DOM 变更（MO 不响）也不改 log 边框盒
    //    （RO 不响），全量重量能自愈这类几何漂移——纯算术路径会读到陈旧 tops。
    el.addEventListener('scroll', scheduleMeasure, { passive: true });
    // 内容长高（流式文本/工具卡/题卡）→ 几何失效，与 ChatSessionView 贴底那套同配置。
    const mo = new MutationObserver(scheduleMeasure);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    // 面板拖宽拖高 / 全屏 ⇄ 面板切换 → 视口尺寸变化。
    const ro = new ResizeObserver(scheduleMeasure);
    ro.observe(el);
    scheduleMeasure();
    return () => {
      el.removeEventListener('scroll', scheduleMeasure);
      mo.disconnect();
      ro.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      cancelAnimationFrame(dragJumpRafRef.current);
      dragJumpRafRef.current = 0;
    };
  }, [logRef]);

  // 双阈值不满足（<3 提问 / 无溢出 / 隐藏容器）不渲染。
  if (!isRailVisible(pairs.length, geom.scrollHeight, geom.clientHeight)) return null;

  const containerHeight = geom.clientHeight - RAIL_INSET * 2;
  const { tick, gap } = railTickLayout(pairs.length, containerHeight);
  const active = findActivePair(
    pairs, geom.tops, geom.heights,
    geom.scrollTop, geom.scrollTop + geom.clientHeight,
  );

  // 刻度块纵向居中（CSS safe center）——锚点数学必须同规则：装得下带居中偏移，溢出退回 0。
  const contentH = pairs.length * tick + Math.max(0, pairs.length - 1) * gap;
  const blockOffset = contentH < containerHeight ? (containerHeight - contentH) / 2 : 0;
  const tickCenter = (i: number) => blockOffset + i * (tick + gap) + tick / 2;

  // hover 预览的纵向落位：以刻度中心为锚、估高 64px（元信息行 + 两行正文封顶），
  // clamp 在容器内保证不出视口。
  const previewTop = hover !== null
    ? Math.min(Math.max(tickCenter(hover) - 32, 0), Math.max(containerHeight - 68, 0))
    : 0;

  // 点击时刻同步重量（而非读缓存几何）：刻度刚出现 / 流式长高中，缓存可能落后
  // 一帧（E2E 实测：追加一轮后秒点新刻度，tops 尚无该消息 → 跳转失效）。
  // 跳转精度是点击语义本身，值得这一次 O(n) 量测。
  const jumpToIndex = (i: number, smooth: boolean) => {
    const el = logRef.current;
    const pair = pairs[i];
    if (!el || !pair || el.clientHeight === 0) return;
    const { tops } = measureMessages(el);
    const top = tops[pair.userMsgIndex];
    if (top === undefined) return;
    onJumpScroll(Math.max(0, top - RAIL_INSET), smooth);
  };

  // 拖动刷选：Y → 最近刻度下标。
  const pairIndexAtY = (clientY: number) => {
    const track = trackRef.current;
    if (!track) return -1;
    const r = track.getBoundingClientRect();
    const step = tick + gap;
    const idx = Math.round((clientY - r.top - blockOffset - tick / 2) / step);
    return Math.min(pairs.length - 1, Math.max(0, idx));
  };

  // 拖动中的跳转按帧合并（pointermove 频率高于帧率，O(n) 量测不必每次都做）。
  const scheduleDragJump = (i: number) => {
    if (dragJumpRafRef.current) return;
    dragJumpRafRef.current = requestAnimationFrame(() => {
      dragJumpRafRef.current = 0;
      jumpToIndex(i, false);
    });
  };

  return (
    <div
      className="chat-message-rail"
      data-testid="chat-message-rail"
      role="navigation"
      aria-label={t('chat.messageRailNav')}
      onKeyDown={(e) => {
        // 键盘走格：↑/↓ 在刻度间移动焦点（onFocus 已联动预览），Enter 原生点击跳转。
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        const buttons = Array.from(
          trackRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [],
        );
        if (!buttons.length) return;
        const cur = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = buttons[
          Math.min(buttons.length - 1, Math.max(0, cur + (e.key === 'ArrowDown' ? 1 : -1)))
        ];
        if (next) {
          e.preventDefault();
          next.focus();
        }
      }}
    >
      {/* 轨道：极端刻度数的裁剪在 CSS 的 track 上；预览气泡必须是它的兄弟，
          否则容器级 overflow 会把外侧定位的气泡整个裁掉（验收实测踩中）。 */}
      <div
        className="chat-message-rail-track"
        ref={trackRef}
        onPointerDown={(e) => {
          // 拖动刷选：按下即跳，移动实时刷（预览跟手、视口即时跟随），松手收尾。
          // 指针捕获到轨道 → 拖动后的 click 重定目标，刻度 onClick 不会重复触发。
          e.currentTarget.setPointerCapture(e.pointerId);
          dragRef.current = true;
          const i = pairIndexAtY(e.clientY);
          setHover(i);
          jumpToIndex(i, false);
        }}
        onPointerMove={(e) => {
          if (!dragRef.current) return;
          const i = pairIndexAtY(e.clientY);
          setHover(i);
          scheduleDragJump(i);
        }}
        onPointerUp={() => { dragRef.current = false; }}
        onPointerCancel={() => { dragRef.current = false; }}
      >
        {pairs.map((pair, i) => (
          <button
            key={pair.userMsgIndex}
            type="button"
            data-testid="chat-message-rail-tick"
            className={i === active ? 'is-active' : undefined}
            style={{ height: tick, marginBottom: i < pairs.length - 1 ? gap : undefined }}
            aria-label={t('chat.messageRailJump')}
            onClick={() => jumpToIndex(i, true)}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover((h) => (h === i ? null : h))}
            onFocus={() => setHover(i)}
            onBlur={() => setHover((h) => (h === i ? null : h))}
          />
        ))}
      </div>
      {hover !== null && pairs[hover] && (
        <div
          className="chat-message-rail-preview"
          data-testid="chat-message-rail-preview"
          style={{ top: previewTop }}
        >
          {/* 元信息行只放通用事实（序号）。题卡数/对错等会话状态是后续增量层：
              等解答题交互改版后经可选 meta 字段接入，不在导航基座里耦合。 */}
          <div className="chat-message-rail-preview-meta">
            {t('chat.messageRailRound', { n: hover + 1 })}
          </div>
          <div className="chat-message-rail-preview-text">
            {pairs[hover].preview || t('chat.messageRailImageOnly')}
          </div>
        </div>
      )}
    </div>
  );
}

function pairsEqual(a: RailPair[], b: RailPair[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.userMsgIndex !== y.userMsgIndex
      || x.lastMsgIndex !== y.lastMsgIndex
      || x.preview !== y.preview
    ) {
      return false;
    }
  }
  return true;
}

/** memo：assistant 流式输出只改 pairs 外的消息内容——逐元素比较拦掉无谓重渲。 */
export const MessageRail: NamedExoticComponent<MessageRailProps> = memo(
  MessageRailImpl,
  (prev, next) =>
    prev.logRef === next.logRef
    && prev.onJumpScroll === next.onJumpScroll
    && pairsEqual(prev.pairs, next.pairs),
);
