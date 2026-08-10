# 用户模块（云端认证服务）设计

> 状态: **实施中**（2026-08-07 重启；附录 B 的 FC 评估结论已折回正文）
> 日期: 2026-08-07
> 范围: 第一期 = 身份层（注册/登录/token）；**不含**多端同步、支付、设备管理

## 一、背景与目标

Molio 目前是纯本地应用：没有任何用户概念，`AppConfig` 只有 agents/weixin/feishu/preload，daemon 绑定 localhost、所有 API 无鉴权（信任模型 = 本机单用户）。

为支撑后续的**多端同步**与**付费功能**，并让**日志监控**（ARMS/SLS）能按用户归因故障，需要先建立用户身份体系。本文档定义第一期的用户模块：云端认证服务 + 客户端登录能力。

### 第一期目标

1. 用户能用邮箱验证码注册/登录（注册即登录，无密码）
2. token 安全落本地，支持静默续期、服务端可吊销
3. ARMS 监控注入 userId，支持按用户排障
4. 权益（entitlement）字段留桩，为第二期付费做准备
5. **local-first 底线**：云端不可达时，本地功能（知识库、AI run）零影响

### 三层边界（不要混淆）

| 层 | 内容 | 期次 |
|---|---|---|
| 身份层 | 注册/登录/token/用户表 | ✅ 第一期（本文档） |
| 权益层 | 免费/付费、设备数、功能开关 | 第二期；表结构第一期留桩 |
| 数据层 | 多端同步（冲突解决、加密、增量协议） | 独立立项，不在本设计范围 |

## 二、已拍板的决策

| 决策点 | 结论 | 影响 |
|---|---|---|
| 登录强制性 | **可选登录** | 未登录态是一等公民，本地功能零依赖云端；所有付费功能需"未登录→引导登录"分支 |
| 注册方式 | **邮箱 + 验证码**（第一期） | 无密码设计：新邮箱首次验证即隐式注册，省掉注册页/密码找回/重置链路 |
| 服务形态 | **自建轻量服务，FC 部署** | 代码 = 标准 Hono HTTP 服务（团队零学习成本、可容器化）；计算层用阿里云函数计算 FC（Web 函数形态），数据层托管 PG；数据自控；将来信创私有化改回 Docker 镜像部署即可（FC 只是官方云的部署形态，见附录 B） |
| 自部署策略 | **Docker/NAS 也连云端官方登录** | daemon 加 `MOLIO_AUTH_URL` 可覆盖端点，天然为私有化留口子 |
| 注销后再注册 | **同邮箱重新建号**（2026-08-10 拍板） | users.email 用部分唯一索引（`UNIQUE WHERE deleted_at IS NULL`）；新号新 ULID，历史数据与监控归因不找回（同 D4 一类代价）；隐私政策声明"注销后再注册视为新用户" |

## 三、架构总览

```
┌─────────────────────────────┐        ┌──────────────────────────┐
│ 客户端（桌面/Docker/web）      │        │  云端认证服务 @molio/cloud │
│                             │  HTTPS │                          │
│ web: 登录页/账户面板          │◄──────►│  Hono（FC Web 函数）       │
│ daemon: auth client 模块    │        │  + 托管 PostgreSQL          │
│ desktop: safeStorage 存token │        │                          │
│                             │        │  send-code / verify /    │
│ 本地功能完全不经这条路          │        │  refresh / me / session / │
└─────────────────────────────┘        │  account                 │
                                       │  邮件: 阿里云 DirectMail   │
                                       └──────────────────────────┘
```

**核心约定**：Web UI 永远不直接连云端，只跟本地 daemon 说话（与现有架构一致）。daemon 是唯一的 token 持有者和云端通信方——token 管理、重试退避、离线缓存全部收在 daemon 一处。

**信任模型不变**：daemon 本地 API（localhost）维持现状不加鉴权；鉴权只存在于 daemon → 云端这条链路。daemon 维持「一设备一用户」单用户模型，不做多租户。

## 四、范围：做什么 / 不做什么

**第一期做**：

1. 云端：用户表 + 验证码（限频/过期/错次锁定）+ JWT access + 可吊销轮换 refresh + `GET /me`（权益留桩）+ 注销账号 API
2. 客户端：contracts 类型、daemon auth client（token 刷新 + 权益快照缓存）、web 登录/账户 UI、desktop safeStorage、Docker `.env` 加 `MOLIO_AUTH_URL`
3. 监控：登录后 ARMS 注入 userId；云端日志带 userId
4. 合规：隐私政策 + 用户协议更新（上线前置）

**明确不做**：多端同步、支付、设备管理（踢下线/设备数限制）、手机/微信登录、daemon 多租户、密码体系。

## 五、数据库设计（托管 PostgreSQL，三张表）

```sql
CREATE TABLE users (
  id                TEXT PRIMARY KEY,            -- ULID
  email             TEXT NOT NULL,               -- 小写归一化存储；唯一性由下方部分唯一索引保证（注销账号不占位）
  email_verified_at TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'active',  -- active / deactivated（第二期 admin 封禁桩，第一期无写入方）
  entitlement       JSONB NOT NULL DEFAULT '{}', -- 权益桩：{plan, expiresAt, ...}，schema 第二期定
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ                  -- 软删除（个保法要求可注销）
);

CREATE TABLE auth_codes (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,                     -- 限频查询依赖 index(email)
  code_hash   TEXT NOT NULL,                     -- SHA-256(code + pepper)，不存明文
  expires_at  TIMESTAMPTZ NOT NULL,              -- 签发后 5 分钟
  attempts    INT NOT NULL DEFAULT 0,            -- 错误次数，≥5 锁定该码
  consumed_at TIMESTAMPTZ,                       -- 一次性：验证成功后立即置位
  ip          TEXT,                              -- IP 限频依赖 index(ip, created_at)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id          TEXT PRIMARY KEY,                  -- token id (jti)
  user_id     TEXT NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL UNIQUE,              -- SHA-256，不存明文
  device_hint TEXT,                              -- "Windows desktop v0.4.x" / "Docker NAS"
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,              -- 30 天，每次轮换顺延（滑动）
  revoked_at  TIMESTAMPTZ,                       -- 吊销：logout / rotation / admin / replay
  replaced_by TEXT                               -- 轮换产生的新 token id（审计链）
);

-- 部分唯一约束：已注销（软删除）账号不占邮箱位，同邮箱可重新建号（见 §二「注销后再注册」）
CREATE UNIQUE INDEX users_email_alive  ON users (email) WHERE deleted_at IS NULL;
-- 限频查询（下文设计要点依赖这两个索引）
CREATE INDEX auth_codes_email          ON auth_codes (email);
CREATE INDEX auth_codes_ip_created     ON auth_codes (ip, created_at);
-- 「吊销该用户全部 session」（重放检测 / 注销账号）按 user_id 查
CREATE INDEX refresh_tokens_user       ON refresh_tokens (user_id);
```

设计要点：

- **验证码与 refresh token 都只存 hash**，DB 泄漏不等于凭据泄漏
- **refresh token 存 DB 是有意为之**：这是服务端主动吊销（登出、将来踢下线、封禁）的唯一抓手；纯 JWT 做不到
- **限频以 DB 查询为准**：FC 实例短暂且多实例，内存限流不可用；限频判断全部走 `auth_codes` 表查询（index(email) / index(ip, created_at)）；数值：同邮箱 60s 重发间隔 / 每邮箱每日 10 封 / 每 IP 每日 30 次，均可 env 覆盖；第一期不引 Redis，将来流量上来再评估
- **持久层抽象为 `AuthStore` 接口**：`PgAuthStore`（生产，PolarDB Serverless）+ `MemoryAuthStore`（node:test 用）双实现。SQL DDL 集中在 `schema.sql`，业务测试不依赖真库（CI 的 win/mac 无 PG）；部署前对真库做一次冒烟
- `entitlement` 用 JSONB 留桩，第二期定 schema 前不写死列
- **注销后同邮箱 = 新账号**：部分唯一索引让保留期内的软删除旧行与新账号共存；所有鉴权路径对活跃账号的判定统一为 `deleted_at IS NULL AND status = 'active'`（收口在 AuthStore 方法内，路由不重复拼条件）
- **邮箱归一化在 send-code / verify 入口就强制**（小写），否则每邮箱限频与 code_hash 比对可被大小写绕过
- `updated_at` 由应用层维护（更新操作同步写入），PG 不自动更新
- **过期数据清理**：auth_codes（含 IP，属个人信息）保留 7 天，失效 refresh_tokens 保留 90 天；第一期手动 SQL 定期执行，第二期与 L3 物理清除一并做成 FC 定时触发器
- **并发注册兜底**：两台设备同时验证同一新邮箱时靠部分唯一索引兜底，verify 捕获 unique_violation 后回退为复用刚建账号，不得 500

## 六、API 设计

### 云端（`@molio/cloud`，第一期全集 = 6 个端点）

| Method | Path | 入参 | 出参 | 说明 |
|---|---|---|---|---|
| POST | `/auth/send-code` | `{email}` | `202 {ok, resendAfterSec}` | 限频（数值可 env 覆盖）：同邮箱 60s 重发间隔 / 每邮箱每日 10 封 / 每 IP 每日 30 次；429 = rate_limited |
| POST | `/auth/verify` | `{email, code}` | `200 {accessToken, refreshToken, user}` | 邮箱不存在（或对应账号已注销）则隐式建新号；401 = invalid_code / locked |
| POST | `/auth/refresh` | `{refreshToken}` | `200 {accessToken, refreshToken}` | 轮换：旧 refresh 作废发新的；**重放检测**：已用过的 refresh 再次出现 → 吊销该用户全部 session |
| GET | `/auth/me` | Bearer access | `{user, entitlement}` | 权益快照来源 |
| DELETE | `/auth/session` | Bearer access + `{refreshToken}` | `{ok}` | 吊销当前设备（本机登出） |
| DELETE | `/auth/account` | Bearer access | `{ok}` | 注销账号：软删除 + 吊销全部 session（个保法硬要求） |

Token 规格：

| | Access Token | Refresh Token |
|---|---|---|
| 形态 | JWT（**HS256**，支持 kid 轮换） | 256-bit 随机串 |
| 寿命 | 15 分钟 | 30 天滑动 |
| payload | `{sub: userId, email, jti: 关联 refresh id}` | 只存 hash 于 DB |
| 用途 | 每次云端 API 调用携带 | 仅用于换新 token 对 |

### daemon 本地镜像（给 Web UI 用）

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/auth/start` `{email}` | 转发云端 send-code |
| POST | `/api/auth/verify` `{email, code}` | 转发云端 verify，token 落本地存储 |
| GET | `/api/auth/status` | 登录态 + 用户 + 权益快照（Web UI 渲染用；离线时返回缓存快照 + `stale: true`；`configured` 标记 MOLIO_AUTH_URL 是否已配置，未配置时 Web 隐藏登录表单） |
| POST | `/api/auth/logout` | 云端吊销 + 清本地 token |
| DELETE | `/api/auth/account` | 注销账号（§7.4）：云端软删除 + 吊销全部 session 成功后才清本地 token；云端不可达 → 502 且保留本地 token 供重试（与 logout 的本地优先语义相反） |

## 七、核心流程

### 7.1 验证码登录（注册 = 登录）

```
用户          Web UI         daemon              云端                 邮件通道
 │ 输入邮箱点"发送验证码" │                │                  │               │
 │─────────►│ POST /api/auth/start │      │                  │               │
 │          │───────────►│ POST /auth/send-code {email}      │               │
 │          │            │        │ ① 限频检查：同邮箱60s、每日上限、IP限频     │
 │          │            │        │ ② 生成6位码，hash后存DB（5分钟有效）        │
 │          │            │        │──────────────────────────►│ 发验证邮件     │
 │ 输入验证码，提交        │        │                  │               │
 │─────────►│ POST /api/auth/verify │     │                  │               │
 │          │───────────►│ POST /auth/verify {email, code}   │               │
 │          │            │        │ ③ hash比对；错≤5次，超限锁定              │
 │          │            │        │ ④ 验证码一次性，验证后立即作废              │
 │          │            │        │ ⑤ 邮箱不存在 → 隐式创建用户                │
 │          │            │◄───────│ {access 15min, refresh 30天, user}       │
 │          │            │ ⑥ token 落盘（桌面 safeStorage；文件 chmod 600）   │
 │          │◄───────────│ {user, loggedIn: true}            │               │
```

### 7.2 静默续期（用户无感）

```
daemon 调云端 API（带 access）
  ├─ 200 → 正常返回
  └─ 401（access 过期）
       ├─ /auth/refresh 换新 token 对 → 重试原请求（用户无感）
       └─ refresh 也失效 → 标记"未登录"，通知 Web UI 显示"登录已过期"
```

daemon 另在 access 剩余寿命 < 2 分钟时主动刷新，避免请求中途失败。

### 7.3 启动恢复 + 离线容错

```
App 启动 → daemon 读本地 token
  ├─ 能连云 → /auth/refresh 验证 → 恢复登录态，拉权益快照缓存本地
  └─ 连不上云（NAS 断网/云端故障）
       ├─ 本地功能：完全不受影响
       └─ 付费功能：用本地权益快照宽限（默认 7 天），过期降级提示而非锁死
```

### 7.4 登出 / 吊销 / 注销

- **本机登出**：daemon 调 `DELETE /auth/session` + 清本地 token
- **远程吊销**：refresh 存 DB，第二期设备管理可吊销任意设备 session
- **注销账号**：`DELETE /auth/account`，软删除 + 吊销全部 session；Web UI 账户面板提供入口；注销后同邮箱再注册创建新账号（新 userId，历史不找回）

## 八、安全设计

| 项 | 方案 |
|---|---|
| 验证码存储 | SHA-256(code + pepper)，pepper 走环境变量 |
| 验证码滥用 | 三层限频（同邮箱 60s / 每日 10 封 / 每 IP 每日 30 次）+ 错 5 次锁码；后续可加图形验证码 |
| refresh 泄漏 | 轮换机制：旧 token 被重放 → 判定泄漏 → 吊销该用户全部 session |
| 本地 token 存储 | 桌面：Electron `safeStorage`；Docker/web：daemon 目录文件 chmod 600。**token 不进明文 `config.json`** |
| 传输 | 全链路 HTTPS。第一期无浏览器直连云端（Web UI 一律经 daemon），**不配 CORS**；将来若加云端托管登录页再开白名单 |
| 密钥管理 | JWT 签名密钥支持 kid 轮换；密钥不入代码库 |

## 九、离线宽限策略（local-first 红线）

原则：**云端不可达时，降级的是"增值"，不是"可用"。**

| 场景 | 行为 |
|---|---|
| 未登录 | 全部本地功能可用，UI 提供非阻断式登录入口 |
| 已登录、云端不可达 | 本地功能不受影响；权益用本地快照宽限（默认 7 天） |
| 宽限期已过、仍不可达 | 付费功能降级提示（不锁死），本地功能仍可用 |
| 云端故障恢复 | 下次心跳自动重新校验权益 |

宽限时长是信任权衡：太松 = 白嫖漏洞，太紧 = 体验差。第一期定 7 天，做成配置项。

## 十、客户端改动清单

| 模块 | 改动 |
|---|---|
| `packages/contracts` | 新增 `User` / `Entitlement` / `AuthStatus` 类型。⚠️ daemon 测试吃 contracts dist，改后须先 build |
| `apps/daemon` | 新增 `core/auth/`：`auth-client.ts`（云端 API + 重试退避，复用 retry 模式）、`token-store.ts`、`entitlement-cache.ts`；`routes/auth.ts`（5 个本地端点：start/verify/status/logout/account）；`MOLIO_AUTH_URL` 环境变量 |
| `apps/web` | 登录页（邮箱 + 验证码两步）、账户设置面板、登录态 store；关键交互元素加 `data-testid`，同步 E2E |
| `apps/desktop` | `safeStorage` token 持久化 IPC；登录后 ARMS 注入 userId |
| Docker 部署 | `.env.example` / `install.sh` 内嵌模板加 `MOLIO_AUTH_URL`（⚠️ install.sh heredoc 同步规则） |

## 十一、监控接入

- **ARMS**：登录态变化后注入 userId（需先验证 `@arms/rum-electron` 的用户打标 API）。注入时机：登录成功、启动恢复登录态、登出清除
- **云端日志**：所有请求日志带 userId（SLS），支撑按用户排障
- **隐私**：userId 上报必须在隐私政策中明确声明（见下节）

## 十二、合规要求（上线前置）

1. **隐私政策**：更新 `docs/privacy.html`，声明收集邮箱、上报 userId、数据用途
2. **用户协议**：登录页展示并需勾选同意
3. **注销账号**：API + UI 入口齐全（个保法硬要求），软删除 + 法定最短保留期后清除
4. **数据最小化**：第一期只收集邮箱，不收集手机号/实名信息

## 十三、部署

| 项 | 方案 |
|---|---|
| 代码位置 | monorepo 新增 `apps/cloud`（`@molio/cloud`），复用 contracts 与 node:test；**独立部署，不进 Molio 应用镜像** |
| 运行时 | Hono + `@hono/node-server`（与 daemon 一致）；代码保持可容器化，FC 只是部署形态之一 |
| 部署 | **阿里云函数计算 FC**：Web 函数 / Custom Runtime 形态，HTTP server 原样部署（监听 `CAPort`）；Serverless Devs（`s deploy`）发布；daily/prod 两个函数。VPC 连 PG 有冷启动（百 ms~1-2s），登录低频可接受 |
| DB | **PolarDB Serverless**（已拍板）：按负载弹性、低流量自动缩到极低规格，与 FC「用才付费」最搭 |
| 邮件 | 阿里云 DirectMail，走**官方 SDK**（`@alicloud/dm20151123`）；发信域名需配置 SPF/DKIM |
| 域名 | **需 ICP 备案，周期 1-2 周，最先启动**；FC 自定义域名同样要备案，且「备案服务号」FC 可申请但有数量限制，M0 先确认 |
| 环境 | daily / prod 双环境（对齐 ARMS 的 env 概念）；daily 环境验证码写日志不发真邮件 |
| 本地开发 | cloud 可本地跑（`pnpm dev:cloud`，tsx + MemoryAuthStore，无 DATABASE_URL 时自动内存模式）；daemon 以 `MOLIO_AUTH_URL=http://localhost:3200` 指向本地 cloud；web E2E 走这条链路（验证码获取方式见 §十四，待定） |
| CI | 新增 `cloud.yml`：typecheck + node:test；部署流程第一期可手动，稳定后再自动化 |

## 十四、测试策略

遵循项目错误驱动测试规则：

| 层 | 框架 | 覆盖 |
|---|---|---|
| cloud | node:test | 限频、验证码过期/锁码/一次性、隐式注册、轮换与重放检测、注销（含同邮箱再注册建新号） |
| daemon | node:test | mock 云端行为（非仅返回值）：401→刷新→重试、refresh 失效→登出态、云端不可达→宽限 |
| web | Playwright | 登录流程（daily 模式读日志验证码）、未登录态全功能可用、登录过期提示；`data-testid` 定位 |

老版本升级回归：E2E 必须覆盖「从未登录」场景，确认存量用户零感知。

## 十五、实施分期

| 里程碑 | 内容 | 依赖 |
|---|---|---|
| M0 | 域名备案启动 + 隐私政策草稿 + DirectMail 发信域名配置 | 外部周期最长，立即启动，不占开发资源 |
| M1 | `apps/cloud` 骨架：三张表 + 6 端点 + node:test | 域名备案并行 |
| M2 | daemon auth client + token 存储 + 权益快照缓存 | M1 |
| M3 | web 登录 UI + 账户面板 + E2E | M2 |
| M4 | desktop safeStorage + ARMS userId | M2 |
| M5 | Docker `.env` + install.sh 同步 + 文档 + 发版 | M3/M4 |

> 实施记录（2026-08-07）：本轮在 `feat/user-auth` 分支一次实施 M1~M5；M0（域名备案）待用户启动，不阻塞开发。

## 十六、风险与开放问题

| 风险/问题 | 说明 | 对策 |
|---|---|---|
| ICP 备案周期 | 1-2 周，卡上线 | M0 立即启动；同时确认 FC 备案服务号可申请 |
| 验证码轰炸 | 邮件通道也会被刷（成本 + 骚扰） | 三层限频先行（DB 查询实现，见 §五），观察后决定是否加图形验证码 |
| FC 冷启动 | VPC 连 PG 拉长冷启动，首次登录请求可能 1-2s | 登录低频可接受；介意可设单实例并发（摊薄冷启动）或少量预留实例 |
| ARMS 用户打标 API | 未验证 SDK 支持程度 | M4 开工前先 spike 验证 |
| 权益 schema 未定 | 取决于第二期商业模式（订阅 vs 功能包） | 第一期只留 JSONB 桩，不做任何付费判断逻辑 |
| 邮件送达率 | DirectMail 进垃圾箱风险 | 发信域名 SPF/DKIM 配好；文案引导"检查垃圾邮件" |
| NAS 长期离线 | 超过宽限期后付费功能降级，用户可能不满 | 降级提示说明原因；宽限时长可配置 |
| 目标用户不用邮箱 | 用户群为非技术人群，可能不常查邮箱，验证码登录转化率低 | UI 文案引导「检查垃圾邮件」；观察登录漏斗，第二期评估微信登录（详见 §十七） |
| 云端 DB 丢失 | 全员掉线 + 账号重建后 userId 变化 | PolarDB 自动备份；影响与代价见 §十七 D4 |

## 十七、设计自查（2026-08-07）：已知缺陷、限制与开放问题

> 重启实施前的一轮批判性自查。状态分三类：**已定对策**（实施时照做）、**接受**（已知限制，写清楚不解决）、**待定**（需要继续讨论）。

### 缺陷类（必须处理）

| # | 问题 | 分析 | 对策 | 状态 |
|---|---|---|---|---|
| D1 | **重放检测误伤重试**：daemon 的 refresh 请求若服务端已成功但响应丢失（超时重试），重放的旧 refresh 会被判"泄漏"→ 吊销该用户全部 session → 全设备掉线；并发请求同时触发 refresh（无单飞锁）同样引发轮换竞争 | 轮换式重放检测与"至少一次"重试天然冲突，是业界已知问题（OAuth rotation reuse detection 普遍配 leeway） | 双管齐下：① daemon refresh **single-flight**（并发刷新共享一个 Promise）；② 云端**轮换宽限窗**：被轮换吊销（有 `replaced_by`）且吊销时间 <30s 的 token 再次出现，视为重试而非攻击——不吊销，直接返回替换链上的新 token 对；超过宽限窗或人工吊销的才触发全吊销 | 已定对策 |
| D2 | **E2E 拿不到验证码**：web E2E 测登录流程，验证码走邮件（daily 只写日志），测试无法读取云端日志 | — | daily/local 模式下 `send-code` 响应附加 `devCode` 字段（prod 模式严格不返回）；daily 环境不得带此开关暴露公网 | 已定对策 |
| D3 | **Windows 上 chmod 600 无意义**：§八「Docker/web：文件 chmod 600」在 Windows（主开发平台）不生效 | daemon 现有信任模型本就是「本机单用户」（localhost 免鉴权、SQLite 明文），token 明文文件与现有数据同级 | 明确分级：Linux/macOS chmod 600；Windows 非桌面模式明文文件（与 SQLite/config 同信任级，文档声明）；桌面端 safeStorage 是**增强**而非基线。token 仍不进 config.json（避免随配置误同步） | 已定对策 |
| D4 | **云端 DB 无灾备声明**：users/refresh 全在 PolarDB，丢库 = 全员掉线 + 账号丢失 | PolarDB 有自动备份能力 | 开启自动备份；文档声明：DB 丢失后用户可凭邮箱验证码隐式注册"找回"，但 userId 会变（ULID 重建）→ ARMS 历史归因断裂，属可接受代价 | 已定对策 |

### 限制类（接受，写清楚）

| # | 限制 | 说明 |
|---|---|---|
| L1 | **verify 端点不做限频**：安全性推理 = send-code 限频（每邮箱每日 10 封）× 每码错 5 次锁定 = 每邮箱每日最多暴试 50 次，6 位码空间 10^6，期望破解时间 >> 账号寿命。verify 无需再限频 |
| L2 | **防邮箱枚举是有意设计**：send-code 对已注册/未注册邮箱一律返回 202，不泄露注册状态 |
| L3 | **注销清理第一期只软删除**：`deleted_at` 置位即完成个保法"注销"动作；法定保留期后的物理清除第一期无定时任务，手动 SQL 或第二期加 FC 定时触发器 |
| L4 | **NAS 多用户共享单账号**：daemon「一设备一用户」模型下，多人共用一台 NAS daemon = 共享同一登录态。第一期明确不做多租户，接受 |
| L5 | **限频竞态窗口**：FC 多实例并发 send-code 可能同时通过"距上次 >60s"检查 → 极端情况双发一封邮件。损害有限，接受；不引入分布式锁 |
| L6 | **kid 轮换第一期只留桩**：JWT payload 带 kid 位，但第一期单密钥（env 注入）；密钥轮换操作流程第二期定 |
| L7 | **本地开发重启丢登录态**：无 DATABASE_URL 时走 MemoryAuthStore，cloud 重启 = 所有 token 失效，开发时需重新走验证码。预期行为，不做本地持久化 |
| L8 | **注销后同邮箱再注册 = 新账号**：2026-08-10 拍板（不复活旧账号）。新 ULID，历史数据与 ARMS 归因不找回（同 D4 一类代价）；法定保留期内软删除旧行与新账号共存，唯一性由部分索引 `UNIQUE(email) WHERE deleted_at IS NULL` 保证；隐私政策文案须声明 |

### 风险表增补（§十六 同步）

| 风险/问题 | 说明 | 对策 |
|---|---|---|
| 目标用户不用邮箱 | 用户群为非技术人群，可能不常查邮箱/无邮箱习惯，验证码登录转化率低 | 第一期按已拍板方案做；UI 文案引导「检查垃圾邮件」；观察登录漏斗数据，第二期评估微信登录 |
| 验证码轰炸追打邮件成本 | 每邮箱每日 10 封上限 × 邮箱数 = 成本上限可估算 | 上线后盯 DirectMail 账单，异常再收紧 IP 限频 |

### 开放问题（待定）

| # | 问题 | 备注 |
|---|---|---|
| Q1 | 云端可用性告警：FC/SLS 默认告警是否够？云端挂掉用户无法登录（本地功能不受影响） | 第一期至少接 SLS 默认错误告警，细则部署时定 |
| Q2 | daemon → 云端请求是否带版本头（如 `X-Molio-Version`），为将来 API 兼容判断留依据 | 第一期加了没成本，倾向加 |
| Q3 | 用户对本自查清单之外是否还有疑虑 | 待用户补充 |

## 附录：与现有模块的关联点速查

| 现有模块 | 关联 |
|---|---|
| `AppConfig`（config.ts） | 不加 user 字段；token 走独立 auth store |
| daemon routes | 本地 API 不加鉴权；新增 `routes/auth.ts` 除外走云端 |
| 飞书/微信渠道 | 其 token-store / 状态机 / 重试模式可作为 auth client 的实现参考 |
| ARMS（desktop monitoring.js） | 登录态注入 userId 的挂载点 |
| OSS/ACR | cloud 服务不走这两条发版链路，独立部署 |

## 附录 B：FC 部署形态评估（2026-08-07，存档时结论）

针对「计算层用阿里云函数计算 FC 还是 ECS/Docker 常驻」的评估结论：

**结论：FC 适合，代码形态零改动（Hono HTTP 服务经 Web 函数/Custom Runtime 原样部署），但以下四处需在启用时修订本文档：**

| # | 修订点 | 说明 |
|---|---|---|
| 1 | §五 限频方案 | FC 实例短暂且多实例，**内存限流器失效**，改为以 `auth_codes` 表 DB 查询限频为主（原设计的兜底方案扶正为主方案） |
| 2 | §十三 冷启动 | VPC 连 RDS 拉长冷启动（百 ms~1-2s），登录低频可接受；介意可设单实例并发或少量预留实例 |
| 3 | M0 备案 | FC 自定义域名大陆地域同样要 ICP 备案；注意「备案服务号」FC 可申请但有数量限制，M0 先确认 |
| 4 | §二 私有化表述 | FC 搬不进内网，但**只影响部署形态不影响代码**——apps/cloud 仍是标准 Node HTTP 服务，私有化时改回 Docker 镜像部署即可 |

**存储层结论：FC 只做计算，存储必须独立托管**（实例用完即释放、多实例、吊销/重放检测需单一事实源）。保持 PostgreSQL 不变，**已拍板选 PolarDB Serverless**（低流量更省，与 FC「用才付费」最搭）。Tablestore 虽趋近零成本但要放弃 SQL，不选。

账单形态：FC 计算（新用户 15 万 CU/月免费×3 个月，之后每月几元级）+ 一个托管 PG（唯一固定成本）。

**存档原因**：用户模块曾整体暂缓（M0 备案等外部动作一并挂起）。**2026-08-07 重启**：模块恢复实施，上表四处修订已折回正文（§二/§五/§十三/§十六），本附录保留为评估记录。
