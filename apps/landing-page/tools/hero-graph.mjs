/**
 * Hero knowledge-graph generator.
 *
 * Emits the inline SVG for the landing-page hero: a real force-directed graph of
 * the 《资治通鉴》 knowledge base (cluster hubs 资治通鉴 / 商鞅变法 / 汉武帝 /
 * 淝水之战 / 唐太宗 / 三省六部, 107 nodes, ~324 edges).
 *
 * The layout is deterministic (seeded PRNG + fixed iteration count) so the same
 * command always produces byte-identical SVG — no random churn in git.
 *
 *   node apps/landing-page/tools/hero-graph.mjs            # print inline SVG
 *   node apps/landing-page/tools/hero-graph.mjs --preview  # write a standalone preview
 *
 * The output is inlined into index.html (see the HERO GRAPH markers) so that the
 * SVG inherits the page's fonts and CSS animation. Regenerate after editing the
 * data below, then paste into index.html.
 */
import { writeFileSync } from 'node:fs';

const ARGS = process.argv.slice(2);
const PREVIEW = ARGS.includes('--preview');
const PREVIEW_OUT = ARGS.find((a) => a.endsWith('.html')) ?? null;

/* ---------------- deterministic RNG ---------------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260921);

/* ---------------- data ---------------- */
const KIND_W = { hub: 1.0, major: 0.68, mid: 0.45, minor: 0.26 };

// ax/ay are cluster anchors in normalised (-1..1) space; the simulation pulls
// each cluster toward its anchor so the six eras stay visually separable.
const CLUSTERS = [
  { id: 'tongjian', ax: 0.00, ay: 0.00, nodes: [
    ['资治通鉴', 'hub'], ['司马光', 'major'], ['编年体', 'major'], ['史官制度', 'mid'],
    ['资治通鉴考异', 'mid'], ['通鉴纪事本末', 'mid'], ['周纪', 'minor'], ['秦纪', 'minor'],
    ['汉纪', 'minor'], ['唐纪', 'minor'], ['后梁纪', 'minor'], ['王安石', 'minor'],
  ]},
  { id: 'zhanguo', ax: -0.80, ay: -0.56, nodes: [
    ['商鞅变法', 'hub'], ['商鞅', 'major'], ['秦孝公', 'major'], ['秦始皇', 'major'],
    ['李斯', 'mid'], ['三家分晋', 'mid'], ['战国', 'mid'], ['秦', 'mid'],
    ['焚书坑儒', 'mid'], ['荆轲', 'minor'], ['郡县制', 'minor'], ['礼制', 'minor'],
  ]},
  { id: 'qinhan', ax: 0.78, ay: -0.58, nodes: [
    ['汉武帝', 'hub'], ['刘邦', 'major'], ['项羽', 'major'], ['韩信', 'major'],
    ['董仲舒', 'mid'], ['卫青', 'mid'], ['霍去病', 'mid'], ['张良', 'mid'],
    ['萧何', 'mid'], ['西汉', 'mid'], ['吕后', 'minor'], ['樊哙', 'minor'],
    ['鸿门宴', 'minor'], ['楚汉之争', 'minor'], ['巨鹿之战', 'minor'], ['陈胜吴广起义', 'minor'],
    ['白登之围', 'minor'], ['罢黜百家', 'minor'], ['张骞通西域', 'minor'], ['巫蛊之祸', 'minor'],
  ]},
  { id: 'weijin', ax: -0.90, ay: 0.38, nodes: [
    ['淝水之战', 'hub'], ['光武帝', 'major'], ['曹操', 'major'], ['刘备', 'major'],
    ['孙权', 'mid'], ['诸葛亮', 'mid'], ['司马懿', 'mid'], ['苻坚', 'mid'],
    ['谢安', 'mid'], ['王莽', 'mid'], ['东汉', 'mid'], ['三国', 'mid'],
    ['南北朝', 'mid'], ['西晋', 'minor'], ['东晋', 'minor'], ['光武中兴', 'minor'],
    ['王莽改制', 'minor'], ['昆阳之战', 'minor'], ['官渡之战', 'minor'], ['赤壁之战', 'minor'],
    ['夷陵之战', 'minor'], ['八王之乱', 'minor'], ['永嘉之乱', 'minor'], ['孝文帝改革', 'minor'],
    ['侯景之乱', 'minor'], ['均田制', 'minor'],
  ]},
  { id: 'suitang', ax: 0.90, ay: 0.40, nodes: [
    ['唐太宗', 'hub'], ['李渊', 'major'], ['魏征', 'major'], ['武则天', 'major'],
    ['安史之乱', 'major'], ['玄武门之变', 'major'], ['隋炀帝', 'mid'], ['唐', 'mid'],
    ['节度使', 'mid'], ['贞观之治', 'mid'], ['隋', 'minor'], ['隋灭陈', 'minor'],
    ['武周革命', 'minor'], ['狄仁杰', 'minor'], ['开元盛世', 'minor'], ['姚崇', 'minor'],
    ['宋璟', 'minor'], ['安禄山', 'minor'], ['郭子仪', 'minor'], ['永贞革新', 'minor'],
    ['甘露之变', 'minor'], ['黄巢起义', 'minor'], ['黄巢', 'minor'], ['朱温', 'minor'],
    ['朱温篡唐', 'minor'], ['五代', 'minor'], ['府兵制', 'minor'],
  ]},
  { id: 'zhidu', ax: 0.00, ay: 0.88, nodes: [
    ['三省六部', 'hub'], ['科举制', 'major'], ['察举制', 'mid'], ['监察制度', 'mid'],
    ['中书省', 'minor'], ['门下省', 'minor'], ['尚书省', 'minor'], ['六部', 'minor'],
    ['御史台', 'minor'], ['谏官', 'minor'],
  ]},
];

// semantic relations that cross cluster boundaries
const EXTRA = [
  ['资治通鉴','汉武帝'],['资治通鉴','唐太宗'],['资治通鉴','商鞅变法'],['资治通鉴','淝水之战'],['资治通鉴','三省六部'],
  ['通鉴纪事本末','安史之乱'],['司马光','王安石'],['郡县制','三省六部'],['察举制','汉武帝'],
  ['科举制','唐太宗'],['科举制','武则天'],['府兵制','唐太宗'],['节度使','安史之乱'],['节度使','五代'],
  ['礼制','董仲舒'],['礼制','三省六部'],['监察制度','汉武帝'],['御史台','监察制度'],
  ['西汉','王莽'],['东汉','三国'],['三国','西晋'],['南北朝','隋'],['隋','唐'],['唐','五代'],
  ['汉武帝','张骞通西域'],['汉武帝','卫青'],['汉武帝','霍去病'],['汉武帝','巫蛊之祸'],
  ['唐太宗','魏征'],['唐太宗','玄武门之变'],['唐太宗','贞观之治'],['李渊','玄武门之变'],
  ['武则天','狄仁杰'],['姚崇','开元盛世'],['安禄山','郭子仪'],['黄巢','黄巢起义'],['朱温','朱温篡唐'],
  ['商鞅','秦孝公'],['商鞅变法','战国'],['秦始皇','焚书坑儒'],['荆轲','秦始皇'],
  ['光武帝','光武中兴'],['王莽','王莽改制'],['曹操','官渡之战'],['曹操','赤壁之战'],
  ['刘备','赤壁之战'],['孙权','赤壁之战'],['刘备','夷陵之战'],['诸葛亮','刘备'],['司马懿','诸葛亮'],
  ['苻坚','淝水之战'],['谢安','淝水之战'],['八王之乱','永嘉之乱'],['永嘉之乱','东晋'],['孝文帝改革','南北朝'],
  ['刘邦','项羽'],['刘邦','韩信'],['刘邦','萧何'],['刘邦','张良'],['刘邦','樊哙'],
  ['项羽','鸿门宴'],['刘邦','鸿门宴'],['项羽','巨鹿之战'],['陈胜吴广起义','秦'],['白登之围','刘邦'],
  ['吕后','刘邦'],['汉纪','汉武帝'],['唐纪','唐太宗'],['周纪','三家分晋'],['秦纪','秦始皇'],
  ['编年体','史官制度'],['资治通鉴考异','司马光'],['汉武帝','罢黜百家'],['秦','西汉'],['光武帝','东汉'],
  ['贞观之治','开元盛世'],['安史之乱','甘露之变'],['黄巢起义','朱温篡唐'],['隋炀帝','隋灭陈'],
  ['司马光','编年体'],['战国','秦'],['光武帝','昆阳之战'],['王莽','昆阳之战'],
  ['安史之乱','郭子仪'],['魏征','贞观之治'],['科举制','察举制'],['三省六部','中书省'],['三省六部','门下省'],
  ['三省六部','尚书省'],['尚书省','六部'],['隋炀帝','武则天'],['隋炀帝','唐太宗'],
];

// nodes that carry a visible text label
const LABELS = new Set([
  '资治通鉴','司马光','编年体','商鞅变法','秦始皇','汉武帝','刘邦','项羽','赤壁之战',
  '曹操','淝水之战','唐太宗','魏征','武则天','安史之乱','科举制','三省六部','玄武门之变',
]);

// the single red "thread": 文本 → 史书 → 纪 → 帝王 → 制度 → 人物
const LIVE_PATH = [
  ['资治通鉴','唐纪'],['唐纪','唐太宗'],['唐太宗','玄武门之变'],['玄武门之变','李渊'],
  ['资治通鉴','汉纪'],['汉纪','汉武帝'],['汉武帝','张骞通西域'],
  ['三家分晋','周纪'],['周纪','资治通鉴'],['三家分晋','战国'],
  ['资治通鉴','三省六部'],['三省六部','科举制'],['科举制','唐太宗'],
  ['资治通鉴','司马光'],['司马光','编年体'],['资治通鉴','淝水之战'],['淝水之战','谢安'],
];

/* ---------------- build graph ---------------- */
const nodes = [];
const clusterOf = [];
const index = new Map();
for (let ci = 0; ci < CLUSTERS.length; ci++) {
  for (const [label, kind] of CLUSTERS[ci].nodes) {
    if (index.has(label)) throw new Error('duplicate node: ' + label);
    index.set(label, nodes.length);
    clusterOf.push(ci);
    nodes.push({ id: label, kind, ci, w: KIND_W[kind], hub: kind === 'hub', x: 0, y: 0, vx: 0, vy: 0 });
  }
}

const edges = [];
const edgeKey = new Set();
function addEdge(a, b) {
  const ia = index.get(a), ib = index.get(b);
  if (ia === undefined || ib === undefined || ia === ib) return;
  const k = ia < ib ? ia + ':' + ib : ib + ':' + ia;
  if (edgeKey.has(k)) return;
  edgeKey.add(k);
  edges.push([ia, ib]);
}
// hub spokes
for (let ci = 0; ci < CLUSTERS.length; ci++) {
  const members = nodes.filter((n) => n.ci === ci);
  const hub = members.find((n) => n.hub);
  for (const m of members) if (m !== hub) addEdge(hub.id, m.id);
}
// intra-cluster mesh keeps clusters from looking like fans
for (let ci = 0; ci < CLUSTERS.length; ci++) {
  const members = nodes.filter((n) => n.ci === ci && !n.hub);
  const links = members.length > 14 ? 2 : 1;
  for (const m of members) {
    for (let k = 0; k < links; k++) addEdge(m.id, members[Math.floor(rnd() * members.length)].id);
  }
}
for (const [a, b] of EXTRA) addEdge(a, b);

const liveKey = new Set();
for (const [a, b] of LIVE_PATH) {
  const ia = index.get(a), ib = index.get(b);
  if (ia === undefined || ib === undefined) continue;
  liveKey.add(ia < ib ? ia + ':' + ib : ib + ':' + ia);
}

/* ---------------- force-directed layout ---------------- */
// Two layouts ship in one page: landscape for desktop, portrait for phones
// (a 2000x600 graph scaled into a 390px column would render ~3px labels).
const PORTRAIT = ARGS.includes('--portrait');
const VBW = PORTRAIT ? 900 : 2000;
const VBH = PORTRAIT ? 1500 : 600;
const CNX = VBW / 2, CNY = VBH / 2;
const AX = VBW * (PORTRAIT ? 0.34 : 0.345);
const AY = VBH * (PORTRAIT ? 0.30 : 0.315);
const SPREAD_X = PORTRAIT ? 0.42 : 0.4;
const SPREAD_Y = PORTRAIT ? 0.42 : 0.4;

// Portrait: six clusters in 2 columns x 3 rows. Landscape: the flat, era-ordered spread.
const ANCHORS = PORTRAIT
  ? [
      { ax: -0.46, ay: -0.80 }, // 通鉴
      { ax:  0.52, ay: -0.76 }, // 战国
      { ax: -0.54, ay: -0.16 }, // 秦汉
      { ax:  0.54, ay:  0.02 }, // 魏晋
      { ax: -0.50, ay:  0.62 }, // 隋唐
      { ax:  0.52, ay:  0.78 }, // 制度
    ]
  : CLUSTERS.map((c) => ({ ax: c.ax, ay: c.ay }));

for (let i = 0; i < nodes.length; i++) {
  const c = ANCHORS[clusterOf[i]];
  nodes[i].x = CNX + c.ax * AX * SPREAD_X + (rnd() - 0.5) * (PORTRAIT ? 200 : 240);
  nodes[i].y = CNY + c.ay * AY * SPREAD_Y + (rnd() - 0.5) * (PORTRAIT ? 200 : 160);
}

const REP = 5600, LINK_LEN = 104, SPRING = 0.016, ANCHOR = 0.030, CENTER = 0.0075, ITER = 1100;
for (let it = 0; it < ITER; it++) {
  const cool = 1 - it / ITER;
  for (const n of nodes) { n.fx = 0; n.fy = 0; }

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) { dx = (rnd() - 0.5) * 2; dy = (rnd() - 0.5) * 2; d2 = 1; }
      const d = Math.sqrt(d2);
      const f = REP / d2;
      const ux = dx / d, uy = dy / d;
      a.fx += ux * f; a.fy += uy * f;
      b.fx -= ux * f; b.fy -= uy * f;
    }
  }
  for (const [ia, ib] of edges) {
    const a = nodes[ia], b = nodes[ib];
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.max(1, Math.hypot(dx, dy));
    const f = (d - LINK_LEN) * SPRING;
    const ux = dx / d, uy = dy / d;
    const w = 0.6 + 0.8 * (a.w + b.w) / 2;
    a.fx += ux * f * w; a.fy += uy * f * w;
    b.fx -= ux * f * w; b.fy -= uy * f * w;
  }
  for (const n of nodes) {
    const c = ANCHORS[n.ci];
    n.fx += (CNX + c.ax * AX - n.x) * ANCHOR;
    n.fy += (CNY + c.ay * AY - n.y) * ANCHOR;
    n.fx += (CNX - n.x) * CENTER;
    n.fy += (CNY - n.y) * CENTER;
  }
  for (const n of nodes) {
    n.vx = (n.vx + n.fx) * 0.80;
    n.vy = (n.vy + n.fy) * 0.80;
    const sp = Math.hypot(n.vx, n.vy);
    const cap = 24 * (0.35 + cool);
    if (sp > cap) { n.vx = n.vx / sp * cap; n.vy = n.vy / sp * cap; }
    n.x += n.vx; n.y += n.vy;
  }
}

/* ---------------- fit to viewBox ---------------- */
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
for (const n of nodes) {
  minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
  minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
}
const PAD_X = PORTRAIT ? 60 : 84, PAD_Y = PORTRAIT ? 56 : 40;
const s = Math.min((VBW - PAD_X * 2) / (maxX - minX), (VBH - PAD_Y * 2) / (maxY - minY));
const ox = PAD_X + (VBW - PAD_X * 2 - (maxX - minX) * s) / 2 - minX * s;
const oy = PAD_Y + (VBH - PAD_Y * 2 - (maxY - minY) * s) / 2 - minY * s;
for (const n of nodes) {
  n.px = +(n.x * s + ox).toFixed(1);
  n.py = +(n.y * s + oy).toFixed(1);
}

const rOf = (n) => +(2.2 + 9.8 * n.w).toFixed(2);
const opOf = (n) => +(0.30 + 0.58 * n.w).toFixed(2);
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------------- serialise ---------------- */
const pulse = {};
let pi = 0;
for (const [a, b] of LIVE_PATH) {
  const ia = index.get(a), ib = index.get(b);
  if (ia === undefined || ib === undefined) continue;
  const k = ia < ib ? ia + ':' + ib : ib + ':' + ia;
  if (!(k in pulse)) pulse[k] = +(pi++ * 0.5).toFixed(2);
}

const edgeSvg = edges.map(([ia, ib]) => {
  const a = nodes[ia], b = nodes[ib];
  const k = ia < ib ? ia + ':' + ib : ib + ':' + ia;
  const live = liveKey.has(k);
  const cls = live ? 'mg-edge mg-edge--live' : (a.hub || b.hub ? 'mg-edge mg-edge--strong' : 'mg-edge');
  let out = '<path class="' + cls + '" d="M' + Math.round(a.px) + ' ' + Math.round(a.py) + 'L' + Math.round(b.px) + ' ' + Math.round(b.py) + '"';
  if (live) out += ' style="--mg-delay:' + pulse[k] + 's"';
  return out + '/>';
}).join('');

const nodeSvg = nodes
  .slice()
  .sort((a, b) => a.w - b.w)
  .map((n) => '<circle class="mg-node mg-node--' + n.kind + '" cx="' + n.px + '" cy="' + n.py + '" r="' + rOf(n) + '" fill-opacity="' + opOf(n) + '"/>')
  .join('');

/* ---------------- labels: avoid nodes, then each other ---------------- */
const FS = PORTRAIT ? 30 : 21;
const widthOf = (t) => t.length * FS;

function hitsNode(box, own) {
  for (const n of nodes) {
    if (n === own) continue;
    const rad = rOf(n) + 4.5;
    const cx = Math.max(box.x0, Math.min(n.px, box.x1));
    const cy = Math.max(box.y0, Math.min(n.py, box.y1));
    const dx = n.px - cx, dy = n.py - cy;
    if (dx * dx + dy * dy < rad * rad) return true;
  }
  return false;
}
const placedBoxes = [];
const hitsLabel = (box) => placedBoxes.some((b) =>
  box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0);

const labelSvg = [];
const skipped = [];
let placed = 0;

for (const n of nodes.filter((x) => LABELS.has(x.id)).sort((a, b) => b.w - a.w)) {
  const rad = rOf(n);
  const w = widthOf(n.id);
  const gap = rad + 9;
  const away = Math.sign(n.px - CNX) || 1;
  const awayV = Math.sign(n.py - CNY) || 1;
  const raw = [
    { x: n.px + gap, y: n.py + 7, anchor: 'start' },
    { x: n.px - gap, y: n.py + 7, anchor: 'end' },
    { x: n.px + gap, y: n.py - rad + 2, anchor: 'start' },
    { x: n.px - gap, y: n.py - rad + 2, anchor: 'end' },
    { x: n.px + gap, y: n.py + rad + FS * 0.6, anchor: 'start' },
    { x: n.px - gap, y: n.py + rad + FS * 0.6, anchor: 'end' },
    { x: n.px, y: n.py - rad - 8, anchor: 'middle' },
    { x: n.px, y: n.py + rad + FS, anchor: 'middle' },
  ];
  // bias toward the outside of the constellation so labels read outward
  const score = (c) => (away > 0 ? c.anchor === 'start' : c.anchor === 'end') ? 0 : 1;
  const cands = raw.slice().sort((a, b) => score(a) - score(b));

  let done = false;
  for (const c of cands) {
    const x0 = c.anchor === 'start' ? c.x : c.anchor === 'end' ? c.x - w : c.x - w / 2;
    const box = { x0: x0 - 4, y0: c.y - FS * 0.86 - 3, x1: x0 + w + 4, y1: c.y + FS * 0.22 + 3 };
    if (box.x0 < 12 || box.x1 > VBW - 12 || box.y0 < 6 || box.y1 > VBH - 6) continue;
    if (hitsNode(box, n)) continue;
    if (!n.hub && hitsLabel(box)) continue;
    placedBoxes.push(box);
    labelSvg.push('<text class="mg-label mg-label--' + (n.hub ? 'hub' : n.kind) + '" x="' + c.x + '" y="' + c.y + '" text-anchor="' + c.anchor + '">' + esc(n.id) + '</text>');
    placed++; done = true;
    break;
  }
  // the focal label always ships, even if it has to sit tight under the hub
  if (!done && n.hub) {
    const y = n.py + rad + FS * 1.05;
    placedBoxes.push({ x0: n.px - w / 2 - 4, y0: y - FS - 3, x1: n.px + w / 2 + 4, y1: y + 6 });
    labelSvg.push('<text class="mg-label mg-label--hub" x="' + n.px + '" y="' + y + '" text-anchor="middle">' + esc(n.id) + '</text>');
    placed++; done = true;
  }
  if (!done) skipped.push(n.id);
}

const inner = [
  '<g class="mg-edges">' + edgeSvg + '</g>',
  '<g class="mg-nodes">' + nodeSvg + '</g>',
  '<g class="mg-labels">' + labelSvg.join('') + '</g>',
].join('\n');

const svg = [
  '<svg class="hero-graph-svg" viewBox="0 0 ' + VBW + ' ' + VBH + '"',
  ' preserveAspectRatio="xMidYMid meet" role="img"',
  ' aria-label="《资治通鉴》知识图谱：107 个条目按战国、秦汉、魏晋、隋唐等时代聚类，' + placed + ' 个关键节点标注名称，一条印章红主线串起文本、史书、帝王与制度之间的关系。">',
  '<title>《资治通鉴》知识图谱</title>',
  inner,
  '</svg>',
].join('');

if (PREVIEW_OUT) {
  writeFileSync(PREVIEW_OUT, [
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>hero graph preview</title>',
    '<style>',
    '@import url("https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;700;900&display=swap");',
    'body{margin:0;background:#F5F0E8;display:grid;place-items:center;min-height:100vh}',
    'svg{width:min(94vw,1760px);height:auto}',
    '.mg-edge{stroke:#0D0D0D;stroke-opacity:.15;stroke-width:1;fill:none}',
    '.mg-edge--strong{stroke-opacity:.21}',
    '.mg-edge--live{stroke:#C41E24;stroke-opacity:.55;stroke-width:1.3}',
    '.mg-node{fill:#0D0D0D}',
    '.mg-label{font-family:"Noto Serif SC",serif;font-size:21px;fill:#0D0D0D;fill-opacity:.55}',
    '.mg-label--hub{font-weight:900;fill-opacity:.94;font-size:27px}',
    '.mg-label--major{font-weight:700;fill-opacity:.8;font-size:23px}',
    '</style></head><body>', svg, '</body></html>',
  ].join('\n'), 'utf8');
} else {
  process.stdout.write(svg + '\n');
}

process.stderr.write('nodes ' + nodes.length + ' edges ' + edges.length +
  ' labels ' + placed + ' live ' + Object.keys(pulse).length +
  (skipped.length ? ' skipped ' + skipped.join(',') : '') + '\n');
