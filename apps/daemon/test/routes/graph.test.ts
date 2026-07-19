import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildGraph } from '../../src/routes/graph.js';

const roots: string[] = [];

function write(root: string, relative: string, content: string): void {
  const target = join(root, ...relative.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('buildGraph 路径限定 wikilink', () => {
  it('在同名文件回退前精确解析嵌套页面', () => {
    const root = mkdtempSync(join(tmpdir(), 'molio-graph-path-'));
    roots.push(root);
    write(root, 'wiki/INDEX.md',
      '[[建筑工程/规范审查/消防规范/concepts/防火分区|消防防火分区]]');
    write(root, 'wiki/建筑工程/规范审查/消防规范/concepts/防火分区.md', '# 消防');
    write(root, 'wiki/经济学/concepts/防火分区.md', '# 经济学同名页');

    const graph = buildGraph(root);
    assert.deepEqual(graph.deadLinks, []);
    assert.ok(graph.edges.some((edge) =>
      [edge.source, edge.target].includes('wiki/INDEX.md')
      && [edge.source, edge.target].includes(
        'wiki/建筑工程/规范审查/消防规范/concepts/防火分区.md',
      )));
    assert.ok(!graph.edges.some((edge) =>
      [edge.source, edge.target].includes('wiki/INDEX.md')
      && [edge.source, edge.target].includes('wiki/经济学/concepts/防火分区.md')));
  });
});
