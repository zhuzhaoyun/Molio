// apps/daemon/src/core/market/suggest.ts
// 发布元数据起草（"AI 先写、用户改"）：采样 vault → 一次性 agent 调用 → 归一为
// MarketPublishSuggestion。纪律：
// - 只支持 claude / codex（两者都有稳定的无交互 JSON 输出模式）；都不可用 →
//   suggest_unavailable，前端静默回落手填，绝不阻断发布。
// - 运行 cwd = 空临时目录：纯文本起草，agent 不接触用户文件；超时强杀。
// - 产物一律过 normalize 硬校验（与云端 service.create 同口径：名称 ≤30 码点、
//   简介 ≤100 码点、标签 ≤2×10 码点、icon 必须在 MARKET_ICONS 白名单内）。
// - runner 可注入（测试替身），真实路径走 spawnOneShot。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MARKET_ICONS, type MarketPublishSuggestion } from '@molio/contracts';
import { buildContentDigest, contentPromptLines, normalizeContent, type ContentDigest } from './content.js';
import { buildAgentEnv, getAgentConfig } from '../config.js';
import { buildSpawnEnv } from '../runtimes/env.js';
import { needsShellOnWindows, resolveAgentBinary } from '../runtimes/launch.js';
import { getAgentDef } from '../runtimes/registry.js';

/** 支持一次性起草的 agent（按偏好序） */
export const SUGGEST_AGENT_IDS = ['claude', 'codex'] as const;
/** 首次启动/冷缓存可能较慢，给足时间；前端有 loading 态 */
export const SUGGEST_TIMEOUT_MS = 180_000;
/** 采样上限：文件数 / 摘要文件数 / 单摘要码点数 */
const MAX_PATHS = 200;
const MAX_SNIPPET_FILES = 8;
const MAX_SNIPPET_CHARS = 500;
/** stdout 收集上限（防异常输出撑爆内存） */
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
// 与云端 market/service.ts 同口径
const MAX_NAME_CP = 30;
const MAX_SUMMARY_CP = 100;
const MAX_TAG_CP = 10;
/** 自动起草标签数（上限仍是 3，留 1 个给用户自定义） */
export const AUTO_TAG_COUNT = 2;
/** 标签总数上限（与云端 MAX_TAGS/发布表单同口径）：模型给 2 个 + 最多 1 个检索词补位 */
const MAX_TAGS_TOTAL = 3;
// 排除规则与 packager 同源（隐藏文件/目录 + 系统垃圾）
const JUNK_FILES = new Set(['thumbs.db', 'desktop.ini']);

export interface VaultDigest {
  /** 相对路径列表（.md 优先，截断至 MAX_PATHS） */
  fileNames: string[];
  /** 内容摘录（README/index 类优先） */
  snippets: Array<{ file: string; text: string }>;
}

function isExcluded(name: string): boolean {
  return name.startsWith('.') || JUNK_FILES.has(name.toLowerCase());
}

function cpLen(s: string): number { return [...s].length; }
function cpSlice(s: string, max: number): string {
  return cpLen(s) <= max ? s : [...s].slice(0, max).join('');
}

/** 采样 vault：文件清单（.md 优先）+ 少量正文摘录。读取失败的文件静默跳过。 */
export function buildVaultDigest(vaultPath: string, include?: string[]): VaultDigest {
  const mdFiles: string[] = [];
  const otherFiles: string[] = [];
  // 与打包范围一致：选了目录就只看这些一级目录，避免商品页描述未随包交付的内容。
  const allowedTop = include && include.length > 0 ? new Set(include) : null;
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (isExcluded(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!prefix && allowedTop && !allowedTop.has(entry.name)) continue;
        walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        (entry.name.toLowerCase().endsWith('.md') ? mdFiles : otherFiles).push(rel);
      }
    }
  };
  walk(vaultPath, '');
  // 清单/摘录优先级：readme/index 类 > 顶层 md > 嵌套 md（排序同时服务两者）
  const rank = (rel: string): number => {
    const base = rel.split('/').pop()!.toLowerCase().replace(/\.md$/, '');
    if (base === 'readme' || base === 'index' || base === 'home') return 0;
    return rel.includes('/') ? 2 : 1;
  };
  const rankedMd = [...mdFiles].sort((a, b) => rank(a) - rank(b));
  const fileNames = [...rankedMd, ...otherFiles].slice(0, MAX_PATHS);

  const snippets: Array<{ file: string; text: string }> = [];
  for (const rel of rankedMd) {
    if (snippets.length >= MAX_SNIPPET_FILES) break;
    try {
      const text = fs.readFileSync(path.join(vaultPath, rel), 'utf8').slice(0, MAX_SNIPPET_CHARS * 4);
      const clean = text.replace(/\s+/g, ' ').trim();
      if (clean) snippets.push({ file: rel, text: [...clean].slice(0, MAX_SNIPPET_CHARS).join('') });
    } catch { /* 不可读跳过 */ }
  }
  return { fileNames, snippets };
}

/** 起草提示词：只输出一个 JSON 对象（含商品页结构化内容草稿） */
export function composeSuggestPrompt(digest: VaultDigest, contentDigest?: ContentDigest, today?: string): string {
  const lines = [
    '你是 Molio 知识库的发布助手。根据下面的知识库内容，为它撰写资源库上架信息。',
    '这份资源会作为独立页面发布到公网（molio.cn/resource/…），首要目标是',
    '**在站外被搜到、被引用**：先过 Google/Bing 与 ChatGPT/Perplexity 这类搜索和',
    'AI 问答这一关，再考虑卡片好不好看。',
    '',
    '站外检索规则（决定有没有人搜得到，必须照做）：',
    '- 搜索引擎和 AI 主要靠「实体正式名 + 可核对的具体事实」来做匹配和引用。',
    '  标题里必须出现内容的正式名（学科/教材/作品/人物），简介里必须给出数字或范围',
    '  （多少页、多少人物、覆盖哪几册/哪几章）。没有数字和实体名的文案，搜索侧等于没写。',
    '- 写之前先想：用户会在 Google 或 ChatGPT 里怎么输入？把那个说法原样写进名称或简介，',
    '  不要换成意译、比喻或口号。',
    '- 简介第一句要能单独被摘出来当结果摘要：主语明确，不用「你/我们」这类指代，不堆形容词。',
    '',
    '要求：',
    `- queries：3-6 个用户真的会输入的搜索词或问法（每个 ${2}-${MAX_TAG_CP} 个字、不带空格），`,
    '  按「最可能被搜到」排序；后面几个字段要覆盖它们',
    `- name：≤${MAX_NAME_CP} 字（同时是页面 H1、面包屑和结构化数据的 name），`,
    '  格式「内容主体 + 范围/用途」，主体词必须放在最前面，例：',
    '  「人教版高中数学 五册知识图谱」「封神演义 人物关系全解」；',
    '  不要「终极」「一站式」「必看」「大全」这类没有检索价值的营销词占字数',
    `- summary：≤${MAX_SUMMARY_CP} 字的一句事实陈述（也是 meta description 的兜底）：`,
    '  开头就出现主体名与用途，中间给 1-2 个可核对数字（页数/条目数/覆盖范围），',
    '  不要口号，不要「重磅」「干货」这类修饰',
    `- tags：恰好 ${AUTO_TAG_COUNT} 个中文标签（每个 ≤${MAX_TAG_CP} 字）：补名称/简介没覆盖到的`,
    '  检索词——同义词、简称、英文名（如「高数」「微积分」「Calculus」），不要泛词',
    `- icon：从 ${JSON.stringify([...MARKET_ICONS])} 中选最贴切的一个`,
    '',
    '只输出一个 JSON 对象，不要 markdown 围栏，不要任何其他文字：',
    '{"queries":["...","..."],"name":"...","summary":"...","tags":["...","..."],"icon":"...","content":{...}}',
    '',
    '知识库文件清单：',
    ...digest.fileNames.map((f) => `- ${f}`),
  ];
  if (digest.snippets.length > 0) {
    lines.push('', '内容摘录：');
    for (const s of digest.snippets) lines.push(`### ${s.file}`, s.text);
  }
  if (contentDigest) lines.push(...contentPromptLines(contentDigest, today ?? new Date().toISOString().slice(0, 10)));
  return lines.join('\n');
}

/** 从模型输出提取 JSON：容忍 ```json 围栏与前后噪声（取首个 { 到末尾 }） */
export function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>; } catch { return null; }
}

/**
 * 把模型自列的检索词（queries）里**还没出现在名称/简介/标签中**的词补进标签。
 * 标签既上公网页（站外抓取/结构化数据）也参与站内搜索，且是唯一不占标题/简介字数的
 * 检索位，所以缺哪个词就补哪个——只补模型自己声明过的词，不臆造。
 */
export function appendSearchTermTags(
  tags: string[],
  name: string,
  summary: string,
  rawQueries: unknown,
): string[] {
  const out = [...tags];
  if (!Array.isArray(rawQueries)) return out;
  const haystack = (): string => [name, summary, ...out].join(' ').toLowerCase();
  for (const raw of rawQueries) {
    if (out.length >= MAX_TAGS_TOTAL) break;
    if (typeof raw !== 'string') continue;
    const term = raw.trim();
    // 带空格的检索词放不进单个标签（用户输入的多词查询仍会逐词命中，不需要整串）
    if (!term || /\s/.test(term) || cpLen(term) > MAX_TAG_CP) continue;
    if (haystack().includes(term.toLowerCase())) continue;
    out.push(term);
  }
  return out;
}

/** 硬校验 + 截断；名称/简介缺失视为不可用（throw suggest_failed） */
export function normalizeSuggestion(raw: Record<string, unknown>, agentId: string): MarketPublishSuggestion {
  const name = typeof raw['name'] === 'string' ? cpSlice(raw['name'].trim(), MAX_NAME_CP) : '';
  const summary = typeof raw['summary'] === 'string' ? cpSlice(raw['summary'].trim(), MAX_SUMMARY_CP) : '';
  if (!name || !summary) throw new Error('suggest_failed: empty name or summary');
  const tags: string[] = [];
  if (Array.isArray(raw['tags'])) {
    for (const tg of raw['tags']) {
      if (typeof tg !== 'string') continue;
      const v = cpSlice(tg.trim(), MAX_TAG_CP);
      if (v && !tags.includes(v)) tags.push(v);
      if (tags.length >= AUTO_TAG_COUNT) break;
    }
  }
  const icon = typeof raw['icon'] === 'string' && (MARKET_ICONS as readonly string[]).includes(raw['icon'])
    ? raw['icon'] : MARKET_ICONS[0]!;
  return { name, summary, tags: appendSearchTermTags(tags, name, summary, raw['queries']), icon, agentId };
}

export interface PickedAgent { agentId: string; binary: string; }

/** 选第一个可用的起草 agent（claude 优先） */
export function pickSuggestAgent(): PickedAgent | null {
  for (const id of SUGGEST_AGENT_IDS) {
    const def = getAgentDef(id);
    if (!def) continue;
    const configuredEnv = getAgentConfig(id).env || {};
    const result = resolveAgentBinary(def, { configuredEnv });
    if (result.binary) return { agentId: id, binary: result.binary };
  }
  return null;
}

/** 在空临时目录里跑一次性调用；超时强杀；返回 stdout 文本 */
function spawnOneShot(binary: string, args: string[], env: NodeJS.ProcessEnv, prompt: string, timeoutMs: number): Promise<string> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-suggest-'));
  return new Promise((resolve, reject) => {
    const isCmd = needsShellOnWindows(binary);
    const spawnArgs = isCmd
      ? args.map((a) => (/[ "]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
      : args;
    const child = spawn(binary, spawnArgs, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workDir,
      shell: isCmd,
      windowsHide: true,
      windowsVerbatimArguments: process.platform === 'win32' && !isCmd,
    });
    let stdout = '';
    let stdoutLen = 0;
    let stderr = '';
    let stderrLen = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('suggest_timeout'));
    }, timeoutMs);
    const cleanup = () => fs.rmSync(workDir, { recursive: true, force: true });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdoutLen < MAX_STDOUT_BYTES) { stdout += chunk; stdoutLen += chunk.length; }
    });
    child.stderr?.on('data', (chunk: string) => {
      if (stderrLen < MAX_STDERR_BYTES) { stderr += chunk; stderrLen += chunk.length; }
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error(`suggest_failed: spawn: ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      if (code === 0) resolve(stdout);
      else reject(new Error(`suggest_failed: exit ${code}: ${stderr.slice(-500)}`));
    });
    child.stdin?.on('error', () => { /* EPIPE：agent 提前关闭输入，忽略 */ });
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

/** claude：-p --output-format json → 单个 JSON，.result 为最终文本 */
function extractClaudeResult(stdout: string): string {
  const obj = extractJson(stdout);
  if (!obj || typeof obj['result'] !== 'string') throw new Error('suggest_failed: bad claude output');
  if (obj['is_error'] === true) throw new Error('suggest_failed: claude is_error');
  return obj['result'] as string;
}

/** codex：JSONL 事件流 → 最后一个 item.completed 的 agent_message 文本 */
function extractCodexMessage(stdout: string): string {
  let text: string | null = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
    if (obj['type'] === 'item.completed' && typeof obj['item'] === 'object' && obj['item'] !== null) {
      const item = obj['item'] as Record<string, unknown>;
      if (item['type'] === 'agent_message' && typeof item['text'] === 'string') text = item['text'];
    }
  }
  if (text === null) throw new Error('suggest_failed: bad codex output');
  return text;
}

export type OneShotRunner = (agentId: string, prompt: string, timeoutMs: number) => Promise<string>;

/** 真实 runner：解析二进制 → 组 env → spawn → 按 agent 提取最终文本 */
export const defaultOneShotRunner: OneShotRunner = async (agentId, prompt, timeoutMs) => {
  const def = getAgentDef(agentId);
  if (!def) throw new Error('suggest_unavailable');
  const agentConfig = getAgentConfig(agentId);
  const env = buildSpawnEnv(def, buildAgentEnv(agentId, agentConfig));
  const result = resolveAgentBinary(def, { configuredEnv: agentConfig.env || {} });
  if (!result.binary) throw new Error('suggest_unavailable');
  const args = agentId === 'claude'
    ? ['-p', '--output-format', 'json']
    : ['exec', '--json', '--skip-git-repo-check',
      // 与 runtimes/codex.ts 同策略：Windows/WSL 无 read-only 沙箱可用
      ...(process.platform === 'win32' || !!process.env['WSL_DISTRO_NAME']
        ? ['--sandbox', 'danger-full-access']
        : ['--sandbox', 'read-only'])];
  const stdout = await spawnOneShot(result.binary, args, env, prompt, timeoutMs);
  return agentId === 'claude' ? extractClaudeResult(stdout) : extractCodexMessage(stdout);
};

export interface SuggestDeps {
  /** 测试注入：覆盖 agent 选择 */
  pick?: () => PickedAgent | null;
  /** 测试注入：覆盖一次性调用（返回模型最终文本） */
  runner?: OneShotRunner;
  timeoutMs?: number;
}

/**
 * 主入口：采样 → 起草 → 归一。
 * 错误约定（路由按前缀映射状态码）：
 * - suggest_unavailable：无可用起草 agent
 * - suggest_timeout：超时
 * - suggest_failed：其余一切（空库/输出不可解析/字段缺失/进程失败）
 */
export async function suggestPublishMeta(vaultPath: string, deps: SuggestDeps = {}, opts: { include?: string[] } = {}): Promise<MarketPublishSuggestion> {
  const picked = (deps.pick ?? pickSuggestAgent)();
  if (!picked) throw new Error('suggest_unavailable');
  const digest = buildVaultDigest(vaultPath, opts.include);
  if (digest.fileNames.length === 0) throw new Error('suggest_failed: empty vault');
  const contentDigest = buildContentDigest(vaultPath, opts.include);
  const prompt = composeSuggestPrompt(digest, contentDigest);
  const runner = deps.runner ?? defaultOneShotRunner;
  const text = await runner(picked.agentId, prompt, deps.timeoutMs ?? SUGGEST_TIMEOUT_MS);
  const json = extractJson(text);
  if (!json) throw new Error('suggest_failed: unparseable output');
  const meta = normalizeSuggestion(json, picked.agentId);
  // content 是加分项：解析/归一失败只丢内容草稿，不影响名称、简介等元数据。
  const content = json['content'] !== undefined ? normalizeContent(json['content']) : null;
  return content ? { ...meta, content } : meta;
}
