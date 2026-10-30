// apps/web/src/utils/inlineSources.ts
// 消息内联「引用」条的数据层：把一条 assistant 消息的工具事件整理成
// 「可查证层（库内文档 + 外部链接）」+「其余层（媒体 · 数据 · 过程痕迹 · 库外）」。
//
// 与会话级 dock（sessionSources.ts）同源同口径，但粒度不同：
// - dock 按**整会话**聚合、给引用次数；这里按**单条消息**、给一次性的导航 chip。
// - 两边共用 toolRefs 的真值源：writeKey（归一化）、classifyWritePath（库内/库外/骨架）、
//   disambiguateLabels（同名消歧）。
import type { ToolEvent } from '../hooks/useChatCore.ts';
import { extractSources, writeKey, classifyWritePath, isMetaBasename } from './toolRefs.ts';
import { disambiguateLabels } from './workSteps.ts';

/** 次要组的构成类别 —— 折叠时据此给出「这堆是什么」的一句话说明。 */
export type InlineBucket = 'media' | 'meta' | 'outside' | 'pattern';

export interface InlineSourceItem {
  kind: 'file' | 'url';
  /** 去重 key：文件 = 归一化后的路径（库内为 vault 相对路径），URL = 完整 URL */
  key: string;
  /** 展示名（同名文件带父目录消歧） */
  label: string;
  /** 完整路径 / URL —— chip 的 title 与跳转目标 */
  path: string;
  /** 能否点击打开：库外路径 / 检索目录 / glob 模式都点不开 */
  navigable: boolean;
  /** 次要组的构成类别；可查证层为 undefined */
  bucket?: InlineBucket;
}

export interface InlineSources {
  /** 可查证层：库内文档（markdown 家族）+ 外部链接 —— 用户真正想查证的东西 */
  primary: InlineSourceItem[];
  /** 其余层：媒体与数据文件、骨架文件、库外路径、检索模式 */
  minor: InlineSourceItem[];
  /** 全部来源，按首次出现顺序（平铺形态用它，保证 chip 顺序稳定） */
  ordered: InlineSourceItem[];
  /** 去重后的总数 */
  total: number;
}

/**
 * glob 模式字符：出现在路径里说明这是搜索模式而非文件
 * （残渣过滤在 toolRefs.extractSources 里做 —— 那里是「记账口径不变、展示层过滤」的分界）
 */
const GLOB_META_RE = /[*?[\]{}]/;

/** Grep 的 path 若是目录就没有扩展名 —— 那是「检索动作」不是「读了这个文件」 */
const HAS_EXT_RE = /\.[A-Za-z0-9]+$/;

/** 文档家族：与 toolRefs.MARKDOWN_RE 同口径 */
const DOC_RE = /\.(mdown|markdown|md)$/i;

function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() ?? p;
}

/**
 * 把一条消息的工具事件整理成内联引用条的两层。
 *
 * @param tools 该消息的工具事件
 * @param opts.vaultPath 活跃库路径 —— 有它才能判「库内/库外」并把绝对路径归一成
 *   vault 相对路径（去重 key 与跳转目标都靠它）。没有它时不做库外判定
 *   （无法证伪的按「可能在库内」处理，与旧行为一致）。
 */
export function groupInlineSources(
  tools: ToolEvent[],
  opts: { vaultPath?: string | null } = {},
): InlineSources {
  const vaultPath = opts.vaultPath ?? null;
  const refs = extractSources(tools);
  // 同一文件可能被多次提到（不同写法：'a.md' / './a.md' / 绝对路径）。
  // 先按归一化 key 合并，再统一定层 —— 否则「先来的是 pattern、后来的是可打开文档」
  // 时，层级会被第一次出现钉死。
  const merged = new Map<string, { key: string; kind: 'file' | 'url'; navigable: boolean; doc: boolean; meta: boolean; pattern: boolean; searchDir: boolean; inside: boolean }>();

  for (const ref of refs) {
    if (ref.kind === 'url') {
      if (!merged.has(ref.target)) {
        merged.set(ref.target, {
          key: ref.target,
          kind: 'url',
          navigable: true,
          doc: false,
          meta: false,
          pattern: false,
          searchDir: false,
          inside: true,
        });
      }
      continue;
    }

    const key = writeKey(ref.target, vaultPath ?? undefined);
    const layer = classifyWritePath(key);
    // 不知道库在哪时无法证伪「库外」，按在库内处理（与旧行为一致）
    const inside = vaultPath ? layer !== 'hidden' : true;
    const pattern = GLOB_META_RE.test(ref.target);
    const searchDir = ref.toolName === 'Grep' && !HAS_EXT_RE.test(ref.target);
    const navigable = ref.navigable && !pattern && !searchDir && inside;

    const existing = merged.get(key);
    if (existing) {
      // 合并：可导航性与「像个文档」都取「任一次出现满足」
      existing.navigable = existing.navigable || navigable;
      existing.doc = existing.doc || DOC_RE.test(key);
      existing.pattern = existing.pattern && pattern;
      existing.searchDir = existing.searchDir && searchDir;
      existing.inside = existing.inside && inside;
      continue;
    }
    merged.set(key, {
      key,
      kind: 'file',
      navigable,
      doc: DOC_RE.test(key),
      meta: isMetaBasename(key),
      pattern,
      searchDir,
      inside,
    });
  }

  const items: InlineSourceItem[] = [];
  for (const [key, m] of merged) {
    if (m.kind === 'url') {
      // 外部链接：永远可点（外部打开不依赖 vault），且永远算「可查证」
      items.push({
        kind: 'url',
        key,
        label: key.replace(/^https?:\/\//, '').split('/')[0]!,
        path: key,
        navigable: true,
      });
      continue;
    }
    // 可查证层 = 可打开的库内文档；骨架文件（INDEX/log/hot）每次 wiki 操作都读，不算依据
    const isPrimary = m.doc && !m.meta && m.inside && m.navigable;
    let bucket: InlineBucket | undefined;
    if (!isPrimary) {
      bucket = m.pattern || m.searchDir ? 'pattern'
        : !m.inside ? 'outside'
        : m.meta ? 'meta'
        : 'media';
    }
    items.push({
      kind: 'file',
      key,
      label: basename(key),
      path: key,
      navigable: m.navigable,
      bucket,
    });
  }

  // 同名文件消歧：a/x.md 与 b/x.md → 显示 a/x.md、b/x.md（否则看着像重复 chip）
  const files = [...items.values()].filter((i) => i.kind === 'file');
  const proxies = files.map((f) => ({ path: f.key, label: f.label }));
  disambiguateLabels(proxies);
  files.forEach((f, i) => {
    f.label = proxies[i]!.label;
  });

  const all = [...items.values()];
  return {
    primary: all.filter((i) => i.bucket === undefined),
    minor: all.filter((i) => i.bucket !== undefined),
    ordered: all,
    total: all.length,
  };
}
