// 首页首屏几何回归测试。
// v3 契约：知识世界铺满整屏（slice cover + 径向遮罩让出中央），
// Slogan 与 CTA 居中浮出；宽屏不锁进居中窄柱。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(path.join(here, '..', 'styles.css'), 'utf8');

const HERO = styles;

test('首屏：宽屏不再使用 1440px 居中窄容器', () => {
  assert.ok(HERO.length > 0, '必须能找到首页 Hero 样式块');
  assert.match(HERO, /body\.home \.home-hero-inner\s*\{[^}]*?max-width:\s*none/s,
    'Hero 容器必须 max-width: none，避免 1440px 居中窄柱');
  assert.match(HERO, /body\.home \.home-hero-inner\s*\{[^}]*?padding-left:\s*clamp\(/s,
    'Hero 左侧内边距必须用 clamp() 跟随视口，而不是 (100% - 1440px) / 2 的居中公式');
  assert.doesNotMatch(HERO, /calc\(\(100%\s*-\s*var\(--max-w-home\)\)\s*\/\s*2\)/,
    'Hero 不允许再出现 (100% - max-w-home) / 2 居中公式');
});

test('首屏：背景世界铺满整屏，并把中央让给 Slogan', () => {
  assert.match(HERO, /body\.home \.home-hero-world\s*\{[^}]*?mask-image:\s*radial-gradient/s,
    '世界必须有径向遮罩：中央近乎隐形，四周逐渐清晰');
  assert.match(HERO, /body\.home \.hero-world-svg\s*\{[^}]*?width:\s*100%;\s*height:\s*100%/s,
    '世界必须 slice 盖满画布，节点从四边进入，不留截图框');
  assert.match(HERO, /body\.home \.home-hero-veil\s*\{[^}]*?radial-gradient/s,
    '中央必须有纸色柔光，把世界推远、把 Slogan 托出来');
  assert.match(HERO, /body\.home \.home-hero-world\s*\{[^}]*?animation:\s*worldDrift/s,
    '世界必须有极慢漂移，制造「知识在生长」的感觉');
});

test('首屏：2560 等宽屏内容不再只占中间 1/3', () => {
  assert.match(HERO, /@media\s*\(min-width:\s*1441px\)/,
    '必须有 1441px 以上的宽屏断点');
  assert.match(HERO, /@media\s*\(min-width:\s*1921px\)/,
    '必须有超宽断点，避免 2560 屏上 Slogan 缩在中间');
  assert.match(HERO, /body\.home \.home-hero h1\s*\{[^}]*?font-size:\s*clamp\(/s,
    'Slogan 字号必须用 clamp() 跟随视口');
  assert.doesNotMatch(HERO, /grid-template-columns:\s*minmax\(0,\s*1\.06fr\)/,
    '左右分栏的列比例已随单列重排删除');
});

test('资源屏：卡片随视口自动列数，文案不截断', () => {
  assert.match(HERO, /body\.home \.home-resources-grid\s*\{[^}]*?grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(240px,\s*1fr\)\)/s,
    '资源卡片必须 auto-fit，窄屏自动降列而不是截断');
  assert.doesNotMatch(HERO, /body\.home \.home-res-card\s+span\s*\{[^}]*?white-space:\s*nowrap/s,
    '卡片说明不允许 nowrap 截断');
});
