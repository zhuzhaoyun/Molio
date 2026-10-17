// apps/web/test/session-output/classifyWritePath.test.ts
// 产出面板三层分流的分类真值源：product（用户关心的文档产出）/ other（库内脚本·日志·
// 中间产物，折叠收纳）/ hidden（库外写入·点开头目录，一律不出现）。
// 输入是 writeKey 归一化后的路径（vault 内绝对路径已还原为相对）。
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { classifyWritePath } from '../../src/utils/toolRefs.ts';

describe('classifyWritePath', () => {
  describe('product —— 库内文档（面板主列表）', () => {
    it('库内 .md 文档', () => {
      assert.strictEqual(classifyWritePath('wiki/concepts/盗窃罪.md'), 'product');
      assert.strictEqual(classifyWritePath('笔记/入门.markdown'), 'product');
      assert.strictEqual(classifyWritePath('a.mdown'), 'product');
    });

    it('库根下的裸文档', () => {
      assert.strictEqual(classifyWritePath('总结.md'), 'product');
    });

    it('名字里含 index/hot/log 但不等于这些名字的文档仍是产出', () => {
      assert.strictEqual(classifyWritePath('wiki/index-notes.md'), 'product');
      assert.strictEqual(classifyWritePath('wiki/hot-takes.md'), 'product');
      assert.strictEqual(classifyWritePath('wiki/hotspot.md'), 'product');
      assert.strictEqual(classifyWritePath('wiki/README.md'), 'product');
      assert.strictEqual(classifyWritePath('wiki/overview.md'), 'product');
    });
  });

  describe('other —— 库内非文档 / 工作日志（折叠收纳）', () => {
    it('脚本与数据文件按扩展名归入 other', () => {
      assert.strictEqual(classifyWritePath('scripts/build_report.py'), 'other');
      assert.strictEqual(classifyWritePath('wiki/batches/concepts.tsv'), 'other');
      assert.strictEqual(classifyWritePath('data/export.csv'), 'other');
      assert.strictEqual(classifyWritePath('pkg/index.mjs'), 'other');
    });

    it('无扩展名文件归入 other', () => {
      assert.strictEqual(classifyWritePath('wiki/notes/DRAFT'), 'other');
    });

    it('basename 为 log.md 的构建日志归入 other', () => {
      assert.strictEqual(classifyWritePath('wiki/log.md'), 'other');
      assert.strictEqual(classifyWritePath('wiki/sources/log.md'), 'other');
    });

    // 这一族是「登记 / 缓存」文件：技能每次操作都重写它们，用户从不点开。
    // 判据与 daemon routes/graph.ts 的 GRAPH_EXCLUDED_BASENAMES（index/log）同源——
    // 图谱早就不把它们当节点；wiki-build/sweep.mjs、wiki-lint 统计页面时同样排除这三个名字。
    it('登记元文件（INDEX.md / hot.md）归入 other，不进产出清单', () => {
      assert.strictEqual(classifyWritePath('wiki/INDEX.md'), 'other');
      assert.strictEqual(classifyWritePath('wiki/sources/INDEX.md'), 'other');
      assert.strictEqual(classifyWritePath('wiki/entities/INDEX.md'), 'other');
      assert.strictEqual(classifyWritePath('wiki/concepts/INDEX.md'), 'other');
      assert.strictEqual(classifyWritePath('wiki/hot.md'), 'other');
    });

    it('元文件判据与目录无关（库内任意位置的 index.md 都算登记文件，与图谱一致）', () => {
      assert.strictEqual(classifyWritePath('docs/INDEX.md'), 'other');
      assert.strictEqual(classifyWritePath('INDEX.md'), 'other');
    });

    it('元文件判据对大小写不敏感', () => {
      assert.strictEqual(classifyWritePath('wiki/index.md'), 'other');
      assert.strictEqual(classifyWritePath('WIKI/LOG.MD'), 'other');
      assert.strictEqual(classifyWritePath('wiki/Hot.MD'), 'other');
    });

    it('元文件的衍生名（带别的扩展名）同样不是产出', () => {
      assert.strictEqual(classifyWritePath('wiki/log.md.bak'), 'other');
      assert.strictEqual(classifyWritePath('wiki/INDEX.md.bak'), 'other');
    });
  });

  describe('hidden —— 库外写入 / 点开头目录（不出现）', () => {
    it('绝对路径即库外（vault 前缀未命中时保留原样）', () => {
      assert.strictEqual(classifyWritePath('/Users/albert/.claude/projects/x/memory/MEMORY.md'), 'hidden');
      assert.strictEqual(classifyWritePath('/tmp/scratch.md'), 'hidden');
    });

    it('Windows 绝对路径', () => {
      assert.strictEqual(classifyWritePath('C:/Users/x/notes.md'), 'hidden');
      assert.strictEqual(classifyWritePath('D:/vault/a.md'), 'hidden');
    });

    it('~ 前缀', () => {
      assert.strictEqual(classifyWritePath('~/.claude/memory/MEMORY.md'), 'hidden');
    });

    it('含 .. 的越界路径', () => {
      assert.strictEqual(classifyWritePath('../outside.md'), 'hidden');
      assert.strictEqual(classifyWritePath('wiki/../../outside.md'), 'hidden');
    });

    it('任一段以 . 开头的隐藏目录', () => {
      assert.strictEqual(classifyWritePath('.molio/wiki-build/plan.md'), 'hidden');
      assert.strictEqual(classifyWritePath('.claude/skills/wiki-build/scripts/deadcheck.mjs'), 'hidden');
      assert.strictEqual(classifyWritePath('wiki/.drafts/a.md'), 'hidden');
    });

    it('点开头的隐藏文件', () => {
      assert.strictEqual(classifyWritePath('wiki/.hidden.md'), 'hidden');
    });
  });

  describe('边界', () => {
    it('空串不崩，按 other 处理（无扩展名的退化形态）', () => {
      assert.strictEqual(classifyWritePath(''), 'other');
    });

    it('Windows 反斜杠分隔在归一化后一样判定', () => {
      // writeKey 已把 \ 统一为 /；此处再兜一层，防调用方漏归一化
      assert.strictEqual(classifyWritePath('wiki\\log.md'), 'other');
      assert.strictEqual(classifyWritePath('wiki\\concepts\\盗窃罪.md'), 'product');
    });

    it('扩展名大小写不敏感', () => {
      assert.strictEqual(classifyWritePath('README.MD'), 'product');
      assert.strictEqual(classifyWritePath('SCRIPT.PY'), 'other');
    });

    it('名字里含 log 但不是 log.md 的文档仍是产出', () => {
      assert.strictEqual(classifyWritePath('wiki/catalog.md'), 'product');
      assert.strictEqual(classifyWritePath('wiki/log.md.bak'), 'other');
    });
  });
});
