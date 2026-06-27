# 微信通道与 Claude Code Agent 交互设计

> 本文档记录 `fix/weixin-multiturn-reuse` 分支对微信通道与 Claude Code agent 交互方式的三项修改及其设计依据，供后续维护参考。

## 核心原则

**利用 Claude Code 自身的智能化，代码只做通道机械。** 凡是"何时做多轮连续""用什么检索路径回答""是否要把文件发给用户"这类**意图判断**，都交给 agent（由提示词引导）决定；daemon 代码只负责通道适配（收发消息、spawn 进程、解析标记、投递附件），不替 agent 猜意图、不在代码里堆场景逻辑。下面三项修改都是把原本"代码在猜"的逻辑交还给 agent。

---

## 1. 多轮复用：一个微信用户一个 claude 进程

### 问题
Claude Code 原生支持 multiTurn（`stdin` 保持打开，跨轮复用同一 session，保留上下文 + prompt cache）。但微信通道原来每收到一条消息就 `runManager.createRun` 一次——spawn 一个全新 `claude -p` 进程、新 sessionId。原生的 session 连续性被每条消息新开进程的设计直接丢掉，prompt cache 也无法复用。

### 方案
`WeixinService` 用 `userRuns: Map<fromUserId, UserRunState>` 维护每个微信用户的活跃 run：

- **首条消息 / 进程失活**：`canReuseRunFor(fromUserId)` 为 false → `createRun`（fresh spawn），记入 `userRuns`。wiki 提示词在这次 spawn 注入（见 §2）。
- **后续消息，进程存活**：走 `RunManager.sendMessage(runId, message)`——往同一进程的 stdin 写一条新 user 消息，复用已有 session 与 system prompt。**不重注 wiki 提示词**（进程首轮已带）。
- **turn 进行中又来消息**：排入 `UserRunState.queue`，`turn_end` 后 `drainQueue` 发送。
- **进程失活**（`canAcceptMessage=false`，如进程退出）：回退到 fresh spawn + cancel 旧 run。
- **`/new` 或 stop/超时**：`cancelUserRun` / `cancelAllUserRuns` 清理，下条消息重新 spawn。

`RunManager.canAcceptMessage(runId)` 是非抛错的预检：run 存在、非终态、agent 支持 multiTurn、stdin 仍可写。

### 代码落点
- `apps/daemon/src/core/weixin/service.ts`：`userRuns`、`canReuseRunFor`、`dispatchMessage`、`drainQueue`、`cancelUserRun`、`cancelAllUserRuns`、`QueuedMessage`。
- `apps/daemon/src/core/RunManager.ts`：`canAcceptMessage`、`sendMessage`、`flushPendingReply`。

### DB 顺序
`dispatchMessage` 在追加下一条 user 消息前先 `flushPendingReply`，保证 DB 里 user→assistant→user 顺序与真实对话一致（与桌面 `POST /api/runs/:id/messages` 对齐）。

---

## 2. wiki 提示词走 system prompt（`--append-system-prompt-file`）

### 问题
`WIKI_WEIXIN_PROMPT` / `WIKI_QUERY_PROMPT` 原来** prepend 到 user message 文本**发出去。这把 agent 角色锁死在提示词规定的检索路径（"先读 hot.md → INDEX.md → wiki 页 → 源文件"），压制了 agent 原生的检索判断。实测对照（cwd = wiki-vault，问"总结今天的工作"）：

| | 工具调用 | 总结 |
|---|---|---|
| 无 wiki prompt | `git log --since=today` + `git status` + `find` + 文件系统 | 准确全面 |
| prompt prepend 进 user 消息（旧） | 只 `Read hot.md` + `Read log.md` | 严重缺失（"只有 1 条入库记录"） |
| prompt 走 `--append-system-prompt`（新） | `git log` + `find -newermt today` + 读 wiki 页 | 准确全面，且保留 wechat-article-extractor 等微信专有约定 |

**同样的字，作为 user 消息把 agent 锁死，作为 system 背景就不锁了。** 位置改了就够，不需要砍提示词内容。且与 git 无关：非 git 仓库下 agent 在 `git log` 静默失败后自动回退 `find -newermt`（见下方"mtime"框），同样产出完整总结。

> **mtime 是什么**：file **m**odification **time**，文件系统给每个文件记的元数据时间戳（内容最后被修改的时间）。`find -newermt "2026-06-26"` = 列出 mtime 在该日期之后的文件 = "今天改过的文件"。agent 在非 git 仓库里就靠它发现"今天做了什么"——每个文件都有 mtime，不依赖 git。

### 方案
把 wiki 提示词作为 agent 的 **system prompt** 注入，user 消息只留干净原文：

- `buildWeixinRunMessage(db, text, cwd, isFirstTurn)` 返回 `{ message, appendSystemPrompt? }`：`message` = `buildMolioPrompt(text)`（保留附件格式化，去掉 `用户消息：` 壳和 wiki prepend）；`isFirstTurn && vault` 时 `appendSystemPrompt = WIKI_WEIXIN_PROMPT`，否则 undefined。
- `dispatchMessage` 的 fresh-spawn 分支把 `appendSystemPrompt` 传给 `createRun`；reuse 分支（sendMessage）不传（进程已带）。
- `RunManager.createRun` 把 `opts.appendSystemPrompt`（文本）经 `getAppendSystemPromptFile` 写成临时文件，把**文件路径**传给 `buildArgs`。
- `claude.ts` `buildArgs` push `--append-system-prompt-file <path>`。
- 桌面端 `routes/runs.ts` 同治：`query` 操作 + vault 首轮分支改设 `appendSystemPrompt = WIKI_QUERY_PROMPT`（不再 prepend 到 message）；`build/ingest/lint/save` 任务指令保持原样（角色锁定是对的）。

### 为什么用 `-file` 而非 inline `--append-system-prompt <text>`（argv 教训）

最初用 inline 文本。桌面冒烟（`WIKI_QUERY_PROMPT` 1.8KB）通过，给了假阳性信心。但微信实测用 `WIKI_WEIXIN_PROMPT`（4.9KB，含 22 个双引号 + 10 个反斜杠，如 `node "<skill_dir>/extract.js"`、`<attach path="D:\\..."/>`）时，**inline 文本经 `claude.exe` 自己的 argv 解析器出错，把尾部的 `--dangerously-skip-permissions` 当成 system prompt 的一部分吃掉了** → 所有 Bash 工具返回 "This command requires approval" → `wechat-article-extractor` 的 `node extract.js` 跑不了（agent 确实调了 skill，但脚本被权限挡，只能列方案给用户）。

排查要点：Node 的 `child_process.spawn` 本身能正确传 4.9KB argv + 尾部 flag（探针证实），是 `claude.exe` 的解析器问题；桌面（1.8KB）bash 执行、微信（4.9KB）bash 被挡、同 daemon 同代码同 model，唯一差异是 inline 文本。

修法：把 wiki prompt 物化成**固定名文件**，argv 只剩一个短路径，`--dangerously-skip-permissions` 不再被吃。

**wiki prompt 实际写到哪个文件**：`~/.molio/sysprompt/` 下的固定名文件（`os.homedir()/.molio/sysprompt/`，Windows 上即 `C:\Users\<用户>\.molio\sysprompt\`）：

| 文件 | 大小 | 内容 |
|---|---|---|
| `weixin.txt` | ~9.7KB | `WIKI_WEIXIN_PROMPT`（微信通道） |
| `query.txt` | ~3.8KB | `WIKI_QUERY_PROMPT`（桌面 vault 查询） |

- `ensureWikiSysPromptFiles()`（在 `wiki-prompts.ts`）在 **daemon 启动时**（`index.ts`）调一次，幂等覆盖写入这两个文件，保证内容随 daemon 版本更新。
- caller（`buildWeixinRunMessage` / `runs.ts`）直接传**文件路径**（`WEIXIN_SYS_PROMPT_FILE` / `QUERY_SYS_PROMPT_FILE` 常量）给 `createRun`；`RunManager` 只转发路径给 `buildArgs`，**不做文本→文件转换**（无 hash、无 memoize、无临时文件）。
- `claude.ts` `buildArgs` push `--append-system-prompt-file <path>`，claude 启动时读文件全文 append 到默认 system prompt。
- 文件内容 = `wiki-prompts.ts` 里对应常量的纯文本，随时 `cat ~/.molio/sysprompt/weixin.txt` 可查看。

> 设计取舍：早期版本用 `os.tmpdir()/molio-sysprompt-<sha256>.txt`（按内容 hash 命名、懒写、memoize）——能跑但不直观（hash 名、藏在系统临时目录，难发现）。改成固定名 + `.molio` 后：可发现、可读、RunManager 甩掉文件写入职责。`wiki-prompts.ts` 仍是内容 source of truth（保 `VAULT_STRUCTURE` 等共享常量的 DRY），只是把内容物化成可发现文件。

**教训：inline 大文本 argv 在 Windows 有解析风险，大 prompt 一律走 `-file`；冒烟要用真实最大/最敌意的输入（WEIXIN prompt），别只用较小的 QUERY prompt。**

### 代码落点
- `packages/contracts/src/agent.ts`：`RuntimeBuildOptions.appendSystemPromptFile?: string`（路径）。
- `apps/daemon/src/core/wiki-prompts.ts`：`WIKI_*_PROMPT` 常量（内容 source of truth）、`WEIXIN_SYS_PROMPT_FILE` / `QUERY_SYS_PROMPT_FILE`（固定路径）、`ensureWikiSysPromptFiles()`（启动时写文件）。
- `apps/daemon/src/index.ts`：启动时调 `ensureWikiSysPromptFiles()`。
- `apps/daemon/src/core/RunManager.ts`：`CreateRunOptions.appendSystemPromptFile?`（路径，caller 传）、createRun 直接转发给 buildArgs（不做转换）。
- `apps/daemon/src/core/runtimes/claude.ts`：`buildArgs` push `--append-system-prompt-file`。
- `apps/daemon/src/core/weixin/service.ts`：`buildWeixinRunMessage`（返回 `{message, appendSystemPromptFile?}`）、`QueuedMessage`、`createMolioRun`、`dispatchMessage`。
- `apps/daemon/src/routes/runs.ts`：`query` 操作 + vault 分支。

---

## 3. 文件投递：只在用户显式要时发（`<attach/>` 标记）

### 问题
`extractOutboundMedia` 原有两路投递触发：① agent 用 Write 类工具写文件且扩展名在白名单（含 `md/txt/csv`）就**自动投递**；② agent 在回复写 `<attach path="..."/>` 标记 → 投递。入库时 agent 用 Write 建 `wiki/sources/*.md`、`raw/wechat/*.md`，被①误发到用户微信——用户没要文件却收到 .md。

根因不是提示词（提示词的"文件回传规则"本就规定只在用户显式要文件时写 `<attach/>`），是**代码与提示词错配**：代码替 agent 猜了"Write 新建 = 要发给用户"。

### 方案
**删掉①自动投递路径，只留 `<attach/>` 标记。** 投递完全由 agent 显式表态决定（提示词引导 agent 在用户要文件时写标记）：

- `extractOutboundMedia(replyText, cwd)` 只解析 `<attach/>` 标记（签名从 `(toolUses, reply, cwd)` 简化为 `(reply, cwd)`）。
- 删 `WRITE_TOOLS`、`filePathFromInput`、Write-tool 循环。
- `service.ts` `forwardRunReply` 删 `writtenFiles` 收集 + `tool_use` 分支（tool_use 事件不再用于检测投递）。
- `classifyByExt` 保留：只做**通道机械**（image→图片消息、video→视频消息、file→文件附件，给微信 API 选路由），不再做"拒绝 .ts"的内容策略（内容策略在提示词）。

三个场景都正：生成图（没说要发）→ 存 vault 不发；"生成图发给我" → agent 写 `<attach/>` → 发；入库链接 → agent Write .md 做内部工作无标记 → 不发。

### 代码落点
- `apps/daemon/src/core/weixin/outbound-media.ts`：`extractOutboundMedia`（marker-only）、`classifyByExt`。
- `apps/daemon/src/core/weixin/service.ts`：`forwardRunReply`（删 writtenFiles / tool_use 分支）。

---

## daemon 开发注意

- **daemon dev 脚本 = `tsx src/index.ts`（非 watch）**。`pnpm dev:daemon` / `dev:desktop` 都不热重载；改代码后必须手动重启 daemon 才生效（`dev:watch` 才是 watch 模式）。调试时改了 daemon 代码没重启 → 跑的还是旧代码，容易误判。
- spawn 出来的 claude 进程命令行可用 `Get-CimInstance Win32_Process -Filter "name='claude.exe'"` 查看（验证 flag 是否齐全）。注意 WMI 对超长命令行会截断——inline 大文本时看不到尾部 flag，这正是发现 argv bug 的线索。

## 验证方式

- **A/B/C 探针**：直接用 `claude -p` 在 vault cwd 跑同一问题，对比"无 prompt / prepend / --append-system-prompt"三组，看工具调用与总结质量。这是验证"提示词位置是否压制原生检索"的最干净方法。
- **run 日志**：`~/.molio/runs/<runId>/events.jsonl` 记录每个 run 的 tool_use / tool_result，用于排查"agent 实际做了什么 / 工具是否被挡"。
- **冒烟覆盖最敌意输入**：用真实的 `WIKI_WEIXIN_PROMPT`（4.9KB、含引号/反斜杠）测 spawn，别只用较小的 QUERY prompt。

## 不改的

- `WIKI_WEIXIN_PROMPT` / `WIKI_QUERY_PROMPT` 文本内容不动（位置改了就够，实测验证）。
- `build/ingest/lint/save` 任务指令保持 message prepend（是任务动词，角色锁定是对的）。
- session jsonl 转录本不碰（跨会话总结靠 git + 文件系统 mtime，与 session 文件无关）。
