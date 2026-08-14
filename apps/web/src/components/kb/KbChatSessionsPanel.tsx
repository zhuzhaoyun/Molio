// apps/web/src/components/kb/KbChatSessionsPanel.tsx
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from 'react';
import {
  kbChatSessionsStore, useKbChatSessions, useKbChatActiveSessionId, useKbChatPanelOpen,
  MAX_CHAT_SESSIONS,
} from '../../stores/kbChatSessionsStore';
import { useCurrentContext } from '../../stores/currentContextStore';
import { ChatSessionTabBar } from './ChatSessionTabBar';
import { KbChatSession, type KbChatSessionApi } from './KbChatSession';
import { WIKI_PROMPTS, WIKI_INGEST_PROMPT, WIKI_TITLES } from './kbChatPrompts';
import { ConfirmDialog } from './KbModals';
import './KbChatSessionsPanel.css';

export interface KbChatSessionsPanelHandle {
  runWikiOp: (opts: { mode: 'build' | 'lint' | 'ingest'; filePath?: string; isDirectory?: boolean }) => void;
  openQa: (opts: { filePath: string | null; vaultId: string | null; selectedText?: string | null }) => void;
  /** 打开历史会话（方案 D：任意页面就地打开，不跳转知识库页）。 */
  openConversation: (conversationId: string) => void;
}

interface WikiOpOpts { mode: 'build' | 'lint' | 'ingest'; filePath?: string; isDirectory?: boolean }

/* 面板宽度：默认 500，可拖拽 320–720 并持久化（超视口时由 CSS max-width:min(90vw,720px) 收住） */
const PANEL_WIDTH_DEFAULT = 500;
const PANEL_WIDTH_MIN = 320;
const PANEL_WIDTH_MAX = 720;
const STORAGE_KEY_WIDTH = 'molio.kb.chatPanelWidth';

function clampPanelWidth(w: number): number {
  return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, Math.round(w)));
}
function readPanelWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_WIDTH);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n)) return clampPanelWidth(n);
    }
  } catch { /* storage unavailable */ }
  return PANEL_WIDTH_DEFAULT;
}

/* 面板高度：默认撑满视口（CSS calc(100vh-96px)，null = 未自定义 → 用 CSS 默认随视口自适应），
   顶缘可拖拽 320–视口高-96 并持久化（超视口时由 CSS max-height 收住）。 */
const PANEL_HEIGHT_MIN = 320;
const STORAGE_KEY_HEIGHT = 'molio.kb.chatPanelHeight';

function clampPanelHeight(h: number): number {
  const max = Math.max(window.innerHeight - 96, PANEL_HEIGHT_MIN);
  return Math.min(max, Math.max(PANEL_HEIGHT_MIN, Math.round(h)));
}
function readPanelHeight(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_HEIGHT);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n)) return clampPanelHeight(n);
    }
  } catch { /* storage unavailable */ }
  return null;
}

/* 双形态：悬浮（默认，可拖拽位置/尺寸）与停靠侧边栏（页头之下、右缘、可拖宽）。
   形态按页记忆并持久化（KB 页默认停靠、其余页面默认悬浮）；悬浮位置持久化；
   形态切换经按钮（带过渡动画）或拖拽（瞬时）。 */
const STORAGE_KEY_DOCK_MODE_BY_PAGE = 'molio.kb.chatDockModeByPage';
const STORAGE_KEY_FLOAT_POS = 'molio.kb.chatFloatPos';

function defaultDockFor(page: string): 'float' | 'dock' {
  return page === 'knowledge' ? 'dock' : 'float';
}

function readDockModeByPage(): Record<string, 'float' | 'dock'> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_DOCK_MODE_BY_PAGE);
    if (raw) {
      const m = JSON.parse(raw);
      if (m && typeof m === 'object') return m as Record<string, 'float' | 'dock'>;
    }
  } catch { /* storage unavailable */ }
  return {};
}
function readFloatPos(): { left: number; top: number } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_FLOAT_POS);
    if (raw) {
      const p = JSON.parse(raw) as { left?: unknown; top?: unknown };
      if (typeof p.left === 'number' && typeof p.top === 'number') {
        return { left: p.left, top: p.top };
      }
    }
  } catch { /* storage unavailable */ }
  return null;
}

interface Props {
  agentId: string | null;
}

export const KbChatSessionsPanel = forwardRef<KbChatSessionsPanelHandle, Props>(function KbChatSessionsPanel(
  { agentId }, ref,
) {
  const sessions = useKbChatSessions();
  const activeSessionId = useKbChatActiveSessionId();
  // 上下文改从全局 store 读（方案 D：面板常驻 App 层，任意页面可用，不依赖 KB 页 props）
  const { vault, filePath, page } = useCurrentContext();
  const panelOpen = useKbChatPanelOpen();
  const vaultPath = vault?.path ?? null;
  const currentVaultId = vault?.id ?? null;
  const currentFilePath = filePath;

  const [pendingSelection, setPendingSelection] = useState<string | null>(null);
  // #5: pendingSelection 归属的会话 id（null = 无）。只投给目标会话，避免广播给所有空会话、
  // 被任意会话的首条消息消费。
  const [pendingSelectionSessionId, setPendingSelectionSessionId] = useState<string | null>(null);
  const [runningMap, setRunningMap] = useState<Record<string, boolean>>({});
  const [confirmDialog, setConfirmDialog] = useState<{ show: boolean; title: string; message: string }>({ show: false, title: '', message: '' });
  const [toast, setToast] = useState<string | null>(null);
  // 关闭「运行中会话」的确认态（ref 作真值源，state 触发渲染）
  const [closePendingOpen, setClosePendingOpen] = useState(false);
  // 面板宽度：初值从 localStorage 读，拖拽后持久化（宽度自适应由 CSS max-width 兜底）
  const [panelWidth, setPanelWidth] = useState<number>(readPanelWidth);
  // 面板高度：null = 未自定义 → CSS 默认（calc(100vh-96px) 随视口自适应），拖拽后持久化
  const [panelHeight, setPanelHeight] = useState<number | null>(readPanelHeight);
  // 形态按页记忆：dockByPage 存每页上次的形态（持久化），dockMode 是当前页生效形态。
  // 'float' 悬浮（可拖位置/尺寸）| 'dock' 停靠侧边栏（可拖宽）。
  const [dockByPage, setDockByPage] = useState<Record<string, 'float' | 'dock'>>(readDockModeByPage);
  const [dockMode, setDockModeState] = useState<'float' | 'dock'>(() =>
    dockByPage[page] ?? defaultDockFor(page),
  );
  // 按页记忆停靠形态：进入 KB 页时应用该页记忆（默认停靠）。
  // 离开 KB 页不切换形态——悬浮按钮已屏蔽、面板只在 KB 页打开，离开时面板即将被自动收起，
  // 原地从当前几何关闭；若在此把 dockMode 换成悬浮，会先跳到悬浮几何再淡出（视觉 bug）。
  // 面板无法在非 KB 页打开，故非 KB 页的形态记忆不再需要生效。
  useEffect(() => {
    if (page !== 'knowledge') return;
    setDockModeState(dockByPage[page] ?? defaultDockFor(page));
    // 仅响应 page 导航，不含 dockByPage（切换停靠时 setDockMode 已同步 state，无需回读）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);
  // 悬浮位置（left/top）。null = 未移动过 → CSS 默认右下角。持久化。
  const [floatPos, setFloatPos] = useState<{ left: number; top: number } | null>(readFloatPos);
  // 形态切换过渡：切换瞬间加 --morphing 启用几何过渡，260ms 后移除
  const [morphing, setMorphing] = useState(false);
  const morphTimerRef = useRef<number | null>(null);
  const panelElRef = useRef<HTMLDivElement>(null);
  // handleEl 记录手柄元素：is-dragging 加在手柄上（pointerdown 的 e.currentTarget），
  // 结束/兜底时须从「同一个手柄」移除（此前误从面板移除 → is-dragging 永远残留）。
  // opposite = 被拖边的对侧边缘（宽度=右缘、高度=下缘）：拖动期间钉死对侧、被拖边跟随光标，
  // 不依赖 CSS 锚在 left/right（面板被移动后 inline left 固定时，旧逻辑会让被拖边钉死、对侧外扩）。
  const dragRef = useRef<{ startX: number; startWidth: number; opposite: number; handleEl: HTMLElement } | null>(null);
  const heightDragRef = useRef<{ startY: number; startHeight: number; opposite: number; handleEl: HTMLElement } | null>(null);
  // 头部拖拽移动悬浮位置（moveRef 真值源：拖动中直接写 DOM，release 时提交 floatPos）
  const moveRef = useRef<{ grabX: number; grabY: number; fromDock: boolean } | null>(null);

  const docked = dockMode === 'dock';
  // 知识库页停靠 = 还原改动前的「页内分栏」：面板从页顶占满整高、贴右缘，
  // 文档区经 --kb-dock-w 让出等宽 → 问答与文档分栏而非覆盖。其他页面停靠仍是
  // 页头之下的悬浮式侧边栏（--dock 基础几何）。
  const dockKb = docked && page === 'knowledge';
  // 停靠形态不应用高度/位置 inline（几何交给 --dock）；悬浮形态应用自定义高度与位置
  const panelStyle: React.CSSProperties = { width: panelWidth };
  if (!docked) {
    panelStyle.height = panelHeight ?? undefined;
    if (floatPos) {
      panelStyle.left = floatPos.left;
      panelStyle.top = floatPos.top;
    }
  }

  // 停靠形态的文档区联动：把面板当前宽度同步到根节点的 --kb-dock-w，
  // .kb-shell 的 padding-right 消费它 → 文档区实时重排（拖宽时逐帧跟随，无需逐帧 setState）。
  // ResizeObserver 监听面板宽度变化（拖拽/提交/重载初始化都覆盖），只在
  // 「停靠 + 打开 + KB 页」时生效，其余情况置 0（文档区恢复全宽）。
  const syncDockVar = useCallback(() => {
    const el = panelElRef.current;
    if (!el) return;
    const active = dockMode === 'dock' && panelOpen && page === 'knowledge';
    document.documentElement.style.setProperty('--kb-dock-w', active ? `${el.offsetWidth}px` : '0px');
  }, [dockMode, panelOpen, page]);
  useEffect(() => {
    const el = panelElRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => syncDockVar());
    ro.observe(el);
    syncDockVar();
    return () => {
      ro.disconnect();
      document.documentElement.style.setProperty('--kb-dock-w', '0px');
    };
  }, [syncDockVar]);

  const commitWidth = useCallback((w: number) => {
    const clamped = clampPanelWidth(w);
    setPanelWidth(clamped);
    try { localStorage.setItem(STORAGE_KEY_WIDTH, String(clamped)); } catch { /* storage unavailable */ }
  }, []);
  // 边缘跟随光标：拖左缘向左 → 变宽、向右 → 变窄，右缘始终钉死、左缘跟随光标。
  // 拖动中直接写 DOM 避免每帧 setState 重渲染。用几何记录对侧边缘，而非依赖 CSS 锚点
  // （面板被移动后 inline left 固定，若只改 width 会让「被拖的边钉死、对侧外扩」反直觉）。
  const onResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = panelElRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const handleEl = e.currentTarget as HTMLElement;
    dragRef.current = { startX: e.clientX, startWidth: rect.width, opposite: rect.right, handleEl };
    handleEl.classList.add('is-dragging');
    handleEl.setPointerCapture(e.pointerId);
    document.body.classList.add('kb-resizing');
  }, []);
  const onResizePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const el = panelElRef.current;
    if (!d || !el) return;
    const w = clampPanelWidth(d.startWidth + (d.startX - e.clientX));
    el.style.width = `${w}px`;
    // over-constrained 时 left 生效：显式左缘 = 对侧右缘 - 宽 → 右缘钉死、左缘跟随光标
    el.style.left = `${d.opposite - w}px`;
  }, []);
  const onResizePointerEnd = useCallback(() => {
    const el = panelElRef.current;
    const d = dragRef.current;
    dragRef.current = null;
    // is-dragging 是加在手柄上的（见 pointerdown），必须从同一手柄移除；面板兜底。
    d?.handleEl.classList.remove('is-dragging');
    if (el) {
      el.classList.remove('is-dragging');
      const w = clampPanelWidth(parseFloat(el.style.width) || panelWidth);
      const left = parseFloat(el.style.left);
      el.style.width = '';
      el.style.left = '';
      commitWidth(w);
      // 悬浮且面板被移动过（floatPos 生效）：左缘此刻是拖拽终点，同步进 floatPos，
      // 否则重渲染会把 left 跳回旧位置（左缘钉死、右缘外扩的反直觉行为）。
      if (!docked && floatPos && Number.isFinite(left)) {
        const p = { left: Math.round(left), top: floatPos.top };
        setFloatPos(p);
        try { localStorage.setItem(STORAGE_KEY_FLOAT_POS, JSON.stringify(p)); } catch { /* storage unavailable */ }
      }
    }
    document.body.classList.remove('kb-resizing');
  }, [panelWidth, commitWidth, docked, floatPos, setFloatPos]);
  const onResizeKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); commitWidth(panelWidth - 20); }
    if (e.key === 'ArrowRight') { e.preventDefault(); commitWidth(panelWidth + 20); }
  }, [panelWidth, commitWidth]);

  const commitHeight = useCallback((h: number) => {
    const clamped = clampPanelHeight(h);
    setPanelHeight(clamped);
    try { localStorage.setItem(STORAGE_KEY_HEIGHT, String(clamped)); } catch { /* storage unavailable */ }
  }, []);
  // 面板下锚定：向上拖（clientY 减小）→ 变高。拖动中直接写 DOM 避免每帧 setState 重渲染。
  // 边缘跟随光标：拖顶缘向上 → 变高、向下 → 变矮，下缘始终钉死、顶缘跟随光标。
  // 与宽度同理用几何记录对侧下缘，避免面板移动后 inline top 固定导致「被拖的边钉死」。
  const onResizeHeightPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = panelElRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const handleEl = e.currentTarget as HTMLElement;
    heightDragRef.current = {
      startY: e.clientY,
      startHeight: rect.height,
      opposite: rect.bottom,
      handleEl,
    };
    handleEl.classList.add('is-dragging');
    handleEl.setPointerCapture(e.pointerId);
    document.body.classList.add('kb-resizing-v');
  }, []);
  const onResizeHeightPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = heightDragRef.current;
    const el = panelElRef.current;
    if (!d || !el) return;
    const h = clampPanelHeight(d.startHeight + (d.startY - e.clientY));
    el.style.height = `${h}px`;
    // over-constrained 时 top 生效：显式顶缘 = 对侧下缘 - 高 → 下缘钉死、顶缘跟随光标
    el.style.top = `${d.opposite - h}px`;
  }, []);
  const onResizeHeightPointerEnd = useCallback(() => {
    const el = panelElRef.current;
    const d = heightDragRef.current;
    heightDragRef.current = null;
    // is-dragging 是加在手柄上的（见 pointerdown），必须从同一手柄移除；面板兜底。
    d?.handleEl.classList.remove('is-dragging');
    if (el) {
      el.classList.remove('is-dragging');
      const h = clampPanelHeight(parseFloat(el.style.height) || (panelHeight ?? Math.max(window.innerHeight - 96, PANEL_HEIGHT_MIN)));
      const top = parseFloat(el.style.top);
      el.style.height = '';
      el.style.top = '';
      commitHeight(h);
      // 悬浮且面板被移动过：顶缘同步进 floatPos，避免重渲染跳回旧位置
      if (!docked && floatPos && Number.isFinite(top)) {
        const p = { left: floatPos.left, top: Math.round(top) };
        setFloatPos(p);
        try { localStorage.setItem(STORAGE_KEY_FLOAT_POS, JSON.stringify(p)); } catch { /* storage unavailable */ }
      }
    }
    document.body.classList.remove('kb-resizing-v');
  }, [panelHeight, commitHeight, docked, floatPos, setFloatPos]);
  const onResizeHeightKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const cur = panelHeight ?? Math.max(window.innerHeight - 96, PANEL_HEIGHT_MIN);
    if (e.key === 'ArrowUp') { e.preventDefault(); commitHeight(cur - 20); }
    if (e.key === 'ArrowDown') { e.preventDefault(); commitHeight(cur + 20); }
  }, [panelHeight, commitHeight]);

  // 拖拽兜底清理：任何 pointerup/pointercancel（气泡阶段，目标处理器已先跑、幂等）或窗口失焦，
  // 都清掉全部拖拽状态与 body 光标类。覆盖 pointerup 丢失的真实路径 —— 手柄 capture 被异常释放、
  // 拖动中元素被移除、OS 手势/失焦抢走指针。此前这类路径会让 body 保持 ns-resize/col-resize
  // 光标（「鼠标卡在拖拽调节状态」）。header 拖拽（moveRef）也一并清理。
  useEffect(() => {
    const endAllDrags = () => {
      dragRef.current?.handleEl.classList.remove('is-dragging');
      heightDragRef.current?.handleEl.classList.remove('is-dragging');
      dragRef.current = null;
      heightDragRef.current = null;
      moveRef.current = null;
      panelElRef.current?.classList.remove('is-dragging');
      document.body.classList.remove('kb-resizing', 'kb-resizing-v', 'kb-moving');
    };
    window.addEventListener('pointerup', endAllDrags);
    window.addEventListener('pointercancel', endAllDrags);
    window.addEventListener('blur', endAllDrags);
    return () => {
      window.removeEventListener('pointerup', endAllDrags);
      window.removeEventListener('pointercancel', endAllDrags);
      window.removeEventListener('blur', endAllDrags);
    };
  }, []);

  // ─── 形态切换（悬浮 / 停靠侧边栏） ───
  const setDockMode = useCallback((mode: 'float' | 'dock') => {
    setDockModeState(mode);
    setDockByPage((prev) => {
      const next = { ...prev, [page]: mode };
      try { localStorage.setItem(STORAGE_KEY_DOCK_MODE_BY_PAGE, JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });
  }, [page]);
  // 清掉拖拽时手动写入的 inline left/top，把几何交还给 React / CSS 控制
  const clearInlinePos = useCallback(() => {
    const el = panelElRef.current;
    if (!el) return;
    el.style.left = '';
    el.style.top = '';
  }, []);
  const startMorph = useCallback(() => {
    setMorphing(true);
    if (morphTimerRef.current) window.clearTimeout(morphTimerRef.current);
    morphTimerRef.current = window.setTimeout(() => setMorphing(false), 260);
  }, []);
  useEffect(() => () => { if (morphTimerRef.current) window.clearTimeout(morphTimerRef.current); }, []);
  // 按钮切换：先交还几何（含手动 inline），再切形态并启用过渡动画
  const toggleDock = useCallback(() => {
    clearInlinePos();
    setDockMode(dockMode === 'dock' ? 'float' : 'dock');
    startMorph();
  }, [dockMode, clearInlinePos, setDockMode, startMorph]);

  // 头部拖拽：悬浮移动 / 停靠时拖离（脱离停靠跟随光标）。拖动中直接写 DOM。
  const clampMoveX = useCallback((x: number) => {
    const w = panelWidth;
    return Math.min(Math.max(Math.round(x), -(w - 80)), window.innerWidth - 80);
  }, [panelWidth]);
  const clampMoveY = useCallback((y: number) => {
    return Math.min(Math.max(Math.round(y), 8), window.innerHeight - 48);
  }, []);
  const onHeaderDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = panelElRef.current;
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const grabX = e.clientX - rect.left;
    const grabY = e.clientY - rect.top;
    if (dockMode === 'dock') {
      // 脱离停靠：立即切为悬浮并让面板跟随光标（瞬时，无过渡）
      setDockMode('float');
      moveRef.current = { grabX, grabY, fromDock: true };
      el.style.left = `${clampMoveX(e.clientX - grabX)}px`;
      el.style.top = `${clampMoveY(e.clientY - grabY)}px`;
    } else {
      moveRef.current = { grabX, grabY, fromDock: false };
    }
    // 拖动中禁止选中文本：header 拖动与文本预览器的文字选择冲突（用户拖顶移动时误选文档文字）
    document.body.classList.add('kb-moving');
    return true;
  }, [dockMode, setDockMode, clampMoveX, clampMoveY]);
  const onHeaderDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = moveRef.current;
    const el = panelElRef.current;
    if (!d || !el) return;
    el.style.left = `${clampMoveX(e.clientX - d.grabX)}px`;
    el.style.top = `${clampMoveY(e.clientY - d.grabY)}px`;
  }, [clampMoveX, clampMoveY]);
  const onHeaderDragEnd = useCallback(() => {
    const d = moveRef.current;
    const el = panelElRef.current;
    moveRef.current = null;
    // 无论是否有有效拖拽，先移除拖动中光标/禁选中（防止中途 abort 后残留）
    document.body.classList.remove('kb-moving');
    if (!d || !el) return;
    const left = parseFloat(el.style.left);
    const top = parseFloat(el.style.top);
    const moved = Number.isFinite(left) && Number.isFinite(top);
    // 先取几何（此刻 inline 位置仍生效）再决定停靠
    const rect = el.getBoundingClientRect();
    const snapDock = !d.fromDock && moved && (window.innerWidth - rect.right) <= 8;
    // 停靠时不提交该位置（此时面板大半在屏外，提交会让之后取消停靠回到屏外）
    if (moved && !snapDock) {
      setFloatPos({ left, top });
      try { localStorage.setItem(STORAGE_KEY_FLOAT_POS, JSON.stringify({ left, top })); } catch { /* storage unavailable */ }
    }
    if (snapDock) {
      clearInlinePos(); // 停靠几何交给 --dock（right:0 / top:72）
      setDockMode('dock');
    }
  }, [clearInlinePos, setDockMode]);

  const sessionApisRef = useRef(new Map<string, KbChatSessionApi>());
  const pendingWikiRef = useRef<WikiOpOpts | null>(null);
  // 新开的 wiki 会话尚未 mount（API 未注册）时缓存待自动发送的提示词，registerApi 时补发
  const pendingAutoSendRef = useRef(new Map<string, string>());
  const closePendingRef = useRef<string | null>(null);
  // #1: 待关闭会话是否为 wiki 模式。wiki 关闭确认只允许「中断并关闭/取消」——
  // 杜绝「后台继续并关闭」让已移除标签的 run 逃过 anyWikiRunning 单例守卫（D3 并发写同一 vault）。
  const closePendingIsWikiRef = useRef(false);

  const registerApi = useCallback((id: string, a: KbChatSessionApi) => {
    sessionApisRef.current.set(id, a);
    const prompt = pendingAutoSendRef.current.get(id);
    if (prompt !== undefined) {
      pendingAutoSendRef.current.delete(id);
      a.clear();
      a.send(prompt);
    }
  }, []);
  const unregisterApi = useCallback((id: string) => {
    sessionApisRef.current.delete(id);
    // #7: 会话在 mount 前就被关闭 → 清掉缓存的待自动发送提示词，避免泄漏
    pendingAutoSendRef.current.delete(id);
  }, []);
  const handleRunningChange = useCallback((id: string, running: boolean) => {
    setRunningMap((prev) => (prev[id] === running ? prev : { ...prev, [id]: running }));
  }, []);
  // #7: 会话关闭时同步清理 runningMap，防止残留条目误判互斥/关闭态
  const pruneRunning = useCallback((id: string) => {
    setRunningMap((prev) => {
      if (!(id in prev)) return prev;
      const n = { ...prev };
      delete n[id];
      return n;
    });
  }, []);

  // 传给标签栏：哪些会话在运行（驱动标签上的运行指示点）
  const runningSessionIds = useMemo(
    () => new Set(Object.entries(runningMap).filter(([, v]) => v).map(([k]) => k)),
    [runningMap],
  );
  const anyWikiRunning = useMemo(
    () => sessions.some((s) => s.mode !== 'qa' && runningMap[s.id]),
    [sessions, runningMap],
  );

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2000);
  }, []);

  // ─── 命令下发 ───
  const wikiPrompt = useCallback((opts: WikiOpOpts) => {
    if (opts.mode === 'build' || opts.mode === 'lint') return WIKI_PROMPTS[opts.mode];
    return WIKI_INGEST_PROMPT(opts.filePath ?? '', opts.isDirectory);
  }, []);

  const clearAndSend = useCallback(async (sessionId: string, opts: WikiOpOpts) => {
    const a = sessionApisRef.current.get(sessionId);
    if (!a) {
      // 会话刚 open、尚未 mount（API 未注册）→ 缓存提示词，registerApi 时补发
      pendingAutoSendRef.current.set(sessionId, wikiPrompt(opts));
      return;
    }
    // D3「新构建停旧构建」：先 cancel 该会话正在跑的 run（daemon 侧 DELETE /api/runs/:id，
    // 杀旧 agent 进程，杜绝新旧构建并发写 vault），再清空、再自动发送。
    // api.cancel 在无 run 时是安全的 no-op；await 确保 cancel 的收尾 setState
    // 不会覆盖随后新 run 的 running 状态。
    // cancel 的网络失败不中止中断（同 useChatCore.send 里 api.cancelRun().catch(() => {}) 模式）：
    // 旧进程可能没杀掉，但 clear + 新 run 照常进行，避免中断无响应。
    try {
      await a.cancel();
    } catch { /* cancel 失败仍继续 clear + send */ }
    a.clear();
    a.send(wikiPrompt(opts));
  }, [wikiPrompt]);

  const runWikiOp = useCallback((opts: WikiOpOpts) => {
    // 1) 找/建该类型 wiki 会话标签
    let tab = sessions.find((s) => s.mode === opts.mode);
    if (!tab) {
      const res = kbChatSessionsStore.openSession({
        mode: opts.mode, title: WIKI_TITLES[opts.mode], conversationId: null, filePath: null,
      });
      if (!res.opened && res.reason === 'limit') {
        showToast(`已达 ${MAX_CHAT_SESSIONS} 个会话标签上限`);
        return;
      }
      tab = res.tab;
    } else {
      kbChatSessionsStore.activateSession(tab.id);
      // 已存在的 wiki 标签：重新打开可能已被收起的面板，保证点击构建/检查必有反馈
      kbChatSessionsStore.setPanelOpen(true);
    }
    if (!tab) return;
    // 2) 任意 wiki 任务在跑 → 三选一
    if (anyWikiRunning) {
      pendingWikiRef.current = opts;
      setConfirmDialog({
        show: true,
        title: '当前任务进行中',
        message: '当前有 Wiki 任务正在运行。选择如何处理：',
      });
      return;
    }
    // 3) 无冲突 → 清空 + 自动发送
    clearAndSend(tab.id, opts);
  }, [sessions, anyWikiRunning, clearAndSend, showToast]);

  const handleConfirmDialog = useCallback(async (action: 'interrupt' | 'queue') => {
    setConfirmDialog((prev) => ({ ...prev, show: false }));
    const opts = pendingWikiRef.current;
    pendingWikiRef.current = null;
    if (!opts) return;
    if (action === 'interrupt') {
      // D3「新构建停旧构建」：中断的语义是「停掉正在跑的那个任务」，不是「停掉新任务要
      // 落地的那个 tab」。当正在跑的 tab 和用户点的新任务 tab 是不同 mode（build 在跑 +
      // 点 lint）时，只 cancel 目标 tab 会落空 → 旧 run 进程没被杀，新旧两个 wiki run
      // 并发写同一 vault（D3 hazard）。先逐个 cancel 所有真正在跑的 wiki 会话并 await，
      // 再对新目标 tab 做 clear + send。
      const running = kbChatSessionsStore.getSessions()
        .filter((s) => s.mode !== 'qa' && runningMap[s.id]);
      await Promise.all(running.map((s) => {
        const api = sessionApisRef.current.get(s.id);
        if (!api) return undefined;
        // cancel 类型是 void | Promise<void> —— 归一化成 Promise 以便 Promise.all 与 .catch
        return Promise.resolve(api.cancel()).catch(() => { /* cancel 失败仍继续新任务 */ });
      }));
      const tab = kbChatSessionsStore.getSessions().find((s) => s.mode === opts.mode);
      if (tab) clearAndSend(tab.id, opts);
    } else {
      // 排队 → 发到正在运行的 wiki 会话
      const running = kbChatSessionsStore.getSessions()
        .find((s) => s.mode !== 'qa' && runningMap[s.id]);
      if (running) sessionApisRef.current.get(running.id)?.send(wikiPrompt(opts));
    }
  }, [clearAndSend, runningMap, wikiPrompt]);

  const openQa = useCallback((opts: { filePath: string | null; vaultId: string | null; selectedText?: string | null }) => {
    const active = kbChatSessionsStore.getActiveSession();
    if (opts.selectedText) {
      // #5: pendingSelection 只投给目标会话（活跃 qa 会话，或新建的 qa 会话），
      // 不再面板级广播给所有空会话。
      setPendingSelection(opts.selectedText);
      setPendingSelectionSessionId(active?.mode === 'qa' ? active.id : null);
    }
    if (active && active.mode === 'qa') {
      kbChatSessionsStore.setPanelOpen(true);
      // #4: 用户对「新选中的文件」再次 💬问答 → 把活跃 qa 会话的 @上下文指向该文件，
      // 否则 composer badge 仍显示旧文档（D7「每个会话记忆自己的文档」依然成立——
      // 显式问答动作把会话重新指向当前文件，恢复旧单会话行为）。
      kbChatSessionsStore.updateSession(active.id, {
        filePath: opts.filePath,
        vaultId: opts.vaultId ?? active.vaultId,
      });
      return;
    }
    const res = kbChatSessionsStore.openSession({
      mode: 'qa', title: '新会话', conversationId: null,
      vaultId: opts.vaultId ?? undefined, filePath: opts.filePath,
    });
    if (res.opened && res.tab) {
      if (opts.selectedText) setPendingSelectionSessionId(res.tab.id);
    } else if (!res.opened && res.reason === 'limit') {
      // 创建失败（达上限）→ 放弃这次 pendingSelection，避免悬空预览
      setPendingSelection(null);
      setPendingSelectionSessionId(null);
      showToast(`已达 ${MAX_CHAT_SESSIONS} 个会话标签上限`);
    }
  }, [showToast]);

  // ─── 面板级事件 ───
  const handleNewSession = useCallback(() => {
    const res = kbChatSessionsStore.openSession({
      mode: 'qa', title: '新会话', conversationId: null,
      vaultId: currentVaultId ?? undefined, filePath: currentFilePath,
    });
    if (!res.opened && res.reason === 'limit') showToast(`已达 ${MAX_CHAT_SESSIONS} 个会话标签上限`);
  }, [currentFilePath, currentVaultId, showToast]);

  const handleCloseTab = useCallback((id: string) => {
    if (runningMap[id]) {
      closePendingRef.current = id;
      // #1: 记录被关闭会话的模式 —— wiki 模式只允许「中断并关闭/取消」。
      closePendingIsWikiRef.current =
        kbChatSessionsStore.getSessions().find((s) => s.id === id)?.mode !== 'qa';
      setClosePendingOpen(true);
      return;
    }
    kbChatSessionsStore.closeSession(id);
    pruneRunning(id);
  }, [runningMap, pruneRunning]);

  const handleCloseConfirm = useCallback((interrupt: boolean) => {
    const id = closePendingRef.current;
    closePendingRef.current = null;
    closePendingIsWikiRef.current = false;
    setClosePendingOpen(false);
    if (!id) return;
    if (interrupt) sessionApisRef.current.get(id)?.cancel();
    kbChatSessionsStore.closeSession(id);
    pruneRunning(id);
  }, [pruneRunning]);

  const handleOpenConversation = useCallback((conversationId: string) => {
    const active = kbChatSessionsStore.getActiveSession();
    const activeRunning = active ? runningMap[active.id] : false;
    if (activeRunning) {
      // 运行中会话禁止就地切换 —— 开新标签保留直播中的会话（切历史不中断回复）。
      // openSession 已按 conversationId 去重（目标会话已在其他标签 → 激活，不重复建标签）；
      // 新建标签 mount 时自动从 DB 加载 + 恢复活跃 run。
      const res = kbChatSessionsStore.openSession({
        mode: 'qa', title: '加载中…', conversationId, filePath: null,
      });
      if (!res.opened && res.reason === 'limit') {
        showToast(`已达 ${MAX_CHAT_SESSIONS} 个会话标签上限`);
      }
      return;
    }
    const res = kbChatSessionsStore.openConversation(conversationId);
    if (res.reason === 'limit') {
      showToast(`已达 ${MAX_CHAT_SESSIONS} 个会话标签上限`);
      return;
    }
    // 就地切换（不新建标签）：store 已更新活动会话的 conversationId，这里触发它真正加载
    if (res.switched && res.tab) {
      sessionApisRef.current.get(res.tab.id)?.loadConversation?.(conversationId);
    }
  }, [runningMap, showToast]);

  const handleLoadError = useCallback((sessionId: string) => {
    showToast('该会话已不存在或无法加载，已关闭标签');
    // #2: 只关「报错的那个」会话标签（可能是隐藏标签），不误关当前活跃标签。
    // closeSession 内部已守卫不存在；这里仍做一次存在性校验以免误 toast 后无标签可关。
    if (kbChatSessionsStore.getSessions().some((s) => s.id === sessionId)) {
      kbChatSessionsStore.closeSession(sessionId);
      pruneRunning(sessionId);
    }
  }, [showToast, pruneRunning]);

  useImperativeHandle(ref, () => ({ runWikiOp, openQa, openConversation: handleOpenConversation }), [runWikiOp, openQa, handleOpenConversation]);

  // 面板头部活动会话的模式标签
  return (
    <div
      ref={panelElRef}
      className={
        `floating-chat-panel` +
        (panelOpen ? '' : ' floating-chat-panel--closed') +
        (docked ? ' floating-chat-panel--dock' : '') +
        (dockKb ? ' floating-chat-panel--dock-kb' : '') +
        (morphing ? ' floating-chat-panel--morphing' : '')
      }
      data-testid="kb-chat-panel"
      style={panelStyle}
    >
      <div
        className="floating-chat-resize-handle"
        data-testid="kb-chat-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整面板宽度"
        tabIndex={0}
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerEnd}
        onPointerCancel={onResizePointerEnd}
        onKeyDown={onResizeKeyDown}
      />
      <div
        className="floating-chat-resize-handle--h"
        data-testid="kb-chat-resize-handle-h"
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整面板高度"
        tabIndex={0}
        onPointerDown={onResizeHeightPointerDown}
        onPointerMove={onResizeHeightPointerMove}
        onPointerUp={onResizeHeightPointerEnd}
        onPointerCancel={onResizeHeightPointerEnd}
        onKeyDown={onResizeHeightKeyDown}
      />
      <ChatSessionTabBar
        sessions={sessions}
        activeSessionId={activeSessionId}
        runningSessionIds={runningSessionIds}
        onActivate={kbChatSessionsStore.activateSession}
        onClose={handleCloseTab}
        onNewSession={handleNewSession}
        onRename={(id, title) => kbChatSessionsStore.updateSession(id, { title })}
        onOpenConversation={handleOpenConversation}
        onClosePanel={() => kbChatSessionsStore.setPanelOpen(false)}
        docked={docked}
        onToggleDock={toggleDock}
        onHeaderDragStart={onHeaderDragStart}
        onHeaderDragMove={onHeaderDragMove}
        onHeaderDragEnd={onHeaderDragEnd}
      />
      <div className="file-chat-session-stack">
        {sessions.length === 0 ? (
          <div className="file-chat-sessions-empty" data-testid="kb-chat-sessions-empty">
            <div className="file-chat-empty-icon">💬</div>
            <p>还没有会话</p>
            <button type="button" className="kb-btn kb-btn-ghost" onClick={handleNewSession}>
              + 新建会话
            </button>
          </div>
        ) : (
          sessions.map((s) => (
            <KbChatSession
              key={s.id}
              session={s}
              active={s.id === activeSessionId}
              agentId={agentId}
              vaultPath={vaultPath}
              vaultId={currentVaultId}
              selectedText={pendingSelectionSessionId === s.id ? pendingSelection : null}
              onSelectedTextConsumed={() => { setPendingSelection(null); setPendingSelectionSessionId(null); }}
              onRunningChange={handleRunningChange}
              onComplete={() => kbChatSessionsStore.notifyWikiComplete()}
              onLoadError={handleLoadError}
              registerApi={registerApi}
              unregisterApi={unregisterApi}
            />
          ))
        )}
      </div>
      {toast && <div className="kb-save-toast" data-testid="kb-notice">{toast}</div>}

      {/* wiki 三选一 */}
      <ConfirmDialog
        show={confirmDialog.show}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmLabel="中断并立即执行"
        tertiaryLabel="排队等当前完成"
        danger
        onConfirm={() => handleConfirmDialog('interrupt')}
        onTertiary={() => handleConfirmDialog('queue')}
        onCancel={() => { setConfirmDialog((p) => ({ ...p, show: false })); pendingWikiRef.current = null; }}
      />
      {/* 关闭运行中会话：qa 会话 → 中断并关闭 / 后台继续并关闭；wiki 会话 → 只有中断并关闭/取消（#1） */}
      <ConfirmDialog
        show={closePendingOpen}
        title="任务正在运行"
        message={closePendingIsWikiRef.current
          ? '关闭该会话将中断正在运行的 Wiki 任务，Wiki 任务不支持后台继续。'
          : '关闭该会话前，请选择对正在运行任务的处理：'}
        confirmLabel="中断并关闭"
        tertiaryLabel={closePendingIsWikiRef.current ? undefined : '后台继续并关闭'}
        danger
        onConfirm={() => handleCloseConfirm(true)}
        onTertiary={closePendingIsWikiRef.current ? undefined : () => handleCloseConfirm(false)}
        onCancel={() => { closePendingRef.current = null; closePendingIsWikiRef.current = false; setClosePendingOpen(false); }}
      />
    </div>
  );
});
