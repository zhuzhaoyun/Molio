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
import { buildAgentEnv, getAgentConfig } from '../config.js';
import { buildSpawnEnv } from '../runtimes/env.js';
import { needsShellOnWindows, resolveAgentBinary } from '../runtimes/launch.js';
import { getAgentDef } from '../runtimes/registry.js';

/** 支持一次性起草的 agent（按偏好序） */
export const SUGGEST_AGENT_IDS = ['claude', 'codex'] as const;
/** 首次启动/冷缓存可能较慢，给足时间；前端有 loading 态 */
export const SUGGEST_TIMEOUT_MS = 120_000;
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
export function buildVaultDigest(vaultPath: string): VaultDigest {
  const mdFiles: string[] = [];
  const otherFiles: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (isExcluded(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
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

/** 起草提示词：只输出一个 JSON 对象 */
export function composeSuggestPrompt(digest: VaultDigest): string {
  const lines = [
    '你是 Molio 知识库的发布助手。根据下面的知识库内容，为它撰写资源库上架信息，',
    '让浏览者一眼就想下载。',
    '',
    '要求：',
    `- name：吸引人的中文标题，不超过 ${MAX_NAME_CP} 字。不要泛泛的"某某知识库"，`,
    '  要突出内容独特价值（如"红楼梦人物关系全解"而非"红楼梦笔记"）',
    `- summary：一句中文简介，不超过 ${MAX_SUMMARY_CP} 字。用"包含/覆盖/适合"开头，`,
    '  说清三件事：里面有什么、能用来做什么、适合谁',
    `- tags：恰好 ${AUTO_TAG_COUNT} 个中文标签，每个不超过 ${MAX_TAG_CP} 字，概括内容领域`,
    `- icon：从 ${JSON.stringify([...MARKET_ICONS])} 中选最贴切的一个`,
    '',
    '只输出一个 JSON 对象，不要 markdown 围栏，不要任何其他文字：',
    '{"name":"...","summary":"...","tags":["...","..."],"icon":"..."}',
    '',
    '知识库文件清单：',
    ...digest.fileNames.map((f) => `- ${f}`),
  ];
  if (digest.snippets.length > 0) {
    lines.push('', '内容摘录：');
    for (const s of digest.snippets) lines.push(`### ${s.file}`, s.text);
  }
  return lines.join('\n');
}

/** 从模型输出提取 JSON：容忍 ```json 围栏与前后噪声（取首个 { 到末尾 }） */
export function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>; } catch { return null; }
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
  return { name, summary, tags, icon, agentId };
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
export async function suggestPublishMeta(vaultPath: string, deps: SuggestDeps = {}): Promise<MarketPublishSuggestion> {
  const picked = (deps.pick ?? pickSuggestAgent)();
  if (!picked) throw new Error('suggest_unavailable');
  const digest = buildVaultDigest(vaultPath);
  if (digest.fileNames.length === 0) throw new Error('suggest_failed: empty vault');
  const prompt = composeSuggestPrompt(digest);
  const runner = deps.runner ?? defaultOneShotRunner;
  const text = await runner(picked.agentId, prompt, deps.timeoutMs ?? SUGGEST_TIMEOUT_MS);
  const json = extractJson(text);
  if (!json) throw new Error('suggest_failed: unparseable output');
  return normalizeSuggestion(json, picked.agentId);
}