# 桌面端 E2E 接入 nightly CI —— 行为说明

> 对应：`.github/workflows/e2e.yml` 新增 `desktop-e2e` job（桌面 GUI E2E 自动化）。本文描述**当前行为与设计取舍**，供维护和下次改动时查阅。

## 背景

`apps/desktop/e2e` 的两个 Playwright Electron spec（smoke、protocol-clip-cold-start）自 2026-08 写好后不在任何 CI 里，只能靠人手动本地跑。结果是 UI 改版把选择器改烂、spec 里硬编码本机路径，腐烂了数周无人发现，直到一次手动端到端验证才撞出来（spec 修复本身见 `docs/2026-09-26-desktop-e2e-spec-revival-design.md`）。本改动把这套 E2E 挂进自动化，堵住「烂了没人知道」的洞。

## 选型：nightly job，不进 PR 快检、不动 release.yml

桌面 E2E 有三个硬约束：每条 spec 独占完整 app 生命周期（启动打包好的 win-unpacked、单实例锁、独占 3100 端口）、需要 Windows GUI 环境、单趟构建+测试约 15–25 分钟。这决定了它不适合的位置：

- **不进 pr-check.yml**：太重，会拖慢每个 PR；
- **不塞进 release.yml**：release 按发版节奏数周才跑一次，反馈周期正是这次事故的成因；且 GUI 测试的偶发抖动不该阻塞发版关键路径。release.yml 的内联 smoke（启动 exe → 探 daemon 健康 → 抓首页 HTML）保持不动，继续兜发布底线。

落在 `e2e.yml` 新增 `desktop-e2e` job：每晚 03:00 UTC 与 web 全量 E2E 并行跑（独立 runner，互不干扰），腐烂 ≤24h 暴露。发版前想要 GUI 层门禁，手动 dispatch E2E Full 选发版分支即可，无需改 release.yml。

## job 行为（windows-2022，timeout 40min）

`checkout → pnpm install（npmjs 官方源）→ pnpm build → electron-builder --win --dir → pnpm --filter @molio/desktop test:e2e → 上传工件`。

几个不显然的点：

- **不需要 `playwright install`**：`_electron` 经 CDP 驱动我们自己打包出的 Electron 二进制，不下载浏览器。
- **exe 定位**：global-setup.ts 按「`MOLIO_EXE_PATH` → `apps/desktop/dist/win-unpacked/Molio.exe` → NSIS 安装目录」解析，job 里上一步刚打出的包即被命中，无需显式设环境变量。
- **fixture**：干净 runner 上没有任何知识库，`kb-fixture.ts` 会在系统临时目录建「E2E Fixture Vault」并造一个 md 文件（见 spec 修复文档），无需预置数据。
- **工件路径有个坑**：Playwright HTML reporter 的 `outputFolder: 'e2e-results'` 相对**配置文件目录**解析（落在 `apps/desktop/e2e/e2e-results/`），而 `test-results`（trace/截图/录屏）落在 `apps/desktop/test-results/`——两个上传路径不一样是有意的，别「顺手统一」。
- **artifact 名带 `run_attempt`**：v4 artifact 不可变，重跑失败 job 时 run_id 不变，不带 run_attempt 会 409。

## 国内网络

CI 是 GitHub 海外 runner，electron-builder 直连 GitHub 下载 Electron zip / NSIS 二进制，无需镜像。国内本地构建先设 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`（npmmirror）；better-sqlite3 的 prebuild 已有 npmmirror 回退。

## 验证

- 本机按 CI 相同步骤实测全绿：install → build → `electron-builder --win --dir` → 6 条用例全过（smoke 5 + protocol 1，单 worker 串行）。
- 工件上传路径按三次真实运行的产物落盘位置核对。
- workflow YAML 经解析校验。
- 真 runner 的首次验证：合并后手动 dispatch 一次 E2E Full 确认。
