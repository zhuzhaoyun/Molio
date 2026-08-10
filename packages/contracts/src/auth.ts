// ─── 用户模块（第一期：身份层）共享类型 ───
// 设计见 docs/user-module-design.md。
// 核心约定：Web UI 永不直连云端（@molio/cloud），只经 daemon 本地镜像端点。

/** 用户公开字段（云端 users 表的可暴露子集） */
export interface User {
  /** ULID */
  id: string;
  /** 小写归一化邮箱 */
  email: string;
  /** ISO 8601 */
  createdAt: string;
}

/** 权益桩：第二期定 schema，第一期为 {} 或仅含少量字段 */
export interface Entitlement {
  plan?: string;
  expiresAt?: string;
  [key: string]: unknown;
}

/** daemon 本地登录态快照（GET /api/auth/status，M2 使用） */
export interface AuthStatus {
  loggedIn: boolean;
  user?: User;
  entitlement?: Entitlement;
  /** 云端不可达，数据来自本地缓存 */
  stale?: boolean;
  /** refresh 已失效，需重新登录 */
  loginExpired?: boolean;
}

// ─── 云端端点请求/响应（@molio/cloud 第一期 6 端点） ───

export interface SendCodeRequest {
  email: string;
}

export interface SendCodeResponse {
  ok: boolean;
  resendAfterSec: number;
  /** 仅 daily/local 返回（E2E 用，见设计 D2）；prod 严格不返回 */
  devCode?: string;
}

export interface VerifyRequest {
  email: string;
  code: string;
  /** 设备提示，如 "Windows desktop v0.4.x" / "Docker NAS" */
  deviceHint?: string;
}

export interface VerifyResponse {
  accessToken: string;
  refreshToken: string;
  user: User;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

export interface MeResponse {
  user: User;
  entitlement: Entitlement;
}
