-- @molio/cloud 数据库 DDL（托管 PostgreSQL / PolarDB Serverless）
-- 设计见 docs/user-module-design.md §五。
-- 所有凭据（验证码、refresh token）只存 hash；时间列统一 TIMESTAMPTZ。

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,            -- ULID
  email             TEXT NOT NULL,               -- 小写归一化存储；唯一性由下方部分唯一索引保证（注销账号不占位）
  email_verified_at TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'active',  -- active / deactivated（第二期 admin 封禁桩，第一期无写入方）
  entitlement       JSONB NOT NULL DEFAULT '{}', -- 权益桩：{plan, expiresAt, ...}，schema 第二期定
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ                  -- 软删除（个保法要求可注销）
);

CREATE TABLE IF NOT EXISTS auth_codes (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,                     -- 限频查询依赖 index(email)
  code_hash   TEXT NOT NULL,                     -- SHA-256(code + pepper)，不存明文
  expires_at  TIMESTAMPTZ NOT NULL,              -- 签发后 5 分钟
  attempts    INT NOT NULL DEFAULT 0,            -- 错误次数，≥5 锁定该码
  consumed_at TIMESTAMPTZ,                       -- 一次性：验证成功后立即置位
  ip          TEXT,                              -- IP 限频依赖 index(ip, created_at)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          TEXT PRIMARY KEY,                  -- token id (jti)
  user_id     TEXT NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL UNIQUE,              -- SHA-256，不存明文
  device_hint TEXT,                              -- "Windows desktop v0.4.x" / "Docker NAS"
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,              -- 30 天，每次轮换顺延（滑动）
  revoked_at  TIMESTAMPTZ,                       -- 吊销：logout / rotation / admin / replay
  replaced_by TEXT                               -- 轮换产生的新 token id（审计链 + D1 宽限窗追踪）
);

-- 部分唯一约束：已注销（软删除）账号不占邮箱位，同邮箱可重新建号
-- （§二「注销后再注册」：新建账号，不复活旧账号）
CREATE UNIQUE INDEX IF NOT EXISTS users_email_alive  ON users (email) WHERE deleted_at IS NULL;
-- 限频查询（同邮箱重发间隔 / 每邮箱每日上限 / 每 IP 每日上限）
CREATE INDEX IF NOT EXISTS auth_codes_email          ON auth_codes (email);
CREATE INDEX IF NOT EXISTS auth_codes_ip_created     ON auth_codes (ip, created_at);
-- 「吊销该用户全部 session」（重放检测 / 注销账号）按 user_id 查
CREATE INDEX IF NOT EXISTS refresh_tokens_user       ON refresh_tokens (user_id);
