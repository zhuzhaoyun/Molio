import { randomBytes } from 'node:crypto';

export type CloudEnv = 'local' | 'daily' | 'prod';

export interface RateLimits {
  /** 同邮箱重发间隔（秒） */
  emailResendSec: number;
  /** 每邮箱每日发信上限 */
  emailDailyMax: number;
  /** 每 IP 每日发信上限 */
  ipDailyMax: number;
}

/**
 * 阿里云 DirectMail 发信配置（§十三）。凭据只经 FC 函数 env 注入，绝不入仓库。
 * 发信地址必须挂在已通过 SPF/DKIM 验证的发信域名下。
 */
export interface DirectMailConfig {
  accessKeyId: string;
  accessKeySecret: string;
  /** 发信地址（如 noreply@mail.molio.cn） */
  accountName: string;
  /** DirectMail 地域，决定 endpoint；默认 cn-hangzhou */
  region: string;
  /** endpoint 显式覆盖（缺省按 region 推导） */
  endpoint?: string;
  /** 可选 Reply-To：用户回复验证码邮件时落到该地址（如企业邮箱人工收件） */
  replyTo?: string;
}

export interface CloudConfig {
  env: CloudEnv;
  port: number;
  /** HS256 签名密钥（prod 必须 env 注入，不入代码库） */
  jwtSecret: string;
  /** kid 留桩（§十七 L6：第一期单密钥） */
  jwtKid?: string;
  /** access token 寿命（秒），默认 15 分钟 */
  accessTtlSec: number;
  /** 验证码 hash pepper（prod 必须 env 注入） */
  codePepper: string;
  /** 验证码有效期（秒），默认 5 分钟 */
  codeTtlSec: number;
  /** 验证码错误次数上限，≥ 该值锁码 */
  codeMaxAttempts: number;
  /** refresh token 寿命（秒），30 天滑动 */
  refreshTtlSec: number;
  /** D1 轮换宽限窗（秒）：被轮换吊销的 token 在窗内重放视为重试而非攻击 */
  rotationGraceSec: number;
  rate: RateLimits;
  /** 无 DATABASE_URL 时走 MemoryAuthStore（§十七 L7） */
  databaseUrl?: string;
  /** DirectMail 配置齐全时才有值；prod 缺失时 loadConfig 直接抛错（fail-fast） */
  directMail?: DirectMailConfig;
}

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`[cloud] env ${key} 必须是正数，实际值: ${raw}`);
  }
  return Math.floor(n);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const envName = (env.MOLIO_ENV ?? 'local') as CloudEnv;
  if (envName !== 'local' && envName !== 'daily' && envName !== 'prod') {
    throw new Error(`[cloud] MOLIO_ENV 非法: ${envName}（可选 local/daily/prod）`);
  }

  const jwtSecret = env.MOLIO_JWT_SECRET ?? '';
  const codePepper = env.MOLIO_CODE_PEPPER ?? '';
  if (envName === 'prod') {
    if (!jwtSecret) throw new Error('[cloud] prod 环境必须设置 MOLIO_JWT_SECRET');
    if (!codePepper) throw new Error('[cloud] prod 环境必须设置 MOLIO_CODE_PEPPER');
  }

  // DirectMail：三项核心凭据全齐才启用；任一缺失视为未配置。
  // prod 未配置 → 启动即失败（与 NotConfiguredMailer 同源：绝不允许 prod 静默发不出邮件）。
  const dmAkId = env.MOLIO_DM_ACCESS_KEY_ID ?? '';
  const dmAkSecret = env.MOLIO_DM_ACCESS_KEY_SECRET ?? '';
  const dmAccount = env.MOLIO_DM_ACCOUNT_NAME ?? '';
  let directMail: DirectMailConfig | undefined;
  if (dmAkId && dmAkSecret && dmAccount) {
    directMail = {
      accessKeyId: dmAkId,
      accessKeySecret: dmAkSecret,
      accountName: dmAccount,
      region: env.MOLIO_DM_REGION || 'cn-hangzhou',
      endpoint: env.MOLIO_DM_ENDPOINT || undefined,
      replyTo: env.MOLIO_DM_REPLY_TO || undefined,
    };
  } else if (envName === 'prod') {
    throw new Error(
      '[cloud] prod 环境必须完整配置 DirectMail：MOLIO_DM_ACCESS_KEY_ID / MOLIO_DM_ACCESS_KEY_SECRET / MOLIO_DM_ACCOUNT_NAME',
    );
  }

  return {
    env: envName,
    // FC Web 函数注入 CAPort；本地默认 3200（§十三）
    port: intEnv(env, 'PORT', intEnv(env, 'CAPort', 3200)),
    // 非 prod 允许缺省（随机生成，重启即失效，与 L7 内存模式一致）
    jwtSecret: jwtSecret || randomBytes(32).toString('hex'),
    jwtKid: env.MOLIO_JWT_KID || undefined,
    accessTtlSec: intEnv(env, 'MOLIO_ACCESS_TTL_SEC', 15 * 60),
    codePepper: codePepper || 'local-dev-pepper',
    codeTtlSec: intEnv(env, 'MOLIO_CODE_TTL_SEC', 5 * 60),
    codeMaxAttempts: intEnv(env, 'MOLIO_CODE_MAX_ATTEMPTS', 5),
    refreshTtlSec: intEnv(env, 'MOLIO_REFRESH_TTL_SEC', 30 * 24 * 60 * 60),
    rotationGraceSec: intEnv(env, 'MOLIO_ROTATION_GRACE_SEC', 30),
    rate: {
      emailResendSec: intEnv(env, 'MOLIO_RATE_EMAIL_RESEND_SEC', 60),
      emailDailyMax: intEnv(env, 'MOLIO_RATE_EMAIL_DAILY_MAX', 10),
      ipDailyMax: intEnv(env, 'MOLIO_RATE_IP_DAILY_MAX', 30),
    },
    databaseUrl: env.DATABASE_URL || undefined,
    directMail,
  };
}
