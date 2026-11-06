/**
 * Hero 背景世界生成器：知识加工流程图。
 *
 *   左：资料来源（PDF / 网页 / Word / 笔记 / 书籍）页片
 *   中：Molio 加工舱 —— 里面坐着真实的《资治通鉴》图谱（结构化图谱本体）
 *   右：Agent 端点（Claude Code / Codex / WorkBuddy / 豆包工作 / Molio AI）
 *
 * 图谱部分复用 ./hero-graph.mjs（确定性力导向布局），本脚本只负责把它
 * 嵌进流程画布并补上两侧的加工叙事。输出直接内联进 index.html：
 *
 *   node apps/landing-page/tools/hero-world.mjs             # 横版（桌面）
 *   node apps/landing-page/tools/hero-world.mjs --portrait  # 竖版（窄屏）
 *
 * 与 hero-graph 一样是确定性输出：同一条命令永远产出逐字节相同的 SVG。
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORTRAIT = process.argv.includes('--portrait');

/* ---------- 取图谱内层（去掉外层 <svg> 壳，嵌进流程画布） ---------- */
function graphInner(args, viewBox) {
  const svg = execFileSync(process.execPath, [path.join(HERE, 'hero-graph.mjs'), ...args], {
    encoding: 'utf8',
  }).trim();
  const start = svg.indexOf('</title>') + '</title>'.length;
  const end = svg.lastIndexOf('</svg>');
  return { inner: svg.slice(start, end).trim(), viewBox };
}

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (cls, x, y, t, anchor = 'middle') =>
  '<text class="' + cls + '" x="' + x + '" y="' + y + '" text-anchor="' + anchor + '">' + esc(t) + '</text>';

/* ---------- 两侧的加工叙事 ---------- */
const SOURCES = ['PDF', '网页', 'Word', '笔记', '书籍'];
const AGENTS = ['Claude Code', 'Codex', 'WorkBuddy', '豆包工作', 'Molio AI'];

function sideMarks(xs, ys, labels, kind, labelDy) {
  const out = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = ys[i];
    if (kind === 'src') {
      out.push(
        '<g class="wf-glyph" transform="rotate(' + (i % 2 ? 3 : -3) + ' ' + (x + 32) + ' ' + (y + 42) + ')">' +
        '<rect x="' + x + '" y="' + y + '" width="64" height="84"/>' +
        '<path d="M' + (x + 48) + ' ' + y + 'L' + (x + 64) + ' ' + (y + 16) + '"/>' +
        '<path d="M' + (x + 12) + ' ' + (y + 34) + 'h34M' + (x + 12) + ' ' + (y + 50) + 'h40M' + (x + 12) + ' ' + (y + 66) + 'h26"/>' +
        '</g>');
    } else {
      out.push(
        '<g class="wf-end"><rect x="' + (x - 12) + '" y="' + (y - 12) + '" width="24" height="24"/>' +
        '<circle cx="' + x + '" cy="' + y + '" r="3"/></g>');
    }
    out.push(text('wf-label', x, y + labelDy, labels[i]));
  }
  return out.join('\n');
}

let body, vb, nested;

if (!PORTRAIT) {
  /* ================= 横版 3200 x 1400 ================= */
  vb = '0 0 3200 1400';
  const g = graphInner([], '0 0 2000 600');
  const SX = [520, 600, 500, 610, 520];
  const SY = [300, 510, 720, 930, 1120];
  const EX = 2520;
  const EY = SY.slice();

  const converge = SX.map((x, i) =>
    '<path d="M' + (x + 64) + ' ' + (SY[i] + 42) + 'C' + (x + 200) + ' ' + (SY[i] + 42) + ' 480 700 580 700"/>').join('\n');
  const diverge = EY.map((y) =>
    '<path d="M2480 700C2500 700 2500 ' + y + ' 2506 ' + y + '"/>').join('\n');

  nested =
    '<g class="wf-core">\n<svg x="620" y="427" width="1820" height="546" viewBox="' + g.viewBox + '" preserveAspectRatio="xMidYMid meet">\n' +
    g.inner + '\n</svg>\n</g>';

  body = [
    '<circle cx="1600" cy="700" r="620" fill="url(#wfGlow)"/>',
    '<text class="wf-caption" x="560" y="268">01 导入</text>',
    '<text class="wf-caption" x="620" y="402" text-anchor="start">02 加工 · 结构化图谱</text>',
    '<text class="wf-caption" x="2520" y="268">03 调用</text>',
    '<g class="wf-link">' + converge + '</g>',
    sideMarks(SX, SY, SOURCES, 'src', 118),
    '<rect class="wf-chamber" x="580" y="360" width="1900" height="680"/>',
    '<g class="wf-corner"><path d="M580 396v-36h36"/><path d="M2444 360h36v36"/><path d="M2480 1004v36h-36"/><path d="M616 1040h-36v-36"/></g>',
    nested,
    '<g class="wf-link wf-link--out">' + diverge + '</g>',
    sideMarks(Array(5).fill(EX), EY, AGENTS, 'end', 46),
    '<path class="wf-pulse" d="M520 700H2520" fill="none" stroke="url(#wfPulse)"/>',
  ].join('\n');
} else {
  /* ================= 竖版 1200 x 2900 =================
     窄屏放不下两侧页片列，改用两行整句标注讲流程：
     01 导入（来源清单）→ 加工舱（真图谱）→ 03 调用（Agent 清单）。 */
  vb = '0 0 1200 2900';
  const g = graphInner(['--portrait'], '0 0 900 1500');

  nested =
    '<g class="wf-core">\n<svg x="100" y="760" width="1000" height="1667" viewBox="' + g.viewBox + '" preserveAspectRatio="xMidYMid meet">\n' +
    g.inner + '\n</svg>\n</g>';

  body = [
    '<circle cx="600" cy="1500" r="760" fill="url(#wfGlow)"/>',
    '<text class="wf-caption" x="600" y="440">01 导入 · PDF / 网页 / Word / 笔记 / 书籍</text>',
    '<g class="wf-link"><path d="M600 470V700"/></g>',
    '<rect class="wf-chamber" x="60" y="700" width="1080" height="1760"/>',
    '<g class="wf-corner"><path d="M60 736v-36h36"/><path d="M1104 700h36v36"/><path d="M1140 2424v36h-36"/><path d="M96 2460h-36v-36"/></g>',
    '<text class="wf-caption wf-caption--block" x="100" y="752" text-anchor="start">02 加工 · 结构化图谱</text>',
    nested,
    '<g class="wf-link wf-link--out"><path d="M600 2460V2690"/></g>',
    '<text class="wf-caption" x="600" y="2760">03 调用 · Claude Code / Codex / WorkBuddy / 豆包工作</text>',
    '<path class="wf-pulse" d="M600 440V2760" fill="none" stroke="url(#wfPulseV)"/>',
  ].join('\n');
}
const grads = PORTRAIT
  ? '    <linearGradient id="wfPulseV" x1="0" y1="0" x2="0" y2="1">\n' +
    '      <stop offset="0" stop-color="#0D0D0D" stop-opacity="0"/>\n' +
    '      <stop offset="0.12" stop-color="#0D0D0D" stop-opacity="0.3"/>\n' +
    '      <stop offset="0.5" stop-color="#0D0D0D" stop-opacity="0.38"/>\n' +
    '      <stop offset="0.88" stop-color="#0D0D0D" stop-opacity="0.3"/>\n' +
    '      <stop offset="1" stop-color="#0D0D0D" stop-opacity="0"/>\n' +
    '    </linearGradient>\n'
  : '    <linearGradient id="wfPulse" x1="0" y1="0" x2="1" y2="0">\n' +
    '      <stop offset="0" stop-color="#0D0D0D" stop-opacity="0"/>\n' +
    '      <stop offset="0.12" stop-color="#0D0D0D" stop-opacity="0.3"/>\n' +
    '      <stop offset="0.5" stop-color="#0D0D0D" stop-opacity="0.38"/>\n' +
    '      <stop offset="0.88" stop-color="#0D0D0D" stop-opacity="0.3"/>\n' +
    '      <stop offset="1" stop-color="#0D0D0D" stop-opacity="0"/>\n' +
    '    </linearGradient>\n';

const svg = [
  '<svg class="hero-world-svg hero-world-svg--' + (PORTRAIT ? 'port' : 'land') + '" viewBox="' + vb + '"',
  ' preserveAspectRatio="xMidYMid slice" aria-hidden="true">',
  '  <defs>',
  '    <radialGradient id="wfGlow" cx="0.5" cy="0.5" r="0.5">',
  '      <stop offset="0" stop-color="#0D0D0D" stop-opacity="0.05"/>',
  '      <stop offset="1" stop-color="#0D0D0D" stop-opacity="0"/>',
  '    </radialGradient>',
  grads.slice(0, -1) + '  </defs>',
  body,
  '</svg>',
].join('\n');

process.stdout.write(svg + '\n');
