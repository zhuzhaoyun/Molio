import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

// prod 全家桶：loadConfig 的 prod 路径要求 DB + 密钥 + DirectMail 全齐
const FULL_PROD = {
  MOLIO_ENV: 'prod',
  DATABASE_URL: 'postgres://user:pass@localhost/molio',
  MOLIO_JWT_SECRET: 'jwt-secret',
  MOLIO_CODE_PEPPER: 'code-pepper',
  MOLIO_DM_ACCESS_KEY_ID: 'ak',
  MOLIO_DM_ACCESS_KEY_SECRET: 'sk',
  MOLIO_DM_ACCOUNT_NAME: 'noreply@mail.molio.cn',
};

test('loadConfig: 缺省 env → local 兜底 + 随机密钥 + 默认端口 3200', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.env, 'local');
  assert.equal(cfg.port, 3200);
  assert.ok(cfg.jwtSecret.length >= 32, '本地兜底密钥应为随机生成');
  assert.equal(cfg.rate.emailResendSec, 60);
  assert.equal(cfg.rate.emailDailyMax, 10);
  assert.equal(cfg.rate.ipDailyMax, 30);
});

test('loadConfig: MOLIO_ENV 非法值 → 抛错', () => {
  assert.throws(() => loadConfig({ MOLIO_ENV: 'staging' }), /MOLIO_ENV 非法/);
});

test('loadConfig: 数值项必须正整数——小数/零/负数/非数字一律抛错', () => {
  // 0.5 若取整成 0 会把限频上限锁死为 0（全部 429），必须拒绝
  assert.throws(() => loadConfig({ MOLIO_RATE_EMAIL_DAILY_MAX: '0.5' }), /正整数/);
  assert.throws(() => loadConfig({ MOLIO_RATE_EMAIL_DAILY_MAX: '0' }), /正整数/);
  assert.throws(() => loadConfig({ MOLIO_RATE_IP_DAILY_MAX: '-1' }), /正整数/);
  assert.throws(() => loadConfig({ MOLIO_CODE_TTL_SEC: 'abc' }), /正整数/);
  assert.throws(() => loadConfig({ PORT: 'not-a-port' }), /正整数/);
});

test('loadConfig: PORT 优先于 CAPort，且 PORT 已设置时不解析 CAPort', () => {
  // FC 注入 CAPort；本地显式 PORT 时 CAPort 即使是非法值也不影响启动
  const cfg = loadConfig({ PORT: '4000', CAPort: 'illegal' });
  assert.equal(cfg.port, 4000);
  const fc = loadConfig({ CAPort: '9000' });
  assert.equal(fc.port, 9000);
});

test('loadConfig: 配置 DATABASE_URL 时必须显式 MOLIO_ENV（防 devCode 后门带上生产）', () => {
  assert.throws(
    () => loadConfig({ DATABASE_URL: 'postgres://x', MOLIO_JWT_SECRET: 's', MOLIO_CODE_PEPPER: 'p' }),
    /必须显式设置 MOLIO_ENV/,
  );
});

test('loadConfig: 连库（多实例）必须显式注入密钥与 pepper——随机兜底会导致跨实例 401', () => {
  assert.throws(() => loadConfig({ MOLIO_ENV: 'daily', DATABASE_URL: 'postgres://x' }), /MOLIO_JWT_SECRET/);
  assert.throws(
    () => loadConfig({ MOLIO_ENV: 'daily', DATABASE_URL: 'postgres://x', MOLIO_JWT_SECRET: 's' }),
    /MOLIO_CODE_PEPPER/,
  );
});

test('loadConfig: prod 缺 DATABASE_URL / JWT / pepper 任一 → 启动即抛错', () => {
  const { DATABASE_URL: _db, ...noDb } = FULL_PROD;
  assert.throws(() => loadConfig(noDb), /DATABASE_URL/);
  const { MOLIO_JWT_SECRET: _jwt, ...noJwt } = FULL_PROD;
  assert.throws(() => loadConfig(noJwt), /MOLIO_JWT_SECRET/);
  const { MOLIO_CODE_PEPPER: _pepper, ...noPepper } = FULL_PROD;
  assert.throws(() => loadConfig(noPepper), /MOLIO_CODE_PEPPER/);
});

test('loadConfig: 纯空白密钥按未设置处理（trim 后为空）', () => {
  assert.throws(() => loadConfig({ ...FULL_PROD, MOLIO_JWT_SECRET: '   ' }), /MOLIO_JWT_SECRET/);
  assert.throws(() => loadConfig({ ...FULL_PROD, MOLIO_CODE_PEPPER: '\t' }), /MOLIO_CODE_PEPPER/);
});

test('loadConfig: 密钥两端空白被 trim（env 粘贴事故不带入签名/哈希）', () => {
  const cfg = loadConfig({ ...FULL_PROD, MOLIO_JWT_SECRET: ' s ', MOLIO_CODE_PEPPER: ' p ' });
  assert.equal(cfg.jwtSecret, 's');
  assert.equal(cfg.codePepper, 'p');
});

test('loadConfig: prod 全齐 → 正常加载，directMail 生效', () => {
  const cfg = loadConfig(FULL_PROD);
  assert.equal(cfg.env, 'prod');
  assert.equal(cfg.databaseUrl, 'postgres://user:pass@localhost/molio');
  assert.ok(cfg.directMail);
  assert.equal(cfg.directMail?.accountName, 'noreply@mail.molio.cn');
});

test('loadConfig: DirectMail region/endpoint 格式非法 → 启动即抛错（不留到首次发信）', () => {
  assert.throws(() => loadConfig({ ...FULL_PROD, MOLIO_DM_REGION: 'cn-hangzhou;evil' }), /MOLIO_DM_REGION 非法/);
  assert.throws(() => loadConfig({ ...FULL_PROD, MOLIO_DM_ENDPOINT: 'https://x.com/path' }), /MOLIO_DM_ENDPOINT 非法/);
});


// 线上事故（2026-08-23）：MOLIO_DM_REPLY_TO 配了显示名格式，DirectMail 以
// InvalidReplyToAddress 拒收，每次 send-code 都 422 mail_failed。启动期拦截。
test('loadConfig: MOLIO_DM_REPLY_TO 格式非法 → 启动即抛错（不留到首次发信 422）', () => {
  // 显示名格式、+ 号、非邮箱——DirectMail 只接受裸邮箱（@ 前后限数字/字母/下划线/减号/点）
  assert.throws(
    () => loadConfig({ ...FULL_PROD, MOLIO_DM_REPLY_TO: '墨友支持 <support@molio.cn>' }),
    /MOLIO_DM_REPLY_TO 非法/,
  );
  assert.throws(() => loadConfig({ ...FULL_PROD, MOLIO_DM_REPLY_TO: 'support+tag@molio.cn' }), /MOLIO_DM_REPLY_TO 非法/);
  assert.throws(() => loadConfig({ ...FULL_PROD, MOLIO_DM_REPLY_TO: 'not-an-email' }), /MOLIO_DM_REPLY_TO 非法/);
});

test('loadConfig: MOLIO_DM_REPLY_TO 两端空白被 trim（env 粘贴事故），纯空白按未设置处理', () => {
  const cfg = loadConfig({ ...FULL_PROD, MOLIO_DM_REPLY_TO: ' support@molio.cn ' });
  assert.equal(cfg.directMail?.replyTo, 'support@molio.cn');
  const blank = loadConfig({ ...FULL_PROD, MOLIO_DM_REPLY_TO: '   ' });
  assert.equal(blank.directMail?.replyTo, undefined);
});

test('loadConfig: MOLIO_DM_REPLY_TO 合法裸邮箱 → 正常加载', () => {
  const cfg = loadConfig({ ...FULL_PROD, MOLIO_DM_REPLY_TO: 'support@mail.molio.cn' });
  assert.equal(cfg.directMail?.replyTo, 'support@mail.molio.cn');
});

test('loadConfig: MOLIO_CORS_EXTRA_ORIGINS 解析——逗号分隔取 origin，空值缺省空数组', () => {
  const cfg = loadConfig({
    MOLIO_CORS_EXTRA_ORIGINS: 'https://preview.molio.cn/docs, http://10.0.0.5:8080/x ',
  });
  assert.deepEqual(cfg.corsExtraOrigins, ['https://preview.molio.cn', 'http://10.0.0.5:8080']);
  assert.deepEqual(loadConfig({}).corsExtraOrigins, []);
  assert.deepEqual(loadConfig({ MOLIO_CORS_EXTRA_ORIGINS: '  ' }).corsExtraOrigins, []);
});

test('loadConfig: MOLIO_CORS_EXTRA_ORIGINS 非法来源 → 启动即抛错', () => {
  assert.throws(() => loadConfig({ MOLIO_CORS_EXTRA_ORIGINS: 'not a url' }), /MOLIO_CORS_EXTRA_ORIGINS 非法来源/);
});
