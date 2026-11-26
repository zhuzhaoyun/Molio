import type { AgentInfo, DiagnosticAction, DiagnosticItem } from '@molio/contracts';
import { formatClock, formatDuration, formatGB, humanizeUpdateError } from './copy.js';
import type { DaemonExitSummary, UpdaterLogStatus } from './main-log.js';

/**
 * 体检项判定层：采集到的事实（Task 1 解析结果 + 各处探针）→ 诊断项。
 * 每个 check* 只做判断与拼文案，确定性产出、不做任何 I/O；
 * 采集（读日志、探测 agent、测磁盘）是 Task 3 runner 的事。
 * 规则即 task brief 的规则表：表里没定义的 steps / actions / detail / subject 一律不产出。
 */

const GB = 1024 ** 3;

const CHECK_UPDATES: DiagnosticAction = { code: 'check-updates', label: '检查更新' };
const RESTART_APP: DiagnosticAction = { code: 'restart-app', label: '重启 Molio' };
const GO_SETTINGS: DiagnosticAction = { code: 'open-url', label: '去设置', target: '/settings?tab=runtimes' };

export function checkVersion(version: string | null): DiagnosticItem {
  if (version === null) {
    return { code: 'app.version', level: 'skip', title: '版本', summary: '开发模式下没有版本号' };
  }
  return { code: 'app.version', level: 'ok', title: '版本', summary: `Molio 版本 ${version}` };
}

export function checkUpdateChannel(status: UpdaterLogStatus | null, currentVersion: string | null): DiagnosticItem {
  if (status === null || status.state === 'none') {
    return { code: 'update.channel', level: 'skip', title: '自动更新', summary: '没有更新检查记录' };
  }
  if (status.state === 'available') {
    // availableVersion 不会被随后的成功清掉，只在 state=available 时读它才有意义
    const version = status.availableVersion ?? '未知版本';
    const currentSuffix = currentVersion !== null ? `（当前 ${currentVersion}）` : '';
    return {
      code: 'update.channel',
      level: 'warn',
      title: '有新版本可用',
      summary: `可以更新到 ${version}${currentSuffix}`,
      steps: ['点击「检查更新」，下载完成后按提示重启 Molio'],
      actions: [CHECK_UPDATES],
    };
  }
  if (status.state === 'failed') {
    const humanized = humanizeUpdateError(status.lastError ?? '');
    if (status.consecutiveFailures >= 3) {
      return {
        code: 'update.channel',
        level: 'error',
        title: '自动更新一直连不上',
        summary: `已连续失败 ${status.consecutiveFailures} 次：${humanized}`,
        // 原始错误给支持人员看；没有原始错误就不产出 detail
        ...(status.lastError !== null ? { detail: status.lastError } : {}),
        steps: ['检查电脑的网络或代理设置是否正常', '也可以联系 Molio 支持人员获取最新安装包，运行后按提示安装'],
        actions: [CHECK_UPDATES],
      };
    }
    return {
      code: 'update.channel',
      level: 'warn',
      title: '更新检查失败过',
      summary: `最近一次检查失败：${humanized}`,
      steps: ['检查电脑的网络或代理设置是否正常', '也可以联系 Molio 支持人员获取最新安装包，运行后按提示安装'],
      actions: [CHECK_UPDATES],
    };
  }
  const timeSuffix = status.lastSuccessAt !== null ? `（上次检查 ${formatClock(status.lastSuccessAt)}）` : '';
  return { code: 'update.channel', level: 'ok', title: '自动更新', summary: `已是最新${timeSuffix}` };
}

// 安全软件相关步骤：有已知名单就点名，没有就给常见名单让用户自查。
// 2026-11-25 客户装机报障的两条教训（都来自现场）：
// ① 白名单必须同时覆盖安装目录与数据目录——数据目录里有一键安装的 AI 运行时
//    （claude.exe 等，同样没有数字签名），杀软盯的不只是主程序；
// ② 已被隔离的文件，退出杀软并不会自动恢复——必须去「隔离区／恢复区」里捞，
//    否则用户「退了火绒还是不行」时会误判白名单没用。
const QUARANTINE_STEP =
  '如果 Molio 的文件已经被安全软件隔离过，退出安全软件并不会找回文件——请到安全软件的「隔离区／恢复区」里恢复，或重新安装一次 Molio';

function whitelistDirs(installDir: string | null, dataDir: string | null): string {
  // 单目录：句首已点名（安装目录／数据目录），后缀只给路径不重复标签；
  // 双目录：分别标注，避免两个裸路径让用户分不清谁是谁
  if (installDir && dataDir) {
    return `：安装目录 ${installDir}；数据目录 ${dataDir}（一键安装的 AI 运行时也在这里）`;
  }
  const single = installDir ?? dataDir;
  return single ? `：${single}` : '';
}

function antivirusSteps(securitySoftware: string[] | null, installDir: string | null, dataDir: string | null): string[] {
  const dirs = whitelistDirs(installDir, dataDir);
  const dirNoun =
    installDir && dataDir ? '安装目录与数据目录都' : dataDir && !installDir ? '数据目录' : '安装目录';
  const first =
    securitySoftware !== null && securitySoftware.length > 0
      ? `您的电脑上装有 ${securitySoftware.join('、')}，它可能把 Molio 误当成可疑程序。请把 Molio 的${dirNoun}加入它的信任区（白名单）${dirs}`
      : `如果电脑上装有 360、火绒、电脑管家等安全软件，请把 Molio 的${dirNoun}加入它们的信任区（白名单）${dirs}`;
  return [first, QUARANTINE_STEP, '然后重启 Molio，再试一次刚才失败的操作'];
}

export function checkDaemonExits(
  summary: DaemonExitSummary | null,
  securitySoftware: string[] | null,
  installDir: string | null,
  dataDir: string | null,
  now: number,
  uptimeSec: number,
): DiagnosticItem {
  if (summary === null) {
    return {
      code: 'daemon.exits',
      level: 'skip',
      title: '后台服务',
      summary: `已运行 ${formatDuration(uptimeSec)}，但读不到运行日志，无法判断有没有异常退出过`,
    };
  }
  if (summary.abnormal24h > 0) {
    // formatClock 用采集时的 now，保证同一条诊断在什么时候生成结论都一致
    const timeSuffix = summary.lastAbnormalAt !== null ? `（最近一次 ${formatClock(summary.lastAbnormalAt, now)}）` : '';
    return {
      code: 'daemon.exits',
      level: 'error',
      title: '后台服务异常退出过',
      summary: `最近 24 小时 Molio 的后台服务意外停止了 ${summary.abnormal24h} 次${timeSuffix}`,
      ...(summary.lastAbnormalCodes.length > 0 ? { detail: `退出码：${summary.lastAbnormalCodes.join('、')}` } : {}),
      steps: antivirusSteps(securitySoftware, installDir, dataDir),
      actions: [RESTART_APP],
    };
  }
  if (summary.abnormal7d > 0 || summary.forced24h > 0) {
    const forcedSuffix = summary.forced24h > 0 ? `，关闭时无响应被强制结束 ${summary.forced24h} 次` : '';
    return {
      code: 'daemon.exits',
      level: 'warn',
      title: '后台服务退出过',
      summary: `过去 7 天后台服务意外停止了 ${summary.abnormal7d} 次${forcedSuffix}`,
      steps: antivirusSteps(securitySoftware, installDir, dataDir),
      actions: [RESTART_APP],
    };
  }
  return {
    code: 'daemon.exits',
    level: 'ok',
    title: '后台服务',
    summary: `运行中 · 已运行 ${formatDuration(uptimeSec)}，没有异常退出的记录`,
  };
}

export function checkSecuritySoftware(names: string[] | null, platform: NodeJS.Platform): DiagnosticItem {
  if (platform !== 'win32') {
    return { code: 'system.security-software', level: 'skip', title: '安全软件', summary: '只能在 Windows 上检查' };
  }
  if (names === null) {
    return { code: 'system.security-software', level: 'skip', title: '安全软件', summary: '未能读取安全软件列表' };
  }
  if (names.length === 0) {
    return { code: 'system.security-software', level: 'ok', title: '安全软件', summary: '没有发现第三方安全软件' };
  }
  return { code: 'system.security-software', level: 'ok', title: '安全软件', summary: `已安装：${names.join('、')}` };
}

export function checkAgents(agents: AgentInfo[] | null): DiagnosticItem {
  if (agents === null) {
    return { code: 'runtime.agents', level: 'skip', title: 'AI 运行时', summary: '未能检测' };
  }
  const available = agents.filter((a) => a.available === true);
  if (available.length === 0) {
    return {
      code: 'runtime.agents',
      level: 'error',
      title: '没有可用的 AI 运行时',
      summary: 'Molio 需要至少一个 AI 运行时（例如 Claude Code）才能对话',
      steps: ['打开「设置 → AI 运行时」，安装或配置一个运行时'],
      actions: [GO_SETTINGS],
    };
  }
  // 探测不到版本号就只报名称，不编造版本
  const availableParts = available.map((a) => (a.version ? `${a.name} ${a.version}` : a.name));
  // 探测失败原因给支持人员看：只列不可用项，有原因才列
  const broken = agents
    .filter((a) => a.available !== true && a.probeError)
    .map((a) => `${a.name}: ${a.probeError}`);
  return {
    code: 'runtime.agents',
    level: 'ok',
    title: 'AI 运行时',
    summary: `可用：${availableParts.join('、')}`,
    ...(broken.length > 0 ? { detail: broken.join('；') } : {}),
  };
}

export interface VaultProbe {
  id: string;
  name: string;
  path: string;
  exists: boolean | null;
  writable: boolean | null;
  watchError: string | null;
}

export function checkVaults(vaults: VaultProbe[], platform: NodeJS.Platform): DiagnosticItem[] {
  const items: DiagnosticItem[] = [];
  for (const vault of vaults) {
    // 每个库只报一条、按严重度取先：找不到 → 不可写 → 监听未就绪
    if (vault.exists === false) {
      items.push({
        code: 'vault.missing',
        level: 'error',
        subject: vault.name,
        title: '知识库文件夹找不到',
        summary: `「${vault.name}」的位置：${vault.path}`,
        detail: vault.path,
        steps: [
          '如果它放在移动硬盘或网络盘上，请先连接好',
          '如果文件夹已经被移动或改名，请在仓库管理器里重新打开它的新位置',
        ],
      });
      continue;
    }
    if (vault.writable === false) {
      // 平台差异：Mac 挂 NTFS 移动盘默认只读，Windows 多是文件夹属性/安全软件
      const steps =
        platform === 'darwin'
          ? [
              '如果知识库在 NTFS 格式的移动硬盘上：这种硬盘连接 Mac 时默认只读。请换一个可写的磁盘，或改用在 Windows 上的知识库',
              '也可以在仓库管理器里新建一个知识库，把资料放进新位置',
            ]
          : platform === 'win32'
            ? ['右键这个文件夹 → 属性，取消勾选「只读」', '如果仍然不行，检查安全软件是否开启了文件夹保护']
            : ['请确认当前系统账户对这个文件夹有写入权限'];
      items.push({
        code: 'vault.readonly',
        level: 'error',
        subject: vault.name,
        title: '知识库文件夹无法写入',
        summary: `Molio 需要在「${vault.name}」里创建索引和技能文件，但被系统拒绝了`,
        detail: vault.path,
        steps,
      });
      continue;
    }
    if (vault.watchError && vault.exists === true) {
      items.push({
        code: 'vault.watch',
        level: 'warn',
        subject: vault.name,
        title: '文件变化监听没有就绪',
        summary: `Molio 暂时感知不到「${vault.name}」里的文件变化，目录和图谱可能不会自动刷新`,
        detail: vault.watchError,
        steps: ['重启 Molio'],
        actions: [RESTART_APP],
      });
    }
  }
  if (items.length === 0 && vaults.length > 0) {
    items.push({ code: 'vaults', level: 'ok', title: '知识库', summary: `${vaults.length} 个知识库状态正常` });
  }
  return items;
}

export interface DiskUsage {
  label: string;
  freeBytes: number;
  totalBytes: number;
}

export function checkDisk(usages: DiskUsage[]): DiagnosticItem {
  if (usages.length === 0) {
    return { code: 'system.disk', level: 'skip', title: '磁盘空间', summary: '没有可检查的磁盘' };
  }
  // 剩余最少的盘决定结论，label 也取自它
  const min = usages.reduce((a, b) => (b.freeBytes < a.freeBytes ? b : a));
  if (min.freeBytes < GB) {
    return {
      code: 'system.disk',
      level: 'error',
      title: '磁盘空间不足',
      summary: `「${min.label}」所在的磁盘只剩 ${formatGB(min.freeBytes)}`,
      detail: `${min.label}：剩余 ${formatGB(min.freeBytes)} / 共 ${formatGB(min.totalBytes)}`,
      steps: ['清理磁盘空间，或把知识库移到空间充足的磁盘'],
    };
  }
  if (min.freeBytes < 5 * GB) {
    return {
      code: 'system.disk',
      level: 'warn',
      title: '磁盘空间剩余不多',
      summary: `「${min.label}」所在的磁盘只剩 ${formatGB(min.freeBytes)}`,
      detail: `${min.label}：剩余 ${formatGB(min.freeBytes)} / 共 ${formatGB(min.totalBytes)}`,
    };
  }
  return {
    code: 'system.disk',
    level: 'ok',
    title: '磁盘空间',
    summary: `剩余空间充足（最少 ${formatGB(min.freeBytes)}）`,
  };
}
