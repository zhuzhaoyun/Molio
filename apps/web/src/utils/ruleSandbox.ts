/**
 * rule-sandbox 协议：声明式交互块的解析与判定。
 *
 * 设计约束（见 docs/2026-10-19-interactive-content-research.md §3.2）：
 * - 不执行任意代码。所有输入是 JSON，组件用 React 渲染。
 * - 判定条件只允许白名单比较运算，不接受表达式语言。
 * - 单条判定坏 → 只废该条；整块坏 → 整块降级。
 */

export const SANDBOX_PROTOCOL_VERSION = 1;

/** 原始 JSON 长度上限 —— 与 quiz 协议同量级，防止超大块拖垮渲染。 */
export const MAX_SANDBOX_RAW_CHARS = 512_000;
/** 判定条数上限。 */
export const MAX_SANDBOX_VERDICTS = 20;
/** param / fixed 的 id 与条件里引用的 id 长度上限。 */
export const MAX_SANDBOX_ID_CHARS = 64;
/** 标题长度上限。 */
export const MAX_SANDBOX_TITLE_CHARS = 120;
/** 单条判定里的条件条数上限。 */
export const MAX_SANDBOX_CONDITIONS = 12;
/** fixed 刻度数量上限。 */
export const MAX_SANDBOX_FIXED = 4;

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
  sources?: SandboxSource[];
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
  const out: SandboxSource[] = [];
  for (const item of value) {
    if (!isRecord(item) || !nonEmptyString(item.path)) return null;
    const source: SandboxSource = { path: item.path.trim() };
    if (nonEmptyString(item.quote)) source.quote = item.quote;
    out.push(source);
  }
  return out;
}

function parseParam(value: unknown): SandboxParam | null {
  if (!isRecord(value)) return null;
  if (!validId(value.id)) return null;
  if (!nonEmptyString(value.label)) return null;
  if (!isFiniteNumber(value.min) || !isFiniteNumber(value.max) || !isFiniteNumber(value.value)) return null;
  if (value.min >= value.max) return null;
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
  if (!nonEmptyString(value.label)) return null;
  if (!isFiniteNumber(value.value)) return null;
  if (value.value < param.min || value.value > param.max) return null; // 画在同一轨道上，越界无法绘制
  return { id: value.id.trim(), label: value.label.trim(), value: value.value };
}

/**
 * 解析一条判定。返回 null 表示该条不合格（调用方负责丢弃并记录原因）。
 * `knownIds` 是 param + fixed 的 id 集合。
 */
function parseVerdict(
  value: unknown,
  knownIds: Set<string>,
): { verdict: SandboxVerdict } | { reason: string } {
  if (!isRecord(value)) return { reason: 'verdict is not an object' };

  const tone = value.tone;
  if (typeof tone !== 'string' || !SANDBOX_TONES.includes(tone as SandboxTone)) {
    return { reason: 'tone is not supported' };
  }
  if (!nonEmptyString(value.title)) return { reason: 'title is missing' };
  if (!nonEmptyString(value.detail)) return { reason: 'detail is missing' };

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
    const paramId = raw.param.trim();
    if (!knownIds.has(paramId)) return { reason: `condition references unknown id: ${paramId}` };
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
    conditions.push({ param: paramId, op: raw.op as SandboxOp, value: condValue });
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
  if (!nonEmptyString(value.title)) return null;
  if (!nonEmptyString(value.detail)) return null;
  const out: SandboxDefaultVerdict = {
    tone: tone as SandboxTone,
    title: value.title.trim(),
    detail: value.detail.trim(),
  };
  if (value.sources !== undefined) {
    const sources = parseSources(value.sources);
    if (!sources) return null;
    out.sources = sources;
  }
  return out;
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
    for (const rawFixed of data.fixed) {
      const parsed = parseFixed(rawFixed, param);
      if (!parsed) return { ok: false, error: 'sandbox fixed entry is invalid' };
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
    const parsed = parseVerdict(rawVerdict, knownIds);
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
