// ─── Molio Doctor 自助诊断契约 ───
// daemon 产出诊断报告，web 渲染，desktop 执行动作；三方共用同一套形状。

/** 单个诊断项的结论等级 */
export type DiagnosticLevel = 'error' | 'warn' | 'ok' | 'skip';

/** 诊断项可以携带的动作 */
export type DiagnosticActionCode = 'restart-app' | 'check-updates' | 'open-folder' | 'open-url';

export interface DiagnosticAction {
  code: DiagnosticActionCode;
  label: string;
  /** open-folder: 绝对目录；open-url: 应用内路径 */
  target?: string;
}

export interface DiagnosticItem {
  /** 稳定 id（如 'daemon-exit-abnormal'），web 端据此定位与聚合 */
  code: string;
  level: DiagnosticLevel;
  /** 限定主体（如 'daemon' / 'updater' / 具体 vault id） */
  subject?: string;
  title: string;
  summary: string;
  detail?: string;
  /** 建议用户执行的步骤（有序） */
  steps?: string[];
  actions?: DiagnosticAction[];
}

export interface DiagnosticsReport {
  generatedAt: number;
  /** 应用版本，取不到为 null */
  version: string | null;
  platform: string;
  /** 安装目录，取不到为 null */
  installDir: string | null;
  daemonUptimeSec: number;
  items: DiagnosticItem[];
}

export interface SupportBundleResult {
  path: string;
}
