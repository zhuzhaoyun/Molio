# E2E 端口平移补全：让全部 spec 真正用上既有的平移能力

日期：2026-11-16
分支：`fix/e2e-hardcoded-ports`（基于 `origin/main`，纯测试基建改动，不含任何产品代码）
关联：zhuzhaoyun/Molio#414（图标 PR）全量 E2E 排查的衍生修复，**独立成 PR，不并入图标 PR**

## 1. 问题

全量 Web E2E 在「端口平移 + 数据隔离」模式下跑（`MOLIO_E2E_WEB_PORT` /
`MOLIO_E2E_DAEMON_PORT` 等指向非默认端口），出现大面积失败：
2026-11-15 实测 487 通过 / 161 失败。失败形态高度一致——

- `page.goto('http://localhost:5173/knowledge?vault=…')` 后 `.kb-shell` 正常可见；
- 但依赖测试数据的元素（如 `kb-btn-ask`、文件树节点）永不出现，30s 超时。

同一份代码在云端 CI（默认端口、无竞争）全绿。

## 2. 根因

**平移能力早已建好，但约 30 个 spec 没有采用它。**

`playwright.config.ts` 支持四个服务整体平移（web / daemon / cloud / mock-oss 都读
`MOLIO_E2E_*_PORT` 起在指定端口），并用 `MOLIO_E2E_DATA_DIR`（mkdtemp）隔离数据。
config 头注明确警告过：默认 5173 被另一个 dev server 占用时，复用它「页面看起来
正常、断言全红」。

然而 181 处 spec 代码把地址写死：

| 类别 | 数量 | 写法 |
|---|---|---|
| web 导航 | 177 | `page.goto('http://localhost:5173/…')`（含模板串） |
| 剪贴板授权 origin | 1 | `graph.spec.ts` `grantPermissions({ origin: 'http://localhost:5173' })` |
| 多窗口 web 基址 | 1 | `multi-window.spec.ts` `const WEB = 'http://localhost:5173'`（自建 context + `waitForURL` 前缀匹配，必须绝对地址） |
| daemon 直连 | 1 | `kb-external-roots.spec.ts` `const DAEMON = 'http://localhost:3100/api'` |
| mock-oss 直连 | 1 | `market-community.spec.ts` `const MOCK_OSS = 'http://localhost:3199'` |

写死的 goto 绕过 config 的 `baseURL`，打到**默认端口上别人的服务**：
5173 上是另一个 dev vite（其代理按 `vite.config.ts` 默认指向 3100），3100 上是
已安装桌面实例的 daemon——测试 vault 在那里根本不存在，于是页面壳正常、数据全错。
这不是产品回归，是测试脚本与既有平移机制脱节。

其余 2 个失败（`onboarding.spec.ts:147`、`session-output-history.spec.ts:18`）
不含硬编码端口，迁移前本机日志（2026-11-15）已同样失败，且云端 CI（Linux）
两者均通过——是**本机 Windows 环境性失败**，不是普适 main 缺陷，
与本修复和图标 PR 均无关，另行排查（见 §5.1）。

## 3. 修复：迁移到既有机制，不新造机制

两条规则（与仓库里已采用平移的 spec 完全一致）：

1. **默认 context 的导航一律相对路径**：`page.goto('/knowledge?vault=…')`，
   由 Playwright 按 config `baseURL` 解析。`helpers/navigation.ts` 的 `gotoHome`
   早已是这种写法，本次把剩余 177 处补齐。
2. **必须绝对地址的 4 处改 env 模板**（跟随对应 `MOLIO_E2E_*_PORT`，默认值不变）：
   - `graph.spec.ts`：`WEB_ORIGIN`（grantPermissions 按 origin 精确匹配）；
   - `multi-window.spec.ts`：`WEB`（`browser.newContext()` 自建 context 不继承
     config 的 `baseURL`，且 `popup.waitForURL` 用它做前缀匹配）；
   - `kb-external-roots.spec.ts`：`DAEMON`（直连 fetch 建 vault）；
   - `market-community.spec.ts`：`MOCK_OSS`（直连替身上传/下载）。

改动范围：30 个 spec 文件，+188/−181 行；**零产品代码改动**。
`e2e/scenarios/*.md` 是手动场景文档（对着 `pnpm dev` 默认端口跑），不改。

## 4. 防回归守卫（错误驱动测试）

新增 `apps/web/test/e2e-port-shift.test.ts`（node:test，随 `pnpm --filter @molio/web test`
进 PR 门禁）：扫描全部 `e2e/*.spec.ts` 与 `e2e/helpers/*.ts`，凡
`http(s)://localhost` 或 `127.0.0.1` 后紧跟**数字**端口即判硬编码（env 模板跟的是
`$`，不命中；helpers 里 `http://127.0.0.1:${port}` 动态端口 mock 同样不命中），
失败消息直接给出两条修法。与 `test/area-map.test.ts` 同哲学——守卫「这文件还能
不能正常干活」的契约，而不是审美。

守卫边界（如实声明）：只拦字面量形态。字符串拼接（`'http://localhost:' + '5173'`）、
非 env 常量模板（`const PORT = 5173` + `${PORT}`）、协议相对 URL（`//localhost:5173`）
正则无法区分，靠 review 兜底；纯注释行里写坏例子也会被拦（宁严勿漏）。

RED→GREEN 已验证：暂存迁移改动后守卫在 main 原状下失败（列出全部 181 处），
恢复改动后通过。

## 5. 验证

- `pnpm --filter @molio/web typecheck`：通过（注意：web tsconfig 的 `include` 只覆盖
  `src/**`，e2e/test 不在 typecheck 范围内——此项不构成本改动的类型背书；改动为
  纯字符串替换，正确性由全量 E2E 实跑背书）。
- `pnpm --filter @molio/web test`：716/716 通过（715 既有 + 1 新守卫）。
- 全量 E2E（平移端口 + 隔离数据目录，2026-11-16）：**650 通过 / 5 失败 / 9 跳过，
  30 分钟**。迁移前基线（2026-11-15，同机同命令）：487 通过 / 161 失败 /
  9 跳过 / 8 未跑，1.2 小时。**161 → 5**，端口类失败全部消除。
  对比限定：迁移前基线跑在图标 PR 分支检出上（665 个测试，比 main 的 664 多
  1 个图标专属用例；产品代码含图标改动），不是严格受控 A/B；181 处硬编码两边
  一致，根因结论不受影响。迁移前日志未直接记录平移端口 env，平移模式由失败
  签名（相对路径用例过 / 硬编码用例败的分裂）高置信推断。
- 本 PR 云端 CI（默认端口）：e2e-affected、build-and-test（win+mac）、cloud-test
  **全绿**（2026-11-16 复核）。
- 用户真实数据零污染：跑后 `~/.molio/app.sqlite` 与跑前备份字节数、mtime 完全一致
  （WAL 模式下主文件 mtime 一致是弱证据，但测试 daemon 用独立 mkdtemp 数据目录，
  结构上不触碰 `~/.molio`）；复核真实 daemon 的 10 个 vault 全为用户库，无任何
  e2e 残留。

### 5.1 残留 5 个失败的归属（均非本迁移引入）

本分支产品代码与 `origin/main` 完全一致（diff 仅 e2e spec + 守卫测试 + 本文档）。
以下失败均与端口迁移本身无关：2 个是本机 Windows 环境性失败（云端 CI 通过），
3 个是「测试终于打到正确后端、前置用例走完」之后暴露的既有竞态/时序问题：

| 用例 | 归属证据 |
|---|---|
| `onboarding.spec.ts:147` | 迁移前（11-15 本机日志）已同样失败，失败步骤逐字相同；云端 CI Linux ✓4.0s → 本机 Windows 环境性失败（该 spec 不含硬编码端口），机制待查 |
| `session-output-history.spec.ts:18` | 迁移前已同样失败；云端 CI Linux ✓1.5s → Windows 专属**用例缺陷**：选择器 `[data-path="D:\Temp\…"]` 的反斜杠未做 CSS 转义（`\T`→T 等）导致永不命中；修法 `CSS.escape` 或 data-testid，另行立项 |
| `graph-local.spec.ts:321`（暗色 scope-loading chip） | 迁移前败在更早的端口步骤（notes 文件夹不可见）；迁移后到达 chip 断言才败——端口问题已修，暴露下一层既有问题。浅色 chip 过、暗色败 → 暗色专属渲染/时序竞态 vs 产品缺陷待验证 |
| `floating-chat.spec.ts:814`（磁吸拖拽隐藏） | 迁移前 goto 确为硬编码（打到错误后端，KB 空态下纯前端磁吸照常工作 → 环境假象通过）；迁移后两次隔离重跑均复现（n=2，未见 flaky 迹象） |
| `market-community.spec.ts:401`（账号导航竞态） | 该用例自身路径迁移前就全为相对/env 驱动，失败断言（:417）先于任何被迁移地址——不是错误后端问题。迁移前前置用例 1/2 未走完发布流程，daemon 状态/时序不同，竞态未触发；迁移后前置走完 → 竞态暴露，停在 `/resources` 未导航 `/me`（NavRail 兜底 vs AccountModal 自动导航的竞态，在 main 产品代码里） |

3 个新暴露失败已隔离重跑复核，均再次复现（n=2）。它们属于产品/用例自身的独立缺陷
（或本机时序竞态），**不在本测试基建改动范围内**，需另行立项排查。

## 6. 边界

- 本修复只解决「spec 未采用平移能力」这一类失败；不承诺修复 §5.1 的 5 个本机
  既有残留（2 个 Windows 环境性 + 3 个既有竞态/时序，均与端口无关，也与图标 PR #414 无关）。
- 默认端口无竞争时（如云端 CI），迁移前后行为等价：相对路径解析到同一个
  `baseURL`，env 模板回落同一个默认端口。
