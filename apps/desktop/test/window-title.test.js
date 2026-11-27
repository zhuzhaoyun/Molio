/**
 * 每窗口标题（任务栏悬浮预览）守护测试。
 *
 * 背景：开多个知识库窗口时，Windows 任务栏悬浮预览里每个窗口都显示
 * "Molio"（createWindow 的静态 title，web 层从不设置 document.title），
 * 无法区分。修复：导航事件（did-navigate + did-navigate-in-page）驱动
 * updateWindowTitle，从 daemon 的 /api/knowledge/vaults 解析 vault 名，
 * 标题改为「知识库名 — Molio」，非知识库页面（首页/对话）回退 "Molio"。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf-8');

/** 截取 recordVaultNavigation 函数体（到监听器注册行为止）。 */
function navigationHandlerBody() {
  const start = mainSource.indexOf('const recordVaultNavigation = ');
  assert.ok(start !== -1, '未找到 recordVaultNavigation');
  const end = mainSource.indexOf("win.webContents.on('did-navigate'", start);
  assert.ok(end !== -1, '未找到 did-navigate 监听器注册');
  return mainSource.slice(start, end);
}

describe('main.js per-window title (taskbar hover previews)', () => {
  it('vault 导航驱动标题更新：全量加载与 SPA 切换共用 recordVaultNavigation', () => {
    const body = navigationHandlerBody();
    assert.ok(body.includes('updateWindowTitle(win, vaultId)'), '导航处理器必须调用 updateWindowTitle');
    assert.ok(mainSource.includes("win.webContents.on('did-navigate', recordVaultNavigation)"), '全量加载必须走同一处理器');
    assert.ok(mainSource.includes("win.webContents.on('did-navigate-in-page', recordVaultNavigation)"), 'SPA 切换必须走同一处理器');
  });

  it('标题以知识库名开头，格式「名称 — Molio」，无 vault 时回退 Molio', () => {
    assert.ok(mainSource.includes('`${name} — Molio`'), '标题必须以知识库名开头（悬浮预览看前缀）');
    assert.match(mainSource, /win\.setTitle\(name \? `\$\{name\} — Molio` : 'Molio'\)/, '无 vault 名的页面必须回退到纯 Molio');
  });

  it('vault 名从 daemon 的 /api/knowledge/vaults 解析，带缓存与 miss 重取', () => {
    assert.ok(mainSource.includes('/api/knowledge/vaults'), '必须复用 daemon vault 列表接口');
    assert.ok(mainSource.includes('v.name || v.id'), 'vault 缺名时回退 id');
    assert.ok(mainSource.includes('vaultNameCache'), '必须有缓存——did-navigate-in-page 每次路由变化都触发，不能每次都 fetch');
  });

  it('异步防护：窗口已销毁或序号过期时不落标题', () => {
    const start = mainSource.indexOf('async function updateWindowTitle(');
    assert.ok(start !== -1, '未找到 updateWindowTitle');
    const body = mainSource.slice(start, start + 800);
    assert.ok(body.includes('win.isDestroyed()'), 'await 之后必须重查窗口存活');
    assert.ok(body.includes('windowTitleSeq'), '必须用序号丢弃过期的异步结果（快速连续导航）');
  });

  it('阻止页面静态 <title> 覆盖窗口标题（page-title-updated preventDefault）', () => {
    // web index.html 有静态 <title>Molio</title>，全量加载后 page-title-updated
    // 会把 setTitle 的结果冲掉——真机验证抓到的回归点，必须锁住。
    assert.match(
      mainSource,
      /win\.on\('page-title-updated',\s*\(event\)\s*=>\s*event\.preventDefault\(\)\)/,
      '缺少 page-title-updated preventDefault — 页面静态标题会覆盖每窗口 vault 标题',
    );
  });

  it('recency 记录的 vaultRecency 空值守卫不影响标题更新', () => {
    const body = navigationHandlerBody();
    assert.ok(body.includes('if (vaultId && vaultRecency) vaultRecency.touch(vaultId);'), 'recency 仍受 vaultRecency 空值守卫');
    assert.ok(
      body.indexOf('vaultRecency.touch') < body.indexOf('updateWindowTitle'),
      '标题更新必须独立于 recency 守卫执行（vaultRecency 未初始化时标题也要工作）',
    );
  });
});
