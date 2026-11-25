# E2E 端口自动平移 — 设计说明

日期：2026-09-29（最后修订：2026-11-22）

## 问题

本机跑 E2E 时，5173 / 3100 等默认端口常被占用——可能是无关应用、另一个
checkout 的 `pnpm dev`，或上次残留的 E2E 服务。修复前有两种失败方式：

- 默认不复用：Playwright 在启动时直接报 `is already used`，得自己去发现
  端口被占、再手动设 `MOLIO_E2E_*_PORT`（`#417` 起支持 env 换端口）。
- 设 `MOLIO_E2E_REUSE_SERVERS=1`：`reuseExistingServer` 只看 URL 有没有
  响应，会把占用者当成自己的服务复用——页面壳可能正常，但实际跑的是旧代码、
  别人的数据目录，断言成批失败，报错里还看不出原因。

也就是说，换端口始终是**手动**的：得先发现占用，再记得设 env。

## 复现（修复前）

```bash
# 1. 占用 5173（任何非 Molio 的 HTTP 服务都可以）
node -e "require('http').createServer((q,s)=>s.end('<h1>other</h1>')).listen(5173)"
# 2a. 默认路径：立即报 already used
cd apps/web && npx playwright test e2e/bootstrap.spec.ts
# 2b. 开启复用：静默打到占用者上，成批超时
MOLIO_E2E_REUSE_SERVERS=1 npx playwright test e2e/bootstrap.spec.ts
```

## 方案

`apps/web/e2e/helpers/ports.ts` 在 config 求值期统一解析 web / daemon /
cloud / mock-oss 四个服务的端口（默认 5173 / 3100 / 3201 / 3199）：

| 情况 | 行为 |
|---|---|
| 显式 env（`MOLIO_E2E_*_PORT`） | 校验后原样使用；被占时提前警告，不改端口 |
| 显式 env + `MOLIO_E2E_REUSE_SERVERS=1` + 探针命中 | 标记 reuse，复用该端口上的服务 |
| 默认端口无人监听 | 用默认端口，Playwright 拉起服务 |
| 默认端口有人监听 | 自动找空闲端口，拉起**本次全新**的服务 |
| 默认端口有人监听 + `MOLIO_E2E_REUSE_SERVERS=1` + 探针命中 | 复用已有服务（显式 opt-in） |

要点：

- **默认永不复用**。健康探针只能证明对面是同一种服务，证明不了它跑的是
  本 checkout 的代码、用的是本次数据目录；另一个 checkout 的 dev server
  签名完全一致。复用只能显式开启，开启者自行承担数据目录归属。
- **显式端口也能复用**。开了复用后，显式端口探针命中会标记 `reuse`，
  config 才会打开 `reuseExistingServer`；探针未命中的占用者是无关应用，
  保持 explicit 让 Playwright 立即失败，而不是静默采信。
- **串行解析 + 预留**。四个服务的扫描区间重叠（mock-oss 平移时从 3200 起扫，
  会撞上 cloud 的默认端口 3201），并行选端口会撞车。先把默认端口和显式端口
  全部登记，再按 web → daemon → cloud → mock-oss 串行解析，保证四个端口
  两两不同。
- **显式端口校验**。非 1–65535 整数、两个 env 同端口、撞上其他服务默认
  端口，都在 config 求值期报错并点名 env，避免 60 秒 webServer 超时。
- **探测双栈**。连接与健康探针都查 IPv4 / IPv6 回环——只绑 `::1` 的服务
  同样算占用。探针（`/@vite/client`、`/api/health`、`/health`、
  mock-oss 新增的 `/__health`）只用于区分警告文案和显式复用判定。
- **幂等**。解析结果写回 `MOLIO_E2E_*_PORT`，worker 二次求值按
  `MOLIO_E2E_PORTS_RESOLVED` 标记跳过探测，不会把「自己刚起的服务」
  误判为占用。

配套：`playwright.config.ts` 四个 webServer 的 url/env 全部由解析结果驱动，
vite 端口沿用 `#417` 的 env 形态（`vite.config.ts` 读
`MOLIO_E2E_WEB_PORT` / `PORT`）；单测在 `apps/web/test/ports.test.ts`
（放 `e2e/` 下会被 Playwright 的 `testMatch` 当 spec 执行）。

## 验证

手工（复现同款场景）：占住 5173 后跑 `npx playwright test
e2e/bootstrap.spec.ts`，终端会打印平移警告并在 5174 拉起真正的 Molio，
用例全绿；杀掉占用进程再跑，回到 5173、无警告。先手动 `pnpm dev` 再跑
E2E，则提示「已被另一个 Molio 实例占用」，仍在 5174 起本 checkout 的全新
实例（不复用）。

自动化：`cd apps/web && pnpm test` 825/825（含端口决策 23 条：分配回归、
串行预留不撞端口、显式端口校验、显式端口复用判定、二次求值幂等、IPv6
探针）；typecheck 通过；`e2e/bootstrap.spec.ts` 7/7，本机实测
`web=:5174(shift) daemon=:3101(shift) cloud=:3201(start) mockOss=:3199(start)`。

## 与 #417 的关系

互补，不重复：`#417` 把 spec 里写死的端口改成相对路径 / env 模板（解决
「平移了也打错后端」）；本机制解决「**谁来平移**」，把 `#417` 之后仍需
手动的步骤自动化。

## 已知边界

- 探测与拉起之间有窗口期：第三方恰在此刻抢端口时 Playwright 会直接报错，
  不会静默复用，重跑即可。
- `MOLIO_E2E_REUSE_SERVERS=1` 不保证数据目录隔离，是显式逃生门。
- Windows 保留端口区间（Hyper-V / WSL）靠 connect 探测发现不了（连不上但
  bind 会失败），暂不处理。
- `apps/web/tsconfig.json` 的 include 只覆盖 `src/`，`e2e/` 与 `test/` 不在
  类型检查范围（既有状态，单独处理）。
- CI（`CI=1`）下端口通常空闲，行为不变。
