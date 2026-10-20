/**
 * rule-sandbox 协议纯函数。
 *
 * 这一层是渲染与交互的入口：模型输出的是不可信文本，解析必须做到
 * 「整块坏 → 降级；单条判定坏 → 只废该条」，判定求值必须只用白名单比较，
 * 绝不执行任何表达式。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

const {
  parseRuleSandbox,
  SANDBOX_PROTOCOL_VERSION,
  MAX_SANDBOX_RAW_CHARS,
} = await import('../src/utils/ruleSandbox.ts');

const PARAM = { id: 'load', label: '服务器负载', min: 0, max: 100, value: 60, unit: '%' };
const VALID = {
  version: 1,
  kind: 'rule-sandbox',
  title: '负载预警',
  template: 'threshold-axis',
  params: [PARAM],
  fixed: [{ id: 'threshold', label: '警戒线', value: 80 }],
  verdicts: [{
    when: { all: [{ param: 'load', op: '>', value: 'threshold' }] },
    tone: 'error',
    title: '负载过高',
    detail: '超过警戒线，应扩容或限流。',
    sources: [{ path: 'notes/运维手册.md', quote: '负载持续高于 80% 需人工介入' }],
  }],
  defaultVerdict: { tone: 'ok', title: '负载正常', detail: '低于警戒线。' },
};

function expectOk(raw: string) {
  const res = parseRuleSandbox(raw);
  assert.equal(res.ok, true, `expect ok, got: ${res.ok ? '' : res.error}`);
  if (!res.ok) throw new Error(res.error);
  return res;
}

describe('parseRuleSandbox', () => {
  it('parses a valid sandbox and keeps verdict order', () => {
    const res = expectOk(JSON.stringify(VALID));
    assert.equal(res.sandbox.title, '负载预警');
    assert.equal(res.sandbox.verdicts.length, 1);
    assert.equal(res.invalidVerdicts.length, 0);
    assert.equal(SANDBOX_PROTOCOL_VERSION, 1);
  });

  it('rejects bad JSON / wrong version / wrong kind / wrong template', () => {
    assert.equal(parseRuleSandbox('{nope').ok, false);
    for (const patch of [{ version: 2 }, { kind: 'other' }, { template: 'free-canvas' }]) {
      assert.equal(parseRuleSandbox(JSON.stringify({ ...VALID, ...patch })).ok, false);
    }
  });

  it('rejects non-finite and inverted ranges, out-of-range param value', () => {
    assert.equal(parseRuleSandbox(JSON.stringify({ ...VALID, params: [{ ...PARAM, min: 100, max: 0 }] })).ok, false);
    assert.equal(parseRuleSandbox(JSON.stringify({ ...VALID, params: [{ ...PARAM, value: 150 }] })).ok, false);
    assert.equal(parseRuleSandbox(JSON.stringify({ ...VALID, params: [{ ...PARAM, min: NaN }] })).ok, false);
    assert.equal(parseRuleSandbox(JSON.stringify({ ...VALID, params: [{ ...PARAM, max: Infinity }] })).ok, false);
  });

  it('rejects fixed values outside the param range', () => {
    assert.equal(parseRuleSandbox(JSON.stringify({ ...VALID, fixed: [{ id: 't', label: '线', value: 120 }] })).ok, false);
    assert.equal(parseRuleSandbox(JSON.stringify({ ...VALID, fixed: [{ id: 't', label: '线', value: -5 }] })).ok, false);
  });

  it('rejects more than one param (P1 is a single-axis template)', () => {
    assert.equal(parseRuleSandbox(JSON.stringify({ ...VALID, params: [PARAM, { ...PARAM, id: 'other', min: -10 }] })).ok, false);
    assert.equal(parseRuleSandbox(JSON.stringify({ ...VALID, params: [] })).ok, false);
  });

  it('rejects oversized ids', () => {
    const res = expectOk(JSON.stringify({
      ...VALID,
      verdicts: [VALID.verdicts[0], { ...VALID.verdicts[0], when: { all: [{ param: 'x'.repeat(65), op: '>', value: 0 }] } }],
    }));
    assert.equal(res.sandbox.verdicts.length, 1);
    assert.equal(res.invalidVerdicts.length, 1);
  });

  it('drops verdicts referencing unknown ids, keeps the rest, rejects when none left', () => {
    const res = expectOk(JSON.stringify({
      ...VALID,
      verdicts: [
        { ...VALID.verdicts[0], when: { all: [{ param: 'ghost', op: '>', value: 0 }] } },
        VALID.verdicts[0],
      ],
    }));
    assert.equal(res.sandbox.verdicts.length, 1);
    assert.equal(res.invalidVerdicts[0].index, 0);
    assert.equal(parseRuleSandbox(JSON.stringify({
      ...VALID, verdicts: [{ ...VALID.verdicts[0], when: { all: [{ param: 'ghost', op: '>', value: 0 }] } }],
    })).ok, false);
  });

  it('rejects string-number condition values (strict typing)', () => {
    const res = parseRuleSandbox(JSON.stringify({
      ...VALID, verdicts: [{ ...VALID.verdicts[0], when: { all: [{ param: 'load', op: '>', value: '55' }] } }],
    }));
    assert.equal(res.ok, false);
  });

  it('rejects non-whitelisted ops, missing sources, empty when', () => {
    assert.equal(parseRuleSandbox(JSON.stringify({
      ...VALID, verdicts: [{ ...VALID.verdicts[0], when: { all: [{ param: 'load', op: '**', value: 2 }] } }],
    })).ok, false);
    assert.equal(parseRuleSandbox(JSON.stringify({
      ...VALID, verdicts: [{ ...VALID.verdicts[0], sources: [] }],
    })).ok, false);
    assert.equal(parseRuleSandbox(JSON.stringify({
      ...VALID, verdicts: [{ ...VALID.verdicts[0], when: {} }],
    })).ok, false);
  });

  it('rejects oversized raw before parsing', () => {
    assert.equal(parseRuleSandbox('x'.repeat(MAX_SANDBOX_RAW_CHARS + 1)).ok, false);
  });
});

const { evaluateRuleSandbox, clampSandboxValue } = await import('../src/utils/ruleSandbox.ts');

const TWO_VERDICTS = {
  ...VALID,
  verdicts: [
    { when: { all: [{ param: 'load', op: '>', value: 'threshold' }] }, tone: 'error',
      title: '负载过高', detail: '扩容。', sources: [{ path: 'notes/ops.md' }] },
    { when: { any: [{ param: 'load', op: '>=', value: 60 }, { param: 'load', op: '<=', value: 10 }] },
      tone: 'warn', title: '负载偏高', detail: '观察。', sources: [{ path: 'notes/ops.md' }] },
  ],
};

describe('evaluateRuleSandbox', () => {
  const parsed = parseRuleSandbox(JSON.stringify(TWO_VERDICTS));
  if (!parsed.ok) throw new Error(parsed.error);
  const sandbox = parsed.sandbox;

  it('matches verdicts in order (all-group by reference id)', () => {
    assert.equal(evaluateRuleSandbox(sandbox, { load: 85 }).title, '负载过高');
  });

  it('falls through to any-group and defaultVerdict', () => {
    assert.equal(evaluateRuleSandbox(sandbox, { load: 70 }).title, '负载偏高');
    assert.equal(evaluateRuleSandbox(sandbox, { load: 30 }).title, '负载正常');
  });

  it('treats unresolvable string refs as false, never throws', () => {
    // 解析期就会丢掉引用未知 id 的判定（见 parseRuleSandbox），所以这里直接
    // 构造对象来测 evaluate 的防御分支：解析不到的引用按 false 处理，不抛错。
    const broken = {
      ...sandbox,
      verdicts: [{
        when: { all: [{ param: 'load', op: '>', value: 'ghost' }] },
        tone: 'error' as const, title: '不该命中', detail: 'x', sources: [],
      }],
    };
    assert.equal(evaluateRuleSandbox(broken, { load: 85 }).title, '负载正常');
  });

  it('clamps dragged values into range (NaN → min)', () => {
    assert.equal(clampSandboxValue(120, 0, 100), 100);
    assert.equal(clampSandboxValue(-5, 0, 100), 0);
    assert.equal(clampSandboxValue(NaN, 0, 100), 0);
  });
});
