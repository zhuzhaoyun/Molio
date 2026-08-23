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
  /** 轮换宽限窗（秒）：被轮换吊销的 token 在窗内重放视为重试而非攻击 */
  rotationGraceSec: number;
  rate: RateLimits;
  /** 无 DATABASE_URL 时走 MemoryAuthStore（§十七 L7） */
  databaseUrl?: string;
  /** DirectMail 配置齐全时才有值；prod 缺失时 loadConfig 直接抛错（fail-fast） */
  directMail?: DirectMailConfig;
}

/**
 * DirectMail 回信地址格式。比通用邮箱校验更严：官方文档要求 @ 前后仅限
 * 数字/字母/下划线/减号/点——显示名（"客服 <a@b.c>"）、+ 号、空格都会被
 * SingleSendMail 以 InvalidReplyToAddress 拒收（2026-08-23 线上 422 事故）。
 * 域名至少含一个点（同 service.ts EMAIL_RE 的思路）。
 */
const DM_REPLY_TO_RE = /^[A-Za-z0-9._-]+@([A-Za-z0-9._-]+\.)+[A-Za-z0-9._-]+$/;

function rawPort(env: NodeJS.ProcessEnv): string | undefined {
  return env.PORT !== undefined && env.PORT !== '' ? env.PORT : undefined;
}

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  // 必须是正整数：小数（如 0.5）取整会变 0，导致限频上限为 0 锁死全部发信
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`[cloud] env ${key} 必须是正整数，实际值: ${raw}`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const rawEnvName = env.MOLIO_ENV;
  const envName = (rawEnvName ?? 'local') as CloudEnv;
  if (envName !== 'local' && envName !== 'daily' && envName !== 'prod') {
    throw new Error(`[cloud] MOLIO_ENV 非法: ${envName}（可选 local/daily/prod）`);
  }
  const databaseUrl = env.DATABASE_URL || undefined;
  if (rawEnvName === undefined) {
    // devCode 仅在非 prod 返回；MOLIO_ENV 缺省按 local 处理，部署环境漏配会把验证码后门带上生产，
    // 因此连持久库（= 部署形态）时强制显式声明环境，其余场景仅告警。
    if (databaseUrl) {
      throw new Error('[cloud] 配置 DATABASE_URL 时必须显式设置 MOLIO_ENV（local/daily/prod）');
    }
    console.warn('[cloud] MOLIO_ENV 未设置，按 local 处理（send-code 响应将附带 devCode，仅限本地开发）');
  }

  // trim 后校验：纯空白字符串是 truthy，不能当作有效密钥/pepper
  const jwtSecret = (env.MOLIO_JWT_SECRET ?? '').trim();
  const codePepper = (env.MOLIO_CODE_PEPPER ?? '').trim();
  if (envName === 'prod') {
    if (!jwtSecret) throw new Error('[cloud] prod 环境必须设置 MOLIO_JWT_SECRET');
    if (!codePepper) throw new Error('[cloud] prod 环境必须设置 MOLIO_CODE_PEPPER');
    // prod 禁止内存模式：重启即丢全部用户/会话/验证码状态且无告警（§十七 L7 仅本地开发）
    if (!databaseUrl) throw new Error('[cloud] prod 环境必须设置 DATABASE_URL（禁止内存模式）');
  }
  // 连持久库 = 多实例共享签名密钥与 pepper：随机兜底值会导致跨实例 401 / 验证码 hash 不一致
  if (databaseUrl) {
    if (!jwtSecret) throw new Error('[cloud] 配置 DATABASE_URL 时必须设置 MOLIO_JWT_SECRET');
    if (!codePepper) throw new Error('[cloud] 配置 DATABASE_URL 时必须设置 MOLIO_CODE_PEPPER');
  }

  // DirectMail：三项核心凭据全齐才启用；任一缺失视为未配置。
  // prod 未配置 → 启动即失败（与 NotConfiguredMailer 同源：绝不允许 prod 静默发不出邮件）。
  const dmAkId = env.MOLIO_DM_ACCESS_KEY_ID ?? '';
  const dmAkSecret = env.MOLIO_DM_ACCESS_KEY_SECRET ?? '';
  const dmAccount = env.MOLIO_DM_ACCOUNT_NAME ?? '';
  let directMail: DirectMailConfig | undefined;
  if (dmAkId && dmAkSecret && dmAccount) {
    // region/endpoint 启动期格式校验：坏值会在 deriveDirectMailEndpoint 拼成非法 endpoint，
    // 拖到首次发信才以难懂的 SDK 错误爆出来，与 prod fail-fast 设计不一致
    const region = env.MOLIO_DM_REGION || 'cn-hangzhou';
    if (!/^[a-z0-9-]+$/.test(region)) {
      throw new Error(`[cloud] MOLIO_DM_REGION 非法: ${region}（仅小写字母/数字/连字符，如 cn-hangzhou）`);
    }
    const endpoint = env.MOLIO_DM_ENDPOINT || undefined;
    if (endpoint !== undefined && !/^[a-z0-9.-]+$/.test(endpoint)) {
      throw new Error(`[cloud] MOLIO_DM_ENDPOINT 非法: ${endpoint}（应为纯主机名，如 dm.aliyuncs.com）`);
    }
    // 回信地址：先 trim（env 粘贴事故），再按 DirectMail 字符集校验。
    // 坏值若放过，会在每次 send-code 发信时以难懂的 InvalidReplyToAddress → 422 爆出来，
    // 与上方 region/endpoint 同理，启动期 fail-fast。
    const replyToRaw = (env.MOLIO_DM_REPLY_TO ?? '').trim();
    if (replyToRaw && !DM_REPLY_TO_RE.test(replyToRaw)) {
      throw new Error(
        `[cloud] MOLIO_DM_REPLY_TO 非法: ${replyToRaw}（DirectMail 仅接受裸邮箱，@ 前后限数字/字母/下划线/减号/点，不允许显示名/加号/空格）`,
      );
    }
    directMail = {
      accessKeyId: dmAkId,
      accessKeySecret: dmAkSecret,
      accountName: dmAccount,
      region,
      endpoint,
      replyTo: replyToRaw || undefined,
    };
  } else if (envName === 'prod') {
    throw new Error(
      '[cloud] prod 环境必须完整配置 DirectMail：MOLIO_DM_ACCESS_KEY_ID / MOLIO_DM_ACCESS_KEY_SECRET / MOLIO_DM_ACCOUNT_NAME',
    );
  }

  return {
    env: envName,
    // FC Web 函数注入 CAPort；本地默认 3200（§十三）。
    // 惰性求值：PORT 已设置时不解析 CAPort，无关变量非法不阻断启动。
    port: rawPort(env) !== undefined ? intEnv(env, 'PORT', 3200) : intEnv(env, 'CAPort', 3200),
    // 随机兜底仅限本地内存模式：连库（多实例）/prod 已在上方强制显式注入
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
    databaseUrl,
    directMail,
  };
}
