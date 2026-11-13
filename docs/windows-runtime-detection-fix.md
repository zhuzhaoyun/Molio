# Windows 运行时探测失败排查：`.cmd` shim + 空格路径 + `shell: true`

> 适用：daemon 的 agent 运行时探测与启动链路（`apps/daemon/src/core/runtimes/launch.ts`、`core/RunManager.ts`）。
> 记录「Windows 下重启 / 切换分支后找不到 Claude Code 运行时，需重新一键安装」问题的根因、实证、临时解法与修复方案。排查日期：2026-07-30。

## 症状

- Windows 下重启本项目（daemon 重启）或切换分支启动后，UI 报「找不到运行时」，Claude Code 显示为未安装。
- 重新执行一键安装后，**当前会话**恢复正常。
- 再次重启后问题复发，循环往复。
- macOS 下未复现。

## 根因

两个 bug 叠加，仅 Windows 触发。

### Bug 1（致命）：`.cmd` + 带空格路径 + `shell: true` 未加引号

`probeVersion`（`launch.ts`）对 `.cmd`/`.bat` shim 判定 `needsShellOnWindows → shell: true`。Node 在 `shell: true` 时把命令拼成：

```
cmd.exe /d /s /c "C:\Program Files\nodejs\claude.cmd --version"
```

cmd.exe 的 `/s` 会剥掉外层第一对引号，随后按第一个空格断词，实际执行的是 `C:\Program` → 报错退出（status 1）：

```
'C:\Program' 不是内部或外部命令，也不是可运行的程序或批处理文件。
```

即：**任何位于带空格路径（如 `C:\Program Files\...`）下的 `.cmd`/`.bat` shim 都探测失败**，哪怕 shim 背后的程序完好可用。

同一隐患存在于运行时 spawn：`RunManager.createRun`（`RunManager.ts:286-290`）在 `shell: true` 时只对 *args* 中含空格者加了引号，**binary 路径本身没有加引号** —— 若探测结果落到此类 `.cmd`，启动 run 会以同样方式失败。

### Bug 2（放大器）：首个候选探测失败即判「未安装」，不回退后续候选

`detectAgents`（`RunManager.ts:122`）逻辑：`resolveAgentBinary` 返回第一个命中（`where` 顺序）→ 探测失败 → 直接 `available = false`。后面的候选（包括完好无损的 `~/.molio/bin/claude.exe`）**根本没有被尝试的机会**。

### 触发链（本机实例）

1. 机器上有早年 `npm i -g @anthropic-ai/claude-code` 留下的 shim：`C:\Program Files\nodejs\claude.cmd`（v2.1.220，本身完好）。
2. Windows 合成 PATH 时**系统 PATH 永远在用户 PATH 之前**，`C:\Program Files\nodejs` 排在 `C:\Users\<user>\.molio\bin`（一键安装目标，写在用户 PATH）前面。
3. `where claude` 第一个命中 `C:\Program Files\nodejs\claude.cmd` → 命中 Bug 1 探测失败 → 命中 Bug 2 直接判未安装。

```
$ where claude
C:\Program Files\nodejs\claude          ← 无扩展名，被跳过
C:\Program Files\nodejs\claude.cmd      ← 第一个 .cmd，resolveOnPath 返回它
C:\Users\86300\.molio\bin\claude.exe    ← 完好，但永远轮不到
```

## 为什么「一键安装能修好，重启又坏」

| 时机 | PATH 状态 | `where claude` 第一命中 | 结果 |
|------|-----------|------------------------|------|
| 一键安装后（本会话） | 安装流程 `updateCurrentProcessPath` 把 `~/.molio\bin` **前置进当前 daemon 进程 PATH** | `~/.molio\bin\claude.exe` | `.exe` 不需要 shell，探测/启动正常 ✅ |
| daemon 重启 / 换分支重启 / 重启系统 | 新进程 PATH = 系统快照，`Program Files\nodejs`（系统 PATH）重新排到 `~/.molio\bin`（用户 PATH）前面 | `C:\Program Files\nodejs\claude.cmd` | 探测失败 → 「未安装」❌ |

注意：即使 `addToUserPathWindows` 的 PATH 持久化完全成功，也无法绕过此问题 —— 用户 PATH 条目在合成顺序中天然排在系统 PATH 之后。

## 为什么 macOS 不复现

- 没有 `.cmd` shim 概念；npm 全局安装产生的是带 shebang 的 symlink，`execFileSync` 直接执行（executable bit），**不走 `shell: true`**，无引号问题。
- 常见全局 bin 目录 `/usr/local/bin`、`/opt/homebrew/bin` 不含空格。
- `addToUserPathUnix` 往 shell rc 写入 `export PATH="~/.molio/bin:$PATH"` —— 新开 shell 时 Molio 目录在最前，`which claude` 优先命中 Molio 二进制。

## 实证记录（2026-07-30，本机 Windows）

1. `where claude` 输出见上文：旧 npm shim 排第一，Molio `.exe` 排第三。
2. 直接带引号执行旧 shim：`"C:\Program Files\nodejs\claude.cmd" --version` → `2.1.220 (Claude Code)`，**shim 本身完好**。
3. 运行中的 daemon `GET /api/agents` 实际返回：

   ```json
   {
     "id": "claude",
     "available": false,
     "binary": "C:\\Program Files\\nodejs\\claude.cmd",
     "source": "path",
     "probeError": "'C:\\Program' 不是内部或外部命令……"
   }
   ```
4. 用与 `probeVersion` 完全等价的 Node 调用复现（`execFileSync('C:\\Program Files\\nodejs\\claude.cmd', ['--version'], { shell: true })`）→ status 1，stderr 与 daemon 报告一致。

## 临时解法（零代码改动，重启后稳定）

探测逻辑第一优先级是 `CLAUDE_BIN` 环境变量覆盖（`launch.ts` `resolveAgentBinary` 步骤 1），直接绕过 PATH 查找与 `.cmd` shim。

**方案 A（推荐，保留 npm 全局 v2.1.220）**：在 `~/.molio/config.json` 中配置 agent 级 env（经 `configuredEnv` 传入探测）：

```json
{
  "agents": {
    "claude": {
      "env": {
        "CLAUDE_BIN": "C:\\Program Files\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"
      }
    }
  }
}
```

该路径是 shim 背后真正的 `.exe`（已确认存在）；`.exe` 不触发 `shell: true`，无引号问题。

**方案 B**：管理员 shell 执行 `npm rm -g @anthropic-ai/claude-code` 删除旧 shim，探测自然落到 `~/.molio/bin/claude.exe`（版本回到 Molio 钉住的 2.1.179）。

## 修复方案（已实施，2026-11-03）

> 落地结果见文末「实施记录」。分支 `fix/windows-runtime-detection-fix`。

### 1. 引号修复（治本）

`launch.ts` 新增 `quoteForCmd(p: string): string`（包裹双引号、转义内部引号），应用于：

- `probeVersion`：`needsShell` 时 file 参数使用 `quoteForCmd(bin)`；version args 固定且简单，一并引号化以消除 DEP0190 告警。
- `RunManager.createRun` spawn：binary 路径同样在 `shell: true` 时加引号（与现有 args 引号逻辑统一）。

验证手段：`cmd.exe /d /s /c ""C:\Program Files\nodejs\claude.cmd" --version"` —— `/s` 剥掉最外层引号后，内层引号保留，cmd 正确解析带空格路径。

### 2. 候选回退（治根，消除「前面坏 shim 遮蔽后面好二进制」整类问题）

- `launch.ts` 增加 `resolveAgentBinaryCandidates(def, options): string[]`，按现有优先级（env-override → PATH → well-known dirs → fallbackBins）返回**去重后的有序候选列表**；`resolveAgentBinary` 收敛为取首个候选的薄封装。
- `detectAgents` / `createRun` 改为：依序探测候选，返回第一个探测成功者；全部失败才 `available = false`，并保留首个候选的 `probeError` 供诊断。
- 优先级不调整（保持 PATH 优先于 well-known，尊重用户自装版本），引号修复后 `.cmd` 候选可正常工作。

### 3. 回归测试（错误驱动，`apps/daemon/test/runtimes/`，node:test）

| 用例 | 平台 | 内容 |
|------|------|------|
| 空格路径 `.cmd` 探测 | win32 门控 | 临时目录名含空格，放入 `@echo 1.2.3` 的 `.cmd` shim，`probeVersion` 须成功返回版本（修复前必失败） |
| spawn 引号 | win32 门控 | 带空格路径 `.cmd` 经 `createRun` 等价 spawn 参数组装后能启动 |
| 候选回退 | 跨平台 | 候选 A 探测失败（exit 1 的可执行脚本）→ 自动落到候选 B 并返回 B 的版本 |

### 4. 提交规范

- 分支 `fix/windows-runtime-detection`，Conventional Commits：`fix(daemon): quote .cmd binary paths and fall through on probe failure`。
- PR 合入前：`pnpm typecheck` + `pnpm test`（daemon 单测）；本次改动文件（`launch.ts`、`RunManager.ts`）不在 E2E 核心保护清单内，但建议本机手动验证：重启 daemon → `curl localhost:3100/api/agents` → `claude.available: true`。

## 相关文件

| 文件 | 角色 |
|------|------|
| `apps/daemon/src/core/runtimes/launch.ts` | 二进制解析（`resolveAgentBinary`）、版本探测（`probeVersion`）、`needsShellOnWindows` |
| `apps/daemon/src/core/RunManager.ts` | `detectAgents`（available 判定）、`createRun`（spawn，args 已引号化、binary 未） |
| `apps/daemon/src/core/runtimes/env.ts` | `buildSpawnEnv` / `augmentPath`（spawn 时把 `~/.molio/bin` 前置进子进程 PATH） |
| `apps/daemon/src/core/runtimes/install.ts` | 一键安装：下载至 `~/.molio/bin`，`addToUserPath` + `updateCurrentProcessPath` |
| `apps/daemon/src/routes/agents.ts` | `GET /api/agents`（暴露 available / probeError）、`POST /:agentId/install` |

## 实施记录（2026-11-03）

**分支**：`fix/windows-runtime-detection-fix`（基于 `origin/main` = `b2d0c522`）

### 实际改动

| 文件 | 改动 |
|------|------|
| `launch.ts` | 新增 `quoteForCmd` / `quoteArgForCmd` / `shellCommandFor` / `samePath` / `BinaryCandidate` / `pickFirstWorkingCandidate(Sync\|Async)` / `resolveAgentBinaryCandidates(Sync\|Async)`；`probeVersion(Sync\|Async)` 在 `needsShell` 时改用 `shellCommandFor`；`resolveAgentBinary` 收敛为取首个候选的薄封装 |
| `RunManager.ts` | `detectAgents` / `runAgentDetection` / `createRun` 全部改走候选列表；新增 `verifiedBinaries` 缓存（避免每条消息重探 1–3s）；spawn 时 binary 路径按 `isCmd` 加引号 |
| `market/suggest.ts` | `spawnOneShot` 同样引号化 binary；`defaultOneShotRunner` 改走候选探测（避免「聊天能用、一键起草起不来」） |
| `runtimes/hermes.ts` | `runExecFile` 改用 `shellCommandFor` |
| `streams/acp-pool.ts` | `spawnEntry` 引号化 binary |
| `test/runtimes/windows-cmd-quoting.test.ts` | 新增，18 个用例 |

> 与方案的一处偏差：`shellCommandFor` 的参数引号**保留**修复前的 `\"` 转义（提取为 `quoteArgForCmd`），没有改成 cmd 的 `""`——参数引号路径有既存行为，不在本次修复范围内；只有 binary 路径（不会含 `"`）用新的 `quoteForCmd`。

### 验证结果

修复前（端口 3199 真机）：
```
claude available=false ... probeError: 'C:\Program' 不是内部或外部命令
```

修复后：
```
claude available=true version=2.1.316 (Claude Code) binary=C:\Program Files\nodejs\claude.cmd
```

本机候选列表（4 个候选现在全部探测成功）：
```
[path]       C:\Program Files\nodejs\claude.cmd                    -> 2.1.316
[path]       C:\Users\86300\.molio\bin\claude.exe                  -> 2.1.286
[well-known] C:\Users\86300\AppData\Roaming\nvm\v22.12.0\claude.cmd -> 2.1.165
[well-known] C:\Users\86300\AppData\Roaming\nvm\v24.13.1\claude.cmd -> 2.1.316
```

端到端：`POST /api/runs` 返回 201，Claude Code 进程真实启动并执行了工具调用（最终因上游 Token Plan 429 结束，与二进制解析无关）。

测试：daemon 全量 **2043 用例 / 2031 通过 / 0 失败 / 12 跳过**；`tsc --noEmit` 无错误。
