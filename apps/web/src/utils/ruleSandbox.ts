/**
 * rule-sandbox 协议：声明式交互块的解析与判定。
 *
 * 设计约束（见 docs/2026-10-19-interactive-content-research.md §3.2）：
 * - 不执行任意代码。所有输入是 JSON，组件用 React 渲染。
 * - 判定条件只允许白名单比较运算，不接受表达式语言。
 * - 单条判定坏 → 只废该条；整块坏 → 整块降级。
 */

export const SANDBOX_PROTOCOL_VERSION = 1;

import {
  intersect, isSubsetOf, measure, union,
  type Interval, type IntervalSet,
} from './intervals.ts';

/** 原始 JSON 长度上限 —— 与 quiz 协议同量级，防止超大块拖垮渲染。 */
export const MAX_SANDBOX_RAW_CHARS = 512_000;
/** 判定条数上限。 */
export const MAX_SANDBOX_VERDICTS = 20;
/** param / fixed 的 id 与条件里引用的 id 长度上限。 */
export const MAX_SANDBOX_ID_CHARS = 64;
/** 标题长度上限。 */
export const MAX_SANDBOX_TITLE_CHARS = 120;
/** 详情（detail）长度上限 —— 防止一个巨型文本节点。 */
export const MAX_SANDBOX_DETAIL_CHARS = 2_000;
/** 标签（label）长度上限。 */
export const MAX_SANDBOX_LABEL_CHARS = 120;
/** 出处 path 长度上限。 */
export const MAX_SANDBOX_PATH_CHARS = 500;
/** 出处 quote 长度上限。 */
export const MAX_SANDBOX_QUOTE_CHARS = 1_000;
/** 单条判定里的条件条数上限。 */
export const MAX_SANDBOX_CONDITIONS = 12;
/** fixed 刻度数量上限。 */
export const MAX_SANDBOX_FIXED = 4;
/** 单条判定的出处条数上限 —— 与 quiz 的每题出处数量级一致。 */
export const MAX_SANDBOX_SOURCES = 8;
/**
 * 参数区间宽度上限。
 *
 * 百分比定位是 (v - min) / (max - min)。区间宽到 1e308 量级时这个除法会
 * 溢出成 Infinity，渲染出 `left: NaN%` —— 滑块直接跑到错误位置。
 */
export const MAX_SANDBOX_RANGE = 1e12;

export type SandboxTone = 'ok' | 'warn' | 'error' | 'neutral';
export type SandboxOp = '>' | '>=' | '<' | '<=' | '==' | '!=';

const SANDBOX_OPS: readonly SandboxOp[] = ['>', '>=', '<', '<=', '==', '!='];
const SANDBOX_TONES: readonly SandboxTone[] = ['ok', 'warn', 'error', 'neutral'];

export interface SandboxParam {
  id: string;
  label: string;
  min: number;
  max: number;
  value: number;
  unit?: string;
  step?: number;
}

export interface SandboxFixed {
  id: string;
  label: string;
  value: number;
}

export interface SandboxCondition {
  param: string;
  op: SandboxOp;
  value: number | string;
}

export interface SandboxSource {
  path: string;
  quote?: string;
}

export interface SandboxVerdict {
  when: { all?: SandboxCondition[]; any?: SandboxCondition[] };
  tone: SandboxTone;
  title: string;
  detail: string;
  sources: SandboxSource[];
}

export interface SandboxDefaultVerdict {
  tone: SandboxTone;
  title: string;
  detail: string;
  sources: SandboxSource[];
}

export interface RuleSandbox {
  version: 1;
  kind: 'rule-sandbox';
  title: string;
  template: 'threshold-axis';
  params: SandboxParam[];
  fixed: SandboxFixed[];
  verdicts: SandboxVerdict[];
  defaultVerdict: SandboxDefaultVerdict;
}

export interface InvalidSandboxVerdict {
  index: number;
  reason: string;
}

export type ParseRuleSandboxResult =
  | { ok: true; sandbox: RuleSandbox; invalidVerdicts: InvalidSandboxVerdict[] }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 合法 id：非空、trim 后 ≤ MAX_SANDBOX_ID_CHARS。 */
function validId(value: unknown): value is string {
  return nonEmptyString(value) && value.trim().length <= MAX_SANDBOX_ID_CHARS;
}

function parseSources(value: unknown): SandboxSource[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.length > MAX_SANDBOX_SOURCES) return null;
  const out: SandboxSource[] = [];
  for (const item of value) {
    if (!isRecord(item) || !nonEmptyString(item.path)) return null;
    if (item.path.trim().length > MAX_SANDBOX_PATH_CHARS) return null;
    const source: SandboxSource = { path: item.path.trim() };
    if (nonEmptyString(item.quote)) {
      if (item.quote.trim().length > MAX_SANDBOX_QUOTE_CHARS) return null;
      source.quote = item.quote.trim();
    }
    out.push(source);
  }
  return out;
}

function parseParam(value: unknown): SandboxParam | null {
  if (!isRecord(value)) return null;
  if (!validId(value.id)) return null;
  if (!nonEmptyString(value.label) || value.label.trim().length > MAX_SANDBOX_LABEL_CHARS) return null;
  if (!isFiniteNumber(value.min) || !isFiniteNumber(value.max) || !isFiniteNumber(value.value)) return null;
  if (value.min >= value.max) return null;
  if (value.max - value.min > MAX_SANDBOX_RANGE) return null; // 百分比定位会溢出
  if (value.value < value.min || value.value > value.max) return null;
  const param: SandboxParam = {
    id: value.id.trim(),
    label: value.label.trim(),
    min: value.min,
    max: value.max,
    value: value.value,
  };
  if (nonEmptyString(value.unit)) param.unit = value.unit;
  if (value.step !== undefined) {
    if (!isFiniteNumber(value.step) || value.step <= 0) return null;
    param.step = value.step;
  }
  return param;
}

function parseFixed(value: unknown, param: SandboxParam): SandboxFixed | null {
  if (!isRecord(value)) return null;
  if (!validId(value.id)) return null;
  if (value.id.trim() === param.id) return null; // 与 param 同名 → 无法区分引用
  if (!nonEmptyString(value.label) || value.label.trim().length > MAX_SANDBOX_LABEL_CHARS) return null;
  if (!isFiniteNumber(value.value)) return null;
  if (value.value < param.min || value.value > param.max) return null; // 画在同一轨道上，越界无法绘制
  return { id: value.id.trim(), label: value.label.trim(), value: value.value };
}

/**
 * 解析一条判定。返回 null 表示该条不合格（调用方负责丢弃并记录原因）。
 * `paramId` 是可拖参数的 id（条件的左边只能是它）；`knownIds` 是
 * param + fixed 的 id 集合（条件的右边可以引用其中任意一个）。
 */
function parseVerdict(
  value: unknown,
  paramId: string,
  knownIds: Set<string>,
): { verdict: SandboxVerdict } | { reason: string } {
  if (!isRecord(value)) return { reason: 'verdict is not an object' };

  const tone = value.tone;
  if (typeof tone !== 'string' || !SANDBOX_TONES.includes(tone as SandboxTone)) {
    return { reason: 'tone is not supported' };
  }
  if (!nonEmptyString(value.title) || value.title.trim().length > MAX_SANDBOX_TITLE_CHARS) {
    return { reason: 'title is missing or too long' };
  }
  if (!nonEmptyString(value.detail) || value.detail.trim().length > MAX_SANDBOX_DETAIL_CHARS) {
    return { reason: 'detail is missing or too long' };
  }

  const sources = parseSources(value.sources);
  if (!sources) return { reason: 'sources are missing' };

  const when = value.when;
  if (!isRecord(when)) return { reason: 'when is missing' };
  const hasAll = Array.isArray(when.all);
  const hasAny = Array.isArray(when.any);
  if (hasAll === hasAny) return { reason: 'when must have exactly one of all/any' };
  const rawConditions = (hasAll ? when.all : when.any) as unknown[];
  if (rawConditions.length === 0 || rawConditions.length > MAX_SANDBOX_CONDITIONS) {
    return { reason: 'condition count is out of range' };
  }

  const conditions: SandboxCondition[] = [];
  for (const raw of rawConditions) {
    if (!isRecord(raw)) return { reason: 'condition is not an object' };
    if (!validId(raw.param)) return { reason: 'condition param id is invalid' };
    const subject = raw.param.trim();
    // 条件的左边必须是被拖动的参数。若左边写固定刻度（fixed），条件会恒真，
    // 吞掉后面所有判定 —— 拖动时界面毫无反应。
    if (subject !== paramId) {
      return { reason: 'condition must compare the draggable parameter' };
    }
    if (typeof raw.op !== 'string' || !SANDBOX_OPS.includes(raw.op as SandboxOp)) {
      return { reason: 'condition op is not supported' };
    }
    // value：有限数字，或引用一个已知 id。字符串数字（如 "55"）既不是数字
    // 也不是已知 id → 不合法（模型很容易犯这个错，必须挡住）。
    let condValue: number | string;
    if (isFiniteNumber(raw.value)) {
      condValue = raw.value;
    } else if (validId(raw.value)) {
      const ref = raw.value.trim();
      if (!knownIds.has(ref)) return { reason: `condition value references unknown id: ${ref}` };
      condValue = ref;
    } else {
      return { reason: 'condition value is neither a number nor a known id' };
    }
    conditions.push({ param: subject, op: raw.op as SandboxOp, value: condValue });
  }

  const verdict: SandboxVerdict = {
    when: hasAll ? { all: conditions } : { any: conditions },
    tone: tone as SandboxTone,
    title: value.title.trim(),
    detail: value.detail.trim(),
    sources,
  };
  return { verdict };
}

function parseDefaultVerdict(value: unknown): SandboxDefaultVerdict | null {
  if (!isRecord(value)) return null;
  const tone = value.tone;
  if (typeof tone !== 'string' || !SANDBOX_TONES.includes(tone as SandboxTone)) return null;
  if (!nonEmptyString(value.title) || value.title.trim().length > MAX_SANDBOX_TITLE_CHARS) return null;
  if (!nonEmptyString(value.detail) || value.detail.trim().length > MAX_SANDBOX_DETAIL_CHARS) return null;
  // 出处是硬门槛：defaultVerdict 也是一种判定，缺出处就整块不合格。
  const sources = parseSources(value.sources);
  if (!sources) return null;
  return {
    tone: tone as SandboxTone,
    title: value.title.trim(),
    detail: value.detail.trim(),
    sources,
  };
}

/**
 * 解析一段 rule-sandbox JSON。
 *
 * 整块不合格 → `{ ok: false }`（调用方降级为代码块）。
 * 单条判定不合格 → 丢弃该条并记入 `invalidVerdicts`；全部不合格 → 整块拒绝。
 */
export function parseRuleSandbox(raw: string): ParseRuleSandboxResult {
  if (typeof raw !== 'string' || raw.length > MAX_SANDBOX_RAW_CHARS) {
    return { ok: false, error: 'sandbox payload is too large' };
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'sandbox payload is not valid JSON' };
  }
  if (!isRecord(data)) return { ok: false, error: 'sandbox payload must be an object' };

  if (data.version !== SANDBOX_PROTOCOL_VERSION) {
    return { ok: false, error: 'unsupported sandbox version' };
  }
  if (data.kind !== 'rule-sandbox') {
    return { ok: false, error: 'unsupported sandbox kind' };
  }
  if (data.template !== 'threshold-axis') {
    return { ok: false, error: 'unsupported sandbox template' };
  }
  if (!nonEmptyString(data.title) || data.title.trim().length > MAX_SANDBOX_TITLE_CHARS) {
    return { ok: false, error: 'sandbox title is invalid' };
  }

  // P1 单轴：params 恰好 1 个。
  if (!Array.isArray(data.params) || data.params.length !== 1) {
    return { ok: false, error: 'threshold-axis requires exactly one param' };
  }
  const param = parseParam(data.params[0]);
  if (!param) return { ok: false, error: 'sandbox param is invalid' };

  const fixed: SandboxFixed[] = [];
  if (data.fixed !== undefined) {
    if (!Array.isArray(data.fixed) || data.fixed.length > MAX_SANDBOX_FIXED) {
      return { ok: false, error: 'sandbox fixed list is invalid' };
    }
    const seenFixedIds = new Set<string>();
    for (const rawFixed of data.fixed) {
      const parsed = parseFixed(rawFixed, param);
      if (!parsed) return { ok: false, error: 'sandbox fixed entry is invalid' };
      // 重复 id → 渲染出重复 React key，条件引用也会指向不确定的那条。
      if (seenFixedIds.has(parsed.id)) {
        return { ok: false, error: 'sandbox fixed ids must be unique' };
      }
      seenFixedIds.add(parsed.id);
      fixed.push(parsed);
    }
  }

  const knownIds = new Set<string>([param.id, ...fixed.map((f) => f.id)]);

  if (!Array.isArray(data.verdicts) || data.verdicts.length === 0) {
    return { ok: false, error: 'sandbox has no verdicts' };
  }
  if (data.verdicts.length > MAX_SANDBOX_VERDICTS) {
    return { ok: false, error: 'sandbox has too many verdicts' };
  }

  const verdicts: SandboxVerdict[] = [];
  const invalidVerdicts: InvalidSandboxVerdict[] = [];
  for (const [index, rawVerdict] of data.verdicts.entries()) {
    const parsed = parseVerdict(rawVerdict, param.id, knownIds);
    if ('verdict' in parsed) {
      verdicts.push(parsed.verdict);
    } else {
      invalidVerdicts.push({ index, reason: parsed.reason });
    }
  }
  if (verdicts.length === 0) {
    return { ok: false, error: 'sandbox has no usable verdict' };
  }

  const defaultVerdict = parseDefaultVerdict(data.defaultVerdict);
  if (!defaultVerdict) return { ok: false, error: 'sandbox defaultVerdict is invalid' };

  const sandbox: RuleSandbox = {
    version: SANDBOX_PROTOCOL_VERSION,
    kind: 'rule-sandbox',
    title: data.title.trim(),
    template: 'threshold-axis',
    params: [param],
    fixed,
    verdicts,
    defaultVerdict,
  };
  return { ok: true, sandbox, invalidVerdicts };
}

/** 把拖动得到的值收窄到 [min, max]。NaN 落到 min（渲染不出 NaN 轨道）。 */
export function clampSandboxValue(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function compare(left: number, op: SandboxOp, right: number): boolean {
  switch (op) {
    case '>': return left > right;
    case '>=': return left >= right;
    case '<': return left < right;
    case '<=': return left <= right;
    case '==': return left === right;
    case '!=': return left !== right;
  }
}

/**
 * 求当前参数值下命中的判定。
 *
 * - `values` 是 param id → 当前值。
 * - 条件里的字符串 value 解析为另一个 param/fixed 的当前值；解析不到 → 该条件
 *   判为 false（不抛错、不中断）。
 * - **多条判定同时命中时，取区间最窄的那条**（最具体者胜），而不是数组里
 *   第一个命中的。模型最自然的写法是阈值升序（60 档 → 80 档），按数组顺序
 *   取首个命中会让低档恒真、把高档判定吞掉 —— 用户拖过危险线仍看到低档结论。
 *   区间只用于比较具体程度；命中本身仍由原始条件精确求值，边界不被近似吃掉。
 * - 全不命中 → `defaultVerdict`。
 */
export function evaluateRuleSandbox(
  sandbox: RuleSandbox,
  values: Record<string, number>,
): SandboxVerdict | SandboxDefaultVerdict {
  const resolve = (ref: string): number | undefined => {
    if (Object.prototype.hasOwnProperty.call(values, ref)) {
      const v = values[ref];
      return Number.isFinite(v) ? v : undefined;
    }
    const fixed = sandbox.fixed.find((f) => f.id === ref);
    return fixed ? fixed.value : undefined;
  };

  const conditionHolds = (condition: SandboxCondition): boolean => {
    const left = resolve(condition.param);
    if (left === undefined) return false;
    const right = typeof condition.value === 'number' ? condition.value : resolve(condition.value);
    if (right === undefined) return false;
    return compare(left, condition.op, right);
  };

  const matched: { verdict: SandboxVerdict; region: IntervalSet }[] = [];
  for (const verdict of sandbox.verdicts) {
    const conditions = verdict.when.all ?? verdict.when.any ?? [];
    if (conditions.length === 0) continue;
    const holds = verdict.when.all
      ? conditions.every(conditionHolds)
      : conditions.some(conditionHolds);
    if (!holds) continue;
    matched.push({ verdict, region: verdictRegion(verdict, resolve) });
  }

  if (matched.length === 1) return matched[0]!.verdict;
  if (matched.length > 1) {
    // 取最具体的一条：区间更窄的优先。无法比较（区间相同或互不包含）时
    // 退回到数组顺序 —— 至少是确定的。
    let best = matched[0]!;
    for (const candidate of matched.slice(1)) {
      if (isMoreSpecific(candidate.region, best.region)) best = candidate;
    }
    return best.verdict;
  }
  return sandbox.defaultVerdict;
}

/**
 * 判定条件在参数轴上覆盖的区间。
 *
 * 条件形如 `param OP 常量`，因此每条条件对应一个区间；`all` 取交集，`any`
 * 取并集。区间的端点按闭区间处理（严格不等号的差异只影响边界一点点，
 * 而命中判定本身由原始条件精确求值）。
 */
function verdictRegion(
  verdict: SandboxVerdict,
  resolve: (ref: string) => number | undefined,
): IntervalSet {
  const conditions = verdict.when.all ?? verdict.when.any ?? [];
  const isAll = verdict.when.all !== undefined;
  // `all` 是求交 → 从全集开始；`any` 是求并 → 从空集开始。
  let region: IntervalSet = isAll ? [{ lo: -Infinity, hi: Infinity }] : [];

  for (const condition of conditions) {
    const right = typeof condition.value === 'number' ? condition.value : resolve(condition.value);
    if (right === undefined) continue;
    const interval = conditionInterval(condition.op, right);
    if (!interval) continue;
    region = isAll ? intersect(region, [interval]) : union(region, [interval]);
  }
  return region;
}

/** 单个比较条件对应的区间。`==` / `!=` 无法用区间表达 → 返回 null。 */
function conditionInterval(op: SandboxOp, value: number): Interval | null {
  switch (op) {
    case '>': return { lo: value, hi: Infinity };
    case '>=': return { lo: value, hi: Infinity };
    case '<': return { lo: -Infinity, hi: value };
    case '<=': return { lo: -Infinity, hi: value };
    default: return null;
  }
}

/**
 * a 是否比 b 更具体。
 *
 * 判据：a 的区间是 b 的子集（更窄），或 a 的区间总长度更小。
 * 两者都无法判定时返回 false —— 调用方保留先遇到的那条。
 */
function isMoreSpecific(a: IntervalSet, b: IntervalSet): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (isSubsetOf(a, b)) return true;
  if (isSubsetOf(b, a)) return false;
  return measure(a) < measure(b);
}

/**
 * 从流式文本里剥掉 rule-sandbox 围栏。
 *
 * 与 `stripQuizForStreaming` 同构：围栏未闭合 → 剥掉围栏尾并报 `generating`
 * （调用方显示「正在生成…」占位）；围栏已闭合 → 整块移除。
 */
export function stripSandboxesForStreaming(text: string): { text: string; generating: boolean } {
  let output = '';
  let index = 0;
  let generating = false;

  while (index < text.length) {
    const start = text.indexOf('```rule-sandbox', index);
    if (start === -1) {
      output += text.slice(index);
      break;
    }
    output += text.slice(index, start);
    const bodyStart = start + '```rule-sandbox'.length;
    const close = text.indexOf('```', bodyStart);
    if (close === -1) {
      generating = true;
      break;
    }
    index = close + 3;
  }

  return { text: output.trim(), generating };
}

/**
 * 一次扫描同时剥离 quiz 与 rule-sandbox 两种围栏。
 *
 * WorkBlock 的过程叙事两种块都可能出现。若用两个单类型剥离器串联，第一道会
 * 把「另一种围栏 JSON 里出现的本类型字面量」误认成自己的开栏（例如 sandbox
 * 的 detail 里写了 ```quiz），把对方的收尾 ``` 吃掉 —— 卡片整个消失。
 * 这里统一找**最先出现**的开栏，剥到最近的收尾，循环处理，互不越权。
 */
export function stripInteractiveFences(
  text: string,
): { text: string; quizGenerating: boolean; sandboxGenerating: boolean } {
  const OPENERS = ['```quiz', '```rule-sandbox'] as const;
  let output = '';
  let index = 0;
  let quizGenerating = false;
  let sandboxGenerating = false;

  while (index < text.length) {
    let start = -1;
    let opener: (typeof OPENERS)[number] | null = null;
    for (const candidate of OPENERS) {
      const at = text.indexOf(candidate, index);
      if (at !== -1 && (start === -1 || at < start)) {
        start = at;
        opener = candidate;
      }
    }
    if (start === -1 || !opener) {
      output += text.slice(index);
      break;
    }
    output += text.slice(index, start);
    const bodyStart = start + opener.length;
    const close = text.indexOf('```', bodyStart);
    if (close === -1) {
      if (opener === '```quiz') quizGenerating = true;
      else sandboxGenerating = true;
      break;
    }
    index = close + 3;
  }

  return { text: output.trim(), quizGenerating, sandboxGenerating };
}

/** 完整的 sandbox-suggest 标记（单行，可出现在正文任意位置——按协议应在最末）。 */
const SANDBOX_SUGGEST_MARKER = /<!--\s*sandbox-suggest:\s*([^\n]*?)\s*-->/g;

/**
 * 从回答正文里提取「演示建议」标记。
 *
 * 常驻规则（vault CLAUDE.md）约定：回答的核心结论依赖某个明确边界、而用户
 * 没有要求演示时，模型在回答最末追加 `<!-- sandbox-suggest: 标题 -->`。
 * 标记是协议内容，永远不给用户看：
 * - 完整标记 → 从正文剥离，取最后一个作为 chip 标题；
 * - 流式中的半截标记（末尾 `<!--` 且到结尾无换行、无闭合）→ 整段隐藏，
 *   避免打字过程把原始协议糊出来；跨行未闭合的注释不是本协议的，不动。
 */
export function extractSandboxSuggest(
  text: string,
  streaming = false,
): { text: string; suggest: string | null } {
  let suggest: string | null = null;
  let output = text.replace(SANDBOX_SUGGEST_MARKER, (_m, title: string) => {
    const trimmed = title.trim();
    if (trimmed) suggest = trimmed;
    return '';
  });

  if (streaming) {
    const open = output.lastIndexOf('<!--');
    if (open !== -1) {
      const tail = output.slice(open);
      if (!tail.includes('-->') && !tail.includes('\n')) {
        output = output.slice(0, open);
        suggest = null;
      }
    }
  }

  return { text: output.replace(/[ \t]+$/gm, '').replace(/\n{3,}$/g, '\n\n').trimEnd(), suggest };
}
