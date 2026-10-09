// apps/web/src/components/kb/FloatingChatButton.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { useKbChatPanelOpen, kbChatSessionsStore } from '../../stores/kbChatSessionsStore';
import { withSurfaceTransitionSync } from '../../stores/surfaceTransition';
import { useI18n } from '../../i18n';

/** 全局悬浮对话按钮：面板收起时显示，点击展开多会话面板。
 *
 *  图标 = Molio 品牌标（main.png 圆形裁切，见 CSS __logo）。
 *
 *  位置可拖拽（2026-10-10 定稿）：默认右下角（CSS right/bottom 24px）。
 *  拖近**任意一边**（上下左右，中心距缘 <48px）→ 实时磁吸贴缘 + 朝缘压扁
 *  （「正在被吸进去」的预告）；**吸附状态下松手 → 吸进缘里隐藏**（只露 12px
 *  小签）。不在吸附区松手 = 自由位。位置持久化（molio.kb.chatBtnPos），
 *  重载原样恢复（含隐藏态——用户显式选择被尊重），恢复按当前视口 clamp。
 *
 *  拖拽与点击的判据沿用面板头部模式：位移 >6px 才算拖，纯点击永远开面板；
 *  隐藏态点小签 = 唤回贴缘可见位（不开面板）——唤回与打开各管各的事。 */

const BTN_SIZE = 52;
const TAB_VISIBLE = 12;   // 隐藏态露出的签宽
const EDGE_MARGIN = 8;    // 自由态/恢复时的最小可见边距
const SNAP_ZONE = 48;     // 拖拽中中心距缘 < 48px → 磁吸（松手即隐藏）
const DRAG_THRESHOLD = 6; // 位移超过才算拖（否则是点击）
const LOGO_URL = `${import.meta.env.BASE_URL}images/main.png`;
const STORAGE_KEY = 'molio.kb.chatBtnPos';

type BtnEdge = 'left' | 'right' | 'top' | 'bottom' | null;
type BtnPos = { edge: BtnEdge; x: number | null; y: number | null; hidden: boolean };

function clampY(y: number): number {
  return Math.min(
    Math.max(Math.round(y), EDGE_MARGIN),
    Math.max(EDGE_MARGIN, window.innerHeight - BTN_SIZE - EDGE_MARGIN),
  );
}
function clampFreeX(x: number): number {
  return Math.min(
    Math.max(Math.round(x), EDGE_MARGIN),
    Math.max(EDGE_MARGIN, window.innerWidth - BTN_SIZE - EDGE_MARGIN),
  );
}
/** 拖拽中允许压出视口（磁吸/藏边手势需要），但永远留 8px 可抓。 */
function clampDragX(x: number): number {
  return Math.min(
    Math.max(Math.round(x), -(BTN_SIZE - EDGE_MARGIN)),
    window.innerWidth - EDGE_MARGIN,
  );
}
function clampDragY(y: number): number {
  return Math.min(
    Math.max(Math.round(y), -(BTN_SIZE - EDGE_MARGIN)),
    window.innerHeight - EDGE_MARGIN,
  );
}

function readBtnPos(): BtnPos | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<BtnPos>;
    if (p.edge !== 'left' && p.edge !== 'right' && p.edge !== 'top' && p.edge !== 'bottom' && p.edge !== null) return null;
    if ((p.x !== null && typeof p.x !== 'number') || (p.y !== null && typeof p.y !== 'number')) return null;
    // 恢复 clamp：持久化值可能出自更大的窗口（同一课见 KbChatSessionsPanel.clampFloatPos）。
    // 只 clamp 存的那根平行轴；垂直轴由 edge 推导，天然随窗口尺寸走。
    const cx = p.x === null ? null : clampFreeX(p.x);
    const cy = p.y === null ? null : clampY(p.y);
    return {
      edge: p.edge,
      x: p.edge === 'left' || p.edge === 'right' ? null : cx,
      y: p.edge === 'top' || p.edge === 'bottom' ? null : cy,
      hidden: p.hidden === true,
    };
  } catch { /* storage unavailable */ }
  return null;
}
function persistBtnPos(pos: BtnPos): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pos)); } catch { /* storage unavailable */ }
}

/** 各状态的 left/top。edge 的垂直轴由视口推导——resize 天然安全；
 *  平行轴用存的坐标（clamp 过）。 */
function derivedLeft(pos: BtnPos): number {
  const vw = window.innerWidth;
  if (pos.edge === 'left') return pos.hidden ? -(BTN_SIZE - TAB_VISIBLE) : 0;
  if (pos.edge === 'right') return pos.hidden ? vw - TAB_VISIBLE : vw - BTN_SIZE;
  return clampFreeX(pos.x ?? 0);
}
function derivedTop(pos: BtnPos): number {
  const vh = window.innerHeight;
  if (pos.edge === 'top') return pos.hidden ? -(BTN_SIZE - TAB_VISIBLE) : 0;
  if (pos.edge === 'bottom') return pos.hidden ? vh - TAB_VISIBLE : vh - BTN_SIZE;
  return clampY(pos.y ?? 0);
}

export function FloatingChatButton() {
  const panelOpen = useKbChatPanelOpen();
  const { t } = useI18n();
  const [pos, setPos] = useState<BtnPos | null>(readBtnPos);
  const posRef = useRef(pos);
  useEffect(() => { posRef.current = pos; }, [pos]);
  const btnRef = useRef<HTMLButtonElement>(null);
  // 拖拽真值源：拖动中直接写 DOM（不逐帧 setState），松手一次性提交。
  // edge 非空 = 正被某条缘磁吸（垂直轴已钉在缘上）。
  const dragRef = useRef<{
    px: number; py: number; grabX: number; grabY: number;
    x: number; y: number; edge: BtnEdge; moved: boolean;
  } | null>(null);
  // 拖完松手浏览器仍会派发 click——用这个标记吞掉，避免「拖完误开面板」
  const swallowClickRef = useRef(false);
  const glideTimerRef = useRef<number | null>(null);
  useEffect(() => () => { if (glideTimerRef.current) window.clearTimeout(glideTimerRef.current); }, []);

  const style: React.CSSProperties | undefined = pos
    ? { left: derivedLeft(pos), top: derivedTop(pos) }
    : undefined;

  /** 释放后的一次性滑动动画：加类启用 transition，超时统一摘掉。
   *  时机与时长成对写在 settle() 里；reduced-motion 下 CSS 直接置 none。 */
  const finishGlide = useCallback((classes: string[], removeAfterMs: number) => {
    const el = btnRef.current;
    if (!el) return;
    for (const c of classes) el.classList.add(c);
    if (glideTimerRef.current) window.clearTimeout(glideTimerRef.current);
    glideTimerRef.current = window.setTimeout(() => {
      glideTimerRef.current = null;
      el.classList.remove(
        'floating-chat-btn--snap', 'floating-chat-btn--impact',
        'floating-chat-btn--hide', 'floating-chat-btn--restore',
      );
    }, removeAfterMs);
  }, []);

  const settle = useCallback(() => {
    const d = dragRef.current;
    const el = btnRef.current;
    dragRef.current = null;
    if (!d) return;
    if (!d.moved) return; // 纯点击：交给 onClick
    el?.classList.remove('is-dragging');
    el?.classList.remove(
      'floating-chat-btn--swallow-left', 'floating-chat-btn--swallow-right',
      'floating-chat-btn--swallow-top', 'floating-chat-btn--swallow-bottom',
    );
    swallowClickRef.current = true;
    let next: BtnPos;
    if (d.edge) {
      // 吸附状态下松手 → **吸进缘里隐藏**（用户定义的交互：磁吸即藏边意图）
      next = {
        edge: d.edge,
        x: d.edge === 'top' || d.edge === 'bottom' ? Math.round(d.x) : null,
        y: d.edge === 'left' || d.edge === 'right' ? Math.round(d.y) : null,
        hidden: true,
      };
      finishGlide(['floating-chat-btn--hide'], 300);
    } else {
      // 自由位：原地落定，无滑动
      next = { edge: null, x: clampFreeX(d.x), y: clampY(d.y), hidden: false };
    }
    setPos(next);
    persistBtnPos(next);
  }, [finishGlide]);
  const settleRef = useRef(settle);
  useEffect(() => { settleRef.current = settle; }, [settle]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    const el = btnRef.current;
    if (!el) return;
    e.preventDefault(); // 防图片原生拖拽/文本选择；click 仍会派发
    const rect = el.getBoundingClientRect();
    dragRef.current = {
      px: e.clientX, py: e.clientY,
      grabX: e.clientX - rect.left, grabY: e.clientY - rect.top,
      x: rect.left, y: rect.top, edge: null, moved: false,
    };
    el.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    const el = btnRef.current;
    if (!d || !el) return;
    if (!d.moved && Math.hypot(e.clientX - d.px, e.clientY - d.py) <= DRAG_THRESHOLD) return;
    if (!d.moved) {
      d.moved = true;
      el.classList.add('is-dragging');
      // 从隐藏态直接拖 = 先当自由拖处理（--hidden 的视觉随 inline 几何一并离开）
      el.classList.remove('floating-chat-btn--hidden');
    }
    const rawX = clampDragX(e.clientX - d.grabX);
    const rawY = clampDragY(e.clientY - d.grabY);
    // 磁吸判定：中心距**任意一边** < SNAP_ZONE → 贴到该缘 + 朝缘压扁（吸附预告）
    const cx = rawX + BTN_SIZE / 2;
    const cy = rawY + BTN_SIZE / 2;
    const dl = cx, dr = window.innerWidth - cx, dt = cy, db = window.innerHeight - cy;
    const min = Math.min(dl, dr, dt, db);
    const edge: BtnEdge = min < SNAP_ZONE
      ? (min === dl ? 'left' : min === dr ? 'right' : min === dt ? 'top' : 'bottom')
      : null;
    el.classList.toggle('floating-chat-btn--swallow-left', edge === 'left');
    el.classList.toggle('floating-chat-btn--swallow-right', edge === 'right');
    el.classList.toggle('floating-chat-btn--swallow-top', edge === 'top');
    el.classList.toggle('floating-chat-btn--swallow-bottom', edge === 'bottom');
    d.edge = edge;
    // 磁吸：垂直轴钉死在缘上（flush），平行轴继续跟手
    d.x = edge === 'left' ? 0 : edge === 'right' ? window.innerWidth - BTN_SIZE : rawX;
    d.y = edge === 'top' ? 0 : edge === 'bottom' ? window.innerHeight - BTN_SIZE : rawY;
    el.style.left = `${d.x}px`;
    el.style.top = `${d.y}px`;
  }, []);

  const onPointerUp = useCallback(() => { settleRef.current(); }, []);

  const onPointerCancel = useCallback(() => {
    const d = dragRef.current;
    const el = btnRef.current;
    dragRef.current = null;
    if (!d?.moved) return;
    el?.classList.remove('is-dragging');
    el?.classList.remove(
      'floating-chat-btn--swallow-left', 'floating-chat-btn--swallow-right',
      'floating-chat-btn--swallow-top', 'floating-chat-btn--swallow-bottom',
    );
    // 受控几何写回（setPos 同值会被 React bail，必须手动重写 inline）
    const p = posRef.current;
    if (el && p) {
      el.style.left = `${derivedLeft(p)}px`;
      el.style.top = `${derivedTop(p)}px`;
    }
  }, []);

  const onClick = useCallback(() => {
    if (swallowClickRef.current) { swallowClickRef.current = false; return; }
    const p = posRef.current;
    if (p?.hidden) {
      // 隐藏态小签点击 = 唤回贴缘可见位（不开面板），用「面板展开」同族曲线弹回
      const next: BtnPos = { ...p, hidden: false };
      setPos(next);
      persistBtnPos(next);
      finishGlide(['floating-chat-btn--restore'], 280);
      return;
    }
    withSurfaceTransitionSync(() => kbChatSessionsStore.setPanelOpen(true));
  }, [finishGlide]);

  if (panelOpen) return null; // 面板展开时不显示按钮
  const cls =
    'floating-chat-btn' +
    (pos?.hidden ? ' floating-chat-btn--hidden' : '') +
    (pos?.edge ? ` floating-chat-btn--edge-${pos.edge}` : '');
  return (
    <button
      ref={btnRef}
      type="button"
      data-testid="floating-chat-btn"
      className={cls}
      style={style}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      title={t('kb.floatingChat')}
      aria-label={t('kb.floatingChat')}
    >
      {/* 白色描边聊天气泡已换为品牌标：圆形裁切后波浪圆环居中留呼吸边（CSS __logo） */}
      <img className="floating-chat-btn__logo" src={LOGO_URL} alt="" draggable={false} />
    </button>
  );
}
