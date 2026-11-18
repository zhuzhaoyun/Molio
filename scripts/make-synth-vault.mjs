#!/usr/bin/env node
/**
 * make-synth-vault — 生成合成基准库（图谱测量用，跨平台）。
 * 用法: node scripts/make-synth-vault.mjs <outDir> [nFiles=6500] [cohesion=0.85]
 *
 * 形态（对齐真实 PKM 库画像）：
 *   - n 篇 md 分 20 个主题目录；3 个 hub（总目录/人物索引/术语索引，被 ~18% 链接指向）
 *   - 出链预算 2-6 条/篇：18%→hub、5%→死链、其余按 cohesion 比例同目录/全局随机
 *   - ~10% 孤立节点；60% 带 frontmatter type
 *   - cohesion=0（纯随机，无社区结构）/ 0.6（弱内聚）/ 0.85（强内聚，默认）
 * 确定性随机（固定种子），多次生成可复现、可比。
 * 内容与真实库无关——测的是图谱管线（构建/社区发现/渲染），数量形态对齐即可。
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
if (!out) {
  console.error('用法: node scripts/make-synth-vault.mjs <outDir> [nFiles=6500] [cohesion=0.85]');
  process.exit(1);
}
const n = Number(process.argv[3] ?? 6500);
const cohesion = Number(process.argv[4] ?? 0.85);
if (existsSync(out) && readdirSync(out).length > 0) {
  console.error(`目录已非空: ${out}（换个新目录，别污染）`);
  process.exit(1);
}

// LCG（确定性）
let seed = 20261118;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const ri = (excl) => Math.floor(rnd() * excl);

const dirCount = 20;
const perDir = Math.floor(n / dirCount);
const dirs = Array.from({ length: dirCount }, (_, i) => `主题${String(i).padStart(2, '0')}`);
for (const d of dirs) mkdirSync(path.join(out, d), { recursive: true });

const hubs = ['总目录', '人物索引', '术语索引'];
const types = ['concept', 'person', 'book'];

const rel = (i) => `${dirs[i % dirCount]}/笔记${String(i).padStart(5, '0')}.md`;
// 同目录内随机选一个非自身的文件
const sameDirTarget = (i) => {
  const idx = ri(perDir);
  let t = idx * dirCount + (i % dirCount);
  if (t >= n || t === i) t = ((idx + 1) % perDir) * dirCount + (i % dirCount);
  return t;
};

for (let i = 0; i < n; i++) {
  const p = rel(i);
  const title = `笔记${String(i).padStart(5, '0')}`;
  const lines = [`# ${title}`, ''];
  const orphan = rnd() < 0.1;
  if (!orphan) {
    const linkCount = 2 + ri(5); // 2-6 条出链
    for (let j = 0; j < linkCount; j++) {
      const r = rnd();
      let target;
      if (r < 0.18) {
        target = hubs[ri(hubs.length)];
      } else if (r < 0.23) {
        target = `不存在的目标${ri(400)}`; // 5% 死链
      } else {
        let t;
        if (rnd() < cohesion) {
          t = sameDirTarget(i);
        } else {
          t = ri(n);
          if (t === i) t = (i + 1) % n;
        }
        target = rel(t).replace(/\.md$/, '').split('/').pop();
      }
      lines.push(`- 关联 [[${target}]]（见 [[${target}]] 的展开）`);
    }
  }
  lines.push('', `正文段落 ${i}：示例内容，占位用。`.repeat(3));
  const fm = rnd() < 0.6 ? `---\ntype: ${types[ri(types.length)]}\n---\n\n` : '';
  writeFileSync(path.join(out, p), fm + lines.join('\n') + '\n');
}
for (const h of hubs) writeFileSync(path.join(out, `${h}.md`), `# ${h}\n\n索引页。\n`);
console.log(`OK ${n} md (cohesion=${cohesion}) + ${hubs.length} hubs -> ${out}`);
