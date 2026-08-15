import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import {
  DirectMailMailer,
  LogMailer,
  buildVerificationMail,
  createMailer,
  deriveDirectMailEndpoint,
  type DirectMailTransport,
} from '../src/mailer.js';
import { AuthService } from '../src/service.js';
import { createApp } from '../src/app.js';
import { MemoryAuthStore } from '../src/store/memory.js';
import { makeClock, post, testConfig } from './helpers.js';

// ─── 邮件内容 ─────────────────────────────────────────────────────────

test('buildVerificationMail: 主题与正文包含验证码、有效期与垃圾箱提示', () => {
  const mail = buildVerificationMail('123456', 300);
  assert.equal(mail.subject, 'Molio 登录验证码');
  assert.ok(mail.textBody.includes('123456'));
  assert.ok(mail.textBody.includes('5 分钟'));
  assert.ok(mail.textBody.includes('垃圾邮件'));
  assert.ok(mail.htmlBody.includes('123456'));
});

test('buildVerificationMail: 有效期按分钟取整，不足 1 分钟按 1 分钟', () => {
  assert.ok(buildVerificationMail('1', 600).textBody.includes('10 分钟'));
  assert.ok(buildVerificationMail('1', 10).textBody.includes('1 分钟'));
});

test('buildVerificationMail: 验证码做 HTML 转义，无注入面', () => {
  const mail = buildVerificationMail('<img src=x>', 300);
  assert.ok(!mail.htmlBody.includes('<img'));
  assert.ok(mail.htmlBody.includes('&lt;img src=x&gt;'));
});

// ─── endpoint 推导 ────────────────────────────────────────────────────

test('deriveDirectMailEndpoint: 杭州区为 dm.aliyuncs.com，其余地域带前缀', () => {
  assert.equal(deriveDirectMailEndpoint('cn-hangzhou'), 'dm.aliyuncs.com');
  assert.equal(deriveDirectMailEndpoint('ap-southeast-1'), 'dm.ap-southeast-1.aliyuncs.com');
});

// ─── DirectMailMailer（transport 注入 fake，不碰真 SDK） ──────────────

function fakeTransport() {
  const calls: Array<{ toAddress: string; subject: string; textBody: string; htmlBody: string }> = [];
  let failWith: Error | null = null;
  const transport: DirectMailTransport = {
    async send(msg) {
      if (failWith) throw failWith;
      calls.push(msg);
    },
  };
  return { transport, calls, setFail: (e: Error) => (failWith = e) };
}

test('DirectMailMailer.send: 组好的邮件交给 transport，收件人正确', async () => {
  const { transport, calls } = fakeTransport();
  const mailer = new DirectMailMailer(testConfig({ codeTtlSec: 300 }), transport);
  await mailer.send('user@example.com', '654321');
  assert.equal(calls.length, 1);
  const call = calls.at(0);
  assert.ok(call);
  assert.equal(call.toAddress, 'user@example.com');
  assert.ok(call.textBody.includes('654321'));
  assert.equal(call.subject, 'Molio 登录验证码');
});

test('DirectMailMailer.send: transport 抛错 → 原样向上抛（由 service 转 mail_failed）', async () => {
  const { transport, setFail } = fakeTransport();
  setFail(new Error('InvalidSendMailConfiguration'));
  const mailer = new DirectMailMailer(testConfig(), transport);
  await assert.rejects(() => mailer.send('user@example.com', '111111'), /InvalidSendMailConfiguration/);
});

// ─── createMailer 选择逻辑 ────────────────────────────────────────────

test('createMailer: daily/local → LogMailer；prod+DirectMail → DirectMailMailer', () => {
  assert.ok(createMailer(testConfig({ env: 'daily' })) instanceof LogMailer);
  assert.ok(createMailer(testConfig({ env: 'local' })) instanceof LogMailer);
  const prod = testConfig({
    env: 'prod',
    directMail: {
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      accountName: 'noreply@mail.molio.cn',
      region: 'cn-hangzhou',
    },
  });
  assert.ok(createMailer(prod) instanceof DirectMailMailer);
});

test('createMailer: prod 无 DirectMail 配置 → 兜底报错，绝不静默', async () => {
  const mailer = createMailer(testConfig({ env: 'prod' }));
  await assert.rejects(() => mailer.send('a@b.com', '123456'), /DirectMail.*未配置/);
});

// ─── loadConfig 校验（prod fail-fast） ────────────────────────────────

const DM_ENV = {
  MOLIO_ENV: 'prod',
  MOLIO_JWT_SECRET: 's',
  MOLIO_CODE_PEPPER: 'p',
};

test('loadConfig: prod 缺任一 DirectMail 项 → 启动即抛错', () => {
  assert.throws(() => loadConfig({ ...DM_ENV }), /DirectMail/);
  assert.throws(
    () => loadConfig({ ...DM_ENV, MOLIO_DM_ACCESS_KEY_ID: 'ak', MOLIO_DM_ACCESS_KEY_SECRET: 'sk' }),
    /DirectMail/,
  );
});

test('loadConfig: prod DirectMail 齐全 → 配置生效，region 默认 cn-hangzhou', () => {
  const cfg = loadConfig({
    ...DM_ENV,
    MOLIO_DM_ACCESS_KEY_ID: 'ak',
    MOLIO_DM_ACCESS_KEY_SECRET: 'sk',
    MOLIO_DM_ACCOUNT_NAME: 'noreply@mail.molio.cn',
  });
  assert.ok(cfg.directMail);
  assert.equal(cfg.directMail?.region, 'cn-hangzhou');
  assert.equal(cfg.directMail?.accountName, 'noreply@mail.molio.cn');
  assert.equal(cfg.directMail?.endpoint, undefined);
});

test('loadConfig: MOLIO_DM_ENDPOINT/REGION/REPLY_TO 覆盖生效', () => {
  const cfg = loadConfig({
    ...DM_ENV,
    MOLIO_DM_ACCESS_KEY_ID: 'ak',
    MOLIO_DM_ACCESS_KEY_SECRET: 'sk',
    MOLIO_DM_ACCOUNT_NAME: 'noreply@mail.molio.cn',
    MOLIO_DM_REGION: 'ap-southeast-1',
    MOLIO_DM_ENDPOINT: 'dm.custom.example.com',
    MOLIO_DM_REPLY_TO: 'support@molio.cn',
  });
  assert.equal(cfg.directMail?.region, 'ap-southeast-1');
  assert.equal(cfg.directMail?.endpoint, 'dm.custom.example.com');
  assert.equal(cfg.directMail?.replyTo, 'support@molio.cn');
});

test('loadConfig: 非 prod 环境 DirectMail 部分配置 → 不启用也不抛错', () => {
  const cfg = loadConfig({ MOLIO_ENV: 'daily', MOLIO_DM_ACCESS_KEY_ID: 'only-ak' });
  assert.equal(cfg.directMail, undefined);
});

// ─── 端点集成：发信失败 → 422 mail_failed（daemon 对 4xx 不重试） ─────

function setupWithMail(fail: boolean) {
  const clock = makeClock();
  const store = new MemoryAuthStore();
  const config = testConfig({ env: 'prod' });
  const service = new AuthService({
    store,
    config,
    sendMail: async () => {
      if (fail) throw new Error('dm boom');
    },
    now: clock.now,
  });
  const app = createApp({ service, config, storeKind: 'memory', now: clock.now });
  return { app, store, clock };
}

test('send-code: 发信通道失败 → 422 mail_failed（非 5xx，daemon 不会重试）', async () => {
  const { app } = setupWithMail(true);
  const res = await post(app, '/auth/send-code', { email: 'user@example.com' });
  assert.equal(res.status, 422);
  assert.equal(((await res.json()) as { error: string }).error, 'mail_failed');
});

test('send-code: 发信失败后验证码记录保留 → 立即重发撞限频（限频完整性优先）', async () => {
  const { app, store, clock } = setupWithMail(true);
  await post(app, '/auth/send-code', { email: 'user@example.com' });
  assert.notEqual(await store.latestCodeForEmail('user@example.com'), null);
  const retry = await post(app, '/auth/send-code', { email: 'user@example.com' });
  assert.equal(retry.status, 429);
  // 冷却期过后可正常重发
  clock.advance(61_000);
  assert.equal((await post(app, '/auth/send-code', { email: 'user@example.com' })).status, 422);
});

test('send-code: 发信成功 → 202 且 prod 不带 devCode', async () => {
  const { app } = setupWithMail(false);
  const res = await post(app, '/auth/send-code', { email: 'user@example.com' });
  assert.equal(res.status, 202);
  const body = (await res.json()) as { ok: boolean; devCode?: string };
  assert.equal(body.ok, true);
  assert.equal(body.devCode, undefined);
});
