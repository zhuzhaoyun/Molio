/**
 * Windows AppUserModelID 守护测试。
 *
 * 背景：任务栏右键菜单（Jump List）的应用名入口显示 "Electron"。原因是
 * main.js 从未调用 app.setAppUserModelId，窗口拿到的是按 exe 路径自动生成的
 * AUMID，与 NSIS 安装器写进快捷方式的 build.appId 不匹配，Windows 找不到
 * 对应快捷方式，只能回退到 exe 的 FileDescription——未打补丁的旧构建上就是
 * "Electron"。
 *
 * 写法说明（CR 边界）：main.js 中调用行尾带 `// molio:aumid-call` 标记注释，
 * 本测试断言「存在未被注释掉的该标记行」——把调用整行注释掉会让测试变红；
 * 参数改用常量（如 APP_ID）也是合法写法，测试同样能解析比对，不会误报
 * 「无法解析参数」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mainSource = readFileSync(join(desktopDir, 'src', 'main.js'), 'utf-8');
const pkg = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf-8'));

/**
 * 取出未被注释掉的 setAppUserModelId 调用行（靠行尾 molio:aumid-call 标记定位）。
 * 行首出现可选空白后的 // 即视为整行注释，排除。
 */
function findActiveCallLine() {
  return mainSource
    .split('\n')
    .find((line) => !line.trimStart().startsWith('//') && line.includes('// molio:aumid-call'));
}

/** 从调用行解析参数：支持字符串字面量或标识符常量，其余形式返回 null。 */
function resolveCallArgument(callLine) {
  const m = callLine.match(/app\.setAppUserModelId\(\s*(['"][^'"]*['"]|[A-Za-z_$][\w$]*)\s*\)/);
  if (!m) return { error: `调用参数形式无法解析（应为字符串字面量或常量标识符）: ${callLine.trim()}` };
  const raw = m[1];
  if (raw.startsWith("'") || raw.startsWith('"')) return { value: raw.slice(1, -1) };
  const decl = mainSource.match(new RegExp(`(?:const|let|var)\\s+${raw}\\s*=\\s*['"]([^'"]*)['"]`));
  if (!decl) return { error: `常量 ${raw} 未找到字符串字面量声明` };
  return { value: decl[1] };
}

test('main.js 存在未被注释的 setAppUserModelId 调用', () => {
  assert.ok(
    findActiveCallLine(),
    '缺少生效中的 setAppUserModelId 调用（或行尾 molio:aumid-call 标记被删/被注释）— Windows 任务栏 Jump List 会回退显示 exe FileDescription（旧构建为 Electron）',
  );
});

test('setAppUserModelId 的值与 package.json build.appId 一致', () => {
  const callLine = findActiveCallLine();
  assert.ok(callLine, '未找到带 molio:aumid-call 标记的调用行');
  const result = resolveCallArgument(callLine);
  assert.ok(result.value !== undefined, result.error);
  assert.equal(
    result.value,
    pkg.build.appId,
    `AUMID (${result.value}) 与 NSIS 快捷方式携带的 build.appId (${pkg.build.appId}) 不一致`,
  );
});
