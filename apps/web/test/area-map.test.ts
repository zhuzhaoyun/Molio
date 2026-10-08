/**
 * area-map.json 的结构契约。
 *
 * 这个文件是 PR 门禁的**真值源**（`e2e/scripts/select-specs.mjs` 只认它，spec 头部的
 * `@area/@priority` 注释是文档不是数据），而它的两种坏法都不会自我暴露：
 *
 * 1. **不是合法 JSON** → 整条 PR 门禁崩在 `JSON.parse`，错误信息只有 `position N`，
 *    不指病根。2026-10-08 实测：#293 合并后 #319 点「Update branch」，两边都在
 *    `areas.navigation.specs` 末尾各追加一个元素，git 文本合并**没报冲突**却产出
 *    缺逗号的 JSON，`pr-check / e2e-affected` 与 `impact-analysis` 双双 SyntaxError。
 * 2. **area 里写了名字但 `specs` 表里没有条目** → `select-specs.mjs:116` 的
 *    `if (spec && …)` 把 `undefined` 当 falsy **静默跳过**，那个 spec 永远不进 PR
 *    门禁，且没有任何提示。
 *
 * 所以这里断言的是「这文件还能不能正常干活」，不是审美。反向（每个 .spec.ts 都被注册）
 * **不检查**：nightly-only 的 spec 本就不该进 PR 门禁。
 *
 * 失败时的修法都写在断言消息里——CI 上看到这条就知道该改什么。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../e2e');
const AREA_MAP_PATH = resolve(E2E_DIR, 'area-map.json');

interface SpecEntry {
  priority: string;
  file: string;
}
interface AreaEntry {
  paths: string[];
  specs: string[];
}
interface AreaMap {
  areas: Record<string, AreaEntry>;
  specs: Record<string, SpecEntry>;
}

function readRaw(): string {
  return readFileSync(AREA_MAP_PATH, 'utf8');
}

function readAreaMap(): AreaMap {
  return JSON.parse(readRaw()) as AreaMap;
}

describe('area-map.json 结构契约', () => {
  it('是合法 JSON（合并产物缺一个逗号就会让整条 PR 门禁崩）', () => {
    const raw = readRaw();
    try {
      JSON.parse(raw);
    } catch (err) {
      // 定位到出错行，并把原始报错（含 position）一起带出来
      const message = (err as Error).message;
      const at = /position (\d+)/.exec(message)?.[1];
      const line = at ? raw.slice(0, Number(at)).split('\n').length : undefined;
      const context =
        line === undefined
          ? ''
          : '\n出错处附近：\n' +
            raw
              .split('\n')
              .slice(Math.max(0, line - 4), line + 2)
              .map((l, i) => `${Math.max(1, line - 3) + i}| ${l}`)
              .join('\n');
      assert.fail(
        `area-map.json 不是合法 JSON：${message}${context}\n\n` +
          '常见原因：两个分支在同一个数组（如 areas.*.specs）末尾各追加了一行，' +
          'git 文本合并没报冲突却把逗号吃掉了。\n' +
          '修法：**别手工补标点**——以 origin/main 的这份文件为基底重新生成' +
          '（git reset --hard origin/main 后重新追加自己的条目）。',
      );
    }
  });

  it('areas.*.specs 里的每个名字都在 specs 表注册（否则被静默跳过、永不进 PR 门禁）', () => {
    const map = readAreaMap();
    const unregistered: string[] = [];
    for (const [areaName, area] of Object.entries(map.areas)) {
      for (const name of area.specs) {
        if (!Object.hasOwn(map.specs, name)) unregistered.push(`${name}（areas.${areaName}）`);
      }
    }
    assert.deepStrictEqual(
      unregistered,
      [],
      '这些名字写在 area 的 specs 里，但 specs 表里没有条目——select-specs.mjs:116 是 ' +
        '`if (spec && …)`，undefined 直接 falsy，于是它们永远不会被 PR 选中：\n  ' +
        unregistered.join('\n  ') +
        '\n修法：在 specs 表里补条目，例如\n' +
        '  "chat-continue": { "priority": "P1", "file": "chat-continue.spec.ts" }\n' +
        '（P1 = 该 area 源码改动时跑；P0 = 每次 PR 必跑；P2 = 仅 nightly）',
    );
  });

  it('specs.<name>.file 指向真实存在的 spec 文件', () => {
    const map = readAreaMap();
    const missing = Object.entries(map.specs)
      .filter(([, entry]) => !existsSync(resolve(E2E_DIR, entry.file)))
      .map(([name, entry]) => `${name} → ${entry.file}`);
    assert.deepStrictEqual(
      missing,
      [],
      `specs 表里有这些条目，但 apps/web/e2e/ 下找不到对应文件（改名/删除后忘了同步）：\n  ${missing.join('\n  ')}`,
    );
  });

  it('priority 只用 P0 / P1 / P2', () => {
    const map = readAreaMap();
    const bad = Object.entries(map.specs)
      .filter(([, entry]) => !['P0', 'P1', 'P2'].includes(entry.priority))
      .map(([name, entry]) => `${name} → ${entry.priority}`);
    assert.deepStrictEqual(
      bad,
      [],
      `select-specs.mjs 只认 P0/P1/P2（其它值一律不被选中，等于没注册）：\n  ${bad.join('\n  ')}`,
    );
  });

  it('同一个 spec 文件不被两个条目指向（选片会去重，但说明有名字写错了）', () => {
    const map = readAreaMap();
    const seen = new Map<string, string>();
    const dup: string[] = [];
    for (const [name, entry] of Object.entries(map.specs)) {
      const prev = seen.get(entry.file);
      if (prev) dup.push(`${entry.file}：${prev} 与 ${name}`);
      else seen.set(entry.file, name);
    }
    assert.deepStrictEqual(dup, [], `多个条目指向同一个文件：\n  ${dup.join('\n  ')}`);
  });
});
