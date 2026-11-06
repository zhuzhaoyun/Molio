/**
 * fix-exe-metadata.mjs 的 rcedit 选项契约测试（错误驱动）。
 *
 * 背景（2026-09-19 真机发现）：rcedit v5 的 Node API 只认 kebab-case 键
 * （'version-string' / 'file-version' / 'product-version'），camelCase
 * （versionString / fileVersion / productVersion）会被**静默忽略**——
 * hook 日志照常打印 Done，但实际只设置了图标，版本字符串从未写入，
 * 所有发布构建的 exe 元数据都是 Electron 原样（FileVersion=Electron 版本号）。
 * 这正是「任务栏 Jump List 显示 Electron」在 rcedit 补丁后依然存在的另一半原因。
 *
 * 本测试读取 node_modules 里 rcedit 源码声明的可接受键集合，断言
 * fix-exe-metadata.mjs 传入的每个顶层键都在其中——真实的契约校验，
 * rcedit 将来改名也能第一时间炸出来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hookSource = readFileSync(join(desktopDir, 'scripts', 'fix-exe-metadata.mjs'), 'utf-8');

/** 从 rcedit 源码解析其认可的选项键（pairSettings + singleSettings）。 */
function rceditAcceptedKeys() {
  const require = createRequire(join(desktopDir, 'package.json'));
  // rcedit 的 exports 不暴露 ./package.json，直接 resolve 主入口（lib/index.js）
  const lib = readFileSync(require.resolve('rcedit'), 'utf-8');
  const keys = new Set();
  for (const m of lib.matchAll(/(?:pairSettings|singleSettings)\s*=\s*\[([^\]]+)\]/g)) {
    for (const k of m[1].matchAll(/'([^']+)'/g)) keys.add(k[1]);
  }
  assert.ok(keys.size > 0, '无法从 rcedit 源码解析选项键集合（rcedit 结构变了？）');
  return keys;
}

/** 取出 hook 中 rcedit(...) 调用的顶层选项键。 */
function hookOptionKeys() {
  const start = hookSource.indexOf('await rcedit(');
  assert.ok(start !== -1, 'hook 中未找到 rcedit 调用');
  const block = hookSource.slice(start, hookSource.indexOf(');', start));
  const keys = [];
  for (const line of block.split('\n')) {
    // 顶层键缩进 6 空格（对象字面量第一级），更深缩进是 version-string 的内层键
    const m = line.match(/^ {6}(?:'([^']+)'|([A-Za-z-]+))\s*:/);
    if (m) keys.push(m[1] ?? m[2]);
  }
  assert.ok(keys.length > 0, '无法从 hook 解析 rcedit 选项键');
  return keys;
}

test('hook 传入 rcedit 的每个选项键都在 rcedit 认可集合内', () => {
  const accepted = rceditAcceptedKeys();
  for (const key of hookOptionKeys()) {
    assert.ok(
      accepted.has(key),
      `fix-exe-metadata.mjs 的选项键 '${key}' 不在 rcedit 认可集合（${[...accepted].join(', ')}）— 会被静默忽略`,
    );
  }
});

test('版本字符串使用 kebab-case 键，不得出现会被静默忽略的 camelCase', () => {
  assert.ok(hookSource.includes("'version-string'"), '缺少 \'version-string\'');
  assert.ok(hookSource.includes("'file-version'"), '缺少 \'file-version\'');
  assert.ok(hookSource.includes("'product-version'"), '缺少 \'product-version\'');
  for (const bad of ['versionString', 'fileVersion', 'productVersion']) {
    assert.ok(
      !new RegExp(`\\b${bad}\\s*:`).test(hookSource),
      `${bad}: 会被 rcedit v5 静默忽略（本次事故的写法）`,
    );
  }
});

test('版本字符串内容与打包信息一致', () => {
  assert.ok(hookSource.includes("FileDescription: 'Molio'"));
  assert.ok(hookSource.includes("ProductName: 'Molio'"));
  assert.ok(hookSource.includes('packager.appInfo.version'), 'file/product-version 必须取自打包版本号');
});
