import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { AgentInfo, DiagnosticItem, DiagnosticsReport, Vault } from '@molio/contracts';
import { listVaults } from '../db.js';
import {
  parseDaemonExits,
  parseUpdaterStatus,
  parseWatchFailures,
  readLogTail,
  summarizeDaemonExits,
} from './main-log.js';
import { formatDateTime, formatDuration, sortByLevel } from './copy.js';
import {
  checkAgents,
  checkDaemonExits,
  checkDisk,
  checkSecuritySoftware,
  checkUpdateChannel,
  checkVaults,
  checkVersion,
} from './checks.js';
import type { DiskUsage, VaultProbe } from './checks.js';

/**
 * 体检编排层：按 DiagnosticsDeps 采集事实（每项带超时，单项失败/超时不影响其他项），
 * 交给 checks.ts 判定，产出 DiagnosticsReport 与面向非技术用户的纯文本。
 * 全程只读、确定性产出，不依赖 AI、不访问第三方网络。
 */

export const AGENT_PROBE_TIMEOUT_MS = 8_000;
export const SECURITY_SOFTWARE_TIMEOUT_MS = 5_000;
export const MAIN_LOG_TAIL_LINES = 400;

/** 磁盘探测的返回；label 由编排器按用途赋，探测函数不管 */
export interface DiskSpace {
  freeBytes: number;
  totalBytes: number;
}

export interface DiagnosticsDeps {
  now: () => number;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
  uptimeSec: () => number;
  listVaults: () => Vault[];
  pathExists: (p: string) => boolean | null; // 抛错 → null
  pathWritable: (p: string) => boolean | null; // 抛错 → null
  diskUsage: (p: string) => DiskSpace | null; // 抛错 → null
  detectAgents: () => Promise<AgentInfo[]>;
  listSecuritySoftware: () => Promise<string[] | null>;
  readMainLog: () => string[] | null; // null = 没有日志可读
  timeouts?: { agentProbeMs: number; securitySoftwareMs: number };
}

/** 超时返回兜底值；采集器拒绝同样按兜底处理——诊断宁可「未能检查」，绝不整体失败 */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([p.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

// 三个同步探测自身抛错按 null 处理：单项探测失败绝不打断整场体检
// （「抛错 → null」是这条编排约定；生产 pathWritable 用 false 表达「不可写」，不用抛错）
function probe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

export async function runDiagnostics(deps: DiagnosticsDeps): Promise<DiagnosticsReport> {
  // 先发起两个慢采集（AI 运行时探测、安全软件查询），让它们与下面的同步探测并行跑
  const agentsPromise = deps.detectAgents();
  const securityPromise = deps.listSecuritySoftware();

  const now = deps.now();
  const uptime = deps.uptimeSec();
  const rawVersion = deps.env['MOLIO_APP_VERSION'];
  const version = rawVersion ? rawVersion : null;
  // 只有桌面版才有主进程日志目录；有目录即可断定应用装在 process.execPath 旁
  const installDir = deps.env['MOLIO_MAIN_LOG_DIR'] ? path.dirname(process.execPath) : null;

  // 空日志 = 没有日志：更新状态与退出摘要都按「读不到」处理
  const lines = deps.readMainLog() ?? [];
  const hasLog = lines.length > 0;
  const updaterStatus = hasLog ? parseUpdaterStatus(lines) : null;
  const exitSummary = hasLog ? summarizeDaemonExits(parseDaemonExits(lines), now) : null;
  // 监听失败只看本次启动（Starting daemon 之后）的记录，按 vault id 索引
  const watchByVaultId = new Map(parseWatchFailures(lines).map((w) => [w.vaultId, w.error]));

  const vaultProbes: VaultProbe[] = [];
  const diskUsages: DiskUsage[] = [];
  const dataDir = deps.env['MOLIO_DATA_DIR']?.trim() || path.join(os.homedir(), '.molio');
  const dataUsage = probe(() => deps.diskUsage(dataDir));
  if (dataUsage !== null) {
    diskUsages.push({ label: 'Molio 数据', freeBytes: dataUsage.freeBytes, totalBytes: dataUsage.totalBytes });
  }
  for (const vault of deps.listVaults()) {
    const exists = probe(() => deps.pathExists(vault.path));
    // 只对确认存在的库测可写；exists 探测失败时 writable 不能想当然
    const writable = exists === true ? probe(() => deps.pathWritable(vault.path)) : null;
    vaultProbes.push({
      id: vault.id,
      name: vault.name,
      path: vault.path,
      exists,
      writable,
      watchError: watchByVaultId.get(vault.id) ?? null,
    });
    if (exists === true) {
      const usage = probe(() => deps.diskUsage(vault.path));
      if (usage !== null) {
        diskUsages.push({ label: `知识库「${vault.name}」`, freeBytes: usage.freeBytes, totalBytes: usage.totalBytes });
      }
    }
  }

  const agents = await withTimeout<AgentInfo[] | null>(
    agentsPromise,
    deps.timeouts?.agentProbeMs ?? AGENT_PROBE_TIMEOUT_MS,
    null,
  );
  const security = await withTimeout<string[] | null>(
    securityPromise,
    deps.timeouts?.securitySoftwareMs ?? SECURITY_SOFTWARE_TIMEOUT_MS,
    null,
  );

  // 固定顺序逐项判定；同级别条目的先后就是这个顺序
  const items: DiagnosticItem[] = [
    checkVersion(version),
    checkUpdateChannel(updaterStatus, version),
    checkDaemonExits(exitSummary, security, installDir, now, uptime),
    checkSecuritySoftware(security, deps.platform),
    checkAgents(agents),
    ...checkVaults(vaultProbes, deps.platform),
    checkDisk(diskUsages),
  ];

  return {
    generatedAt: now,
    version,
    platform: `${deps.platform} ${deps.arch}`,
    installDir,
    daemonUptimeSec: uptime,
    items: sortByLevel(items),
  };
}

/** 两行：标题行 + 版本/平台/运行时长；版本取不到写「未知」 */
export function renderDiagnosticsHeader(report: DiagnosticsReport): string {
  return [
    `Molio 体检结果（${formatDateTime(report.generatedAt)}）`,
    `版本：${report.version ?? '未知'} · 平台：${report.platform} · 后台服务已运行 ${formatDuration(report.daemonUptimeSec)}`,
  ].join('\n');
}

// 一个条目 = 「N. 标题：摘要」，有步骤就列「要做的事」；detail 只在明确要求时给支持人员看
function appendItems(lines: string[], items: DiagnosticItem[], withDetail: boolean): void {
  items.forEach((item, i) => {
    lines.push(`${i + 1}. ${item.title}：${item.summary}`);
    if (item.steps && item.steps.length > 0) {
      lines.push('   要做的事：');
      item.steps.forEach((step, si) => lines.push(`   ${si + 1}) ${step}`));
    }
    if (withDetail && item.detail) lines.push(`   详情：${item.detail}`);
  });
}

/** 从【需要处理】起的分节正文；节与节直接相连，空的节整节省略 */
export function renderDiagnosticsBody(report: DiagnosticsReport, opts?: { detail?: boolean }): string {
  const withDetail = opts?.detail === true;
  const errors = report.items.filter((i) => i.level === 'error');
  const warns = report.items.filter((i) => i.level === 'warn');
  const oks = report.items.filter((i) => i.level === 'ok');
  const skips = report.items.filter((i) => i.level === 'skip');

  const lines: string[] = ['【需要处理】'];
  if (errors.length > 0) appendItems(lines, errors, withDetail);
  else lines.push('无');
  if (warns.length > 0) {
    lines.push('【提醒】');
    appendItems(lines, warns, withDetail);
  }
  // 正常/未能检查两节没有可读的摘要，只列标题
  if (oks.length > 0) lines.push(`【正常】${oks.map((i) => i.title).join(' · ')}`);
  if (skips.length > 0) lines.push(`【未能检查】${skips.map((i) => i.title).join(' · ')}`);
  return lines.join('\n');
}

/** header + 空行 + body */
export function renderDiagnosticsText(report: DiagnosticsReport): string {
  return `${renderDiagnosticsHeader(report)}\n\n${renderDiagnosticsBody(report)}`;
}

function statfsUsage(p: string): DiskSpace | null {
  try {
    const s = fs.statfsSync(p);
    return { freeBytes: s.bsize * s.bavail, totalBytes: s.bsize * s.blocks };
  } catch {
    return null;
  }
}

const SECURITY_SOFTWARE_CMD =
  'Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | Select-Object -ExpandProperty displayName';

/** 生产环境的采集实现：db 提供 vault 清单，runManager 提供 AI 运行时探测 */
export function createDiagnosticsDeps(opts: {
  db: Database.Database;
  runManager: { detectAgentsAsync(): Promise<AgentInfo[]> };
}): DiagnosticsDeps {
  const { db, runManager } = opts;
  return {
    now: () => Date.now(),
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    uptimeSec: () => Math.floor(process.uptime()),
    listVaults: () => listVaults(db),
    pathExists: (p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return null;
      }
    },
    // 抛错 = 不可写（目录不可写正是要查的结论），与编排层的抛错→null 约定是两回事
    pathWritable: (p) => {
      try {
        fs.accessSync(p, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    diskUsage: statfsUsage,
    detectAgents: () => runManager.detectAgentsAsync(),
    // 安全软件只有 Windows 有 SecurityCenter2；查不到按 null（未能检查）处理
    listSecuritySoftware: async () => {
      if (process.platform !== 'win32') return null;
      return new Promise<string[] | null>((resolve) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', SECURITY_SOFTWARE_CMD],
          { timeout: 5000 },
          (err, stdout) => {
            if (err) {
              resolve(null);
              return;
            }
            // 按行去空白去重；空输出（没装第三方安全软件）是合法的空列表
            const names = [...new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
            resolve(names);
          },
        );
      });
    },
    readMainLog: () => {
      const dir = process.env['MOLIO_MAIN_LOG_DIR']?.trim();
      if (!dir) return null;
      const lines = readLogTail(path.join(dir, 'updater.log'), MAIN_LOG_TAIL_LINES);
      return lines.length > 0 ? lines : null;
    },
  };
}
