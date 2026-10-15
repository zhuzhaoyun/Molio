// apps/web/src/components/kb/FloatingChatButton.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { kbChatSessionsStore, useKbChatPanelOpen } from '../../stores/kbChatSessionsStore';
import { useCurrentContext } from '../../stores/currentContextStore';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { useI18n } from '../../i18n';

/** 全局悬浮对话按钮：面板收起时显示，点击展开多会话面板。
 *
 *  图标 = Molio 品牌标（main.png 圆形裁切，见 CSS __logo）。
 *
 *  位置可拖拽（2026-10-10 定稿）：默认右下角（CSS right/bottom 24px）。
 *  拖近**任意一边**（上下左右，中心距缘 <48px）→ 实时磁吸贴缘 + 朝缘压扁
 *  （「正在被吸进去」的预告）；**吸附状态下松手 → 吸进缘里隐藏**（只露 12px
 *  小签）。不在吸附区松手 = 自由位。位置持久化（molio.kb.chatBtnPos），
 *  重载原样恢复（含隐藏态——用户显式选择被尊重），恢复按当前视口 clamp；
 *  窗口 resize 时跟随收进新视口（藏边小签贴住新缘），不回写持久化——
 *  还原窗口后原位恢复。
 *
 *  右键菜单（2026-10-13 二轮定稿）：**固定动作**，与 KB 页固定按钮同源——
 *  「构建Wiki」走面板 runWikiOp（App 下发，与 KB 页「构建Wiki」按钮同一条
 *  代码路径，复用/三选一互斥全部一致）；「打开会话」只展开面板不创建。
 *  不做动态会话列表（会话标题/内容态是异步易变的，静态动作永不「消失」）。 */

const BTN_SIZE = 52;
const TAB_VISIBLE = 12;   // 隐藏态露出的签宽
const TUCK = 20;          // 吸附预告时嵌入缘里的深度（正圆不变形，滑进口缘）
const EDGE_MARGIN = 8;    // 自由态/恢复时的最小可见边距
const SNAP_GAP = 10;      // 吸附预告时按钮与缘的间隙（辉光填充这里）
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

interface Props {
  /** KB 页构建按钮同一守卫：无可用运行时 → 菜单「构建Wiki」置灰（tooltip 说明）。 */
  agentId: string | null;
  /** 与 KB 页「构建Wiki」按钮同源：App 下发（同一 kbChatPanelRef.runWikiOp）。 */
  onBuildWiki: () => void;
  /** 只展开面板（当前活跃会话），不创建任何东西。 */
  onOpenSession: () => void;
}

export function FloatingChatButton({ agentId, onBuildWiki, onOpenSession }: Props) {
  const panelOpen = useKbChatPanelOpen();
  const { t } = useI18n();
  const { vault } = useCurrentContext();
  const [pos, setPos] = useState<BtnPos | null>(readBtnPos);
  // 右键菜单的锚点（光标处）；null = 菜单关着。菜单纯前端，状态随按钮组件走。
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const posRef = useRef(pos);
  useEffect(() => { posRef.current = pos; }, [pos]);
  // 视口缩放跟随：left/top 都是**渲染期**从 window 尺寸推导的（自由位 clamp、
  // 藏边小签贴缘），但没有重渲染就不会重算——缩窗后按钮/小签悬在旧坐标，
  // 藏边签甚至整个消失在视口外点不回（2026-10-11 用户实测）。这里监听 resize
  // 触发一帧重渲染即可：几何自然落到新视口。持久化**不回写**——存的坐标是
  // 用户的所选位置，还原窗口后原位恢复；恢复路径本来就会按当时视口 clamp。
  const dragActiveRef = useRef(false);
  useEffect(() => {
    const onResize = () => {
      if (dragActiveRef.current) return; // 拖拽中几何由手势直写 DOM，别插手
      setPos((prev) => (prev ? { ...prev } : prev)); // 新对象强制重渲染；clamp 由渲染期推导完成
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const btnRef = useRef<HTMLButtonElement>(null);
  // 拖拽真值源：拖动中直接写 DOM（不逐帧 setState），松手一次性提交。
  // edge 非空 = 正被某条缘磁吸（垂直轴已钉在缘上）。
  const dragRef = useRef<{
    px: number; py: number; grabX: number; grabY: number;
    x: number; y: number; edge: BtnEdge; moved: boolean;
  } | null>(null);
  // 拖完松手浏览器仍会派发 click——用这个标记吞掉，避免「拖完误开面板」
  const swallowClickRef = useRef(false);
  const style: React.CSSProperties | undefined = pos
    ? { left: derivedLeft(pos), top: derivedTop(pos) }
    : undefined;
  /** 唤回的一次性滑动：加类启用 transition，超时摘掉；reduced-motion 由 CSS 置 none。 */
  const glide = useCallback((cls: string, ms: number) => {
    const el = btnRef.current;
    if (!el) return;
    el.classList.add(cls);
    window.setTimeout(() => el.classList.remove(cls), ms);
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
      glide('floating-chat-btn--hide', 400);
    } else {
      // 自由位：原地落定，无滑动
      next = { edge: null, x: clampFreeX(d.x), y: clampY(d.y), hidden: false };
    }
    setPos(next);
    persistBtnPos(next);
  }, []);
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
    dragActiveRef.current = true;
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
    // 磁吸：垂直轴钉在「嵌入 TUCK」处（正圆滑进缘口，不变形——压扁方案被否），平行轴继续跟手
    d.x = edge === 'left' ? -TUCK : edge === 'right' ? window.innerWidth - BTN_SIZE + TUCK : rawX;
    d.y = edge === 'top' ? -TUCK : edge === 'bottom' ? window.innerHeight - BTN_SIZE + TUCK : rawY;
    el.style.left = `${d.x}px`;
    el.style.top = `${d.y}px`;
  }, []);

  const onPointerUp = useCallback(() => {
    dragActiveRef.current = false;
    settleRef.current();
  }, []);

  const onPointerCancel = useCallback(() => {
    const d = dragRef.current;
    const el = btnRef.current;
    dragRef.current = null;
    dragActiveRef.current = false;
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
      glide('floating-chat-btn--restore', 320);
      return;
    }
    kbChatSessionsStore.setPanelOpen(true);
  }, []);

  // ── 右键菜单（2026-10-13 二轮定稿）：固定动作，与 KB 页固定按钮同源 ──
  const showButton = useCallback(() => {
    const p = posRef.current;
    if (!p?.hidden) return;
    const next: BtnPos = { ...p, hidden: false };
    setPos(next);
    persistBtnPos(next);
    glide('floating-chat-btn--restore', 320);
  }, [glide]);

  const hideToNearestEdge = useCallback(() => {
    // 与拖拽松手同一落点语义：吸进**当前位最近**的缘（隐藏），平行轴留在当前位置。
    // pos 为 null（CSS 默认右下角）时读真实矩形（hover 缩放的 ~2px 误差只影响平局判定，可忽略）。
    const el = btnRef.current;
    const left = posRef.current ? derivedLeft(posRef.current) : (el?.getBoundingClientRect().left ?? window.innerWidth - BTN_SIZE - 24);
    const top = posRef.current ? derivedTop(posRef.current) : (el?.getBoundingClientRect().top ?? window.innerHeight - BTN_SIZE - 24);
    const cx = left + BTN_SIZE / 2;
    const cy = top + BTN_SIZE / 2;
    const dl = cx, dr = window.innerWidth - cx, dt = cy, db = window.innerHeight - cy;
    const min = Math.min(dl, dr, dt, db);
    const edge: BtnEdge = min === dl ? 'left' : min === dr ? 'right' : min === dt ? 'top' : 'bottom';
    const next: BtnPos = {
      edge,
      x: edge === 'top' || edge === 'bottom' ? Math.round(clampFreeX(left)) : null,
      y: edge === 'left' || edge === 'right' ? Math.round(clampY(top)) : null,
      hidden: true,
    };
    setPos(next);
    persistBtnPos(next);
    glide('floating-chat-btn--hide', 400);
  }, [glide]);

  const resetPosition = useCallback(() => {
    // 逃生门：清持久化 + 回 CSS 默认右下角（可见）。pos=null 本来就是受支持的形态。
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
    setPos(null);
  }, []);

  const onContextMenu = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault(); // 别弹浏览器原生菜单：这是自定义交互控件
    setMenuPos({ x: e.clientX, y: e.clientY });
  }, []);

  const buildDisabledReason = !vault
    ? t('kb.cmdNeedsVault')
    : !agentId ? t('home.noAgent') : undefined;
  const menuItems: MenuItem[] = [
    {
      label: t('kb.chatMenu.build'),
      disabled: Boolean(buildDisabledReason),
      title: buildDisabledReason,
      testid: 'kb-chat-menu-build',
      onClick: onBuildWiki,
    },
    {
      label: t('kb.chatMenu.openSession'),
      testid: 'kb-chat-menu-open',
      onClick: onOpenSession,
    },
    { divider: true },
    pos?.hidden
      ? { label: t('kb.chatMenu.show'), testid: 'kb-chat-menu-hide-toggle', onClick: showButton }
      : { label: t('kb.chatMenu.hide'), testid: 'kb-chat-menu-hide-toggle', onClick: hideToNearestEdge },
  ];
  if (pos) {
    menuItems.push({ divider: true });
    menuItems.push({ label: t('kb.chatMenu.resetPos'), testid: 'kb-chat-menu-reset', onClick: resetPosition });
  }

  if (panelOpen) return null; // 面板展开时不显示按钮（右键菜单随按钮一起退场）
  const cls =
    'floating-chat-btn' +
    (pos?.hidden ? ' floating-chat-btn--hidden' : '') +
    (pos?.edge ? ` floating-chat-btn--edge-${pos.edge}` : '');
  return (
    <>
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
        onContextMenu={onContextMenu}
        title={t('kb.floatingChat')}
        aria-label={t('kb.floatingChat')}
      >
        {/* 白色描边聊天气泡已换为品牌标：圆形裁切后波浪圆环居中留呼吸边（CSS __logo） */}
        <img className="floating-chat-btn__logo" src={LOGO_URL} alt="" draggable={false} />
      </button>
      {/* 菜单必须是 button 的兄弟（div 不能嵌进 button）；面板展开 → 按钮卸载 → 菜单随之消失 */}
      {menuPos && (
        <ContextMenu items={menuItems} position={menuPos} onClose={() => setMenuPos(null)} />
      )}
    </>
  );
}
