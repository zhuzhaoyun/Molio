# Windows 任务栏显示：AUMID 与每窗口标题

> 2026-09-19 · PR [zhuzhaoyun/Molio#261](https://github.com/zhuzhaoyun/Molio/pull/261) · 涉及 `apps/desktop`（main.js / scripts / e2e / test）

记录两个 Windows 任务栏显示缺陷的根因与修复：右键菜单（Jump List）应用名显示 "Electron"、多窗口悬浮预览全是 "Molio"。两者同属一个主题——**OS 层面拿不到正确的应用/窗口身份**，且各自踩了 Electron 在 Windows 上的经典坑。另含一个打包链路顺带修复（prebuild 下载源回退）。

## 本 PR 改动清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `apps/desktop/src/main.js` | 修复 | AUMID 调用；每窗口 vault 标题（含 page-title-updated 防护） |
| `apps/desktop/scripts/fix-exe-metadata.mjs` | 修复 | rcedit 选项 camelCase → kebab-case（原写法静默失效） |
| `apps/desktop/scripts/prepare-resources.mjs` | 顺带修复 | prebuild 下载 GitHub → npmmirror 两级回退 |
| `apps/desktop/e2e/specs/window-title.spec.ts` | E2E | 打包版窗口标题端到端（已本机 PASS） |
| `apps/desktop/test/packaging/app-user-model-id.test.js` | 单测 | AUMID 调用存在性 + 与 build.appId 一致性 |
| `apps/desktop/test/window-title.test.js` | 单测 | 窗口标题行为 6 条（接线/格式/回退/缓存/异步防护/title 覆盖防护） |
| `apps/desktop/test/packaging/exe-metadata-rcedit-contract.test.js` | 单测 | 读 rcedit 源码认可键集合做契约校验 |
| `apps/desktop/test/packaging/prebuild-source-fallback.test.js` | 单测 | 回退机制 3 条 |
| `docs/desktop-windows-taskbar.md` | 文档 | 本文档 |

## 问题一：Jump List 应用名显示 Electron

### 现象

任务栏图标右键菜单中，「任务」区（新窗口）下方的应用名入口显示 **Electron** 而非 Molio。

### 根因

Windows 解析该入口名称的链路：

1. 窗口的 AppUserModelID（AUMID）能匹配到快捷方式（开始菜单/已固定）→ 用快捷方式名
2. 匹配不到 → 回退 exe 的 `FileDescription` 版本资源

Molio 的环节当时断了两处半：

- `main.js` 从未调用 `app.setAppUserModelId`，窗口拿 Chromium 按 exe 路径自动生成的 AUMID；而 NSIS 安装器给快捷方式盖的是 `build.appId`（`com.molio.desktop`）——两者不匹配，第一条路走不通
- `scripts/fix-exe-metadata.mjs`（f1d2a76）的 rcedit 补丁**从未生效**：rcedit v5 的 Node API 只认 kebab-case 键（`'version-string'` / `'file-version'` / `'product-version'`），hook 传的 camelCase（`versionString` 等）被**静默忽略**——日志照常打印 Done，实际只设置了图标。因此所有构建的 exe 元数据都是 Electron 原样（`FileDescription=Electron`、`FileVersion=40.10.2` 这种 Electron 自己的版本号，一眼可辨），第二条路也是断的。

真机取证命令：

```powershell
(Get-Item "D:\Programs\Molio\Molio.exe").VersionInfo | Select FileDescription, ProductName, FileVersion
# 读快捷方式 AUMID：
$sh = New-Object -ComObject Shell.Application
$sh.Namespace("$env:APPDATA\Microsoft\Windows\Start Menu\Programs").ParseName("Molio.lnk").ExtendedProperty("System.AppUserModel.ID")
```

### 修复

`main.js` 顶部（`app.name = 'Molio'` 旁）显式调用：

```js
app.setAppUserModelId('com.molio.desktop'); // molio:aumid-call
```

AUMID 与快捷方式匹配后，Jump List 名称解析走第一条路，显示「Molio」。同时修正任务栏固定分组与 toast 通知归属。

同时把 `fix-exe-metadata.mjs` 的 rcedit 选项改为 kebab-case，exe 元数据补丁真正生效（`test/packaging/exe-metadata-rcedit-contract.test.js` 读取 rcedit 源码里认可的选项键集合做契约校验，防再次静默失效）。两条路修复后，有无快捷方式都显示 Molio——NSIS 安装版实测：安装后 exe 元数据 `Molio | Molio | 0.3.30`，任务栏右键菜单应用名显示「Molio」（截图确认）。

行尾 `// molio:aumid-call` 标记是**承载性的**：`apps/desktop/test/packaging/app-user-model-id.test.js` 靠它断言「存在未被注释的调用行」且值与 `package.json build.appId` 一致。改常量写法（`setAppUserModelId(AUMID)`）测试同样支持；删标记或注释调用会让测试变红。

## 问题二：多窗口悬浮预览全是 Molio

### 现象

开多个知识库窗口，鼠标悬浮任务栏图标，预览里每个窗口都显示 **Molio**，无法区分。

### 根因

`createWindow` 只设静态 `title: 'Molio'`，web 层从不设置 `document.title`。任务栏悬浮预览、Alt+Tab 显示的都是窗口标题。

### 修复

导航监听驱动每窗口标题（与 macOS dock 最近知识库共用 `recordVaultNavigation`）：

- `did-navigate`（全量加载）+ `did-navigate-in-page`（SPA 切换）→ URL 取 `vault` 参数
- 查 daemon `GET /api/knowledge/vaults` 解析库名（Map 缓存；miss 重取一次覆盖新建/改名；daemon 不可达保持 null 下次重试）
- `win.setTitle('知识库名 — Molio')`；无 vault 参数（首页/对话）回退纯 `Molio`
- 防护：`WeakMap` 序号丢弃快速连续导航的过期异步结果；`isDestroyed()` 防写已关闭窗口

**关键坑——页面静态 `<title>` 覆盖 setTitle**：`apps/web/index.html` 有 `<title>Molio</title>`，Chromium 在每次全量加载后触发 `page-title-updated` 把窗口标题改回 "Molio"，会冲掉 `did-navigate` 时设置的库名标题（真机验证阶段才抓到，单测源码断言发现不了）。修复：

```js
win.on('page-title-updated', (event) => event.preventDefault());
```

web 层从不动态设置 `document.title`，preventDefault 后标题完全由主进程接管，无副作用。

## 顺带修复：prebuild 下载源回退（打包链路）

与本 PR 主题无关，但同为本次端到端验证中踩出的真问题，按错误驱动原则一并修复。

### 现象

`pnpm package:dir` 打包时 `prepare-resources.mjs` 下载 better-sqlite3 的 Electron 预编译产物，直连 GitHub releases 超时，3 次重试全挂，**整个构建中断**（国内/信创网络必现）。

### 根因与机制考证

- prebuild-install 7.x 的 `--mirror` 参数**无效**（不在其 rc/minimist 配置映射里，实测静默忽略，仍走 GitHub）
- 正确的覆盖机制是包级环境变量：`npm_config_better_sqlite3_binary_host`（源码 `getHostMirrorUrl()`：读 `npm_config_<包名>_binary_host[_mirror]`）
- npmmirror 有二进制镜像：`https://registry.npmmirror.com/-/binary/better-sqlite3/v<版本>/<资产名>`，路径布局与 prebuild-install 的拼接规则完全吻合

### 修复

`prepare-resources.mjs` 改为**两级下载源回退**：GitHub releases（3 次重试）→ npmmirror（2 次）；全部失败才报错，报错 Tips 给出 `MOLIO_PREBUILD_HOST` 显式指定第一来源的用法（如 CI 已配镜像时跳过 GitHub 尝试）。

另注意：electron-builder 自身下载 Electron zip / NSIS 二进制也直连 GitHub，需 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 环境变量（本次打包同样踩到，文档化在 desktop 开发指南另行处理）。

### 验证

死源注入实测：`MOLIO_PREBUILD_HOST=https://127.0.0.1:9/dead` → 第一来源 3 次失败 → 自动切 npmmirror → 下载成功、构建通过。

## 验证姿势

| 修复项 | dev 模式 | `--dir` 解包版 | NSIS 安装版 |
|---|---|---|---|
| AUMID（Jump List 应用名） | ❌ 无快捷方式 | ❌ 无快捷方式 | ✅ 只能在这里验证 |
| 每窗口标题（悬浮预览） | ✅ | ✅ | ✅ |

- AUMID 验证：打 NSIS 包 → 安装 → 从**开始菜单快捷方式**启动 → 右键任务栏图标看应用名入口。
- 窗口标题验证：`pnpm dev` 起 dev Electron，开两个不同库的窗口，悬浮任务栏图标。
- 正式版正在运行时验证 dev 实例有单实例锁冲突（`app.name` 相同 → userData 相同 → 锁相同），用独立 profile 绕过：

```bash
electron . --user-data-dir=D:\Temp\molio-verify
```

真机验证结果（Playwright `_electron` 驱动，主进程读原生标题）：

```
["bilibili-knowledge — Molio", "zhihu — Molio", "Molio"]
```

两个库窗口各显示库名，首页窗口正确回退。

## 已执行的验证结果（2026-09-19，全部真机跑过）

| 验证项 | 方法 | 结果 |
|---|---|---|
| 窗口标题 | `e2e/specs/window-title.spec.ts`：win-unpacked 打包版起 app，preload 桥开两个库窗口，主进程读原生标题 | ✅ PASS（10.8s） |
| AUMID（Jump List 名称） | NSIS 打包装临时目录 → 开始菜单快捷方式启动 → UIA 聚焦任务栏按钮 Shift+F10 唤出菜单截图 | ✅ 显示「Molio」（截图确认） |
| exe 元数据补丁 | 安装后读 `Molio.exe` VersionInfo | ✅ `Molio \| Molio \| 0.3.30`（修复前 Electron \| Electron \| 40.10.2） |
| prebuild 自动回退 | 死源注入（见上节） | ✅ 自动切 npmmirror 成功 |
| 单测 | desktop 全量 `node:test` | ✅ 317 个通过 |

## 注意事项

- **老用户重钉图标**：已固定到任务栏的图标带旧（自动生成）AUMID，升级后固定图标与运行窗口不再合并，需取消固定再固定一次；未固定用户无感。
- **Jump List 任务随 AUMID 迁移**：`setUserTasks` 注册的任务按 AUMID 持久化，旧 AUMID 下的注册成为孤岛（无害），新任务注册在 `com.molio.desktop` 下。
- **exe 元数据识别旧构建**：`FileVersion` 显示 Electron 版本号（如 40.10.2）而非应用版本（0.3.x），说明该 exe 是 rcedit camelCase 失效期间（或更早）的产物。

## 相关文件

- `apps/desktop/src/main.js` — AUMID 调用（顶部）、`updateWindowTitle` / `resolveVaultName`、`recordVaultNavigation`、`page-title-updated` 防护
- `apps/desktop/test/packaging/app-user-model-id.test.js` — AUMID 守护测试
- `apps/desktop/test/window-title.test.js` — 窗口标题守护测试
- `apps/desktop/scripts/fix-exe-metadata.mjs` — exe 元数据 rcedit 补丁（kebab-case 修复后真正生效）
- `apps/desktop/test/packaging/exe-metadata-rcedit-contract.test.js` — rcedit 选项契约测试
- `apps/desktop/scripts/prepare-resources.mjs` — prebuild 下载 GitHub → npmmirror 回退（本次打包链路顺带修复）
- `apps/desktop/e2e/specs/window-title.spec.ts` — 打包版窗口标题 E2E
