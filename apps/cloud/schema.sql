-- @molio/cloud 数据库 DDL（托管 PostgreSQL / PolarDB Serverless）
-- 设计见 docs/user-module-design.md §五。
-- 所有凭据（验证码、refresh token）只存 hash；时间列统一 TIMESTAMPTZ。
--
-- ⚠️ 迁移须知：apply-schema.mjs 全部 IF NOT EXISTS，本文件只对**新建库**生效。
-- 已有库需要同步下方变更时，手动执行对应 SQL（见各节注释），勿直接重跑本文件期待生效。

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,            -- ULID
  email             TEXT NOT NULL,               -- 小写归一化存储；唯一性由下方部分唯一索引保证（注销账号不占位）
  nickname          TEXT,                        -- 显示昵称（隐式注册自动生成「墨友xxxx」，可经 PATCH /auth/me 修改）；无唯一约束
  email_verified_at TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'active',  -- active / deactivated（第二期 admin 封禁桩，第一期无写入方）
  entitlement       JSONB NOT NULL DEFAULT '{}', -- 权益桩：{plan, expiresAt, ...}，schema 第二期定
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,                 -- 软删除（个保法要求可注销）
  -- CHECK 约束只拦应用层 bug（代码路径之外无写入方），新库生效；
  -- 已有库补约束：ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('active','deactivated'));
  CONSTRAINT users_status_check CHECK (status IN ('active', 'deactivated'))
);
-- nickname 是后加列：本文件 IF NOT EXISTS 只对新建库生效。
-- 已有库迁移：ALTER TABLE users ADD COLUMN nickname TEXT;
-- ⚠️ 顺序：先 ALTER 再部署含 nickname 的代码——INSERT/UPDATE 显式引用该列，列缺失会 500。
-- （应用层保证新行非空；存量行 NULL 由 toApiUser 省略该 key、客户端 email 兜底）

CREATE TABLE IF NOT EXISTS auth_codes (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,                     -- 限频查询依赖 index(email)
  code_hash   TEXT NOT NULL,                     -- SHA-256(code + pepper)，不存明文
  expires_at  TIMESTAMPTZ NOT NULL,              -- 签发后 5 分钟
  attempts    INT NOT NULL DEFAULT 0,            -- 错误次数，≥5 锁定该码
  consumed_at TIMESTAMPTZ,                       -- 一次性：验证成功后立即置位
  ip          TEXT,                              -- IP 限频依赖 index(ip, created_at)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 已有库补约束：
  --   ALTER TABLE auth_codes ADD CONSTRAINT auth_codes_attempts_check CHECK (attempts >= 0);
  --   ALTER TABLE auth_codes ADD CONSTRAINT auth_codes_ttl_check CHECK (expires_at > created_at);
  CONSTRAINT auth_codes_attempts_check CHECK (attempts >= 0),
  CONSTRAINT auth_codes_ttl_check CHECK (expires_at > created_at)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          TEXT PRIMARY KEY,                  -- token id (jti)
  user_id     TEXT NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL UNIQUE,              -- SHA-256，不存明文
  device_hint TEXT,                              -- "Windows desktop v0.4.x" / "Docker NAS"
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,              -- 30 天，每次轮换顺延（滑动）
  revoked_at  TIMESTAMPTZ,                       -- 吊销：logout / rotation / admin / replay
  replaced_by TEXT,                              -- 轮换产生的新 token id（审计链 + 宽限窗重放追踪）
  -- 已有库补约束：
  --   ALTER TABLE refresh_tokens ADD CONSTRAINT refresh_tokens_ttl_check CHECK (expires_at > created_at);
  CONSTRAINT refresh_tokens_ttl_check CHECK (expires_at > created_at)
);

-- 部分唯一约束：已注销（软删除）或已停用的账号不占邮箱位，同邮箱可重新建号
-- （§二「注销后再注册」：新建账号，不复活旧账号）
-- ⚠️ 已有库迁移（谓词新增 status 条件，IF NOT EXISTS 不会更新既有索引）：
--   DROP INDEX users_email_alive;
--   CREATE UNIQUE INDEX users_email_alive ON users (email) WHERE deleted_at IS NULL AND status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS users_email_alive  ON users (email) WHERE deleted_at IS NULL AND status = 'active';
-- 限频查询（同邮箱重发间隔 / 每邮箱每日上限 / 每 IP 每日上限）
CREATE INDEX IF NOT EXISTS auth_codes_email          ON auth_codes (email);
CREATE INDEX IF NOT EXISTS auth_codes_ip_created     ON auth_codes (ip, created_at);
-- 「吊销该用户全部 session」（重放检测 / 注销账号）按 user_id 查
CREATE INDEX IF NOT EXISTS refresh_tokens_user       ON refresh_tokens (user_id);
-- 保留期清理（下方注释 SQL）扫描用
CREATE INDEX IF NOT EXISTS auth_codes_created        ON auth_codes (created_at);
CREATE INDEX IF NOT EXISTS refresh_tokens_expires    ON refresh_tokens (expires_at);

-- ── 保留期清理（§五：第一期无定时任务，手动/运维按需执行） ──
-- 清理顺序受 FK 约束：refresh_tokens.user_id REFERENCES users(id)，
-- 将来硬删 users 前必须先删该用户的 refresh_tokens（当前只有软删除，不受影响）。
--
-- 验证码 7 天（远超 5min 有效期 + 1 天限频窗口）：
--   DELETE FROM auth_codes WHERE created_at < now() - interval '7 days';
-- refresh token 90 天（30 天滑动 TTL + 宽限/审计富余）：
--   DELETE FROM refresh_tokens WHERE expires_at < now() - interval '90 days';

-- ── 资源市场（社区知识库分享，设计见 2026-08-25-community-vault-sharing-design.md）──
-- 已有库迁移（本文件 IF NOT EXISTS 只对新建库生效）：手动执行下方 CREATE TABLE + 两条索引。
-- 已建 market_listings 的存量库补新列：ALTER TABLE market_listings ADD COLUMN pending_update JSONB;
CREATE TABLE IF NOT EXISTS market_listings (
  id             TEXT PRIMARY KEY,                 -- ULID
  user_id        TEXT NOT NULL REFERENCES users(id),
  source         TEXT NOT NULL DEFAULT 'community',-- official | community
  name           TEXT NOT NULL,
  icon           TEXT NOT NULL,
  tint           TEXT NOT NULL,
  summary        TEXT NOT NULL,
  overview       JSONB NOT NULL DEFAULT '[]',
  highlights     JSONB NOT NULL DEFAULT '[]',
  tags           JSONB NOT NULL DEFAULT '[]',
  previews       JSONB NOT NULL DEFAULT '[]',      -- 预览图绝对 URL 数组
  version        TEXT NOT NULL DEFAULT 'v1.0',
  price_cents    INTEGER NOT NULL DEFAULT 0,       -- Plan 1 恒 0；定价能力 Plan 2
  pay_url        TEXT NOT NULL DEFAULT '',
  author_display TEXT,
  oss_key        TEXT NOT NULL,                    -- resources/{listingId}-vault.zip
  file_size      BIGINT,
  status         TEXT NOT NULL DEFAULT 'uploading',-- uploading | active | removed
  removed_reason TEXT,
  pending_update JSONB,                            -- 更新中暂存声明 {previews:[{key}]}；非更新态 NULL
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at   TIMESTAMPTZ,
  CONSTRAINT market_listings_status_check CHECK (status IN ('uploading','active','removed')),
  CONSTRAINT market_listings_source_check CHECK (source IN ('official','community'))
);
CREATE INDEX IF NOT EXISTS market_listings_active_idx
  ON market_listings (published_at DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS market_listings_user_idx ON market_listings (user_id, created_at DESC);
