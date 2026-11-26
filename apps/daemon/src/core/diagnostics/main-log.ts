import { readFileSync } from 'node:fs';

/**
 * 桌面主进程日志（main.log / updater.log）的纯解析层：
 * 只做「日志行 → 结构化事实」，不判定健康、不产出诊断项（那是 Task 3+ 的事）。
 * 行格式取自真实日志（见 test/core/diagnostics/fixtures.ts）。
 */

export type DaemonExitKind = 'normal' | 'forced' | 'abnormal';

export interface DaemonExit {
  /** 退出时间（epoch ms）；行首时间戳解析不了为 null */
  at: number | null;
  /** 退出码字符串（'0' / '1' / '3758096392'…），日志里写 null 时同样是 null */
  code: string | null;
  signal: string | null;
  kind: DaemonExitKind;
}

export interface DaemonExitSummary {
  abnormal24h: number;
  abnormal7d: number;
  forced24h: number;
  lastAbnormalAt: number | null;
  /** 7 天窗口内异常退出的退出码，去重、最新在前、最多 3 个 */
  lastAbnormalCodes: string[];
}

export type UpdaterLogState = 'none' | 'ok' | 'available' | 'failed';

export interface UpdaterLogStatus {
  state: UpdaterLogState;
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
  availableVersion: string | null;
}

export interface WatchFailure {
  vaultId: string;
  path: string;
  error: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// —— 识别的行模式 ——
const EXIT_RE = /\[main\] daemon exited with code=(\S+) signal=(\S+)\s*$/;
const TASKKILL_RE = /\[main\] force taskkill sent for daemon pid=/;
const UPD_NO_UPDATE_RE = /\[updater\] no update available/;
const UPD_AVAIL_RE = /\[updater\] update available: v?(\S+)/;
const UPD_AVAIL_SHORT_RE = /\[updater\] v(\S+) available/;
const UPD_FAIL_RE = /\[updater\] check failed: (.+)$/;
const START_RE = /\[main\] Starting daemon: /;
const WATCH_FAIL_RE = /\[daemon\] \[vault-watcher\] failed to watch (\S+) \((.+?)\): (.+)$/;

/** 行首 `[<ts>]` 用 Date.parse；解析不了为 null */
function parseLineTs(line: string): number | null {
  const m = /^\[([^\]]+)\]/.exec(line);
  if (!m) return null;
  const t = Date.parse(m[1]!);
  return Number.isNaN(t) ? null : t;
}

/** 文件不存在或读失败 → []；只保留最后 maxLines 行（末尾换行不算多一行） */
export function readLogTail(filePath: string, maxLines: number): string[] {
  if (maxLines <= 0) return [];
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return []; // 诊断场景读不到就不看这块，绝不抛错
  }
  // 归一换行（win CRLF / 裸 CR），再剥掉末尾换行产生的空尾行
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-maxLines);
}

export function parseDaemonExits(lines: string[]): DaemonExit[] {
  const exits: DaemonExit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = EXIT_RE.exec(lines[i]!);
    if (!m) continue;
    const code = m[1] === 'null' ? null : m[1]!;
    const signal = m[2] === 'null' ? null : m[2]!;
    let kind: DaemonExitKind = 'abnormal';
    if (code === '0') {
      kind = 'normal';
    } else if (code === '1') {
      // 我们自己 force taskkill 后的退出（如端口占用强制重启）不算异常
      for (let j = Math.max(0, i - 5); j < i; j++) {
        if (TASKKILL_RE.test(lines[j]!)) {
          kind = 'forced';
          break;
        }
      }
    }
    exits.push({ at: parseLineTs(lines[i]!), code, signal, kind });
  }
  return exits;
}

export function summarizeDaemonExits(exits: DaemonExit[], now: number): DaemonExitSummary {
  const cutoff24h = now - DAY_MS;
  const cutoff7d = now - 7 * DAY_MS;
  let abnormal24h = 0;
  let abnormal7d = 0;
  let forced24h = 0;
  let lastAbnormalAt: number | null = null;
  const abnormalIn7d: DaemonExit[] = [];
  for (const e of exits) {
    if (e.kind === 'abnormal') {
      if (e.at !== null && e.at >= cutoff24h) abnormal24h++;
      // at 为 null 的退出无法定位到 24h 窗口，只计入 7 天窗口
      if (e.at === null || e.at >= cutoff7d) {
        abnormal7d++;
        abnormalIn7d.push(e);
      }
      if (e.at !== null && (lastAbnormalAt === null || e.at > lastAbnormalAt)) lastAbnormalAt = e.at;
    } else if (e.kind === 'forced' && e.at !== null && e.at >= cutoff24h) {
      forced24h++;
    }
  }
  // 最新在前；at 为 null 的排最后（无法定位时间）
  abnormalIn7d.sort((a, b) => (b.at ?? Number.NEGATIVE_INFINITY) - (a.at ?? Number.NEGATIVE_INFINITY));
  const codes: string[] = [];
  for (const e of abnormalIn7d) {
    if (e.code === null || codes.includes(e.code)) continue;
    codes.push(e.code);
    if (codes.length >= 3) break;
  }
  return { abnormal24h, abnormal7d, forced24h, lastAbnormalAt, lastAbnormalCodes: codes };
}

export function parseUpdaterStatus(lines: string[]): UpdaterLogStatus {
  let state: UpdaterLogState = 'none';
  let consecutiveFailures = 0;
  let lastSuccessAt: number | null = null;
  let lastFailureAt: number | null = null;
  let lastError: string | null = null;
  let availableVersion: string | null = null;
  // 出现过 available 且之后没有回到「检查成功」，失败不把状态打成 failed（更新仍然挂着）
  let availableSinceCleanSuccess = false;

  for (const line of lines) {
    const ts = parseLineTs(line);
    if (UPD_NO_UPDATE_RE.test(line)) {
      state = 'ok';
      consecutiveFailures = 0;
      if (ts !== null) lastSuccessAt = ts;
      availableSinceCleanSuccess = false;
      continue;
    }
    const avail = UPD_AVAIL_RE.exec(line) ?? UPD_AVAIL_SHORT_RE.exec(line);
    if (avail) {
      state = 'available';
      availableVersion = avail[1]!;
      consecutiveFailures = 0;
      if (ts !== null) lastSuccessAt = ts;
      availableSinceCleanSuccess = true;
      continue;
    }
    const fail = UPD_FAIL_RE.exec(line);
    if (fail) {
      consecutiveFailures++;
      if (ts !== null) lastFailureAt = ts;
      lastError = fail[1]!;
      if (!availableSinceCleanSuccess) state = 'failed';
    }
  }
  return { state, consecutiveFailures, lastSuccessAt, lastFailureAt, lastError, availableVersion };
}

export function parseWatchFailures(lines: string[]): WatchFailure[] {
  // 只看本次启动：最后一行 Starting daemon 之后的监听失败才算当前会话的
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (START_RE.test(lines[i]!)) startIdx = i;
  }
  if (startIdx === -1) return [];
  const failures: WatchFailure[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = WATCH_FAIL_RE.exec(lines[i]!);
    if (m) failures.push({ vaultId: m[1]!, path: m[2]!, error: m[3]! });
  }
  return failures;
}
