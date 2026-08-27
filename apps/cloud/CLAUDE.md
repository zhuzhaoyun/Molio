# @molio/cloud — 云端认证与资源目录服务

Molio 用户模块的云端服务，两块职责：**身份**（第一期 = 身份层：邮箱验证码登录、token 轮换/吊销、权益留桩与账号注销）+ **资源市场目录**（官方+用户同目录条目元数据：上架/下架/管理；文件字节经 OSS 直传/直下，云端不经手内容）。

**红线**：本地优先。云端只负责身份与权益凭证、资源市场目录元数据（文件字节经 OSS 直传，云端不经手内容），**不存任何知识库内容**；云端不可达时客户端本地功能零影响。**Molio 应用内** Web UI 永不直连本服务，一律经 daemon 本地镜像端点（见 `apps/daemon/src/routes/auth.ts`）；**官网静态页**（molio.cn）登录是唯一例外，浏览器直连本服务，走 `src/cors.ts` 的严格 CORS 白名单（无 cookie、不带 credentials）。

## 技术栈

- **运行时**: Hono + `@hono/node-server`（与 daemon 一致，标准可容器化 HTTP 服务）
- **存储**: PostgreSQL（生产 PolarDB Serverless）；无 `DATABASE_URL` 时自动降级 `MemoryAuthStore`（本地开发，重启丢登录态）
- **鉴权**: HS256 JWT（access，15min）+ 256-bit 随机 refresh（30 天滑动轮换）
- **测试**: node:test（内存 store，不依赖真库）

## 目录结构

```
src/
  index.ts       入口：loadConfig → 按 DATABASE_URL 选 store → serve
  app.ts         Hono 路由（/health + 7 认证端点 + /market 条件挂载）；顶部挂 CORS 白名单中间件
  cors.ts        CORS 白名单：prod 仅 molio.cn(±www)+附加；daily/local 加 localhost；回显 origin 不用 *，不带 credentials
  config.ts      env 加载（MOLIO_ENV / 限频 / TTL / 密钥 / DirectMail / OSS 与市场）
  service.ts     AuthService：限频、一次性原子消费、隐式注册、轮换 + 重放检测
  store/
    types.ts     AuthStore 接口（活跃判定 deleted_at IS NULL AND status='active' 收口于此）
    memory.ts    MemoryAuthStore（node:test / 本地开发）
    pg.ts        PgAuthStore（生产）
    market-types.ts  MarketStore 接口（时间戳统一 epoch 毫秒，与 AuthStore 约定一致）
    market-memory.ts MemoryMarketStore（node:test / 本地开发）
    market-pg.ts     PgMarketStore（生产，语义与内存版逐条对齐）
  jwt.ts         HS256 签发/验签（自实现，kid 留桩）
  crypto.ts      SHA-256(code+pepper) / token hash
  mailer.ts      daily 写 stdout；prod 走阿里云 DirectMail（SingleSendMail），未配置时 loadConfig fail-fast
  market/
    routes.ts    /market/* 路由（公开读 + Bearer 写 + admin 端点；错误归一 {error} JSON）
    service.ts   MarketService：校验/限频/状态机（uploading→active→removed）/签发
    signer.ts    阿里云 OSS V1 签名（node:crypto 零依赖）：预签名直传/直下 + 服务端带 Auth 头请求
test/
  helpers.ts     可编程 mock（时钟/store/邮件）
  *.test.ts      限频、过期/锁码/一次性、隐式注册、轮换与重放、注销、jwt
schema.sql       四表 DDL（users / auth_codes / refresh_tokens / market_listings）+ 部分唯一索引 + 限频索引
```

## 命令

```bash
pnpm dev          # tsx src/index.ts（本地 :3200，内存模式）
pnpm build        # tsc
pnpm test         # rm dist && tsc && node --test dist/test/**（134 用例，含市场四组）
pnpm typecheck    # tsc --noEmit
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `MOLIO_ENV` | 否 | `local`/`daily`/`prod`，默认 `local`。daily/local 的 send-code 响应附带 `devCode`（E2E 用），**prod 严格不返回** |
| `DATABASE_URL` | 否 | PG 连接串；缺省走内存 store |
| `MOLIO_JWT_SECRET` | prod 必填 | HS256 签名密钥，不入代码库 |
| `MOLIO_CODE_PEPPER` | prod 必填 | 验证码 hash pepper |
| `MOLIO_DM_ACCESS_KEY_ID` | prod 必填 | DirectMail 发信 RAM AK（建议最小权限 `dm:SingleSendMail`），不入代码库 |
| `MOLIO_DM_ACCESS_KEY_SECRET` | prod 必填 | DirectMail 发信 RAM SK，不入代码库 |
| `MOLIO_DM_ACCOUNT_NAME` | prod 必填 | 发信地址（如 `noreply@mail.molio.cn`），须挂在已过 SPF/DKIM 验证的发信域名下 |
| `MOLIO_DM_REGION` | 否 | DirectMail 地域，决定 endpoint，默认 `cn-hangzhou` |
| `MOLIO_DM_ENDPOINT` | 否 | endpoint 显式覆盖（缺省按 region 推导：杭州 `dm.aliyuncs.com`，其余 `dm.<region>.aliyuncs.com`） |
| `MOLIO_DM_REPLY_TO` | 否 | 可选 Reply-To（如企业邮箱人工收件箱） |
| `PORT` / `CAPort` | 否 | 监听端口（FC Web 函数注入 `CAPort`），默认 3200 |
| `MOLIO_ACCESS_TTL_SEC` / `MOLIO_CODE_TTL_SEC` / `MOLIO_REFRESH_TTL_SEC` | 否 | token/验证码寿命，默认 15min/5min/30d |
| `MOLIO_ROTATION_GRACE_SEC` | 否 | 轮换宽限窗（重试误判防护），默认 30 |
| `MOLIO_RATE_EMAIL_RESEND_SEC` / `MOLIO_RATE_EMAIL_DAILY_MAX` / `MOLIO_RATE_IP_DAILY_MAX` | 否 | 三层限频，默认 60/10/30 |
| `MOLIO_CORS_EXTRA_ORIGINS` | 否 | CORS 附加白名单（逗号分隔，逐项取 origin，非法项启动报错）；官网域名内置不经此配置 |
| `MOLIO_OSS_AK` | 资源市场需要 | 阿里云 OSS AccessKey ID（市场文件桶）；缺失则 `/market` 不挂载 |
| `MOLIO_OSS_SK` | 资源市场需要 | OSS AccessKey Secret，不入代码库 |
| `MOLIO_OSS_BUCKET` | 资源市场需要 | 市场文件 OSS 桶名；缺失则 `/market` 不挂载 |
| `MOLIO_OSS_REGION` | 否 | OSS 地域，默认 `cn-guangzhou` |
| `MOLIO_MARKET_OSS_ENDPOINT` | 否 | OSS endpoint 显式覆盖（缺省按 `{bucket}.oss-{region}.aliyuncs.com` 推导；本地测试可指向 mock） |
| `MOLIO_MARKET_MAX_ZIP_MB` | 否 | 单个资源包大小上限（MB），默认 50 |
| `MOLIO_MARKET_ADMIN_EMAILS` | 否 | 市场管理员邮箱（逗号分隔），命中后可调 `/market/admin/*` |
| `MOLIO_MARKET_MAX_ACTIVE_PER_USER` | 否 | 单用户在架条目上限，默认 10 |
| `MOLIO_MARKET_MAX_DAILY_CREATES` | 否 | 单用户每日创建条目上限，默认 5 |

## 七个端点（第一期全集）

| Method | Path | 说明 |
|---|---|---|
| POST | `/auth/send-code` | 发验证码（三层限频，429=rate_limited；不泄露注册状态） |
| POST | `/auth/verify` | 校验 + 隐式注册，返回 token 对与 user |
| POST | `/auth/refresh` | 轮换刷新；重放已用 token → 吊销该用户全部 session（宽限窗内视为重试） |
| GET | `/auth/me` | Bearer access → user + entitlement（权益快照来源） |
| PATCH | `/auth/me` | Bearer access → 修改昵称（1-20 code point）返回 `{user, entitlement}`；隐式注册自动生成「墨友+4位随机数」 |
| DELETE | `/auth/session` | 吊销当前设备（本机登出） |
| DELETE | `/auth/account` | 注销账号（软删除 + 吊销全部 session） |

## 资源市场端点（/market/*，OSS 凭证齐全才挂载）

| Method | Path | 说明 |
|---|---|---|
| GET | `/market/listings` | 公开目录列表（`Cache-Control: no-store`，未登录可读） |
| GET | `/market/listings/:id` | 单条详情（`no-store`，未登录可读） |
| GET | `/market/listings/:id/download` | 登录 → 签发限时 OSS 直下 URL（免费/已购；付费未购 402） |
| GET | `/market/pricing/:id` | 公开（wxpay-fc 专用，§九）：`{id,name,priceCents,file,status}`，file=zip 全量 key（桶私有无下载能力） |
| POST | `/market/listings` | 登录 → 创建条目（元数据校验 + 限频），返回直传签名目标 |
| POST | `/market/listings/:id/confirm` | 登录 → 直传完成确认（首发 uploading→active；亦用于更新版本确认） |
| POST | `/market/listings/:id/update` | 登录 → 发起版本更新（预检 + 新上传目标） |
| DELETE | `/market/listings/:id` | 登录 → 本人下架删除 |
| GET | `/market/my` | 登录 → 我的条目列表 |
| GET | `/market/admin/listings` | 管理员 → 全量条目（含归属邮箱） |
| POST | `/market/admin/listings/:id/remove` | 管理员 → 强制下架（可附原因） |
| POST | `/market/admin/listings/:id/restore` | 管理员 → 恢复已下架条目 |

## 关键设计（改动前必读）

- **限频以 DB 查询为准**：FC 多实例、内存限流不可用；限频判断全走 `auth_codes` 表查询。第一期不引 Redis。
- **验证码/refresh 只存 hash**：DB 泄漏 ≠ 凭据泄漏。
- **一次性原子消费**：verify 成功后立即 `consumed_at` 置位，防并发双花。
- **轮换 + 重放检测**：refresh 用一次即换发新对；旧 token 再次出现判泄漏 → 吊销全 session，但 `replaced_by` 链上、宽限窗内的重放视为客户端重试，直接返回链上新 token 对（避免误伤"响应丢失重试"）。
- **注销后同邮箱 = 新账号**：`users_email_alive` 部分唯一索引（`WHERE deleted_at IS NULL`）让软删除旧行与新账号共存；并发注册捕获 unique_violation 回退复用，不得 500。
- **邮箱归一化**：send-code / verify 入口强制小写，否则限频与 hash 比对可被大小写绕过。

## 本地开发 / 与 daemon、E2E 的联动

```bash
pnpm dev:cloud                                   # :3200，内存模式
MOLIO_AUTH_URL=http://localhost:3200 pnpm dev:daemon   # daemon 指向本地 cloud
```

- web E2E 登录链路即此组合：Playwright `webServer` 先起 cloud(:3200) 再给 daemon 注入 `MOLIO_AUTH_URL`，`devCode` 从 `/api/auth/start` 响应捕获（UI 不展示）。
- **daemon 测试吃 contracts dist**：改 `packages/contracts` 后须先 `pnpm build` 再跑 daemon/cloud 测试。

## CI

`.github/workflows/cloud.yml`：PR 时 typecheck + node:test（独立于 pr-check 的 daemon/desktop）。

## 部署（第一期手动）

- 形态：阿里云函数计算 FC（Web 函数/Custom Runtime，HTTP server 原样部署，监听 `CAPort`）+ PolarDB Serverless。**单函数 prod**（cn-hangzhou），自定义域名 `auth.molio.cn` 直连 LATEST 版本（无版本/别名）。
- 发布：`node apps/cloud/scripts/deploy-package.mjs` 产出 `apps/cloud/molio-cloud-deploy.zip`（内含 linux-x64 Node 运行时 + npm 扁平 node_modules），FC 控制台上传 ZIP。启动命令 `/code/runtime/node /code/dist/src/index.js`。⚠️ **仅改控制台环境变量对常驻实例不生效**，必须上传新代码包强制实例换新（2026-08-24 事故教训，细节见脚本头注释）。
- 独立部署，**不进 Molio 应用镜像**，不走 OSS/ACR 桌面发版链路。
- **资源市场启用条件**：OSS 凭证齐全（`MOLIO_OSS_AK` / `MOLIO_OSS_SK` / `MOLIO_OSS_BUCKET`）才装配 `/market`；缺失则 `/market` 不挂载（访问 404），prod 缺凭证启动时打 warn。
- 上线前置：域名 ICP 备案、DirectMail 发信域名（SPF/DKIM）、隐私政策/用户协议（见 `docs/user-module-design.md` §十二）。
