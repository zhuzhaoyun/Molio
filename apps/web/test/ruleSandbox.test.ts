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
  MAX_SANDBOX_SOURCES,
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
  defaultVerdict: {
    tone: 'ok', title: '负载正常', detail: '低于警戒线。',
    sources: [{ path: 'notes/运维手册.md' }],
  },
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

  it('rejects a condition whose subject is a fixed marker (恒真条件)', () => {
    // 条件的左边必须是可拖参数。左边写 fixed id 会得到恒真条件，
    // 吞掉后面所有判定 —— 拖动毫无反应。
    const res = parseRuleSandbox(JSON.stringify({
      ...VALID,
      verdicts: [{ ...VALID.verdicts[0], when: { all: [{ param: 'threshold', op: '>', value: 0 }] } }],
    }));
    assert.equal(res.ok, false);
  });

  it('rejects duplicate fixed ids (重复 React key)', () => {
    assert.equal(parseRuleSandbox(JSON.stringify({
      ...VALID,
      fixed: [
        { id: 'threshold', label: '线一', value: 40 },
        { id: 'threshold', label: '线二', value: 80 },
      ],
    })).ok, false);
  });

  it('rejects a param range so wide that percentages overflow', () => {
    // (v - min) / (max - min) 在 1e308 量级会溢出成 Infinity → 渲染出 NaN%。
    assert.equal(parseRuleSandbox(JSON.stringify({
      ...VALID,
      params: [{ ...PARAM, min: -1e308, max: 1e308, value: 1e308 }],
    })).ok, false);
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

  it('rejects a defaultVerdict without sources (出处是硬门槛)', () => {
    assert.equal(parseRuleSandbox(JSON.stringify({
      ...VALID, defaultVerdict: { tone: 'ok', title: '正常', detail: 'x' },
    })).ok, false);
    assert.equal(parseRuleSandbox(JSON.stringify({
      ...VALID, defaultVerdict: { ...VALID.defaultVerdict, sources: [] },
    })).ok, false);
  });

  it('rejects more sources than the per-verdict limit', () => {
    const many = Array.from({ length: MAX_SANDBOX_SOURCES + 1 }, (_, i) => ({ path: `p${i}.md` }));
    assert.equal(parseRuleSandbox(JSON.stringify({
      ...VALID, verdicts: [{ ...VALID.verdicts[0], sources: many }],
    })).ok, false);
    // 上限之内仍然接受。
    const ok = Array.from({ length: MAX_SANDBOX_SOURCES }, (_, i) => ({ path: `p${i}.md` }));
    const res = expectOk(JSON.stringify({
      ...VALID, verdicts: [{ ...VALID.verdicts[0], sources: ok }],
    }));
    assert.equal(res.sandbox.verdicts[0].sources.length, MAX_SANDBOX_SOURCES);
  });

  it('rejects oversized raw before parsing', () => {
    assert.equal(parseRuleSandbox('x'.repeat(MAX_SANDBOX_RAW_CHARS + 1)).ok, false);
  });
});

const { evaluateRuleSandbox, clampSandboxValue, stripSandboxesForStreaming, stripInteractiveFences } = await import('../src/utils/ruleSandbox.ts');

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

describe('evaluateRuleSandbox — verdict specificity', () => {
  // 回归：模型最自然的写法是阈值升序（60 档 → 80 档）。若按数组顺序取首个
  // 命中，低档恒真会把高档判定吞掉——用户拖过危险线仍看到低档结论。
  const ascending = {
    ...VALID,
    verdicts: [
      { when: { all: [{ param: 'load', op: '>', value: 'warnLine' }] }, tone: 'warn',
        title: '负载偏高', detail: 'x', sources: [{ path: 'notes/ops.md' }] },
      { when: { all: [{ param: 'load', op: '>', value: 'critLine' }] }, tone: 'error',
        title: '负载过高', detail: 'x', sources: [{ path: 'notes/ops.md' }] },
    ],
    fixed: [
      { id: 'warnLine', label: '警告线', value: 60 },
      { id: 'critLine', label: '危险线', value: 80 },
    ],
  };

  it('prefers the more specific verdict regardless of declaration order', () => {
    const parsed = parseRuleSandbox(JSON.stringify(ascending));
    if (!parsed.ok) throw new Error(parsed.error);
    // 三档：低于警告线 → 默认；警告线以上 → 偏高；危险线以上 → 过高。
    assert.equal(evaluateRuleSandbox(parsed.sandbox, { load: 30 }).title, '负载正常');
    assert.equal(evaluateRuleSandbox(parsed.sandbox, { load: 65 }).title, '负载偏高');
    assert.equal(evaluateRuleSandbox(parsed.sandbox, { load: 85 }).title, '负载过高');
    assert.equal(evaluateRuleSandbox(parsed.sandbox, { load: 95 }).title, '负载过高');
  });

  it('keeps the narrow verdict even when the wide one is declared first', () => {
    const parsed = parseRuleSandbox(JSON.stringify({
      ...ascending,
      verdicts: [...ascending.verdicts].reverse(),
    }));
    if (!parsed.ok) throw new Error(parsed.error);
    assert.equal(evaluateRuleSandbox(parsed.sandbox, { load: 85 }).title, '负载过高');
    assert.equal(evaluateRuleSandbox(parsed.sandbox, { load: 65 }).title, '负载偏高');
  });
});

describe('stripSandboxesForStreaming', () => {
  it('leaves plain text untouched', () => {
    assert.deepEqual(stripSandboxesForStreaming('hello'), { text: 'hello', generating: false });
  });

  it('reports generating for an unclosed fence and hides the JSON tail', () => {
    assert.deepEqual(stripSandboxesForStreaming('前言\n```rule-sandbox\n{"version":1,'), {
      text: '前言', generating: true,
    });
  });

  it('removes a complete sandbox block from process text', () => {
    assert.deepEqual(stripSandboxesForStreaming('前言\n```rule-sandbox\n{}\n```\n后记'), {
      text: '前言\n\n后记', generating: false,
    });
  });

  it('handles a fence at the very start', () => {
    assert.deepEqual(stripSandboxesForStreaming('```rule-sandbox\n{}'), { text: '', generating: true });
  });
});

describe('stripInteractiveFences', () => {
  it('strips both fence types in one pass without cross-eating', () => {
    const text = [
      '前.quiz',
      '```quiz',
      '{}',
      '```',
      '中.sandbox',
      '```rule-sandbox',
      '{"detail":"提到 ```quiz 围栏"}',
      '```',
      '后',
    ].join('\n');
    const res = stripInteractiveFences(text);
    // 两个围栏都被剥掉；sandbox JSON 里的 ```quiz 字符串不再让 quiz 剥离越权。
    assert.equal(res.quizGenerating, false);
    assert.equal(res.sandboxGenerating, false);
    assert.ok(!res.text.includes('```quiz\n{'));
    assert.ok(!res.text.includes('rule-sandbox'));
    assert.ok(res.text.includes('前.quiz'));
    assert.ok(res.text.includes('中.sandbox'));
    assert.ok(res.text.includes('后'));
  });

  it('reports generating per type for unclosed fences', () => {
    const res = stripInteractiveFences('前\n```rule-sandbox\n{"x":');
    assert.deepEqual(res, { text: '前', quizGenerating: false, sandboxGenerating: true });
    const res2 = stripInteractiveFences('前\n```quiz\n{');
    assert.deepEqual(res2, { text: '前', quizGenerating: true, sandboxGenerating: false });
  });
});
