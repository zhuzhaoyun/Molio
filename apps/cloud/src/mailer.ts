import DMSdk from '@alicloud/dm20151123';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import { RuntimeOptions } from '@darabonba/typescript';
import type { CloudConfig, DirectMailConfig } from './config.js';

// ESM 加载 CJS 包：Node 把 module.exports 整体挂在 default 绑定上，
// Client 类在 .default 属性上（tsc 的 __esModule 产物）；显式取出避免 interop 陷阱。
const DM20151123 = DMSdk.default;
const SingleSendMailRequest = DMSdk.SingleSendMailRequest;

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
 * prod 兜底：DirectMail 未配置时显式报错。
 * 正常情况下 loadConfig 已在启动时 fail-fast，这里防的是绕过 loadConfig 的误用，
 * 绝不许"prod 静默走日志"。
 */
class NotConfiguredMailer implements Mailer {
  async send(): Promise<void> {
    throw new Error('[cloud] prod 邮件通道（DirectMail）未配置，禁止发信');
  }
}

// ─── DirectMail（prod 真邮件通道，§十三 M0） ─────────────────────────

export interface VerificationMail {
  subject: string;
  textBody: string;
  htmlBody: string;
}

/** 发信传输层：mailer 只组内容，投递经此接口（测试注入 fake，prod 走真 SDK）。 */
export interface DirectMailTransport {
  send(msg: { toAddress: string } & VerificationMail): Promise<void>;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** 验证码邮件内容：纯文本 + 极简 HTML（内联样式、零外链资源，避免被邮件客户端拦截）。 */
export function buildVerificationMail(code: string, ttlSec: number): VerificationMail {
  const minutes = Math.max(1, Math.round(ttlSec / 60));
  const safeCode = escapeHtml(code);
  return {
    subject: 'Molio 登录验证码',
    textBody: [
      `你的 Molio 登录验证码是：${code}`,
      '',
      `验证码 ${minutes} 分钟内有效，请勿告知他人。`,
      '如果你没有请求此验证码，忽略本邮件即可。',
      '',
      '收不到邮件？请检查垃圾邮件文件夹。',
      '',
      '—— Molio 团队',
    ].join('\n'),
    htmlBody: [
      '<div style="max-width:480px;margin:0 auto;padding:24px;font-family:\'PingFang SC\',\'Microsoft YaHei\',Arial,sans-serif;color:#222;">',
      '<h2 style="margin:0 0 16px;font-size:18px;">Molio 登录验证码</h2>',
      '<p style="margin:0 0 12px;font-size:14px;">你的登录验证码：</p>',
      `<div style="font-size:28px;font-weight:bold;letter-spacing:6px;padding:12px 0;">${safeCode}</div>`,
      `<p style="margin:12px 0;font-size:13px;color:#555;">验证码 ${minutes} 分钟内有效，请勿告知他人。</p>`,
      '<p style="margin:0 0 20px;font-size:13px;color:#555;">如果你没有请求此验证码，忽略本邮件即可。</p>',
      '<p style="margin:0;font-size:12px;color:#999;">收不到邮件？请检查垃圾邮件文件夹。</p>',
      '<p style="margin:16px 0 0;font-size:12px;color:#999;">—— Molio 团队</p>',
      '</div>',
    ].join(''),
  };
}

/**
 * DirectMail 地域 → endpoint。
 * 华东1（杭州）是历史默认区，endpoint 为 dm.aliyuncs.com；其余地域带 region 前缀。
 * 可用 MOLIO_DM_ENDPOINT 显式覆盖（见 config）。
 */
export function deriveDirectMailEndpoint(region: string): string {
  return region === 'cn-hangzhou' ? 'dm.aliyuncs.com' : `dm.${region}.aliyuncs.com`;
}

/** prod 真发信传输：阿里云 DirectMail SingleSendMail。 */
export function createDirectMailTransport(config: DirectMailConfig): DirectMailTransport {
  const client = new DM20151123(
    new $OpenApiUtil.Config({
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      endpoint: config.endpoint ?? deriveDirectMailEndpoint(config.region),
    }),
  );
  // SDK 默认超时仅 3s 左右（部署 RDS 时的血泪教训）：发信是用户可感知操作，显式放宽
  const runtime = new RuntimeOptions({ connectTimeout: 10_000, readTimeout: 15_000 });
  return {
    async send(msg) {
      const req = new SingleSendMailRequest({
        accountName: config.accountName,
        // 1 = 发信地址（控制台配置的地址）；0 是批量收件人列表，不用
        addressType: 1,
        replyToAddress: config.replyTo !== undefined,
        replyAddress: config.replyTo,
        toAddress: msg.toAddress,
        subject: msg.subject,
        textBody: msg.textBody,
        htmlBody: msg.htmlBody,
      });
      await client.singleSendMailWithOptions(req, runtime);
    },
  };
}

/** prod 验证码邮件发送器：组内容 → 交给 transport 投递。 */
export class DirectMailMailer implements Mailer {
  constructor(
    private readonly config: CloudConfig,
    private readonly transport: DirectMailTransport,
  ) {}

  async send(to: string, code: string): Promise<void> {
    const mail = buildVerificationMail(code, this.config.codeTtlSec);
    await this.transport.send({ toAddress: to, ...mail });
  }
}

export function createMailer(config: CloudConfig): Mailer {
  if (config.env === 'prod') {
    if (config.directMail) return new DirectMailMailer(config, createDirectMailTransport(config.directMail));
    return new NotConfiguredMailer();
  }
  return new LogMailer();
}
