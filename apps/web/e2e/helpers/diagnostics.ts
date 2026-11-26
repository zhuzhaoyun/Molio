/**
 * Diagnostics mock — intercepts GET /api/diagnostics* with a fixed report so the
 * web UI (and later the diagnose-directive flow) renders without a real daemon
 * health check. Shape: @molio/contracts DiagnosticsReport.
 */
import type { Page } from '@playwright/test';
import type { DiagnosticsReport } from '@molio/contracts';

/** 一份覆盖全部等级（error/warn/ok/skip）与动作的固定报告。 */
export const DIAGNOSTICS_FIXTURE: DiagnosticsReport = {
  generatedAt: new Date(2026, 10, 24, 15, 2).getTime(), version: '0.4.7', platform: 'win32 x64', installDir: 'D:\\molio', daemonUptimeSec: 3725,
  items: [
    { code: 'update.channel', level: 'error', title: '自动更新一直连不上', summary: '已连续失败 220 次：网络无法解析更新服务器（断网、代理或 DNS 问题）', detail: 'net::ERR_NAME_NOT_RESOLVED',
      steps: ['检查电脑的网络或代理设置是否正常', '也可以联系 Molio 支持人员获取最新安装包，运行后按提示安装'], actions: [{ code: 'check-updates', label: '检查更新' }] },
    { code: 'daemon.exits', level: 'warn', title: '后台服务退出过', summary: '过去 7 天后台服务意外停止了 2 次',
      steps: ['如果电脑上装有 360、火绒、电脑管家等安全软件，请把 Molio 的安装目录加入它们的信任区（白名单）：D:\\molio', '然后重启 Molio，再试一次刚才失败的操作'], actions: [{ code: 'restart-app', label: '重启 Molio' }] },
    { code: 'app.version', level: 'ok', title: '版本', summary: 'Molio 版本 0.4.7' },
    { code: 'system.security-software', level: 'skip', title: '安全软件', summary: '未能读取安全软件列表' },
  ],
};

export async function mockDiagnostics(page: Page, report: DiagnosticsReport = DIAGNOSTICS_FIXTURE): Promise<void> {
  await page.route('**/api/diagnostics*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(report) }));
}
