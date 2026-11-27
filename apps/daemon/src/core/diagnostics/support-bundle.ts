import fs from 'node:fs';
import path from 'node:path';
import type { DiagnosticsReport } from '@molio/contracts';
import { formatDateTime, formatDuration } from './copy.js';
import { renderDiagnosticsBody } from './run-diagnostics.js';

/**
 * 支持包生成：体检结果 + 过滤后的主进程日志 → 单个本地文本文件，用户手动发给支持人员。
 * 隐私是硬性要求：不含对话内容、文档正文、密钥、账号标识；日志只保留四类白名单标签的行，
 * 全文里的主目录用户名一律打码；只写这一个文件，不自动上传。
 */

/** 支持包带出的主进程日志上限（行） */
export const BUNDLE_LOG_LINES = 300;

// 白名单只留这四类：机器状态、后台运行与更新记录，是支持人员定位问题必需的。
// 刻意排除 [auth-status-watch]（带账号标识）与 [monitoring] / [daemon-metrics]（遥测）——
// 这台机器的身份与使用情况不随支持包出去。
const KEEP_COMPONENTS = new Set(['main', 'daemon', 'updater', 'wiki-fetcher']);

// 标签行形如 `[<时间戳>] [LEVEL] [component] …`；不带这个前缀的行是上一行的续行。
// 分组间用 \s+：格式抖动（多空格）宁可按标签行丢弃，也不当续行带出去
const TAGGED_LINE_RE = /^\[[^\]]+\]\s+\[[^\]]+\]\s+\[([^\]]+)\]/;

const REDACTED = '<用户>';

export function filterLogForBundle(lines: string[]): string[] {
  const kept: string[] = [];
  let prevKept = false;
  for (const line of lines) {
    const m = TAGGED_LINE_RE.exec(line);
    if (m !== null) {
      // 标签行按白名单取舍；它同时决定紧随续行的去留
      prevKept = KEEP_COMPONENTS.has(m[1]!);
      if (prevKept) kept.push(line);
    } else if (prevKept) {
      // 续行链：续行之后还是续行；一旦标签行被丢弃，链条就地断开
      kept.push(line);
    }
  }
  return kept;
}

// —— 主目录打码 ——
// 路径分隔符认三种写法：JSON 转义的两个反斜杠（日志里被 JSON 序列化过的 Windows 路径必然如此）、
// 转义的斜杠 \/、单反斜杠、斜杠；备选按最长优先，替换时整段保留在原位，只换掉用户名。
// 用户名段到「分隔符 / 引号 / 换行 / Windows 用户名不可能出现的字符」中最先出现的那个为止
// （Windows 用户名可含空格——只有第一个终止的不是分隔符时才回退到空白；POSIX 用户名一遇空白即止；
// 撇号例外：O'Brien 形态按 findUsernameEnd 里的规则判定归属，不残留半个用户名）。
// <用户> 以 < 开头、天然落在终止集里，所以对已打码文本幂等；空的用户名段（根恰在行尾等）不产生打码。

const SEP_SRC = String.raw`\\\\|\\/|\\|/`;
// 引号、换行、Windows 用户名的非法字符
const NAME_STOP_SRC = String.raw`"'<>|:*?(){}\[\],;`;
// UNC 的 server/share 名：不含分隔符、引号、换行与其余终止字符（可含空格）
const NAME_CLASS_SRC = String.raw`[^\\/'"<>|:*?()\[\]{},;\r\n]+`;

// 主目录根（不区分大小写）：盘符形态 C:\Users\ 与 UNC 形态 \\server\share\Users\
const WIN_ROOT_RE = new RegExp(
  String.raw`[A-Za-z]:(?:${SEP_SRC})Users(?:${SEP_SRC})`
    + String.raw`|\\\\${NAME_CLASS_SRC}(?:${SEP_SRC})${NAME_CLASS_SRC}(?:${SEP_SRC})Users(?:${SEP_SRC})`,
  'gi',
);
// 主目录根（区分大小写）：/Users/、/home/ 及其 JSON 转义写法 \/Users\/
const POSIX_ROOT_RE = new RegExp(String.raw`(?:\\/|/)(?:Users|home)(?:${SEP_SRC})`, 'g');

const NAME_STOP_CHARS = '\n\r"\'<>|:*?()[]{},;';

function isNameStop(ch: string): boolean {
  return NAME_STOP_CHARS.includes(ch);
}

function isWs(ch: string): boolean {
  return /\s/.test(ch);
}

/** 用户名段的终点（不含终点字符本身）；返回值等于 from 表示没有用户名可打码 */
function findUsernameEnd(text: string, from: number, posix: boolean): number {
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'") {
      // 撇号是 O'Brien 这类用户名的一部分：之后最近的终止类字符若是分隔符或引号，
      // 撇号属于用户名、继续扫描；否则（空白/换行/非法字符/行尾）撇号终止用户名。
      // 用户名为空时遇到的撇号只是空段/收尾引号，直接终止、不产生打码
      if (i === from) return i;
      const t = nextTerminatorLike(text, i + 1);
      if (t === '\\' || t === '/' || t === '"' || t === "'") continue;
      return i;
    }
    if (ch === '"' || ch === '\\' || ch === '/' || isNameStop(ch)) {
      // 第一个终止的是引号/换行/非法字符（不是分隔符）：用户名退到第一个空白，
      // 没有空白则到终止字符为止——「C:\Users\bob" then D:\data」因此不吞引号与其后的正文
      if (posix || (ch !== '\\' && ch !== '/')) {
        for (let j = from; j < i; j++) {
          if (isWs(text[j]!)) return j;
        }
      }
      return i;
    }
    // POSIX 用户名不含空白；Windows 的空白由上面的回退分支统一处理
    if (posix && isWs(ch)) return i;
  }
  // 后面既无分隔符也无终止字符：到第一个空白为止（POSIX 在循环里已提前返回）
  for (let j = from; j < text.length; j++) {
    if (isWs(text[j]!)) return j;
  }
  return text.length;
}

/** from 起最近一个「终止类」字符（分隔符、引号、空白、换行、Windows 用户名非法字符），行尾返回 '' */
function nextTerminatorLike(text: string, from: number): string {
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\\' || ch === '/' || ch === '"' || ch === "'" || isWs(ch) || isNameStop(ch)) return ch;
  }
  return '';
}

function redactByRoot(text: string, rootRe: RegExp, posix: boolean): string {
  let out = '';
  let last = 0;
  rootRe.lastIndex = 0;
  for (let m = rootRe.exec(text); m !== null; m = rootRe.exec(text)) {
    const rootEnd = m.index + m[0]!.length;
    const end = findUsernameEnd(text, rootEnd, posix);
    if (end > rootEnd) {
      out += text.slice(last, rootEnd) + REDACTED;
      last = end;
    }
  }
  return out + text.slice(last);
}

export function redactHomePaths(text: string): string {
  // 两种形态各扫一遍：打码只替换用户名切片，根与其后的分隔符/引号原样保留
  return redactByRoot(redactByRoot(text, WIN_ROOT_RE, false), POSIX_ROOT_RE, true);
}

export function buildSupportBundle(report: DiagnosticsReport, logLines: string[]): string {
  const bundleLines = filterLogForBundle(logLines);
  const lines: string[] = [
    'Molio 支持包',
    // 用报告的生成时间而不是当前时钟：支持包内容与体检结果严格一致
    `生成时间：${formatDateTime(report.generatedAt)}`,
    `版本：${report.version ?? '未知'} · 平台：${report.platform}`,
  ];
  // 开发模式没有安装目录，整行省略而不是写「undefined」
  if (report.installDir !== null) lines.push(`安装目录：${report.installDir}`);
  lines.push(
    `后台服务已运行 ${formatDuration(report.daemonUptimeSec)}`,
    '',
    '== 体检结果 ==',
    renderDiagnosticsBody(report, { detail: true }),
    '',
    `== 运行日志（最近 ${bundleLines.length} 行，已去除账号信息，用户名已打码）==`,
    bundleLines.join('\n'),
    '',
    '本文件由 Molio 体检自动生成，只包含体检结果与运行日志，不包含对话内容和文档正文。',
  );
  // 打码作用于整篇而不只日志段：体检结果的摘要/详情同样可能带库路径与安装目录里的用户名
  return redactHomePaths(lines.join('\n'));
}

export function writeSupportBundle(content: string, dir: string, now: number): string {
  fs.mkdirSync(dir, { recursive: true });
  // 文件名取 now 的本地时间，用户看文件名就能对上生成时刻
  const d = new Date(now);
  const p = (v: number) => String(v).padStart(2, '0');
  const fileName = `molio-support-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.txt`;
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}
