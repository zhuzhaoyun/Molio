# 可扩展 Wiki 构建实施计划

> **供执行 Agent 使用：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 子技能，逐项实施本计划。使用复选框（`- [ ]`）跟踪步骤。

**目标：** 构建一套确定性、可恢复的 Wiki 构建流程：安全扫描大型 vault，冻结用户批准的语义主题计划，按受限批次执行，并在不新增 daemon API 的前提下生成递归分层索引。

**架构：** 内置 `wiki-build` Skill 随附纯 Node.js CLI。CLI 负责 `.molio/wiki-build` 下的清单、计划校验、状态转换、检查点日志和索引生成；runtime Agent 负责语义分类、文档转换和 Wiki 正文。现有 daemon 继续启动 runtime Agent，查询提示词改为逐级读取递归 `INDEX` 文件。

**技术栈：** Node.js 24 标准库、ECMAScript 模块、TypeScript 5.8 测试、`node:test`、pnpm workspace 脚本。

## 全局约束

- 已安装 Skill 的脚本只能使用 Node.js 标准库。
- 构建工作数据统一存放在 `.molio/wiki-build`，vault 根目录不放置过程文件。
- 用户批准计划之前，不得写入 Wiki 页面或 Wiki 索引。
- 按字节保留源文件；扫描器和预处理器只能读取源文件。
- 先做语义分组，再做容量细分；互不相关的单文件可以分别形成叶主题。
- 默认容量值为 `maxLeafPages=200`、`maxLeafIndexTokens=12000`、`maxTopicDepth=6`。
- 容量细分必须生成至少两个子主题，并使用满足限制的最少数量语义一致子主题。
- 主题无法继续细分或到达第六级时，使用确定性索引分片。
- 不得仅因主题深度、页面数量或 `INDEX` 大小超过叶容量上限而拒绝构建。
- 一期每次只执行一个批次。
- 保持 legacy 扁平 Wiki 可读、可查，不自动迁移。
- `MAX_DIR_ENTRIES=1000` 和 `MAX_TOTAL=50000` 必须与 `apps/daemon/src/core/vault-prune.ts` 一致。
- 不新增 FTS5、BM25、向量检索、Wiki 搜索 API 或 runtime 到 daemon 的回调。
- 不新增构建状态 daemon 端点；CLI 和文件继续作为执行边界。

---

## 文件结构

### 新增生产文件

- apps/daemon/src/tools/skills/wiki-build/scripts/wiki-build.mjs
  - CLI 参数解析、JSON 输出信封、命令分发和退出码。
- apps/daemon/src/tools/skills/wiki-build/scripts/lib/contracts.mjs
  - 模式常量、JSDoc 数据契约、扩展名支持、容量默认值和状态枚举。
- apps/daemon/src/tools/skills/wiki-build/scripts/lib/workspace.mjs
  - 知识库（vault）路径校验、安全相对路径、原子写入、JSON/JSONL 辅助函数、哈希和变更锁。
- apps/daemon/src/tools/skills/wiki-build/scripts/lib/inventory.mjs
  - 受限遍历、过滤、轻量采样、指纹、支持状态检测、重复候选和清单摘要。
- apps/daemon/src/tools/skills/wiki-build/scripts/lib/plan.mjs
  - 计划校验、主题树校验、文件覆盖、批次校验、版本冻结和已批准计划历史。
- apps/daemon/src/tools/skills/wiki-build/scripts/lib/preprocess.mjs
  - 将文本、JSONL、大型 JSON 和外部标准化文档准备为受限分块工作项。
- apps/daemon/src/tools/skills/wiki-build/scripts/lib/state.mjs
  - 初始状态、状态查询、下一批领取、尝试隔离、恢复、失败隔离、暂存、提交日志和幂等检查点。
- apps/daemon/src/tools/skills/wiki-build/scripts/lib/indexes.mjs
  - 自底向上的主题摘要、叶索引、确定性分片、祖先索引、最终覆盖检查和定向 ingest 重建索引。

### 新增测试与文档

- apps/daemon/test/tools/wiki-build-test-helpers.ts
- apps/daemon/test/tools/wiki-build-cli.test.ts
- apps/daemon/test/tools/wiki-build-scan.test.ts
- apps/daemon/test/tools/wiki-build-plan.test.ts
- apps/daemon/test/tools/wiki-build-preprocess.test.ts
- apps/daemon/test/tools/wiki-build-state.test.ts
- apps/daemon/test/tools/wiki-build-indexes.test.ts
- apps/daemon/test/tools/wiki-build-workflow.test.ts
- apps/daemon/test/routes/graph.test.ts
- apps/desktop/test/wiki-build-resources.test.js
- docs/wiki-build-acceptance.md

### 需要修改的现有文件

- apps/daemon/src/tools/skills/wiki-build/SKILL.md
- apps/daemon/src/tools/skills/wiki-ingest/SKILL.md
- apps/daemon/src/core/wiki-prompts.ts
- apps/daemon/test/tools/builtin-skills.test.ts
- apps/daemon/test/core/skill-installer.test.ts
- apps/daemon/test/core/weixin/wiki-sys-prompt-files.test.ts
- apps/daemon/src/routes/graph.ts

---

### 任务 1：建立 CLI、数据契约和安全工作区基础能力

**文件：**
- 新建：`apps/daemon/src/tools/skills/wiki-build/scripts/wiki-build.mjs`
- 新建：`apps/daemon/src/tools/skills/wiki-build/scripts/lib/contracts.mjs`
- 新建：`apps/daemon/src/tools/skills/wiki-build/scripts/lib/workspace.mjs`
- 新建：`apps/daemon/test/tools/wiki-build-test-helpers.ts`
- 新建：`apps/daemon/test/tools/wiki-build-cli.test.ts`

**接口：**
- 输出：`resolveBuildPaths(vaultPath)`，返回 `root`、`inventory`、`plan`、`state`、`samples`、`normalized`、`staging`、`journals` 和 `planHistory` 的绝对路径。
- 输出：`atomicWriteJson(path, value)`、`writeJsonLines(path, records)`、`readJson(path)`、`sha256(value)` 和 `withMutationLock(paths, fn)`。
- 输出：测试辅助函数 `runWikiBuildCli(vaultPath, args)`，返回解析后的 stdout、stderr 和退出状态。
- 输出：CLI 信封 `{ ok, command, data?, error?: { code, message, details? } }`。

- [ ] **步骤 1：编写预期失败的 CLI 契约测试**

~~~ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeVault, runWikiBuildCli } from './wiki-build-test-helpers.js';

describe('wiki-build CLI', () => {
  it('在不创建 wiki/ 的情况下报告 not_started', () => {
    const vault = makeVault();
    const result = runWikiBuildCli(vault.path, ['status', '--json']);
    assert.equal(result.status, 0);
    assert.deepEqual(result.json, {
      ok: true,
      command: 'status',
      data: { phase: 'not_started' },
    });
    assert.equal(existsSync(join(vault.path, 'wiki')), false);
    vault.cleanup();
  });

  it('拒绝逃逸 vault 的相对路径', () => {
    const vault = makeVault();
    const result = runWikiBuildCli(vault.path, ['scan', '--include', '../outside.md', '--json']);
    assert.equal(result.status, 2);
    assert.equal(result.json.error.code, 'PATH_OUTSIDE_VAULT');
    vault.cleanup();
  });
});
~~~

- [ ] **步骤 2：添加共享测试辅助函数**

~~~ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const daemonRoot = resolve(import.meta.dirname, '..', '..', '..');
const cli = join(
  daemonRoot,
  'src',
  'tools',
  'skills',
  'wiki-build',
  'scripts',
  'wiki-build.mjs',
);

export function makeVault() {
  const path = mkdtempSync(join(tmpdir(), 'molio-wiki-build-'));
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

export function runWikiBuildCli(vaultPath: string, args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args, '--vault', vaultPath], {
    cwd: vaultPath,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stderr: result.stderr,
    json: result.stdout.trim() ? JSON.parse(result.stdout) : null,
  };
}
~~~

- [ ] **步骤 3：运行测试，确认因缺少 CLI 而失败**

运行：

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-cli.test.js
~~~

预期：失败，因为 `scripts/wiki-build.mjs` 尚不存在。

- [ ] **步骤 4：实现数据契约、安全路径、原子写入和状态查询**

在 `contracts.mjs` 中添加以下导出常量，名称和值必须保持一致：

~~~js
export const SCHEMA_VERSION = 1;
export const MAX_DIR_ENTRIES = 1000;
export const MAX_TOTAL = 50000;
export const DEFAULT_CAPACITY = Object.freeze({
  maxLeafPages: 200,
  maxLeafIndexTokens: 12000,
  maxTopicDepth: 6,
});
export const FILE_STATUSES = Object.freeze([
  'pending', 'running', 'succeeded', 'failed', 'skipped',
]);
export const BATCH_STATUSES = FILE_STATUSES;
export const BUILD_PHASES = Object.freeze([
  'not_started', 'scanned', 'draft', 'approved', 'running',
  'paused', 'completed', 'completed_with_errors',
]);
~~~

实现 `workspace.mjs`，确保每次变更都执行以下操作：

1. 使用 `realpath` 解析 vault；
2. 拒绝根目录之外的路径；
3. 写入同级 `.tmp` 文件；
4. 对文件执行 `fsync` 后重命名；
5. 变更状态时，通过 `openSync(..., 'wx')` 使用 `.molio/wiki-build/.lock`；
6. 在 `finally` 中移除锁。

在 `wiki-build.mjs` 中实现 `parseArgs` 函数和 `status` 处理器。`status` 按顺序读取存在的 `state.json`、`plan.json`、`inventory.jsonl`；三者都不存在时返回 `phase=not_started`。使用 `--json` 时，向 stdout 输出一个 JSON 对象；错误也写入同一 JSON 信封，并以状态码 2 退出。

- [ ] **步骤 5：运行聚焦测试**

运行：

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-cli.test.js
~~~

预期：2 个测试通过。

- [ ] **步骤 6：提交**

~~~bash
git add apps/daemon/src/tools/skills/wiki-build/scripts apps/daemon/test/tools/wiki-build-test-helpers.ts apps/daemon/test/tools/wiki-build-cli.test.ts
git commit -m "feat(wiki): add deterministic build cli"
~~~

---

### 任务 2：生成受限文件清单和轻量样本

**文件：**
- 新建：`apps/daemon/src/tools/skills/wiki-build/scripts/lib/inventory.mjs`
- 新建：`apps/daemon/test/tools/wiki-build-scan.test.ts`
- 修改：`apps/daemon/src/tools/skills/wiki-build/scripts/wiki-build.mjs`

**接口：**
- 输出：`scanVault({ vaultPath, includePaths?, contentHash?, maxDirEntries?, maxTotal?, sampleBytes? })`。
- 输出：`InventoryRecord`，包含 `id`、`path`、`extension`、`size`、`mtimeMs`、`quickFingerprint`、`contentHash?`、`title`、`encoding`、`samplePath?`、`processor`、`support`、`duplicateOf?` 和 `risks`。
- 依赖：任务 1 的原子 JSONL 和哈希辅助函数。

- [ ] **步骤 1：编写扫描过滤、采样、格式和上限测试**

~~~ts
it('不读取 wiki 或隐藏工作区并写入确定性清单', () => {
  const vault = makeVault();
  writeFile(vault.path, 'notes/economy.md', '# 经济\n' + 'x'.repeat(20_000));
  writeFile(vault.path, 'slides.pptx', '模拟 Office');
  writeFile(vault.path, 'archive.zip', '模拟 ZIP');
  writeFile(vault.path, 'wiki/old.md', '应忽略');
  writeFile(vault.path, '.molio/private.md', '应忽略');

  const result = runWikiBuildCli(vault.path, ['scan', '--json']);
  assert.equal(result.status, 0);
  assert.equal(result.json.data.counts.total, 3);

  const records = readInventory(vault.path);
  assert.deepEqual(records.map((record) => record.path), [
    'archive.zip',
    'notes/economy.md',
    'slides.pptx',
  ]);
  assert.equal(records[1].title, '经济');
  assert.equal(records[1].processor, 'text');
  assert.equal(records[2].processor, 'docling');
  assert.equal(records[0].support, 'needs-confirmation');
  assert.ok(records[1].samplePath.startsWith('.molio/wiki-build/samples/'));
  vault.cleanup();
});

it('记录目录和总量上限错误而不崩溃', () => {
  const vault = makeVault();
  createFiles(vault.path, 'dump', 4);
  const result = runWikiBuildCli(vault.path, [
    'scan', '--max-dir-entries', '3', '--max-total', '2', '--json',
  ]);
  assert.equal(result.status, 0);
  assert.ok(result.json.data.errors.some((error) => error.code === 'DIRECTORY_LIMIT'));
  vault.cleanup();
});
~~~

此测试中的本地 `writeFile` 辅助函数必须先创建父目录再写入。`readInventory` 按行解析 `inventory.jsonl`。

- [ ] **步骤 2：运行扫描测试并确认失败**

运行：

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-scan.test.js
~~~

预期：失败，因为尚未注册 `scan` 命令。

- [ ] **步骤 3：实现确定性遍历和采样**

在 `contracts.mjs` 中使用以下格式分组：

~~~js
export const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.html',
]);
export const DOCLING_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx',
]);
export const CONFIRM_EXTENSIONS = new Set(['.zip', '.rar', '.ifc']);
export const PRUNED_NAMES = new Set([
  'wiki', 'node_modules', 'bower_components', 'jspm_packages',
  'dist', 'build', 'out', 'target', '__pycache__', '.venv',
]);
~~~

`inventory.mjs` 必须：

- 按规范化相对路径排序目录项；
- 跳过点号开头的目录和 `PRUNED_NAMES`；
- 文件头部最多读取 `sampleBytes`，尾部最多读取 `sampleBytes`；
- 使用 `TextDecoder('utf-8', { fatal: true })` 校验 UTF-8；
- 使用第一个 Markdown 标题作为标题，没有标题时使用文件名主干；
- 对 `size`、`mtimeMs`、头部字节和尾部字节计算 `quickFingerprint`；
- 仅在提供 `--content-hash` 时计算 `contentHash`；
- 将大小和 `quickFingerprint` 都相同的记录标记为重复候选；
- 写入 `inventory.jsonl`，并基于其精确字节计算 SHA-256 摘要；
- 不创建 `wiki/`。

在 `wiki-build.mjs` 中注册 `scan`。完整扫描写入 `inventory.jsonl`；`scan --include PATH` 写入 `ingest-candidate.jsonl`，不得替换冻结的清单。

- [ ] **步骤 4：运行聚焦测试和现有遍历测试**

运行：

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-scan.test.js apps/daemon/dist/test/core/knowledge.test.js
~~~

预期：选定测试全部通过。

- [ ] **步骤 5：提交**

~~~bash
git add apps/daemon/src/tools/skills/wiki-build/scripts apps/daemon/test/tools/wiki-build-scan.test.ts
git commit -m "feat(wiki): add bounded vault inventory"
~~~

---

### 任务 3：校验、版本化并冻结语义主题计划

**文件：**
- 新建：`apps/daemon/src/tools/skills/wiki-build/scripts/lib/plan.mjs`
- 新建：`apps/daemon/test/tools/wiki-build-plan.test.ts`
- 修改：`apps/daemon/src/tools/skills/wiki-build/scripts/wiki-build.mjs`
- 修改：`apps/daemon/test/tools/wiki-build-test-helpers.ts`

**接口：**
- 输出：`validatePlan(candidate, inventory, inventoryDigest)`。
- 输出：`saveDraft(paths, candidate)` 和 `approvePlan(paths, candidate)`。
- 输出：`TopicNode`、`FileAssignment` 和 `Batch` 契约。
- 依赖：`DEFAULT_CAPACITY` 和安全原子写入函数。

- [ ] **步骤 1：添加精确的计划夹具构造器**

在 `wiki-build-test-helpers.ts` 中添加 `makePlanFixture`。返回值必须使用以下结构：

~~~ts
{
  schemaVersion: 1,
  planVersion: 1,
  status: 'draft',
  inventoryDigest,
  createdAt: '2026-07-18T00:00:00.000Z',
  capacity: {
    maxLeafPages: 200,
    maxLeafIndexTokens: 12000,
    maxTopicDepth: 6,
  },
  topics: [
    {
      id: 'economy',
      name: '经济',
      slug: '经济',
      kind: 'leaf',
      depth: 1,
      summary: '经济政策与市场',
      rationale: '该文件讨论宏观经济。',
      estimatedPages: 1,
      estimatedIndexTokens: 40,
      fileIds: ['economy-file'],
      indexStrategy: 'inline',
    },
    {
      id: 'motorcycle',
      name: '摩托车维修',
      slug: '摩托车维修',
      kind: 'leaf',
      depth: 1,
      summary: '摩托车故障诊断与维修',
      rationale: '该文件讨论机械维修。',
      estimatedPages: 1,
      estimatedIndexTokens: 40,
      fileIds: ['motorcycle-file'],
      indexStrategy: 'inline',
    },
  ],
  assignments: [
    { fileId: 'economy-file', primaryTopicId: 'economy', relatedTopicIds: [], processor: 'text' },
    { fileId: 'motorcycle-file', primaryTopicId: 'motorcycle', relatedTopicIds: [], processor: 'text' },
  ],
  batches: [
    { id: 'economy-001', topicId: 'economy', order: 1, fileIds: ['economy-file'], estimatedInputTokens: 500 },
    { id: 'motorcycle-001', topicId: 'motorcycle', order: 2, fileIds: ['motorcycle-file'], estimatedInputTokens: 500 },
  ],
  batchPolicy: {
    maxFiles: 50,
    contextWindowTokens: 100000,
    maxInputFraction: 0.2,
    maxInputTokens: 20000,
  },
  excluded: [],
  undecided: [],
}
~~~

- [ ] **步骤 2：编写计划校验和冻结测试**

~~~ts
it('接受互不相关的单文件叶主题', () => {
  const fixture = makeScannedTwoFileVault();
  const candidate = makePlanFixture(fixture.inventoryDigest);
  const result = runPlan(fixture.vault, candidate, 'validate');
  assert.equal(result.status, 0);
  assert.equal(result.json.data.topicCounts.leaf, 2);
  assert.equal(existsSync(join(fixture.vault, 'wiki')), false);
});

it('拒绝单子节点中间主题和未超限的容量细分主题', () => {
  const fixture = makeScannedTwoFileVault();
  const candidate = makePlanFixture(fixture.inventoryDigest);
  candidate.topics = [{
    id: 'root-child',
    name: '多余层级',
    slug: '多余层级',
    kind: 'branch',
    depth: 1,
    splitReason: 'capacity',
    estimatedPages: 2,
    estimatedIndexTokens: 80,
    children: [candidate.topics[0]],
  }];
  const result = runPlan(fixture.vault, candidate, 'validate');
  assert.equal(result.status, 2);
  assert.deepEqual(result.json.error.details.codes, [
    'BRANCH_REQUIRES_TWO_CHILDREN',
    'CAPACITY_SPLIT_BELOW_LIMIT',
  ]);
});

it('冻结已批准版本并拒绝原地覆盖', () => {
  const fixture = makeScannedTwoFileVault();
  const candidate = makePlanFixture(fixture.inventoryDigest);
  assert.equal(runPlan(fixture.vault, candidate, 'approve').status, 0);
  const second = runPlan(fixture.vault, candidate, 'approve');
  assert.equal(second.status, 2);
  assert.equal(second.json.error.code, 'PLAN_VERSION_FROZEN');
});
~~~

- [ ] **步骤 3：运行计划测试并确认失败**

运行：

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-plan.test.js
~~~

预期：失败，因为尚未注册 `plan` 命令。

- [ ] **步骤 4：实现模式和结构校验**

`validatePlan` 必须在一次响应中返回全部校验错误，并强制执行以下规则：

- `inventoryDigest` 与扫描结果一致；
- `planVersion` 是正整数；
- 每个主题的 `id` 和 `slug` 唯一；
- 主题深度与所在位置一致，且不超过 `maxTopicDepth`；
- 中间主题至少有两个子主题，且没有 `fileIds`；
- 叶主题包含 `fileIds`，且没有子主题；
- 单文件叶主题有效；
- 容量细分产生的中间主题声明 `splitReason=capacity`，并且原主题确实超过配置上限；
- 超过上限的叶主题必须继续细分，或声明 `indexStrategy=shards`；
- 保留名称 `INDEX.md`、`log.md`、`hot.md` 和 `meta` 不能作为主题 `slug`；
- 清单中的每个文件必须且只能出现在 `assignments`、`excluded` 或 `undecided` 中一次；
- 每个文件分配都指向叶主题；
- `batchPolicy.maxInputFraction` 介于 0.2 和 0.3，`maxInputTokens` 等于 `floor(contextWindowTokens * maxInputFraction)`；批次按全局顺序排列，主题内顺序稳定；文件 id 必须存在；普通批次最多包含 50 个文件；`estimatedInputTokens` 不得超过 `maxInputTokens`。

`validate` 模式只写入 `plan-draft.json`。`approve` 模式写入 `plan.json`，其中包含 `status=approved`、`approvedAt` 和 `planDigest`；同时把不可变版本复制到 `plan-history/plan-v0001.json`。后续计划必须递增 `planVersion`，并保留旧的历史文件。

- [ ] **步骤 5：运行聚焦测试**

运行：

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-plan.test.js
~~~

预期：计划测试全部通过。

- [ ] **步骤 6：提交**

~~~bash
git add apps/daemon/src/tools/skills/wiki-build/scripts apps/daemon/test/tools/wiki-build-plan.test.ts apps/daemon/test/tools/wiki-build-test-helpers.ts
git commit -m "feat(wiki): freeze validated topic plans"
~~~

---

### 任务 4：为文本、JSON 和标准化文档准备受限工作项

**文件：**
- 新建：`apps/daemon/src/tools/skills/wiki-build/scripts/lib/preprocess.mjs`
- 新建：`apps/daemon/test/tools/wiki-build-preprocess.test.ts`
- 修改：`apps/daemon/src/tools/skills/wiki-build/scripts/lib/contracts.mjs`

**接口：**
- 输出：`prepareWorkItems({ paths, batch, inputManifest, policy })`。
- 输出：`chunkMarkdown(text, policy)`、`chunkPlainText(text, policy)`、`chunkJsonl(path, policy)` 和 `summarizeJsonStream(path, fieldPolicy)`。
- 输入：PDF、PPTX 和 DOCX 的外部标准化记录 `{ fileId, sourcePath, normalizedPath, processor, processorVersion }`。
- 输出：准备后的工作项，包含 `id`、`fileId`、`normalizedPath`、`byteStart`、`byteEnd`、`estimatedTokens`、`overlap` 和 `contentHash`。

- [ ] **步骤 1：编写受限预处理测试**

~~~ts
it('优先按标题切分 Markdown，再使用重叠窗口', () => {
  const fixture = markdownPreparationFixture([
    '# One',
    'a'.repeat(120),
    '# Two',
    'b'.repeat(120),
  ].join('\n'), { maxInputTokens: 60 });
  const result = prepareWorkItems(fixture);
  assert.ok(result.workItems.length >= 2);
  assert.equal(result.workItems[0].heading, 'One');
  assert.equal(result.workItems[1].heading, 'Two');
  assert.ok(result.workItems.every((item) => item.estimatedTokens <= 60));
});

it('不加载整个文件并将 JSONL 流式拆成受限分片', () => {
  const fixture = jsonlPreparationFixture(100, { maxInputTokens: 80 });
  const result = prepareWorkItems(fixture);
  assert.ok(result.workItems.length > 1);
  assert.equal(result.strategy, 'jsonl-stream');
  assert.ok(result.workItems.every((item) => item.byteEnd > item.byteStart));
});

it('大型 JSON 对象必须提供字段策略', () => {
  const fixture = largeJsonPreparationFixture();
  assert.throws(
    () => prepareWorkItems(fixture),
    (error) => error.code === 'JSON_FIELD_POLICY_REQUIRED',
  );
});

it('不修改源文件并计算及登记 docling Markdown 哈希', () => {
  const fixture = officePreparationFixture('report.pptx');
  const before = readFileSync(fixture.source);
  const normalized = writeNormalizedMarkdown(fixture.vault, '# 报告');
  const result = prepareWorkItems({
    ...fixture,
    external: [{
      fileId: fixture.fileId,
      sourcePath: 'report.pptx',
      normalizedPath: normalized,
      processor: 'docling',
      processorVersion: '2.x',
    }],
  });
  assert.deepEqual(readFileSync(fixture.source), before);
  assert.match(result.workItems[0].contentHash, /^[a-f0-9]{64}$/);
});
~~~

- [ ] **步骤 2：运行预处理测试并确认失败**

运行：

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-preprocess.test.js
~~~

预期：失败，因为 `lib/preprocess.mjs` 尚不存在。

- [ ] **步骤 3：实现确定性分块准备**

使用以下精确策略契约：

~~~js
{
  maxInputTokens: 20000,
  tokenEstimate: 'utf8-bytes-div-3',
  fallbackWindowChars: 30000,
  overlapChars: 1000,
  jsonlMaxLines: 500,
}
~~~

`preprocess.mjs` 必须：

- 使用 `Math.ceil(Buffer.byteLength(text, 'utf8') / 3)` 计算 `estimatedTokens`；
- 为 Markdown 分块保留标题文本和源文件字节范围；
- 标题分段仍然过大时，使用带 `overlapChars` 重叠的 `fallbackWindowChars` 窗口；
- 使用 `node:readline` 流式读取 JSONL，并在分片超过 `maxInputTokens` 之前结束当前分片；
- 使用字符串、转义和深度状态机扫描大型 JSON，只记录顶层键和值类型，不保留值；
- 提取大型 JSON 值之前，要求提供已批准的 `fieldPolicy`；
- 校验外部标准化路径位于 `.molio/wiki-build/normalized` 下；
- 记录处理器名称、版本、源内容哈希和标准化内容哈希；
- 原子写入 `prepared/<batchId>-<attemptToken>.json`；
- 拒绝 `estimatedTokens` 超过 `maxInputTokens` 的工作项。

任务 5 会在 `state.mjs` 能够校验活动批次和尝试令牌后，注册 `prepare --batch-id ID --attempt-token TOKEN --input MANIFEST --json`。

- [ ] **步骤 4：运行预处理和扫描测试**

运行：

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-preprocess.test.js apps/daemon/dist/test/tools/wiki-build-scan.test.js
~~~

预期：选定测试全部通过。

- [ ] **步骤 5：提交**

~~~bash
git add apps/daemon/src/tools/skills/wiki-build/scripts apps/daemon/test/tools/wiki-build-preprocess.test.ts
git commit -m "feat(wiki): prepare bounded build inputs"
~~~

---

### 任务 5：添加可恢复状态、尝试隔离和幂等检查点日志

**文件：**
- 新建：`apps/daemon/src/tools/skills/wiki-build/scripts/lib/state.mjs`
- 新建：`apps/daemon/test/tools/wiki-build-state.test.ts`
- 修改：`apps/daemon/src/tools/skills/wiki-build/scripts/wiki-build.mjs`
- 修改：`apps/daemon/src/tools/skills/wiki-build/scripts/lib/plan.mjs`
- 修改：`apps/daemon/src/tools/skills/wiki-build/scripts/lib/preprocess.mjs`

**接口：**
- 输出：`initializeState(plan)`、`getStatus(paths)`、`claimNextBatch(paths)`、`recoverRunning(paths)` 和 `checkpointBatch(paths, result)`。
- 输出：`prepareClaimedBatch(paths, batchId, attemptToken, inputManifest)`；该函数先校验领取记录，再调用 `prepareWorkItems`。
- 输出：`skipFile(paths, fileId, reason)` 和 `retryFailedFile(paths, fileId)`。
- `next` 返回 `batchId`、`attemptToken`、`attempt`、`topicId`、文件记录和 `stagingDir`。
- `checkpoint` 接收 `{ batchId, attemptToken, files, pages, error? }`。
- 页面结果包含 `path`、`topicId`、`type`、`title`、`summary`、`stagedPath` 和 `sha256`。

- [ ] **步骤 1：编写状态转换、失败隔离和过期尝试测试**

~~~ts
it('领取一个批次并在恢复后隔离过期工作进程', () => {
  const fixture = approveTwoBatchPlan();
  const first = runWikiBuildCli(fixture.vault, ['next', '--json']);
  assert.equal(first.json.data.batch.id, 'economy-001');
  assert.ok(first.json.data.attemptToken);

  const blocked = runWikiBuildCli(fixture.vault, ['next', '--json']);
  assert.equal(blocked.status, 2);
  assert.equal(blocked.json.error.code, 'BATCH_ALREADY_RUNNING');

  runWikiBuildCli(fixture.vault, ['status', '--recover', '--json']);
  const retried = runWikiBuildCli(fixture.vault, ['next', '--json']);
  assert.notEqual(retried.json.data.attemptToken, first.json.data.attemptToken);

  const stale = checkpoint(fixture.vault, {
    batchId: 'economy-001',
    attemptToken: first.json.data.attemptToken,
    files: [],
    pages: [],
  });
  assert.equal(stale.status, 2);
  assert.equal(stale.json.error.code, 'STALE_ATTEMPT');
});

it('隔离单个失败文件并重试检查点且不重复输出', () => {
  const fixture = approveOneBatchPlanWithTwoFiles();
  const claim = runWikiBuildCli(fixture.vault, ['next', '--json']).json.data;
  stagePage(fixture.vault, claim.stagingDir, 'wiki/经济/sources/经济.md', '# 经济');

  const payload = {
    batchId: claim.batch.id,
    attemptToken: claim.attemptToken,
    files: [
      { fileId: 'economy-file', status: 'succeeded', contentHash: 'a'.repeat(64) },
      { fileId: 'bad-file', status: 'failed', error: { code: 'PREPROCESS_FAILED', message: 'docling 退出码 1' } },
    ],
    pages: [{
      path: 'wiki/经济/sources/经济.md',
      topicId: 'economy',
      type: 'source',
      title: '经济',
      summary: '经济摘要',
      stagedPath: 'wiki/经济/sources/经济.md',
    }],
  };

  assert.equal(checkpoint(fixture.vault, payload).status, 0);
  assert.equal(checkpoint(fixture.vault, payload).status, 0);
  assert.equal(readFileSync(join(fixture.vault, payload.pages[0].path), 'utf8'), '# 经济');
  assert.equal(readState(fixture.vault).files['bad-file'].status, 'failed');
});

it('跳过待处理工作并只重试选中的失败文件', () => {
  const fixture = approvedPlanWithFailedAndPendingFiles();
  const skipped = runWikiBuildCli(fixture.vault, [
    'skip', '--file-id', 'pending-file', '--reason', '不支持的格式', '--json',
  ]);
  assert.equal(skipped.status, 0);
  assert.equal(readState(fixture.vault).files['pending-file'].status, 'skipped');

  const retried = runWikiBuildCli(fixture.vault, [
    'retry', '--file-id', 'failed-file', '--json',
  ]);
  assert.equal(retried.status, 0);
  assert.equal(retried.json.data.batch.fileIds.length, 1);
  assert.deepEqual(retried.json.data.batch.fileIds, ['failed-file']);
  assert.equal(readState(fixture.vault).files['already-succeeded'].status, 'succeeded');
});

it('源文件在计划批准后变化时拒绝领取批次', () => {
  const fixture = approveOneBatchPlan();
  appendFileSync(join(fixture.vault, 'economy.md'), '\n批准后发生变化');
  const result = runWikiBuildCli(fixture.vault, ['next', '--json']);
  assert.equal(result.status, 2);
  assert.equal(result.json.error.code, 'SOURCE_CHANGED_SINCE_SCAN');
  assert.equal(existsSync(join(fixture.vault, 'wiki')), false);
});
~~~

- [ ] **步骤 2：运行状态测试并确认失败**

运行：

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-state.test.js
~~~

预期：失败，因为尚未注册 `next`、恢复和 `checkpoint`。

- [ ] **步骤 3：实现初始状态和串行批次领取**

`approvePlan` 必须在同一个变更锁中创建 `state.json`。状态结构如下：

~~~js
{
  schemaVersion: 1,
  planVersion: 1,
  planDigest: '...',
  phase: 'approved',
  activeBatchId: null,
  batches: {
    'economy-001': {
      status: 'pending',
      attempts: 0,
      attemptToken: null,
      lastError: null,
    },
  },
  files: {
    'economy-file': {
      status: 'pending',
      attempts: 0,
      contentHash: null,
      lastError: null,
    },
  },
  pages: {},
  updatedAt: '...',
}
~~~

`activeBatchId` 非空时，`claimNextBatch` 必须拒绝领取；否则选择全局顺序最靠前的 pending 批次，递增 `attempts`，把 `randomUUID()` 分配给 `attemptToken`，创建 `staging/<attemptToken>`，并在返回前原子持久化状态。

领取前，将每个源文件的路径、大小、`mtimeMs` 和快速指纹与已批准清单比较。计划内源文件发生变化或消失时，以 `SOURCE_CHANGED_SINCE_SCAN` 拒绝领取；不得用当前内容替换冻结计划中的内容。

`status --recover` 必须把 running 批次和文件状态改回 pending，清除 `activeBatchId`，并保留尝试次数和错误。恢复后的领取必须获得新的 `attemptToken`。

在 `wiki-build.mjs` 中注册 `prepare`。该命令必须校验 `batchId` 和 `attemptToken`，调用 `prepareWorkItems`，原子写入 `prepared/<batchId>-<attemptToken>.json`，并返回受限工作项，不改变批次状态。

在 `wiki-build.mjs` 中注册 `skip` 和 `retry`。`skip` 接受 pending 或 failed 文件，保存原因，并在批次没有剩余可处理文件时将批次标记为 skipped。`retry` 接受 failed 文件，只把该文件重置为 pending，并追加一个稳定 id 为 `retry-<fileId>-<nextAttempt>` 的单文件重试批次；不得重置同批次中已 succeeded 的文件。

- [ ] **步骤 4：实现带日志的检查点**

`checkpointBatch` 必须：

1. 对规范化 payload 计算哈希，并检查现有日志；
2. completed 日志的 payload 哈希相同时，返回已保存结果；
3. 对新日志或未完成日志校验 `batchId` 和 `attemptToken`；
4. 校验暂存路径位于 `staging/<attemptToken>` 内；
5. 自行计算页面哈希；
6. 写入 `journals/<batchId>.json`，其中 `phase=prepared`，并保存目标页面映射；
7. 原子替换每个目标 Wiki 页面；
8. 将日志阶段写为 `phase=applied`；
9. 原子更新文件、批次、页面清单和构建状态；
10. 将日志阶段写为 `phase=completed`；
11. 状态写入成功之前保留暂存文件。

completed 日志收到相同 payload 时，返回已保存结果。崩溃后存在 prepared 或 applied 日志时，只重放目标哈希不同的文件并完成状态转换。同一批次收到不同 payload 时，以 `CHECKPOINT_CONFLICT` 拒绝。

单个 failed 文件不得连带标记 succeeded 同批文件失败。批次同时包含两种状态时，结果摘要返回 `succeeded_with_errors`，队列状态设为 succeeded，使 `next` 可以继续。

- [ ] **步骤 5：运行状态和 CLI 测试**

运行：

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-state.test.js apps/daemon/dist/test/tools/wiki-build-cli.test.js
~~~

预期：选定测试全部通过。

- [ ] **步骤 6：提交**

~~~bash
git add apps/daemon/src/tools/skills/wiki-build/scripts apps/daemon/test/tools/wiki-build-state.test.ts
git commit -m "feat(wiki): add resumable batch checkpoints"
~~~

---

### 任务 6：生成递归索引、确定性分片和完成报告

**文件：**
- 新建：`apps/daemon/src/tools/skills/wiki-build/scripts/lib/indexes.mjs`
- 新建：`apps/daemon/test/tools/wiki-build-indexes.test.ts`
- 修改：`apps/daemon/src/tools/skills/wiki-build/scripts/wiki-build.mjs`

**接口：**
- 输出：`estimateIndexTokens(markdown)`、`buildIndexModel(plan, pages, summaries)`、`writeIndexes(paths, model)`、`verifyCoverage(model)` 和 `finalizeBuild(paths, summaries)`。
- 输出：`reindexTopicAndAncestors({ paths, plan, state, topicId, pageUpdates, summaries })`。
- `finalize` 接收 JSON 映射 `{ [topicId]: { summary: string } }`。
- 输出：根、中间主题、叶主题和分片的 `INDEX` Markdown，以及结构化完成报告。

- [ ] **步骤 1：编写递归层级和分片测试**

~~~ts
it('自底向上写入根、中间主题和叶主题索引', () => {
  const fixture = completedThreeLevelBuild();
  const summaries = writeSummaries(fixture.vault, {
    engineering: { summary: '工程知识' },
    review: { summary: '规范审查' },
    fire: { summary: '消防规范' },
  });
  const result = runWikiBuildCli(fixture.vault, [
    'finalize', '--summaries', summaries, '--json',
  ]);
  assert.equal(result.status, 0);
  assert.match(readWiki(fixture.vault, 'INDEX.md'), /\[\[建筑工程\/INDEX\|建筑工程\]\]/);
  assert.match(readWiki(fixture.vault, '建筑工程/INDEX.md'), /\[\[建筑工程\/规范审查\/INDEX\|规范审查\]\]/);
  assert.match(readWiki(fixture.vault, '建筑工程/规范审查/消防规范/INDEX.md'), /sources\/消防规范/);
});

it('实际叶输出超过容量时创建稳定分片', () => {
  const fixture = completedLeafBuild({ maxLeafPages: 2, pageCount: 5 });
  const first = finalize(fixture);
  const firstFiles = listFiles(join(fixture.vault, 'wiki/topic/index-shards'));
  assert.deepEqual(firstFiles, ['concept-0001.md', 'concept-0002.md', 'concept-0003.md']);

  const second = finalize(fixture);
  assert.deepEqual(second.hashes, first.hashes);
  assert.match(readWiki(fixture.vault, 'topic/INDEX.md'), /concept-0001/);
});

it('缺少 succeeded 源页面或索引条目时拒绝完成', () => {
  const fixture = completedLeafBuild({ deleteSourcePage: true });
  const result = finalize(fixture);
  assert.equal(result.status, 2);
  assert.deepEqual(result.json.error.details.codes, ['SOURCE_PAGE_MISSING']);
});

it('登记 ingest 页面元数据并只重建其祖先链', () => {
  const fixture = completedThreeLevelBuild();
  const beforeUnrelated = hashWiki(fixture.vault, '企业数字化/INDEX.md');
  const input = writeIngestResult(fixture.vault, {
    topicId: 'fire',
    pages: [{
      path: 'wiki/建筑工程/规范审查/消防规范/sources/新规范.md',
      type: 'source',
      title: '新规范',
      summary: '新增消防规范',
      sha256: 'b'.repeat(64),
    }],
  });
  const result = runWikiBuildCli(fixture.vault, [
    'reindex', '--topic-id', 'fire', '--input', input,
    '--summaries', fixture.summaries, '--json',
  ]);
  assert.equal(result.status, 0);
  assert.match(readWiki(fixture.vault, '建筑工程/规范审查/消防规范/INDEX.md'), /新规范/);
  assert.equal(hashWiki(fixture.vault, '企业数字化/INDEX.md'), beforeUnrelated);
});
~~~

- [ ] **步骤 2：运行索引测试并确认失败**

运行：

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-indexes.test.js
~~~

预期：失败，因为尚未注册 `finalize`。

- [ ] **步骤 3：实现自底向上的索引模型**

使用 `Math.ceil(Buffer.byteLength(markdown, 'utf8') / 3)` 作为文档规定的保守 token 估算。索引模型必须：

- 将页面清单中的每条记录映射到一个叶主题；
- 按 `sources`、`entities`、`concepts`、`comparisons`、`questions` 的顺序按类型分组叶页面，其他类型按词法顺序排列；
- 按规范化标题和相对路径排序条目；
- 将每个条目渲染为带路径的 wikilink 加一句摘要；
- 中间主题索引只读取直接子主题摘要；
- `wiki/INDEX.md` 只读取顶层主题摘要；
- 要求每个主题都有摘要；
- 渲染祖先索引时不读取后代页面正文。

叶主题超过任一容量上限时，写入 `index-shards/<type>-NNNN.md`。渲染条目后再分片，确保每个分片同时满足页面数量和 token 上限。叶主题 `INDEX` 列出分片类型、标题范围、条目数和摘要。

- [ ] **步骤 4：实现完成条件校验和原子输出**

存在 pending 或 running 批次时，`finalize` 必须拒绝完成。构建可以包含 failed 或 skipped 文件，但必须：

- 报告 `phase=completed_with_errors`；
- 每个 succeeded 源文件都存在 source 页面；
- 每个生成页面在叶索引与分片中只出现一次；
- 拒绝重复路径、缺失文件、路径逃逸和失效的内部索引链接；
- 通过原子文本替换写入所有索引；
- 全部索引文件通过写后校验扫描后，才更新状态阶段。

为 `wiki-ingest` 添加定向重建索引导出：

~~~js
export async function reindexTopicAndAncestors({
  paths,
  plan,
  state,
  topicId,
  pageUpdates,
  summaries,
}) {
  const nextState = mergePageUpdates(state, pageUpdates);
  await atomicWriteJson(paths.state, nextState);
  return rebuildTopicChain({ paths, plan, state: nextState, topicId, summaries });
}
~~~

注册 `reindex --topic-id ID --input INGEST_RESULT --summaries SUMMARIES --json`。合并页面元数据前，校验每个页面路径存在、哈希匹配，并且 `topicId` 等于请求的叶主题。

- [ ] **步骤 5：运行聚焦测试**

运行：

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-indexes.test.js apps/daemon/dist/test/tools/wiki-build-state.test.js
~~~

预期：选定测试全部通过。

- [ ] **步骤 6：提交**

~~~bash
git add apps/daemon/src/tools/skills/wiki-build/scripts apps/daemon/test/tools/wiki-build-indexes.test.ts
git commit -m "feat(wiki): generate recursive topic indexes"
~~~

---

### 任务 7：通过崩溃恢复验证完整 CLI 工作流

**文件：**
- 新建：`apps/daemon/test/tools/wiki-build-workflow.test.ts`
- 修改：`apps/daemon/src/tools/skills/wiki-build/scripts/wiki-build.mjs`
- 修改：`apps/daemon/src/tools/skills/wiki-build/scripts/lib/state.mjs`
- 修改：`apps/daemon/src/tools/skills/wiki-build/scripts/lib/indexes.mjs`

**接口：**
- 依赖全部 CLI 命令：`scan`、`plan`、`status`、`next`、`prepare`、`checkpoint`、`skip`、`retry`、`reindex` 和 `finalize`。
- 为 `wiki-build` 和 `wiki-ingest` Skill 说明输出稳定的命令契约。

- [ ] **步骤 1：编写端到端夹具测试**

~~~ts
it('从 scan 运行到 finalize，并在模拟崩溃后恢复', () => {
  const vault = createWorkflowVault({
    'economy.md': '# 经济\n市场',
    'motorcycle.md': '# 摩托车维修\n化油器',
  });

  assert.equal(runWikiBuildCli(vault.path, ['scan', '--json']).status, 0);
  const candidate = writeTwoDomainPlan(vault.path);
  assert.equal(runWikiBuildCli(vault.path, [
    'plan', '--input', candidate, '--mode', 'validate', '--json',
  ]).status, 0);
  assert.equal(existsSync(join(vault.path, 'wiki')), false);
  assert.equal(runWikiBuildCli(vault.path, [
    'plan', '--input', candidate, '--mode', 'approve', '--json',
  ]).status, 0);

  const economy = claim(vault.path);
  prepareClaimedBatch(vault.path, economy);
  stageSourcePage(vault.path, economy, '经济');
  checkpointSucceeded(vault.path, economy);

  const motorcycleBeforeCrash = claim(vault.path);
  assert.equal(readState(vault.path).activeBatchId, motorcycleBeforeCrash.batch.id);
  runWikiBuildCli(vault.path, ['status', '--recover', '--json']);

  const motorcycleAfterCrash = claim(vault.path);
  assert.notEqual(motorcycleAfterCrash.attemptToken, motorcycleBeforeCrash.attemptToken);
  prepareClaimedBatch(vault.path, motorcycleAfterCrash);
  stageSourcePage(vault.path, motorcycleAfterCrash, '摩托车维修');
  checkpointSucceeded(vault.path, motorcycleAfterCrash);

  const summaries = writeTopicSummaries(vault.path);
  const final = runWikiBuildCli(vault.path, [
    'finalize', '--summaries', summaries, '--json',
  ]);
  assert.equal(final.json.data.phase, 'completed');
  assert.match(readFileSync(join(vault.path, 'wiki', 'INDEX.md'), 'utf8'), /经济/);
  assert.match(readFileSync(join(vault.path, 'wiki', 'INDEX.md'), 'utf8'), /摩托车维修/);
});
~~~

- [ ] **步骤 2：运行工作流测试**

运行：

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-workflow.test.js
~~~

预期：通过。任何失败都说明命令名称、状态字段、预处理契约或完成条件与任务 1 至 6 发生偏差；继续之前应在对应任务中修正。

- [ ] **步骤 3：运行完整工具测试组**

运行：

~~~bash
pnpm --filter @molio/daemon build
node --test "apps/daemon/dist/test/tools/wiki-build-*.test.js"
~~~

预期：全部 `wiki-build` 工具测试通过。

- [ ] **步骤 4：提交**

~~~bash
git add apps/daemon/src/tools/skills/wiki-build/scripts apps/daemon/test/tools/wiki-build-workflow.test.ts
git commit -m "test(wiki): cover resumable build workflow"
~~~

---

### 任务 8：用 CLI 工作流替换纯提示词构建和 ingest 流程

**文件：**
- 修改：`apps/daemon/src/tools/skills/wiki-build/SKILL.md`
- 修改：`apps/daemon/src/tools/skills/wiki-ingest/SKILL.md`
- 修改：`apps/daemon/test/tools/builtin-skills.test.ts`
- 修改：`apps/daemon/test/core/skill-installer.test.ts`

**接口：**
- 依赖任务 7 的稳定 CLI 命令。
- 输出 `wiki-build` Skill 2.0.0 和 `wiki-ingest` Skill 2.0.0。
- `wiki-ingest` 通过 CLI `reindex` 命令使用 `inventory.jsonl`、`plan.json`、`state.json` 和 `reindexTopicAndAncestors` 行为。

- [ ] **步骤 1：编写已安装 Skill 的工作流断言**

在 `builtin-skills.test.ts` 中添加：

~~~ts
it('安装 Wiki 构建 CLI 和审批工作流', () => {
  const buildDir = path.join(skillsDir, 'wiki-build');
  assert.ok(fs.existsSync(path.join(buildDir, 'scripts', 'wiki-build.mjs')));
  assert.ok(fs.existsSync(path.join(buildDir, 'scripts', 'lib', 'inventory.mjs')));

  const build = fs.readFileSync(path.join(buildDir, 'SKILL.md'), 'utf8');
  assert.match(build, /^version:\s*2\.0\.0$/m);
  assert.match(build, /scan --json/);
  assert.match(build, /plan .*--mode validate/);
  assert.match(build, /等待用户批准/);
  assert.match(build, /plan .*--mode approve/);
  assert.ok(
    build.indexOf('等待用户批准') < build.indexOf('--mode approve'),
    '必须先批准，再冻结计划和写入 Wiki',
  );
  assert.match(build, /status --recover/);
  assert.match(build, /checkpoint/);
  assert.match(build, /skip --file-id/);
  assert.match(build, /retry --file-id/);
  assert.match(build, /finalize/);
});

it('安装递归 ingest 说明', () => {
  const ingest = fs.readFileSync(path.join(skillsDir, 'wiki-ingest', 'SKILL.md'), 'utf8');
  assert.match(ingest, /^version:\s*2\.0\.0$/m);
  assert.match(ingest, /scan --include/);
  assert.match(ingest, /逐级读取/);
  assert.match(ingest, /祖先 INDEX/);
  assert.match(ingest, /legacy/);
});
~~~

- [ ] **步骤 2：运行 Skill 测试，确认版本和内容不匹配**

运行：

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/builtin-skills.test.js apps/daemon/dist/test/core/skill-installer.test.js
~~~

预期：失败，因为已安装 Skill 仍为 1.4.0，且缺少 CLI 说明。

- [ ] **步骤 3：重写 wiki-build 执行章节**

保留现有页面和 frontmatter 指南，然后按以下强制顺序替换旧的扫描到写入流程：

~~~markdown
1. 运行 `node "<wiki-build-skill>/scripts/wiki-build.mjs" scan --json`。
2. 只读取 `inventory.jsonl` 和样本，不得再次遍历或读取整个 vault。
3. 按语义领域对文件分组。即使主题只有一个文件，互不相关的文件也必须分开。
4. 应用容量细分并写入候选计划 JSON。
5. 运行 `plan --input "<candidate>" --mode validate --json`。
6. 在对话中展示主题、文件分配、排除项、待决定文件、风险和工作量。
7. 等待用户批准。用户明确批准前，不得运行 `approve`，也不得写入 `wiki/`。
8. 运行 `plan --input "<candidate>" --mode approve --json`。
9. 运行 `status --json`。恢复会话时，先展示剩余工作，并在运行 `status --recover` 前取得确认。
10. 循环执行 `next -> 标准化受限输入 -> 在返回的 stagingDir 下写入完整页面 -> checkpoint`。
11. 用户要求排除文件时运行 `skip --file-id`；出现可重试失败时运行 `retry --file-id`。
12. 写入 `topic-summaries.json`，然后运行 `finalize --summaries "<path>" --json`。
13. 根据最终 JSON 结果报告已完成、失败、跳过和未解决的文件。
~~~

说明 docling 输出位于 `.molio/wiki-build/normalized`，并记录文本标题/窗口分块、JSON 流式策略和不支持文件的确认流程。`checkpoint` 输入必须包含 `attemptToken`。

- [ ] **步骤 4：为递归 Wiki 重写 wiki-ingest**

Skill 必须：

- 检测 legacy 扁平 Wiki，并保留旧流程；
- 对新文件调用 `scan --include "<source>" --content-hash --json`；
- 逐级读取根和子主题 `INDEX`，提出叶主题建议；
- 允许用户选择其他主题；
- 允许新建单文件语义主题；
- 更新 source 页面和知识页面；
- 运行 `reindex --topic-id "<id>"`，更新叶主题或分片以及全部祖先；
- 不重建无关主题；
- 保留源文件。

- [ ] **步骤 5：升级版本并验证安装器更新**

更新安装器迁移测试，确保目标中的 1.4.0 版本被 2.0.0 替换，并包含 `scripts/wiki-build.mjs`。然后运行：

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/builtin-skills.test.js apps/daemon/dist/test/core/skill-installer.test.js
~~~

预期：选定测试全部通过。

- [ ] **步骤 6：提交**

~~~bash
git add apps/daemon/src/tools/skills/wiki-build apps/daemon/src/tools/skills/wiki-ingest apps/daemon/test/tools/builtin-skills.test.ts apps/daemon/test/core/skill-installer.test.ts
git commit -m "feat(wiki): make build and ingest resumable"
~~~

---

### 任务 9：让常驻查询提示词逐级读取递归索引

**文件：**
- 修改：`apps/daemon/src/core/wiki-prompts.ts`
- 修改：`apps/daemon/src/routes/graph.ts`
- 修改：`apps/daemon/test/core/weixin/wiki-sys-prompt-files.test.ts`
- 新建：`apps/daemon/test/routes/graph.test.ts`

**接口：**
- 输出更新后的 `VAULT_STRUCTURE`，覆盖递归和 legacy 布局。
- 输出 `WIKI_QUERY_PROMPT` 循环，从 `wiki/INDEX.md` 逐级读取中间主题、叶主题和分片索引。
- 导出 `buildGraph(vaultPath): GraphData`，供图谱路由回归测试使用。
- 在文件名和模糊回退之前，精确解析带路径的 wikilink。
- 保持 `QUERY_SYS_PROMPT_FILE` 和 daemon 运行路由不变。

- [ ] **步骤 1：编写查询提示词和带路径图谱链接断言**

~~~ts
it('查询框架逐级读取递归索引并保留 legacy 回退', () => {
  ensureWikiSysPromptFiles(dir);
  const query = readFileSync(join(dir, 'query.txt'), 'utf8');
  assert.match(query, /wiki\/INDEX\.md/);
  assert.match(query, /逐级读取候选主题/);
  assert.match(query, /叶主题/);
  assert.match(query, /index-shards/);
  assert.match(query, /legacy/);
  assert.match(query, /路径限定/);
  assert.match(query, /信息不足.*源文件/s);
});
~~~

新建 `apps/daemon/test/routes/graph.test.ts`：

~~~ts
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
~~~

- [ ] **步骤 2：运行提示词测试并确认失败**

运行：

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/core/weixin/wiki-sys-prompt-files.test.js apps/daemon/dist/test/routes/graph.test.js
~~~

预期：失败，因为提示词仍描述单个扁平 `INDEX`，并且没有导出 `buildGraph`。

- [ ] **步骤 3：更新 VAULT_STRUCTURE 和 WIKI_QUERY_PROMPT**

将仅支持扁平目录的说明替换为：

~~~text
- `wiki/INDEX.md` 列出递归 Wiki 的顶层主题。
- 中间主题 `INDEX` 列出直接子主题及其摘要。
- 叶主题 `INDEX` 列出页面或指向 `index-shards/` 的链接。
- legacy Wiki 可能继续使用单个扁平 `wiki/INDEX.md`；按原结构读取，不做迁移。
~~~

将查询顺序设为：

~~~text
1. 存在 `wiki/hot.md` 时先读取它。
2. 读取 `wiki/INDEX.md`。
3. 选中条目指向另一个主题 `INDEX` 时，继续读取该 `INDEX`。
4. 到达叶主题后，读取相关页面条目或相关索引分片。
5. 打开最相关的 Wiki 页面和关联页面。
6. Wiki 证据不足时才读取源文件。
~~~

嵌套页面和同名文件必须使用带显示别名的路径限定链接，例如 `[[建筑工程/规范审查/消防规范/concepts/防火分区|防火分区]]`。唯一的 legacy 页面仍可使用不带路径的链接。保留现有非 Wiki 活动查询的绕过逻辑和归档建议行为。

- [ ] **步骤 4：在文件名回退前解析带路径的图谱链接**

导出 `buildGraph`，为每个 Markdown 路径注册规范化小写别名，并在读取 `nameIndex` 前执行精确检查：

~~~ts
export function buildGraph(vaultPath: string): GraphData {
  // 现有扫描和索引构建逻辑
  for (const f of mdFiles) {
    const relPath = f.path;
    const key = relPath;
    pathToKey.set(relPath, key);
    pathToKey.set(relPath.replace(/\\/g, '/').toLowerCase(), key);
    // 现有文件名、节点类型和链接计数初始化逻辑
  }
  // 现有边和节点构建逻辑
}

function resolveLink(
  rawName: string,
  sourcePath: string,
  nameIndex: Map<string, string[]>,
  pathToKey: Map<string, string>,
): string | null {
  const normalizedTarget = rawName
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|^\.\//g, '')
    .replace(/\.md$/i, '')
    .toLowerCase();

  if (rawName.match(/\.(png|jpg|jpeg|gif|svg|webp|pdf|docx?|xlsx?)$/i)) {
    return null;
  }

  const exactCandidates = [`${normalizedTarget}.md`];
  if (sourcePath.startsWith('wiki/') && !normalizedTarget.startsWith('wiki/')) {
    exactCandidates.push(`wiki/${normalizedTarget}.md`);
  }
  for (const candidate of exactCandidates) {
    const exact = pathToKey.get(candidate);
    if (exact) return exact;
  }

  const cleanName = normalizedTarget;
  // 保留现有文件名、模糊匹配、同目录和首项匹配回退
}
~~~

- [ ] **步骤 5：运行提示词、图谱和路由回归测试**

运行：

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/core/weixin/wiki-sys-prompt-files.test.js apps/daemon/dist/test/routes/graph.test.js apps/daemon/dist/test/routes/runs-wiki-skill.test.js
~~~

预期：选定测试全部通过；运行路由仍会附加 `QUERY_SYS_PROMPT_FILE`，且不新增 daemon 操作分支。

- [ ] **步骤 6：提交**

~~~bash
git add apps/daemon/src/core/wiki-prompts.ts apps/daemon/src/routes/graph.ts apps/daemon/test/core/weixin/wiki-sys-prompt-files.test.ts apps/daemon/test/routes/graph.test.ts
git commit -m "feat(wiki): navigate recursive topic indexes"
~~~

---

### 任务 10：验证开发目录、vault 安装目录和打包资源副本

**文件：**
- 新建：`apps/desktop/test/wiki-build-resources.test.js`
- 修改：`apps/daemon/test/tools/builtin-skills.test.ts`
- 修改：`apps/daemon/test/core/skill-installer.test.ts`

**接口：**
- 依赖 `skill-installer.ts` 中的递归 `copyDirSync`。
- 依赖 `apps/desktop/scripts/prepare-resources.mjs` 中的递归 `cpSync`。
- 为安装布局和打包布局中的每个 `wiki-build` 脚本及 lib 模块提供回归覆盖。

- [ ] **步骤 1：添加打包资源回归测试**

~~~js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const desktopRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(desktopRoot, '..', '..');
const prepareSource = readFileSync(
  resolve(desktopRoot, 'scripts', 'prepare-resources.mjs'),
  'utf8',
);

describe('wiki-build 打包资源', () => {
  it('递归复制 Skill', () => {
    assert.match(prepareSource, /cpSync\(skillsSrc,\s*skillsDest,\s*\{\s*recursive:\s*true/);
  });

  it('包含 CLI 源文件和全部必需模块', () => {
    const sourceRoot = resolve(
      repoRoot,
      'apps/daemon/src/tools/skills/wiki-build/scripts',
    );
    for (const relative of [
      'wiki-build.mjs',
      'lib/contracts.mjs',
      'lib/workspace.mjs',
      'lib/inventory.mjs',
      'lib/plan.mjs',
      'lib/preprocess.mjs',
      'lib/state.mjs',
      'lib/indexes.mjs',
    ]) {
      assert.ok(existsSync(resolve(sourceRoot, relative)), relative);
    }
  });

  it('运行资源准备后打包资源包含脚本', () => {
    const daemonBundle = resolve(desktopRoot, 'resources/daemon/daemon.mjs');
    if (!existsSync(daemonBundle)) return;
    assert.ok(existsSync(resolve(
      desktopRoot,
      'resources/daemon/skills/wiki-build/scripts/wiki-build.mjs',
    )));
  });
});
~~~

- [ ] **步骤 2：运行桌面端和安装器测试**

运行：

~~~bash
node --test apps/desktop/test/wiki-build-resources.test.js
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/builtin-skills.test.js apps/daemon/dist/test/core/skill-installer.test.js
~~~

预期：选定测试全部通过。

- [ ] **步骤 3：运行 prepare-resources 并验证实际打包路径**

运行：

~~~bash
pnpm --filter @molio/desktop build
node --test apps/desktop/test/wiki-build-resources.test.js
~~~

预期：由于 `resources/daemon/daemon.mjs` 已存在，条件式打包资源测试会执行对应断言。

- [ ] **步骤 4：提交**

~~~bash
git add apps/desktop/test/wiki-build-resources.test.js apps/daemon/test/tools/builtin-skills.test.ts apps/daemon/test/core/skill-installer.test.ts
git commit -m "test(wiki): verify build tool packaging"
~~~

---

### 任务 11：记录并执行由 Molio 触发的 articles-1 验收

**文件：**
- 新建：`docs/wiki-build-acceptance.md`

**接口：**
- 依赖最终 CLI、已安装 Skill、知识库 UI 入口、daemon 运行链路和 runtime Agent 工作流。
- 输出可复现的验收记录，包含 UI 触发的运行标识、清单摘要、各支持类别数量、恢复证据、最终覆盖数量和代表性查询结果。

- [ ] **步骤 1：编写验收手册**

`docs/wiki-build-acceptance.md` 必须包含以下命令和预期证据：

~~~powershell
$cli = "D:\work\02-code\Molio-wiki-build-scalable\apps\daemon\src\tools\skills\wiki-build\scripts\wiki-build.mjs"
$vault = "D:\work\articles-1"
node $cli scan --vault $vault --json
node $cli status --vault $vault --json

Set-Location "D:\work\02-code\Molio-wiki-build-scalable"
pnpm dev:desktop
~~~

记录：

- 清单摘要；
- Molio 运行/会话 id、选定的 runtime Agent、已安装 `wiki-build` Skill 版本和自动发送的 `wiki-build` 提示词；
- 可见文件总数；
- supported、needs-confirmation 和 scan-error 数量；
- 按扩展名统计的总字节数；
- plan、excluded 和 undecided 数量之和与清单数量相等；
- 已批准计划的版本和摘要；
- 批次数量和最大估算 token 负载；
- 至少完成一个检查点后的取消操作；
- 证明已完成批次未被重新领取的恢复输出；
- 最终 succeeded、failed 和 skipped 文件数量；
- 叶索引/分片页面覆盖数和死链数量；
- 代表性问题、选中的索引路径、使用的 Wiki 页面和源文件回退情况。

验收手册必须说明：这些数量反映扫描快照，不构成产品容量承诺。

- [ ] **步骤 2：运行完整自动化验证套件**

运行：

~~~bash
pnpm --filter @molio/daemon test
node --test apps/desktop/test/wiki-build-resources.test.js
pnpm typecheck
~~~

预期：全部测试通过，`typecheck` 以状态码 0 退出。

- [ ] **步骤 3：运行 articles-1 预扫描**

运行验收手册中的两个 PowerShell 命令。预期：

- 退出状态为 0；
- 清单数量等于 supported、needs-confirmation 和 scan-error 文件记录之和；
- 扫描不创建 `wiki/` 目录；
- 清单和样本只存在于 `D:\work\articles-1\.molio\wiki-build` 下。

Agent 向用户展示生成的主题树、文件分配、风险和工作量之前，不得批准或执行计划。

- [ ] **步骤 4：从 Molio 触发 wiki-build 并记录结果**

在此 worktree 中运行 `pnpm dev:desktop` 启动 Molio，打开或添加 `D:\work\articles-1` 并将其选为知识库，选择待测试的 runtime Agent，然后点击“构建 Wiki”。确认对话自动发送 `wiki-build` 提示词，并且 runtime 从 vault 的 Skill 安装目录加载 `wiki-build` Skill 2.0.0。

批准候选计划前，确认：

- Agent 展示递归主题树、文件分配、排除项、待决定文件、风险、批次数量和估算工作量；
- 即使主题只包含一个源文件，互不相关的领域仍保持分开；
- 此时尚未生成 `wiki/` 页面；
- 全部构建过程文件都位于 `D:\work\articles-1\.molio\wiki-build` 下。

在对话中批准计划。等待至少一个批次到达 succeeded 检查点后，从 Molio 取消运行，再次点击“构建 Wiki”。确认 Agent 报告剩余工作，在恢复前请求确认，取得新的尝试令牌，并且不会重新领取 succeeded 批次。随后恢复运行、处理剩余批次并完成索引。

通过同一个知识库对话提出代表性问题。记录每个回答使用的索引路径、Wiki 页面、关联页面和源文件回退。在 `docs/wiki-build-acceptance.md` 中加入运行 id、相关对话摘录、状态数量、最终覆盖情况和观察到的失败。

- [ ] **步骤 5：运行最终回归验证**

运行：

~~~bash
pnpm --filter @molio/daemon test
pnpm --filter @molio/desktop test
pnpm typecheck
git diff --check
git status --short
~~~

预期：测试和 `typecheck` 通过，`git diff` 不报告空白错误，状态中只列出本任务预期的验收文档变更。

- [ ] **步骤 6：提交**

~~~bash
git add docs/wiki-build-acceptance.md
git commit -m "docs: record scalable wiki build acceptance"
~~~

---

## 执行顺序与审查关卡

1. 任务 1 至 4 建立受限输入处理和用户审批计划。审查用户批准前没有发生 `wiki/` 写入。
2. 任务 5 至 7 建立可恢复变更。在允许 Skill 执行前，审查尝试隔离、日志重放和幂等性。
3. 任务 8 至 10 向 runtime Agent 和打包版本开放工作流。审查 legacy 行为和安装路径。
4. 全部自动化关卡通过后，任务 11 才运行真实数据验收。

每个任务都必须保持分支可构建，并以列出的聚焦测试和提交结束。不同审查关卡之间不得合并提交。
