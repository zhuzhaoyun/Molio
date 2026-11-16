// apps/web/src/components/MessageRail.tsx
// 消息导航 rail（豆包式）：消息区右缘一条竖排刻度，一刻度 = 一次提问（问答对）。
// 纯表现 + 自订阅几何：滚动/内容变更/尺寸变化都汇到 rAF 去抖的重测量，
// 状态留在本组件内——ChatSessionView 不因 rail 重渲整个消息列表。
// 几何口径与滚动记忆同源（复用 ChatSessionView 的 measureMessages，浮标剔除一致）。
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
  /** 点击刻度跳转：父级负责写 scrollTop 并脱离贴底跟随 */
  onJumpScroll: (targetScrollTop: number) => void;
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

  // hover 预览的纵向落位：以刻度中心为锚、估高 48px（CSS 两行截断封顶），
  // clamp 在容器内保证不出视口。
  const tickCenter = (i: number) => i * (tick + gap) + tick / 2;
  const previewTop = hover !== null
    ? Math.min(Math.max(tickCenter(hover) - 24, 0), Math.max(containerHeight - 52, 0))
    : 0;

  return (
    <div
      className="chat-message-rail"
      data-testid="chat-message-rail"
      role="navigation"
      aria-label={t('chat.messageRailNav')}
    >
      {pairs.map((pair, i) => (
        <button
          key={pair.userMsgIndex}
          type="button"
          data-testid="chat-message-rail-tick"
          className={i === active ? 'is-active' : undefined}
          style={{ height: tick, marginBottom: i < pairs.length - 1 ? gap : undefined }}
          aria-label={t('chat.messageRailJump')}
          title={t('chat.messageRailJump')}
          onClick={() => {
            const el = logRef.current;
            if (!el || el.clientHeight === 0) return;
            // 点击时刻同步重量：刻度刚出现 / 流式长高中，缓存几何可能落后一帧
            // （E2E 实测：追加一轮后秒点新刻度，tops 尚无该消息 → 跳转失效）。
            // 跳转精度是点击语义本身，值得这一次 O(n) 量测。
            const { tops } = measureMessages(el);
            const top = tops[pair.userMsgIndex];
            if (top === undefined) return;
            onJumpScroll(Math.max(0, top - RAIL_INSET));
          }}
          onMouseEnter={() => setHover(i)}
          onMouseLeave={() => setHover((h) => (h === i ? null : h))}
        />
      ))}
      {hover !== null && pairs[hover] && (
        <div
          className="chat-message-rail-preview"
          data-testid="chat-message-rail-preview"
          style={{ top: previewTop }}
        >
          {pairs[hover].preview}
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
