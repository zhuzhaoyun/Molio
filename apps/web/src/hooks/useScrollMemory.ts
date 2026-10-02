/**
 * 阅读视窗位置记忆 —— 按「文档身份」记住滚动位置，切回时恢复。
 *
 * 背景：小 .md 阅读路径的滚动容器在切换文件时被 React 复用（同位置同元素只换
 * children），`scrollTop` 不归 React 管，于是残留上一篇的位置。重置回顶部能消除
 * 「显示出属于别的文档的坐标」，但会丢掉用户在原文档里的阅读位置 —— 而 KB 里最
 * 常见的动作恰恰是「去别的文档核一下再回来」。
 *
 * 两条被记忆的路径（key 前缀区分）：小 .md 阅读视图（容器 `.kb-content-area`）、
 * 源码视图（大 md / 非 md 文本 → CM，容器 `.cm-scroller`）。PDF / 图片 / 排版 /
 * 编辑模式暂不记忆（hook 完全让位）。两条路径的高度模型不同，位置不通用。
 *
 * 落位语义（restore / fresh 两条路，由调用方按导航意图指定，见 intentRef）：
 * - **restore**：点标签切回一个已经开着的文档、前进/后退回到刚才看过的地方 ——
 *   有记录且内容未变就恢复到原位（VS Code 模型，非 Obsidian 默认；KB 里最常见的
 *   动作就是「去别的文档核一下再回来」）。
 * - **fresh**：把文档开进一个原本没有它的标签（单标签里从树/链接点开另一篇、
 *   新标签首次打开）—— 这篇是「重新开始读」，旧记录作废、从顶部开始。
 *   这也让 #274 修的那类「残留坐标」自然不成立（fresh 必回顶）。
 * - 无记录 / 内容已被改写过 → 一律回顶部（reset 作为退化路径自动生效）。
 *
 * 七个关键实现约束（都不显然，改动时留意）：
 *
 * 1. **位置在滚动时持续写入，不依赖「切走时保存」**。切走那一刻 DOM 已经是新
 *    文档，若等 cleanup 再读 `scrollTop`，读到的可能已被新文档高度 clamp 过的值。
 *
 * 2. **恢复必须等新内容「上屏」，而不是等「数据到手」**。这两件事差着一次渲染：
 *    useKnowledge 不清空 fileContent，而 MdRenderer 拿到新 content 后要经自己的
 *    effect setState 才把新 HTML 写进 DOM。若在数据到手那帧落位，`scrollTo` 会被
 *    容器里**上一篇**的 scrollHeight 截断（`scrollTop` 超界即被浏览器夹到上界）：
 *    上一篇越短截得越狠，短到没有滚动条时直接截成 0 —— 表现就是「切回长文档却
 *    回到顶部」。同理，指纹校验也必须在上屏后做（见约束 3）。故 pending 中转一次，
 *    由调用方用「已上屏内容 === 当前内容」判定 ready。
 *
 * 3. **指纹校验也必须在内容就绪时做，不能在切换瞬间做**。切换瞬间手上那份
 *    fileContent 还是上一篇的指纹，拿它跟新文档的记录比对必然不等 —— 会把「切回
 *    来」一律误判成「内容已变」而错误回顶。故 pending 存的是带指纹的记录本身，
 *    等 ready 时再用「此刻已刷新」的指纹比对。
 *
 * 4. **指纹不进 effect 依赖**。指纹含 mtime，用户保存编辑会改它；若进依赖，每次
 *    保存都会重跑切换逻辑并把视窗顶回顶部。
 *
 * 5. **intentRef 用 ref 而非普通 prop 值**。意图必须与「哪一次选择」严格配对：
 *    调用方在调 selectFile 之前同步写入 ref，hook 在 key 变化的那次 effect 里读。
 *    若用 state 传值，遇到外部 store（useSyncExternalStore）与 setState 的刷新顺序
 *    差异，可能出现「新文档 + 旧意图」的那一帧，从而按错误语义落位。
 *
 * 6. **落位要能重复施加，且「没记录」时绝不动滚动**。切回一篇文档时，阅读分支常常先以
 *    **空壳**挂载（中途看过 PDF/图片/源码 —— 那是另一条渲染分支，那棵子树被整个换掉，
 *    挂回来时 MdRenderer 的 state 是空的），而只要**中间那篇的读取还没落地**
 *    （大文件、慢盘、后台请求排队时都会 —— 桌面端实测那篇 1.1MB 的 PDF 就是这样），
 *    `fileContent` 仍旧是这一篇的，`mdRenderedSource` 也还留着上一次访问这一篇的字符串
 *    ——于是 ready 在**容器还空着**的那一刻就为真，落位被 clamp 到 0（高度等同视口，
 *    无处可滚）。随后 MdRenderer 渲染完，回传的还是同一个字符串，ready 不再变化，
 *    这次落位就永远不会重来。所以：pending 要留到「真的滚过一次」（或 key 变更、内容被
 *    改写）为止，每次 ready 为真都重落一次同一位置；反过来，pending 为空时**什么都不要
 *    做**——曾经的 `else el.scrollTo({top: 0})` 会在 ready 抖动（true → false → true）
 *    的第二趟把刚恢复的位置又顶回顶部。
 *    触发条件挑剔（要「中间那篇的读取没落地」），纯 md 互切、甚至切到图片/源码的用例
 *    都碰不到：E2E 里得把中间那篇的内容请求扣住才复现（见 kb-scroll-memory.spec.ts
 *    「另一条渲染分支的文档读取还没落地时切回」）。
 *
 * 7. **意图与「哪一次导航」配对，容器换了而 key 没换不算导航**。调用方交出的滚动容器可能
 *    在文档不变的情况下换一个新的元素（源码视图就这样：CM 每份内容 new 一个 EditorView，
 *    量完才把 `.cm-scroller` 交出来，途中还会因 ViewerErrorBoundary 重试而重建）。此时若照读
 *    intentRef，会读到上一次导航遗留的 `fresh`，把这篇文档刚记下的位置误作废；若因为容器
 *    还没到位就跳过 intent 处理，`fresh` 的作废也会整个漏掉。所以：只有 key 真的变了才读意图，
 *    `fresh` 的作废不看有没有容器。
 *
 * 记忆是进程内的（组件存活期），不做持久化：跨重启恢复的旧位置风险高于收益。
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';

interface ScrollMemoryEntry {
  top: number;
  /** 内容指纹（size:modifiedAt）—— 文档被改写过则位置作废。 */
  fp: string;
}

/** 记忆条数上限（LRU）：同会话读过的文档数远超此值时不至于无界增长。 */
const MAX_ENTRIES = 100;

/**
 * 本次导航的落位意图：
 * - `restore`：切回一个已经开着的文档（点标签、前进/后退）→ 有记录就恢复原位
 * - `fresh`：把文档开进一个原本没有它的标签（单标签里点开另一篇、新标签首开）
 *   → 旧记录作废，从顶部开始
 */
export type ScrollIntent = 'restore' | 'fresh';

export interface UseScrollMemoryOptions {
  /**
   * 滚动容器（`overflow-y: auto` 的那个元素）。
   * **身份变化 = 容器换了**（effect 依赖它）：源码视图的容器由 CM 量完才交出来，
   * 每份内容都是新元素——那正是一次「该挂监听 / 该落位」的时机。
   */
  containerRef: RefObject<HTMLElement | null>;
  /**
   * 文档身份 key（含 pane/vault 前缀，避免同一文档在主格与副格互相覆盖；
   * 源码视图另有 `cm:` 段，因为两种视图的高度模型不同）。
   * null = 当前这条路径不被记忆（PDF / 图片 / 排版模式 / 编辑模式）——此时 hook
   * 完全让位，不读不写不动滚动。
   */
  key: string | null;
  /** 内容指纹；null = 未知（不参与记忆）。 */
  fingerprint: string | null;
  /**
   * 新文档内容是否**已经上屏**（DOM 里渲染的就是这一篇）。
   * 注意不是「数据到手」——两者差一次渲染，早了会被上一篇的高度截断（约束 2）。
   */
  ready: boolean;
  /**
   * 本次导航的意图（见 ScrollIntent）。调用方必须在触发选择的**同一时刻同步**
   * 写入（ref，不是 state —— 见约束 5）。缺省视为 `restore`（保守：只恢复，
   * 不主动丢记录）。
   */
  intentRef?: RefObject<ScrollIntent>;
}

export interface UseScrollMemoryReturn {
  /** 「回到顶部」动作：归零并同步记忆（滚动监听会自动记下 0）。 */
  scrollToTop: () => void;
}

export function useScrollMemory({
  containerRef,
  key,
  fingerprint,
  ready,
  intentRef,
}: UseScrollMemoryOptions): UseScrollMemoryReturn {
  const memoryRef = useRef(new Map<string, ScrollMemoryEntry>());
  // 渲染期同步 ref，供滚动回调读取「此刻是哪个文档的哪个版本」。
  const keyRef = useRef<string | null>(key);
  const fpRef = useRef<string | null>(fingerprint);
  const readyRef = useRef<boolean>(ready);
  keyRef.current = key;
  fpRef.current = fingerprint;
  readyRef.current = ready;

  /** 待落位的记录（含指纹，等内容就绪后再校验）；null = 本次切换无记录可恢复。 */
  const pendingRef = useRef<ScrollMemoryEntry | null>(null);

  /** 上一次 effect 处理过的 key —— 用来判断这次 effect 是不是一次真正的「导航」（约束 7）。 */
  const lastKeyRef = useRef<string | null>(null);

  // 切换文档：有记录先挂起（校验推迟到内容就绪），无记录立刻回顶；
  // 并挂上持续记录位置的滚动监听（不依赖「切走时保存」，见约束 1）。
  useEffect(() => {
    if (!key) {
      lastKeyRef.current = null;
      pendingRef.current = null;
      return;
    }
    const el = containerRef.current;
    // 意图只跟「key 真的变了」配对（见约束 7）：容器换了而 key 没换不是一次导航。
    const keyChanged = lastKeyRef.current !== key;
    lastKeyRef.current = key;
    const intent = keyChanged ? (intentRef?.current ?? 'restore') : 'restore';

    if (intent === 'fresh') {
      // 新开：这篇这次是「重新开始读」，旧记录作废——否则下次以 restore 回到它
      // （点标签/后退）会跳回一个用户这次没见过的坐标。
      // 容器还没挂时也要作废：源码视图的容器要等 CM 量过一遍才交出来，而那次
      // effect 重跑时 key 已不算变化（见约束 7），若此刻不作废，等容器到位反而会把
      // 旧记录恢复回去。
      memoryRef.current.delete(key);
      pendingRef.current = null;
      el?.scrollTo({ top: 0 });
    } else {
      const saved = memoryRef.current.get(key) ?? null;
      pendingRef.current = saved;
      // 无记录：立刻回顶（reset 的退化路径）。有记录则先不动，等 ready 时再落位。
      if (!saved) el?.scrollTo({ top: 0 });
    }

    // 容器还没到位（源码视图正在构建）——什么都不挂，等 containerRef 身份变化后再来。
    if (!el) return;

    const onScroll = () => {
      // 内容未就绪时容器里还是上一篇：此刻的滚动位置既不属于旧文档（它已经不在
      // 这个位置了）也不属于新文档，记下来只会污染记忆。
      if (!readyRef.current) return;
      // 真的滚起来了 → 这篇的位置从此由用户/记忆负责，停止再施加待落位的记录
      // （否则一次迟到的落位会把用户已经滚走的位置拽回去）。
      pendingRef.current = null;
      const k = keyRef.current;
      const fp = fpRef.current;
      if (!k || fp == null) return;
      const map = memoryRef.current;
      // 先删后写：Map 保持插入序，使淘汰近似 LRU。
      map.delete(k);
      map.set(k, { top: el.scrollTop, fp });
      for (const oldest of map.keys()) {
        if (map.size <= MAX_ENTRIES) break;
        map.delete(oldest);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
    // fingerprint 故意不在依赖里（见约束 4）。key 变即「换了文档」。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, key]);

  // 新内容落地后落位：此时 fpRef 已是新文档的真实指纹，才谈得上比对。
  // **可重复施加**（见约束 6）：pending 一直留到「真的滚过一次」或 key 变更/内容被
  // 改写为止，每次 ready 为真都再落一次同一个位置——重复落到同一处是幂等的。
  useEffect(() => {
    if (!ready || !key) return;
    const el = containerRef.current;
    if (!el) return;
    const entry = pendingRef.current;
    // 本次切换没有待落位的记录（这一篇没读过，或已被 fresh 作废）——**什么都不要做**。
    // 无记录时的「回顶」由上面 key 变化那次 effect（无记录分支）负责，这里不必重复；
    // 反过来在这里无条件回顶，正好会把刚恢复好的位置又顶回顶部。
    if (!entry) return;
    const fp = fpRef.current;
    if (fp != null && fp === entry.fp) {
      el.scrollTo({ top: entry.top });
    } else {
      // 内容已被改写过 → 旧位置作废、明确回顶（不能什么都不做，否则会留在上个文档
      // 残留的位置上）。作废只做一次，之后不再干预这一篇。
      pendingRef.current = null;
      el.scrollTo({ top: 0 });
    }
  }, [containerRef, key, ready]);

  const scrollToTop = useCallback(() => {
    containerRef.current?.scrollTo({ top: 0 });
  }, [containerRef]);

  return useMemo(() => ({ scrollToTop }), [scrollToTop]);
}
