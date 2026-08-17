// ─── 用户模块（第一期：身份层）共享类型 ───
// 设计见 docs/user-module-design.md。
// 核心约定：Web UI 永不直连云端（@molio/cloud），只经 daemon 本地镜像端点。

/** 用户公开字段（云端 users 表的可暴露子集） */
export interface User {
  /** ULID */
  id: string;
  /** 小写归一化邮箱 */
  email: string;
  /**
   * 显示昵称（隐式注册时云端自动生成「墨友xxxx」，可经 PATCH /auth/me 修改）。
   * 可选：旧 token 文件 / 旧快照可能不含该字段，消费方一律 `nickname || email` 兜底。
   */
  nickname?: string;
  /** ISO 8601 */
  createdAt: string;
}

/** 权益桩：第二期定 schema，第一期为 {} 或仅含少量字段 */
export interface Entitlement {
  plan?: string;
  expiresAt?: string;
  [key: string]: unknown;
}

/**
 * daemon 本地登录态快照（GET /api/auth/status，M2/M3 使用）。
 *
 * 判别联合：把两条不变量收进类型系统，非法状态不可表示——
 * - loggedIn=true **必带 user**（daemon getStatus 已保证；消费方无需再 `&& status.user` 防御）
 * - loggedIn=false 不携带 user/entitlement
 *
 * 注意 `loggedIn: true` 与 `configured: false` **可以合法共存**：本地已有会话后
 * MOLIO_AUTH_URL 被移除（token 还在，云端不可达）。消费方应先处理 loggedIn
 * （登出是本地操作，不依赖云端），再按 configured 决定登录表单/说明。
 */
export type AuthStatus =
  | {
      loggedIn: true;
      /** MOLIO_AUTH_URL 已配置（云端可达前提） */
      configured: boolean;
      user: User;
      entitlement?: Entitlement;
      /** 云端不可达，数据来自本地缓存 */
      stale?: boolean;
    }
  | {
      loggedIn: false;
      /** MOLIO_AUTH_URL 已配置（云端可达前提）；未配置时 Web UI 隐藏登录表单、只给说明 */
      configured: boolean;
      /** 云端不可达，数据来自本地缓存 */
      stale?: boolean;
      /** refresh 已失效，需重新登录 */
      loginExpired?: boolean;
    };

// ─── 云端端点请求/响应（@molio/cloud 第一期 6 端点全集） ───
// 成功形状全部定义在此；失败一律走独立的 { error: string, ...extra } 形状
// （不在本文件建模——错误码集合见 apps/cloud ServiceErrorCode / daemon cloudError）。

export interface SendCodeRequest {
  email: string;
}

export interface SendCodeResponse {
  /** 成功响应恒为 true；失败走 {error, ...extra} 独立形状（如 rate_limited） */
  ok: true;
  resendAfterSec: number;
  /**
   * 仅 daily/local 返回（E2E 用，见设计 D2）；prod 严格不返回。
   * 该保证由云端 fail-closed 配置兜底：apps/cloud loadConfig 在连持久库
   * （部署形态）时强制显式 MOLIO_ENV，prod 缺密钥/发信配置直接启动失败——
   * 「prod 漏配 MOLIO_ENV 回落 local 而泄漏验证码」的路径已封死。
   */
  devCode?: string;
}

export interface VerifyRequest {
  email: string;
  code: string;
  /** 设备提示，如 "Windows desktop v0.4.x" / "Docker NAS" */
  deviceHint?: string;
}

/** access/refresh token 对——verify 与 refresh 共用，将来加轮换字段两处同步。 */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface VerifyResponse extends TokenPair {
  user: User;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface RefreshResponse extends TokenPair {}

export interface MeResponse {
  user: User;
  entitlement: Entitlement;
}

/**
 * PATCH /auth/me（修改当前用户资料）请求。
 * 第一期只有 nickname 一个可写字段；不支持清空（空串/纯空白回 invalid_nickname）。
 * 响应复用 MeResponse——调用方一次拿到最新 user + entitlement，省一次 GET。
 */
export interface UpdateMeRequest {
  nickname: string;
}

/** DELETE /auth/session（本机登出：吊销当前设备 session）成功响应。 */
export interface SessionDeleteResponse {
  ok: true;
}

/** DELETE /auth/account（注销账号：软删除 + 吊销全部 session）成功响应。 */
export interface AccountDeleteResponse {
  ok: true;
}
