#!/usr/bin/env node
/**
 * daemon-graph-probe — 台式机测量（daemon 侧）：GET /api/graph 冷/热耗时 + communities 摘要。
 *
 * 用法: node scripts/daemon-graph-probe.mjs --vault <名称或路径子串> [--api http://localhost:3100]
 *
 * 前置：
 *   - daemon 已启动（pnpm dev:daemon 或桌面端）；库已在 UI 注册
 *   - 「冷」数字要求本次 daemon 启动后没请求过该库图谱（VaultCache 有 120s TTL +
 *     失效代识别——热过即热，想重测冷请重启 daemon 再跑）
 *   - 万级库放移动盘测冷建（与真实库同环境）
 *
 * 输出：紧凑报告（可直接贴回）。Windows 控制台若中文乱码不影响数字。
 */
const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const api = get('--api', 'http://localhost:3100');
const needle = get('--vault');
if (!needle) {
  console.error('用法: node scripts/daemon-graph-probe.mjs --vault <名称或路径子串> [--api http://localhost:3100]');
  process.exit(1);
}

const vs = await (await fetch(`${api}/api/knowledge/vaults`)).json();
const list = vs.vaults ?? vs;
const vault = list.find((v) => (v.name ?? '').includes(needle) || (v.path ?? '').includes(needle));
if (!vault) {
  console.error(`找不到 vault "${needle}"；现有：`, list.map((v) => `${v.name}|${v.path}`));
  process.exit(1);
}

const url = `${api}/api/graph/${vault.id}`;
const timed = async () => {
  const t0 = performance.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  const text = await res.text();
  return { ms: performance.now() - t0, kb: text.length / 1024, json: JSON.parse(text) };
};

const cold = await timed(); // 仅当 daemon 刚启动未热过该库时这是真冷
const warm1 = await timed();
const warm2 = await timed();

const c = cold.json.communities;
let comm;
if (!c) {
  comm = 'communities 字段缺失（daemon 版本早于 #416/#423？请 git pull 后重启 daemon）';
} else {
  const sizes = c.clusters.map((x) => x.size).sort((a, b) => b - a);
  const nonHub = cold.json.nodes.length - c.hubIds.length;
  const top5 = c.clusters
    .slice()
    .sort((a, b) => b.size - a.size)
    .slice(0, 5)
    .map((x) => `${x.label}:${x.size}`)
    .join(', ');
  comm = {
    clusters: c.clusters.length,
    hubs: c.hubIds.length,
    hubNames: c.hubIds.slice(0, 6),
    links: c.links.length,
    crumbCount: c.crumbCount,
    quality: c.quality,
    trunkObjects: c.clusters.length + c.hubIds.length,
    maxClusterSharePct: +(((sizes[0] ?? 0) / Math.max(nonHub, 1)) * 100).toFixed(1),
    top5,
  };
}

const report = {
  vault: `${vault.name} (${vault.id}) path=${vault.path}`,
  nodes: cold.json.nodes.length,
  edges: cold.json.edges.length,
  coldMs: +cold.ms.toFixed(0),
  payloadKB: +cold.kb.toFixed(0),
  warmMs: [+warm1.ms.toFixed(0), +warm2.ms.toFixed(0)],
  communities: comm,
};
console.log('=== daemon-graph-probe ===');
console.log(`vault:    ${report.vault}`);
console.log(`graph:    nodes=${report.nodes} edges=${report.edges}`);
console.log(`cold:     ${report.coldMs}ms (payload ${report.payloadKB}KB)`);
console.log(`warm:     ${report.warmMs.join('ms, ')}ms`);
console.log(`communities: ${JSON.stringify(comm, null, 2)}`);
console.log(`JSON: ${JSON.stringify(report)}`);
