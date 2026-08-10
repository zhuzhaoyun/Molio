import type { CloudConfig } from './config.js';

export interface Mailer {
  send(to: string, code: string): Promise<void>;
}

/** daily/local：验证码写 stdout 日志，不发真邮件（§十三）。 */
export class LogMailer implements Mailer {
  async send(to: string, code: string): Promise<void> {
    // 走 stdout：避免云监控 stderr 噪音误报（同 #183 教训）
    console.log(`[cloud][mail] to=${to} code=${code}`);
  }
}

/**
 * prod：阿里云 DirectMail（@alicloud/dm20151123），发信域名需 SPF/DKIM（§十三）。
 * M1 骨架未接 SDK：prod 部署前必须实现并在 createMailer 接入，
 * 此处先以显式报错防止"prod 静默走日志"的事故。
 */
class NotConfiguredMailer implements Mailer {
  async send(): Promise<void> {
    throw new Error('[cloud] prod 邮件通道（DirectMail）未配置，禁止发信');
  }
}

export function createMailer(config: CloudConfig): Mailer {
  if (config.env === 'prod') return new NotConfiguredMailer();
  return new LogMailer();
}
