import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentInfo, DiagnosticItem } from '@molio/contracts';
import {
  humanizeUpdateError,
  formatDuration,
  formatGB,
  formatClock,
  formatDateTime,
  sortByLevel,
} from '../../../src/core/diagnostics/copy.js';
import {
  checkVersion,
  checkUpdateChannel,
  checkDaemonExits,
  checkSecuritySoftware,
  checkAgents,
  checkVaults,
  checkDisk,
} from '../../../src/core/diagnostics/checks.js';
import type { VaultProbe, DiskUsage } from '../../../src/core/diagnostics/checks.js';
import type { DaemonExitSummary, UpdaterLogStatus } from '../../../src/core/diagnostics/main-log.js';

/**
 * 体检项与文案的单测：规则即 task brief 里的规则表，这里逐行断言
 * (level, title, summary) 与 steps / actions / detail / subject。
 * 时间一律用显式构造的本地时间，不依赖真实当前时间（formatClock 的 ok 行除外，
 * 那里按约定用「今天零点」构造）。
 */

// 本地时间 2026-11-24 09:05 / 12:00
const T_0905 = new Date(2026, 10, 24, 9, 5).getTime();
const NOW = new Date(2026, 10, 24, 12, 0).getTime();

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'claude',
    name: 'Claude Code',
    available: true,
    models: [],
    installable: false,
    ...overrides,
  };
}

function makeVault(overrides: Partial<VaultProbe> = {}): VaultProbe {
  return {
    id: 'v1',
    name: '我的知识库',
    path: '/Users/demo/vault',
    exists: true,
    writable: true,
    watchError: null,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<DaemonExitSummary> = {}): DaemonExitSummary {
  return {
    abnormal24h: 0,
    abnormal7d: 0,
    forced24h: 0,
    lastAbnormalAt: null,
    lastAbnormalCodes: [],
    ...overrides,
  };
}

describe('copy.ts 格式化函数', () => {
  it('humanizeUpdateError 按错误特征分类', () => {
    assert.equal(humanizeUpdateError('net::ERR_NAME_NOT_RESOLVED at update.molio.cn'), '网络无法解析更新服务器（断网、代理或 DNS 问题）');
    assert.equal(humanizeUpdateError('net::ERR_CONNECTION_TIMED_OUT'), '连接不上更新服务器');
    assert.equal(humanizeUpdateError('net::ERR_CONNECTION_REFUSED'), '连接不上更新服务器');
    assert.equal(humanizeUpdateError('net::ERR_INTERNET_DISCONNECTED'), '连接不上更新服务器');
    assert.equal(humanizeUpdateError('net::ERR_NETWORK_CHANGED'), '连接不上更新服务器');
    assert.equal(humanizeUpdateError('HTTP 500'), '更新服务器返回错误');
  });

  it('formatDuration 取整并省略零分量', () => {
    assert.equal(formatDuration(3725), '1 小时 2 分');
    assert.equal(formatDuration(3600), '1 小时');
    assert.equal(formatDuration(125), '2 分');
    assert.equal(formatDuration(45), '45 秒');
    assert.equal(formatDuration(0), '0 秒');
  });

  it('formatGB 始终一位小数', () => {
    assert.equal(formatGB(86.4 * 1024 ** 3), '86.4 GB');
    assert.equal(formatGB(0.5 * 1024 ** 3), '0.5 GB');
    assert.equal(formatGB(10 * 1024 ** 3), '10.0 GB');
  });

  it('formatClock 当天显示 HH:mm，更早显示 M月D日 HH:mm', () => {
    const later = new Date(2026, 10, 24, 18, 30).getTime();
    assert.equal(formatClock(T_0905, later), '09:05');
    assert.equal(formatClock(T_0905, NOW), '09:05');
    const yesterday = new Date(2026, 10, 23, 9, 5).getTime();
    assert.equal(formatClock(yesterday, NOW), '11月23日 09:05');
    const lastMonth = new Date(2026, 9, 5, 9, 5).getTime();
    assert.equal(formatClock(lastMonth, NOW), '10月5日 09:05');
  });

  it('formatDateTime 本地时间零填充', () => {
    assert.equal(formatDateTime(T_0905), '2026-11-24 09:05');
  });

  it('sortByLevel 按 error→warn→ok→skip 稳定排序', () => {
    const items: DiagnosticItem[] = [
      { code: 'a', level: 'ok', title: 'a', summary: '' },
      { code: 'b', level: 'error', title: 'b', summary: '' },
      { code: 'c', level: 'ok', title: 'c', summary: '' },
      { code: 'd', level: 'skip', title: 'd', summary: '' },
      { code: 'e', level: 'warn', title: 'e', summary: '' },
    ];
    assert.deepEqual(
      sortByLevel(items).map((i) => i.code),
      ['b', 'e', 'a', 'c', 'd'],
    );
    // 不改原数组
    assert.equal(items[0]?.code, 'a');
  });
});

describe('checkVersion', () => {
  it('无版本号 → skip', () => {
    const item = checkVersion(null);
    assert.equal(item.code, 'app.version');
    assert.equal(item.level, 'skip');
    assert.equal(item.title, '版本');
    assert.equal(item.summary, '开发模式下没有版本号');
  });

  it('有版本号 → ok', () => {
    const item = checkVersion('0.4.8');
    assert.equal(item.code, 'app.version');
    assert.equal(item.level, 'ok');
    assert.equal(item.title, '版本');
    assert.equal(item.summary, 'Molio 版本 0.4.8');
    assert.ok(!('steps' in item));
    assert.ok(!('actions' in item));
  });
});

describe('checkUpdateChannel', () => {
  it('无记录（null 或 state=none）→ skip', () => {
    for (const status of [null, { state: 'none', consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, availableVersion: null } satisfies UpdaterLogStatus]) {
      const item = checkUpdateChannel(status, '0.4.8');
      assert.equal(item.code, 'update.channel');
      assert.equal(item.level, 'skip');
      assert.equal(item.title, '自动更新');
      assert.equal(item.summary, '没有更新检查记录');
    }
  });

  it('available → warn，带检查更新步骤与动作', () => {
    const status: UpdaterLogStatus = { state: 'available', consecutiveFailures: 0, lastSuccessAt: T_0905, lastFailureAt: null, lastError: null, availableVersion: '0.5.0' };
    const item = checkUpdateChannel(status, '0.4.8');
    assert.equal(item.code, 'update.channel');
    assert.equal(item.level, 'warn');
    assert.equal(item.title, '有新版本可用');
    assert.equal(item.summary, '可以更新到 0.5.0（当前 0.4.8）');
    assert.deepEqual(item.steps, ['点击「检查更新」，下载完成后按提示重启 Molio']);
    assert.deepEqual(item.actions, [{ code: 'check-updates', label: '检查更新' }]);
    assert.ok(!('detail' in item));
  });

  it('available 且无当前版本 → 省略括号', () => {
    const status: UpdaterLogStatus = { state: 'available', consecutiveFailures: 0, lastSuccessAt: T_0905, lastFailureAt: null, lastError: null, availableVersion: '0.5.0' };
    const item = checkUpdateChannel(status, null);
    assert.equal(item.summary, '可以更新到 0.5.0');
  });

  it('failed 连续 ≥ 3 次 → error，detail 保留原始错误', () => {
    const raw = 'net::ERR_NAME_NOT_RESOLVED at update.molio.cn';
    const status: UpdaterLogStatus = { state: 'failed', consecutiveFailures: 3, lastSuccessAt: null, lastFailureAt: T_0905, lastError: raw, availableVersion: null };
    const item = checkUpdateChannel(status, '0.4.8');
    assert.equal(item.level, 'error');
    assert.equal(item.title, '自动更新一直连不上');
    assert.equal(item.summary, `已连续失败 3 次：网络无法解析更新服务器（断网、代理或 DNS 问题）`);
    assert.equal(item.detail, raw);
    assert.deepEqual(item.steps, ['检查电脑的网络或代理设置是否正常', '也可以联系 Molio 支持人员获取最新安装包，运行后按提示安装']);
    assert.deepEqual(item.actions, [{ code: 'check-updates', label: '检查更新' }]);
  });

  it('failed 连续 1–2 次 → warn，无 detail', () => {
    const status: UpdaterLogStatus = { state: 'failed', consecutiveFailures: 1, lastSuccessAt: null, lastFailureAt: T_0905, lastError: 'net::ERR_CONNECTION_TIMED_OUT', availableVersion: null };
    const item = checkUpdateChannel(status, '0.4.8');
    assert.equal(item.level, 'warn');
    assert.equal(item.title, '更新检查失败过');
    assert.equal(item.summary, '最近一次检查失败：连接不上更新服务器');
    assert.deepEqual(item.steps, ['检查电脑的网络或代理设置是否正常', '也可以联系 Molio 支持人员获取最新安装包，运行后按提示安装']);
    assert.deepEqual(item.actions, [{ code: 'check-updates', label: '检查更新' }]);
    assert.ok(!('detail' in item));
  });

  it('ok → 已是最新，带上次检查时间', () => {
    // 今天零点：formatClock 用缺省 now 也稳定输出 00:00
    const lastSuccessAt = new Date().setHours(0, 0, 0, 0);
    const status: UpdaterLogStatus = { state: 'ok', consecutiveFailures: 0, lastSuccessAt, lastFailureAt: null, lastError: null, availableVersion: null };
    const item = checkUpdateChannel(status, '0.4.8');
    assert.equal(item.level, 'ok');
    assert.equal(item.title, '自动更新');
    assert.equal(item.summary, '已是最新（上次检查 00:00）');
    assert.ok(!('steps' in item));
    assert.ok(!('actions' in item));
  });

  it('ok 但没有时间 → 只剩「已是最新」', () => {
    const status: UpdaterLogStatus = { state: 'ok', consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, availableVersion: null };
    assert.equal(checkUpdateChannel(status, '0.4.8').summary, '已是最新');
  });
});

describe('checkDaemonExits', () => {
  it('summary=null → skip，说明读不到日志', () => {
    const item = checkDaemonExits(null, null, null, null, NOW, 3725);
    assert.equal(item.code, 'daemon.exits');
    assert.equal(item.level, 'skip');
    assert.equal(item.title, '后台服务');
    assert.equal(item.summary, '已运行 1 小时 2 分，但读不到运行日志，无法判断有没有异常退出过');
  });

  it('24 小时内异常退出 → error，带最近时间、退出码与安全软件步骤', () => {
    const summary = makeSummary({ abnormal24h: 2, abnormal7d: 2, lastAbnormalAt: T_0905, lastAbnormalCodes: ['3758096392', '1'] });
    const item = checkDaemonExits(summary, ['360 安全卫士', '火绒'], 'C:\\Program Files\\Molio', null, NOW, 7200);
    assert.equal(item.code, 'daemon.exits');
    assert.equal(item.level, 'error');
    assert.equal(item.title, '后台服务异常退出过');
    assert.equal(item.summary, '最近 24 小时 Molio 的后台服务意外停止了 2 次（最近一次 09:05）');
    assert.equal(item.detail, '退出码：3758096392、1');
    assert.deepEqual(item.steps, [
      '您的电脑上装有 360 安全卫士、火绒，它可能把 Molio 误当成可疑程序。请把 Molio 的安装目录加入它的信任区（白名单）：C:\\Program Files\\Molio',
      '如果 Molio 的文件已经被安全软件隔离过，退出安全软件并不会找回文件——请到安全软件的「隔离区／恢复区」里恢复，或重新安装一次 Molio',
      '然后重启 Molio，再试一次刚才失败的操作',
    ]);
    assert.deepEqual(item.actions, [{ code: 'restart-app', label: '重启 Molio' }]);
  });

  it('24 小时内异常退出但无时间与安全软件 → 通用提示，不追加目录', () => {
    const summary = makeSummary({ abnormal24h: 1, abnormal7d: 1, lastAbnormalAt: null, lastAbnormalCodes: [] });
    const item = checkDaemonExits(summary, null, null, null, NOW, 7200);
    assert.equal(item.level, 'error');
    assert.equal(item.summary, '最近 24 小时 Molio 的后台服务意外停止了 1 次');
    assert.ok(!('detail' in item));
    assert.deepEqual(item.steps, [
      '如果电脑上装有 360、火绒、电脑管家等安全软件，请把 Molio 的安装目录加入它们的信任区（白名单）',
      '如果 Molio 的文件已经被安全软件隔离过，退出安全软件并不会找回文件——请到安全软件的「隔离区／恢复区」里恢复，或重新安装一次 Molio',
      '然后重启 Molio，再试一次刚才失败的操作',
    ]);
  });

  it('杀软步骤同时列安装目录与数据目录，并含隔离区恢复提示', () => {
    // 2026-11-25 客户装机报障的教训：①一键安装的 AI 运行时（claude.exe，无数字签名）
    // 落在数据目录，杀软同样会盯上，白名单必须覆盖两个目录；②已被隔离的文件退出
    // 杀软不会自动恢复，必须去隔离区捞或重装
    const summary = makeSummary({ abnormal24h: 1, abnormal7d: 1, lastAbnormalAt: null, lastAbnormalCodes: [] });
    const item = checkDaemonExits(summary, ['火绒'], 'C:\\Users\\u\\AppData\\Local\\Programs\\Molio', 'C:\\Users\\u\\.molio', NOW, 7200);
    assert.deepEqual(item.steps, [
      '您的电脑上装有 火绒，它可能把 Molio 误当成可疑程序。请把 Molio 的安装目录与数据目录都加入它的信任区（白名单）：安装目录 C:\\Users\\u\\AppData\\Local\\Programs\\Molio；数据目录 C:\\Users\\u\\.molio（一键安装的 AI 运行时也在这里）',
      '如果 Molio 的文件已经被安全软件隔离过，退出安全软件并不会找回文件——请到安全软件的「隔离区／恢复区」里恢复，或重新安装一次 Molio',
      '然后重启 Molio，再试一次刚才失败的操作',
    ]);
  });

  it('7 天窗口内退出 → warn，forced24h=0 时不追加强制结束子句', () => {
    const summary = makeSummary({ abnormal7d: 1 });
    const item = checkDaemonExits(summary, null, null, null, NOW, 7200);
    assert.equal(item.level, 'warn');
    assert.equal(item.title, '后台服务退出过');
    assert.equal(item.summary, '过去 7 天后台服务意外停止了 1 次');
    assert.ok(!('detail' in item));
    assert.deepEqual(item.actions, [{ code: 'restart-app', label: '重启 Molio' }]);
  });

  it('只有强制结束 → warn，追加强制结束子句', () => {
    const summary = makeSummary({ forced24h: 2 });
    const item = checkDaemonExits(summary, null, null, null, NOW, 7200);
    assert.equal(item.level, 'warn');
    assert.equal(item.summary, '过去 7 天后台服务意外停止了 0 次，关闭时无响应被强制结束 2 次');
  });

  it('全部正常 → ok', () => {
    const item = checkDaemonExits(makeSummary(), null, null, null, NOW, 3600);
    assert.equal(item.level, 'ok');
    assert.equal(item.title, '后台服务');
    assert.equal(item.summary, '运行中 · 已运行 1 小时，没有异常退出的记录');
    assert.ok(!('steps' in item));
    assert.ok(!('detail' in item));
  });
});

describe('checkSecuritySoftware', () => {
  it('非 Windows → skip', () => {
    const item = checkSecuritySoftware(['360 安全卫士'], 'darwin');
    assert.equal(item.code, 'system.security-software');
    assert.equal(item.level, 'skip');
    assert.equal(item.title, '安全软件');
    assert.equal(item.summary, '只能在 Windows 上检查');
  });

  it('读取失败 → skip', () => {
    const item = checkSecuritySoftware(null, 'win32');
    assert.equal(item.level, 'skip');
    assert.equal(item.summary, '未能读取安全软件列表');
  });

  it('空数组 → ok', () => {
    const item = checkSecuritySoftware([], 'win32');
    assert.equal(item.level, 'ok');
    assert.equal(item.summary, '没有发现第三方安全软件');
  });

  it('有安装 → ok，顿号连接', () => {
    const item = checkSecuritySoftware(['360 安全卫士', '火绒'], 'win32');
    assert.equal(item.level, 'ok');
    assert.equal(item.summary, '已安装：360 安全卫士、火绒');
  });
});

describe('checkAgents', () => {
  it('null → skip', () => {
    const item = checkAgents(null);
    assert.equal(item.code, 'runtime.agents');
    assert.equal(item.level, 'skip');
    assert.equal(item.title, 'AI 运行时');
    assert.equal(item.summary, '未能检测');
  });

  it('无可用 → error，带设置入口步骤与动作', () => {
    const item = checkAgents([
      makeAgent({ id: 'claude', available: false, probeError: 'spawn ENOENT' }),
      makeAgent({ id: 'codex', name: 'Codex', available: false, probeError: 'permission denied' }),
    ]);
    assert.equal(item.level, 'error');
    assert.equal(item.title, '没有可用的 AI 运行时');
    assert.equal(item.summary, 'Molio 需要至少一个 AI 运行时（例如 Claude Code）才能对话');
    assert.deepEqual(item.steps, ['打开「设置 → AI 运行时」，安装或配置一个运行时']);
    assert.deepEqual(item.actions, [{ code: 'open-url', label: '去设置', target: '/settings?tab=runtimes' }]);
    // detail 只在「有可用」的 ok 行定义，全不可用行不产出
    assert.ok(!('detail' in item));
  });

  it('有可用 → ok，可用项顿号连接，不可用项进 detail', () => {
    const item = checkAgents([
      makeAgent({ name: 'Claude Code', version: '2.1.233' }),
      makeAgent({ id: 'codex', name: 'Codex', available: false, probeError: 'spawn ENOENT' }),
    ]);
    assert.equal(item.level, 'ok');
    assert.equal(item.title, 'AI 运行时');
    assert.equal(item.summary, '可用：Claude Code 2.1.233');
    assert.equal(item.detail, 'Codex: spawn ENOENT');
  });

  it('不可用项没有 probeError → 不产出 detail', () => {
    const item = checkAgents([makeAgent(), makeAgent({ id: 'codex', name: 'Codex', available: false, probeError: null })]);
    assert.equal(item.level, 'ok');
    assert.equal(item.summary, '可用：Claude Code');
    assert.ok(!('detail' in item));
  });
});

describe('checkVaults', () => {
  it('空数组 → 不产出 item', () => {
    assert.deepEqual(checkVaults([], 'darwin'), []);
  });

  it('文件夹找不到 → error，subject/detail 为名称与路径', () => {
    const item = checkVaults([makeVault({ exists: false, path: '/Volumes/My Passport/demo' })], 'darwin')[0];
    assert.ok(item);
    assert.equal(item.code, 'vault.missing');
    assert.equal(item.level, 'error');
    assert.equal(item.subject, '我的知识库');
    assert.equal(item.title, '知识库文件夹找不到');
    assert.equal(item.summary, '「我的知识库」的位置：/Volumes/My Passport/demo');
    assert.equal(item.detail, '/Volumes/My Passport/demo');
    assert.deepEqual(item.steps, [
      '如果它放在移动硬盘或网络盘上，请先连接好',
      '如果文件夹已经被移动或改名，请在仓库管理器里重新打开它的新位置',
    ]);
    assert.ok(!('actions' in item));
  });

  it('无法写入（darwin）→ error，NTFS 提示', () => {
    const item = checkVaults([makeVault({ writable: false })], 'darwin')[0];
    assert.ok(item);
    assert.equal(item.code, 'vault.readonly');
    assert.equal(item.level, 'error');
    assert.equal(item.subject, '我的知识库');
    assert.equal(item.title, '知识库文件夹无法写入');
    assert.equal(item.summary, 'Molio 需要在「我的知识库」里创建索引和技能文件，但被系统拒绝了');
    assert.equal(item.detail, '/Users/demo/vault');
    assert.deepEqual(item.steps, [
      '如果知识库在 NTFS 格式的移动硬盘上：这种硬盘连接 Mac 时默认只读。请换一个可写的磁盘，或改用在 Windows 上的知识库',
      '也可以在仓库管理器里新建一个知识库，把资料放进新位置',
    ]);
  });

  it('无法写入（win32）→ 右键属性提示', () => {
    const item = checkVaults([makeVault({ writable: false })], 'win32')[0];
    assert.ok(item);
    assert.deepEqual(item.steps, [
      '右键这个文件夹 → 属性，取消勾选「只读」',
      '如果仍然不行，检查安全软件是否开启了文件夹保护',
    ]);
  });

  it('无法写入（其他平台）→ 权限提示', () => {
    const item = checkVaults([makeVault({ writable: false })], 'linux')[0];
    assert.ok(item);
    assert.deepEqual(item.steps, ['请确认当前系统账户对这个文件夹有写入权限']);
  });

  it('监听未就绪 → warn，带重启动作', () => {
    const item = checkVaults([makeVault({ watchError: "ENOENT: watch '/Volumes/x'" })], 'darwin')[0];
    assert.ok(item);
    assert.equal(item.code, 'vault.watch');
    assert.equal(item.level, 'warn');
    assert.equal(item.subject, '我的知识库');
    assert.equal(item.title, '文件变化监听没有就绪');
    assert.equal(item.summary, 'Molio 暂时感知不到「我的知识库」里的文件变化，目录和图谱可能不会自动刷新');
    assert.equal(item.detail, "ENOENT: watch '/Volumes/x'");
    assert.deepEqual(item.steps, ['重启 Molio']);
    assert.deepEqual(item.actions, [{ code: 'restart-app', label: '重启 Molio' }]);
  });

  it('每个库最多一条：找不到优先于不可写与监听失败', () => {
    const items = checkVaults([makeVault({ exists: false, writable: false, watchError: 'oops' })], 'darwin');
    assert.equal(items.length, 1);
    assert.equal(items[0]?.code, 'vault.missing');
  });

  it('有问题库存在时，健康库不产出 ok item', () => {
    const items = checkVaults([makeVault({ writable: false }), makeVault()], 'darwin');
    assert.equal(items.length, 1);
    assert.equal(items[0]?.code, 'vault.readonly');
  });

  it('全部正常 → 单条 ok', () => {
    const items = checkVaults([makeVault(), makeVault({ id: 'v2', name: '法考' })], 'darwin');
    assert.equal(items.length, 1);
    const item = items[0]!;
    assert.equal(item.code, 'vaults');
    assert.equal(item.level, 'ok');
    assert.equal(item.title, '知识库');
    assert.equal(item.summary, '2 个知识库状态正常');
    assert.ok(!('steps' in item));
  });
});

describe('checkDisk', () => {
  it('空数组 → skip', () => {
    const item = checkDisk([]);
    assert.equal(item.code, 'system.disk');
    assert.equal(item.level, 'skip');
    assert.equal(item.title, '磁盘空间');
    assert.equal(item.summary, '没有可检查的磁盘');
  });

  it('最小剩余 < 1 GB → error，带清理步骤', () => {
    const usages: DiskUsage[] = [
      { label: 'D 盘', freeBytes: 20 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 },
      { label: 'C 盘', freeBytes: 0.8 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 },
    ];
    const item = checkDisk(usages);
    assert.equal(item.level, 'error');
    assert.equal(item.title, '磁盘空间不足');
    assert.equal(item.summary, '「C 盘」所在的磁盘只剩 0.8 GB');
    assert.equal(item.detail, 'C 盘：剩余 0.8 GB / 共 100.0 GB');
    assert.deepEqual(item.steps, ['清理磁盘空间，或把知识库移到空间充足的磁盘']);
  });

  it('最小剩余 < 5 GB → warn，无步骤', () => {
    const usages: DiskUsage[] = [{ label: 'C 盘', freeBytes: 3 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 }];
    const item = checkDisk(usages);
    assert.equal(item.level, 'warn');
    assert.equal(item.title, '磁盘空间剩余不多');
    assert.equal(item.summary, '「C 盘」所在的磁盘只剩 3.0 GB');
    assert.equal(item.detail, 'C 盘：剩余 3.0 GB / 共 100.0 GB');
    assert.ok(!('steps' in item));
  });

  it('剩余充足 → ok', () => {
    const usages: DiskUsage[] = [{ label: 'C 盘', freeBytes: 86.4 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 }];
    const item = checkDisk(usages);
    assert.equal(item.level, 'ok');
    assert.equal(item.title, '磁盘空间');
    assert.equal(item.summary, '剩余空间充足（最少 86.4 GB）');
    assert.ok(!('detail' in item));
    assert.ok(!('steps' in item));
  });
});
