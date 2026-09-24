// 首页信息架构回归测试。
// 首页重构的核心风险是“改回功能堆叠”：所有卖点同时出现在首屏，用户无法建立理解顺序。
// v3 的叙事是：知识世界是底 → Slogan 与 CTA 从中央浮出来 → 往下才解释流程与资源。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '..', 'index.html'), 'utf8');

function stripScripts(source) {
  return source.replace(/<script\b[\s\S]*?<\/script>/gi, '');
}

const body = stripScripts(html);
const hero = body.match(/<section class="hero home-hero"[\s\S]*?<\/section>/)?.[0] ?? '';

test('首页 Hero：Slogan 浮在知识世界中央，资源库退到独立一屏', () => {
  assert.match(body, /把过去的积累/);
  assert.match(body, /变成今天的生产力/);
  assert.match(body, /看演示视频/);
  assert.match(body, /id="resources"/, '资源库必须从 Hero 退到独立一屏');
  assert.match(body, /class="home-res-card/, '资源屏必须有卡片');
  assert.match(body, /进资源库看全部/);
  assert.ok(hero.length > 0, 'Hero 必须存在');
  assert.doesNotMatch(hero, /home-resource-link/, 'Hero 不再放资源库入口块');
});

test('首页 Hero：图谱退为背景世界，而不是被框住的展品', () => {
  assert.match(hero, /class="home-hero-world"/, '图谱必须作为铺满整屏的背景层');
  assert.match(hero, /class="home-hero-veil"/, '中央必须有纸色柔光，把世界推远');
  assert.match(hero, /class="hero-world-svg hero-world-svg--land"/, '桌面用横版世界');
  assert.match(hero, /class="hero-world-svg hero-world-svg--port"/, '竖屏必须换竖版世界');
  assert.match(hero, /class="mg-node mg-node--/, '背景必须是真图谱（有节点）');
  assert.match(hero, /class="mg-edge mg-edge--live"/, '背景保留唯一一条印章红主线');
  assert.match(hero, /class="wf-glyph"/, '底图必须有资料来源页片（PDF / 网页 / Word…）');
  assert.match(hero, /class="wf-end"/, '底图必须有 Agent 端点');
  assert.match(hero, /01 导入/, '底图必须有导入站标注');
  assert.match(hero, /02 加工/, '底图必须有加工站标注（加工舱标题块）');
  assert.match(hero, /03 调用/, '底图必须有调用站标注');
  assert.match(hero, /class="wf-core"/, '加工舱里必须坐着真图谱');
  assert.doesNotMatch(body, /home-hero-flow/, '旧的底图示意图已随重做删除');
  assert.doesNotMatch(body, /home-hero-graph/, '旧的框住图谱的容器已随重做删除');
  assert.doesNotMatch(body, /home-flow-panel/, '旧的两侧面板已随重做删除');
});

test('首页 Hero：居中栈只有 Slogan / 说明 / 两个按钮 / 演示', () => {
  const core = hero.match(/<div class="home-hero-core">[\s\S]*$/)?.[0] ?? '';
  const dlAt = core.indexOf('home-cta-primary');
  const resAt = core.indexOf('home-cta-ink');
  const demoAt = core.indexOf('home-demo-link');
  assert.ok(core.length > 0, 'Hero 居中栈必须存在');
  assert.match(core, /把过去的积累/, 'Slogan 必须在居中栈里');
  assert.ok(dlAt > -1, '居中栈必须有下载按钮');
  assert.match(core, /class="home-cta-primary" href="#download"/,
    '下载按钮只允许锚到下载屏，平台选择在那里做');
  assert.ok(resAt > dlAt, '「获取领域知识」必须排在下载按钮旁边');
  assert.match(core, /class="home-cta-ink" href="resources\.html"/,
    '「获取领域知识」必须直接跳到资源页');
  assert.ok(demoAt > resAt, '演示小字链接必须排在两个按钮之后');
  assert.doesNotMatch(hero, /data-dl=/, '首屏不允许直接挂安装包链接');
  assert.doesNotMatch(hero, /dl-seg/, '首屏的 Win/mac 分段已收敛进下载屏');
});

test('首页 Agent 叙事：覆盖 WorkBuddy 与豆包工作', () => {
  for (const agent of ['Claude Code', 'Codex', 'WorkBuddy', '豆包工作']) assert.match(body, new RegExp(agent));
});

test('首页结构：workflow 与 showcase 合并为一屏，只保留核心区块', () => {
  const order = ['id="hero"', 'id="showcase"', 'id="resources"', 'id="download"'];
  let cursor = -1;
  for (const marker of order) {
    const at = body.indexOf(marker);
    assert.ok(at > cursor, `${marker} 必须出现在前一个区块之后`);
    cursor = at;
  }
  assert.doesNotMatch(body, /id="workflow"/, 'workflow 已并入 showcase，不应再作为独立区块存在');
  assert.doesNotMatch(body, /home-workflow-grid/, '三步卡片网格应已删除');
  assert.doesNotMatch(body, /id="positioning"/, '定位对比区应当整体删除');
  assert.doesNotMatch(body, /home-compare-grid/, '定位对比卡片应当整体删除');
});

test('首页叙事：四步工作流闭环，含成果回流', () => {
  for (const step of ['导入', '加工', '使用', '回流']) assert.match(body, new RegExp(step));
  assert.match(body, /<ol class="home-step-line">/, '步骤必须保留为紧凑步骤列表，而不是整屏卡片');
  assert.match(body, /home-step-line-index">04/, '必须有第 04 步：回流');
  assert.doesNotMatch(body, /home-fact-list/, '重复的 1362 年事实卡已并入演示说明');
});

test('首页演示：合并屏保留资治通鉴视频，产品截图已撤下', () => {
  assert.match(body, /id="heroVideoStack"/, '演示视频容器必须保留');
  assert.match(body, /images\/kg-graph\.webp/, '视频海报图必须保留');
  const showcase = body.match(/<section class="section section-inset home-showcase"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.ok(showcase.length > 0, 'showcase 屏必须存在');
  assert.doesNotMatch(showcase, /home-showcase-shots/, '界面截图块已按需求删除');
  assert.doesNotMatch(showcase, /images\/main\.webp/, '导入后截图已按需求删除');
  assert.doesNotMatch(showcase, /images\/wiki_knowledge\.webp/, '加工后截图已按需求删除');
  assert.doesNotMatch(showcase, /导入后：原始目录结构原样保留/, '导入后文案已按需求删除');
  assert.doesNotMatch(showcase, /加工后：Molio 自动构建 Wiki/, '加工后文案已按需求删除');
});

test('首页锚点：导航覆盖首屏/演示/资源/下载四个锚点，且不产生死链', () => {
  assert.doesNotMatch(body, /href="#workflow"/, 'workflow 锚点已随合并删除');
  assert.match(body, /href="#showcase"/, '「看演示视频」必须仍指向合并后的演示屏');
  assert.match(body, /href="#resources"/, '资源屏必须有锚点');
  const anchors = body.match(/<div class="anchor-nav"[\s\S]*?<\/div>/)?.[0] ?? '';
  assert.ok(anchors.length > 0, '章节导航必须存在');
  assert.equal((anchors.match(/data-anchor/g) ?? []).length, 4, '章节导航应覆盖四个区块');
});

test('首页降噪：移除抽象循环和四图能力墙', () => {
  assert.doesNotMatch(body, /closure-ring/);
  assert.doesNotMatch(body, /cap-grid/);
  assert.doesNotMatch(body, /Chrome 扩展离线安装说明/);
});

test('首页技术信任：保留本地、Agent 接入和成果沉淀卖点', () => {
  for (const proof of ['本地数据', 'Agent 可接入', '成果会沉淀']) assert.match(body, new RegExp(proof));
});

test('首页完整性：重构后必须保留站点页脚', () => {
  assert.match(body, /<footer class="site-footer">/);
  assert.match(body, /隐私政策/);
  assert.match(body, /粤ICP备2023134483号-4/);
});

test('首页完整性：能力图灯箱随四图能力墙一起移除', () => {
  assert.doesNotMatch(body, /guideLightbox/);
});

test('首页 CTA 收敛：三次重复的下载入口收敛为两处', () => {
  assert.doesNotMatch(body, /home-final-cta/, '收尾深色 CTA 卡片应随第三次下载入口一并删除');
  assert.doesNotMatch(body, /class="btn btn-seal"/, '不应再出现第三个印章红下载按钮');
  assert.match(body, /别让多年积累，只躺在硬盘里/, '收尾鼓动句并入 download 区块导语保留');
});

