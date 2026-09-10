# 跨文件夹知识库 与 Obsidian 差异化 — 讨论纪要与策略

- **日期**：2026-09-08
- **状态**：讨论纪要约 → 提炼为策略方向（待细化实现）
- **配套文档**：[2026-09-08-linked-source-roots-design.md](./2026-09-08-linked-source-roots-design.md)（本纪要对应的技术设计）
- **一句话**：Molio 要做 Obsidian **做不到/劝阻用户做**的事——**把分散在本机各处的文件夹，不移动、不复制地聚合成一个可被 AI 检索与构建的知识库**。

---

## 第一部分：讨论纪要（从用户疑问到结论）

### 1.1 用户原始疑问

> 「知识库一定要跟原始材料放在同一个仓库吗？我觉得这样有点局限。我尝试用 Windows junction，但 raw 里面好像不能展示 junction 里面的东西。」

### 1.2 根因：Molio 内部存在「两套文件世界观」

这是整场讨论最重要的一条认知。Molio 对文件有两种完全不同的消费路径，它们不一致就是所有问题的总根源：

| 消费方 | 实现 | 对 junction/symlink 的态度 |
|---|---|---|
| **Agent（wiki-build 等）** | `cwd = vault`，用 `find`/Read 工具逛**真实文件系统** | ✅ 跟随（OS 级访问，顺着链接进去） |
| **Daemon / Web UI** | `scanTree` / `findFileByStem` / `searchFiles` / `readFile`，逛**逻辑合成视图** | ❌ 不跟随 |

### 1.3 现象拆解：junction 为什么在 Molio 里「半死」

实测证据（macOS symlink ≡ Windows junction 在 `Dirent` 中表现一致）：

```
readdirSync → { name:"raw", isDirectory:false, isFile:false, isSymbolicLink:true }
```

**拦截点 A — 显示层（`Dirent` 判断）**
[knowledge.ts:80](apps/daemon/src/core/knowledge.ts#L80) 的 `scanTree` 用 `entry.isDirectory()` / `isFile()` 判断。junction 两者都是 `false`（它是「符号链接」），于是既不进目录分支也不进文件分支 → **被静默丢弃**。
同样的判断方式还在三处：`findFileByStem`（[knowledge.ts:344](apps/daemon/src/core/knowledge.ts#L344)）、`searchFiles`（[knowledge.ts:808](apps/daemon/src/core/knowledge.ts#L808)）。
> 取证：`fs.stat`（跟随链接）会得到 `isDirectory:true`，而 `Dirent` 标记不跟随。这就是「改判断条件能修显示」的依据。

**拦截点 B — 读写层（realpath 校验）**
[readFile → `resolveRealWithinVault`](apps/daemon/src/core/knowledge.ts#L453)：junction 的真实路径**必然在 vault 外**，`realpathSync` 解出来后逃出根，直接抛 `Path traversal not allowed`。**即使显示层放开了，点开文件仍会失败。**

**拦截点 C — 监听层（watcher）**
[vault-watcher.ts:96](apps/daemon/src/core/vault-watcher.ts#L96) 只 `chokidar.watch(vaultPath)`。外部目录里的文件变化，vault **收不到 `tree-changed`** → UI 不刷新。

### 1.4 一个关键反转：「wiki-build 不能改」是伪约束

早期判断（图片方案）认为方案 B「索引+直读」不可行，理由是「wiki-build 不能改、只扫 raw/」。
**这个归因是错的**——真正的卡点在 **daemon 层**，不在 agent 层。agent 逛的是真实文件系统，天然能跟 junction。这直接决定了方案选型（见 1.5）。

### 1.5 方案选型结论

| 路线 | 结论 |
|---|---|
| A. 分层 junction（只接线到 raw/） | 只通 wiki-build 层，**Molio UI 层仍全盲** → 不完整 |
| B. 索引 + 直读 | 上条归因错误；真正卡点是 daemon，不是 agent |
| C. junction + 快照双层 | 复杂度翻倍 → 过度设计 |
| D. 纯改判断条件 | **半截修复**：只通显示层，realpath 仍拦；且直接放宽=**安全漏洞** |
| **✅ 采纳：显式「链接素材根」白名单** | 不依赖脆弱 OS 链接、白名单即安全边界、一个 vault 只挂它声明的根 |

### 1.6 安全边界（必须显式设计）

`resolveRealWithinVault` 存在的原因（[knowledge.ts:437](apps/daemon/src/core/knowledge.ts#L437) 注释）：**daemon 无鉴权 + CORS 放开 localhost，边界是防「任意本地网页读取你磁盘任意路径」的逃逸。**

所以：外部根必须收敛为「**用户显式登记、且登记在库的外部根**」，读取时校验 realpath 落「vault 内 ∪ 登记的外部根内」。默认**只读**——素材在外，产物回库。

### 1.7 冲突分析（用户追问「会不会冲突」）

**会产生冲突，根源是「两套文件世界观」不一致**。逐条收敛为设计决策：

| 冲突场景 | 决策 |
|---|---|
| **纯虚拟链接 agent 抓不到**（虚拟挂载只在 daemon 注册表，`find` 看不到）→ build 漏源 | **必须走真实文件系统接入**（junction/符号链接），而非纯虚拟引用 |
| **同名文件撞车**（各 agent memory 都有 `README.md`/`index.md`） | 挂到 `external/<label>/` **命名空间隔离**，`<label>` 取来源名 |
| **watcher 不跟外部根** → UI 陈旧 | `VaultWatcher` 对每个登记的外部根也 `watch`，保证「刷新边界 == 扫描边界」 |
| **路径歧义**（同一文件多虚路径触达） | 虚路径统一 `external/<label>/` 前缀，单一事实源 |
| **安全校验双向拦截** | 白名单放行 + 只读 |

### 1.8 规则层冲突（用户补充的新层次）

用户指出：不同项目的 AI 约定会互相矛盾——**快速迭代项目要求「立刻 commit」，文档项目要求「等我 review 再 commit」**；聚合时若丢了「哪条规则属于哪个项目/场景」，下游就会串味。

**判断**：这类冲突大部分被架构自然消解，但需补一条贯穿原则——

- **操作规则来自「当前 run 的 cwd」，不来自聚合内容**。在各项目里跑 agent 时，`cwd` 决定它读哪个 `CLAUDE.md`，规则天然隔离。
- **聚合内容是「素材」，不是「指令」**。真正会咬人的是两点：① wiki-build 把项目私有约定洗成普适结论；② 检索命中项目私有规则却被当通用答案。
- **贯穿原则：出处与作用域（Provenance & Scope）**——每个外部根天然是一个作用域锚点（`external/<项目>/`），build 对「操作约定类」内容保留作用域、冲突显式呈现（做成对比页而非悄悄二选一），检索带出处；**聚合目录里嵌套的 `CLAUDE.md` 当作待引用素材，不当可执行上下文**。

---

## 第二部分：跨文件夹知识库 —— 为什么这是必做的护城河

### 2.1 用户价值

| 场景 | 痛点 | Molio 跨文件夹的解法 |
|---|---|---|
| 多 AI Agent 记忆聚合 | 多个 agent 的 `memory/` 散在 C:/D:，无法统一检索 | 聚合成一个「公共记忆空间」vault，AI 建 Wiki |
| 素材分散 | 图片/文档/资料散落各处，整理即「搬家」 | 不移动、不复制，原位挂载 |
| 既有工作流 | 不想为了用知识库改变文件组织习惯 | 尊重现状，只加一层「视图」 |

### 2.2 核心立意

> **「不搬家，也能成库」** —— 这是 Obsidian 明确劝阻用户做的事。Molio 要在**把它做对、做稳、做安全**的前提下，提供这个能力。

---

## 第三部分：与 Obsidian 的差异化（用户重点关切）

### 3.1 Obsidian 的真实能力边界（已核实）

Obsidian 官方帮助文档（*Symbolic links and junctions*）：

- ⚠️ **「强烈建议不要使用符号链接」**——明确警告数据丢失、损坏、崩溃风险。
- 🚫 **禁止 vault 内文件夹互相链接**（怕产生重复文件、链接歧义）——**从设计上封死**。
- 🚫 **不允许链接到 vault 的父目录**。
- 🚫 **禁止符号链接环**（防死循环崩溃）。
- ⚠️ 跨盘 symlink：文件管理器**无法跨盘搬文件**，跨盘拖拽会被 Obsidian 当成「删除+新建」且**不更新依赖链接**。
- ⚠️ 与 Sync / Git 冲突：Git 不跟 symlink、跨 vault 同步会冲突或丢数据。
- 🚫 **移动端（iOS/Android）完全不支持 symlink**。
- 「文件 symlink」（非目录）**官方不支持**；外部改动不被监听 → 不更新索引。

**一句话**：Obsidian 把「链接外部文件夹」当成**危险、劝退、且部分封禁**的边缘玩法。

### 3.2 差异化矩阵

| 维度 | Obsidian | Molio（目标） |
|---|---|---|
| **官方立场** | 强烈劝阻，警告数据风险 | **一等公民能力**，原生支持 |
| **vault 内文件夹互链** | 🚫 设计上禁止 | ✅ 允许（白名单内） |
| **跨盘/跨 folder 素材** | ⚠️ 文件管理器搬不动、链接不更新 | ✅ 虚路径统一，无跨盘语义鸿沟 |
| **索引/搜索是否覆盖外部内容** | ❌ 外部改动不监听、不进索引 | ✅ watcher 覆盖外部根，扫描边界一致 |
| **安全模型** | 无（用户自行承担风险） | ✅ 白名单 + 默认只读，边界显式 |
| **移动端** | ❌ 不支持 | 不适用（Molio 无移动端）|
| **同步/Git 冲突** | ⚠️ 易冲突、易丢数据 | 素材只读、产物回库 → **天然规避** |
| **AI 消费** | 无原生 AI | ✅ **AI 直接基于聚合内容做 wiki-build / 检索 / 问答** |

### 3.3 差异化叙事（对用户的一句话）

> **Obsidian 说「别把外面的文件夹链进来，会坏」；Molio 说「链进来，我帮你管好、建好、查好」。**

这不是一个功能点，而是一条**产品立场**：Obsidian 的「独立 vault + 手动整理」假设了**你要为知识库改变文件组织**；Molio 的「链接素材根 + AI 构建」假设**你维持现状，AI 来适应你**。

### 3.4 比 Obsidian 更好用的三个具体落点

1. **「聚合即建库」**：接进来即可 `wiki-build`，AI 自动生成结构化 Wiki（Obsidian 接进来只是多了几个文件夹，还得手动整理）。
2. **「冲突可感知」**：同名/矛盾内容显式呈现（对比页 + lint），而非 Obsidian 的「静默忽略 symlink、静默不更新索引」。
3. **「安全且稳」**：白名单 + 默认只读 + watcher 全覆盖——把 Obsidian 公告里那一长串「风险警告」逐条消解。

### 3.5 Obsidian 为何劝退符号链接？我们踩不踩同样的坑

Obsidian 官方原话：*"We strongly advise against using symbolic links… you risk losing or corrupting your data, or crashing Obsidian."* 拆成 6 条底层原因，逐条对照我们的设计：

| # | Obsidian 的坑 | 底层机制 | 我们的应对 | 判定 |
|---|---|---|---|---|
| 1 | **数据丢失/损坏** | Obsidian 是读写应用，编辑/移动/删除**穿透链接打到真实目标**；跨盘搬文件退化成「删除+新建」且不更新依赖链接 | **外部根默认只读**——不写不移不删 | ✅ 架构上规避（最重的一条，靠只读化解） |
| 2 | **重复文件 / 链接歧义** | 官方**主动忽略**「vault 内文件夹互链」：同一文件出现两次 → 搜索重复、`[[链接]]` 指向不明 | 外部根**天然在 vault 外** + `external/<label>/` 命名空间 | ⚠️ 需加固：强制**互不包含** + 环检测 |
| 3 | **同步冲突** | Git **不跟 symlink**（只存链接路径）；跨 vault 同步冲突/丢数据 | 外部素材**不进 vault 仓库**、只读；进 git 的只有 build 出的 wiki | ⚠️ 需显式声明（用户可能意外 vault 里没有外部内容本体） |
| 4 | **链接死循环** | 环状 symlink → 无限递归 → 崩 | 现有 `MAX_DIR_ENTRIES`/`MAX_TOTAL` 仅兜底，**无环检测** | ⚠️ 必须新增环检测 |
| 5 | **设置损坏** | symlink 共享 `.obsidian/` 有高概率损坏配置 | 元数据在 **SQLite**，不依赖 vault 内配置；dotfiles 已剪枝 | ✅ 规避 |
| 6 | **外部改动不被监听** | 文件 symlink 官方不支持；外部改动不 watch → 索引不更新 | **专门让 watcher 覆盖外部根** | ✅ 反向解决（即差异化点） |
| — | 移动端不支持 | iOS/Android 不支持 symlink | Molio 无移动端 | ✅ 不适用 |

**结论**：6 条里 1/5/6 + 移动端我们天然规避或反向解决；**2/3/4 是我们同样要面对的**——Obsidian 的回答是「劝你别用」，我们的回答必须是「我来兜底」。

### 3.6 我们独有的新风险（Obsidian 没有）

> **Obsidian 是纯本地桌面应用，没有网络面。Molio 的 daemon 是一个「无鉴权 + CORS 放开 localhost」的 HTTP 服务。**

外部根一旦被 daemon 暴露为可读，**任何能访问 `localhost:3100` 的本地进程/浏览器页面，都可能读取登记的这些外部文件夹内容**。这是 Obsidian 完全不面对的攻击面。

而且这个攻击面在「外部根」出现前，被 `assertWithinVault` 挡在 vault 边界内；**为外部根放宽 realpath 校验后，边界从「vault 内」扩到「白名单内」**——白名单若写松，就从「读 vault」降级成「读全盘」。

**因此立场必须是：因为我们有这个 Obsidian 没有的网络面，我们要比 Obsidian 更保守。** 三条硬约束：

1. **白名单即边界**——只读显式登记的根，绝不开放任意路径解析；
2. **只读**——去掉写入可能（Obsidian 数据损坏的根因正是写）；
3. **路径规范化 + 二次逃逸检查 + 环检测**——外部根内部若再有 symlink 指向根外，仍要拦。

### 3.7 结论：不违背初衷，是把「自担风险」变成「产品兜底」

- **Obsidian 的初衷**：vault = 自包含文件夹，笔记自己做主。链接外部文件夹会模糊 vault 边界，所以它把这能力当**边缘危险玩法**——劝退 + 部分封禁。
- **Molio 的定位不同**：接在本地知识上的 AI 工作站。「聚合分散的本地文件夹」不是要容忍的边缘 case，而是**要被工程化解决的核心能力**。立场变了，同样的技术从「危险」变成「必修」。

**差异化的本质不是「我们做它做不了的功能」，而是「它把风险转嫁给用户，我们把风险在产品层收敛掉」。**

---

## 第四部分：待定与建议下一步

### 4.1 决策记录（2026-09-08 已定）

1. **接入机制 → 真实链接（Molio 创建）+ 白名单 + `external/<label>/` 命名空间**。
   理由：wiki-build 是零改动约束下的关键消费方，只认真实文件系统；纯虚拟引用会让 build 漏源（1.7）。裸 junction 只喂饱 agent、UI 仍全盲，故必须叠加 daemon 跟随 + 白名单。Molio 创建链接而非要求用户 `mklink`（用户是非技术人群）。
2. **写回策略 → 只读，且第一版不提供可写开关**。
   理由：写穿透链接是 Obsidian 数据损坏根因；daemon 无鉴权，开放写=任意文件写；「素材在外、产物回库」语义自洽。可写需求将来单独立项 + 显式 opt-in。
3. **作用域标注 → `external/<label>/` 即出处锚点，强制**。
   理由：解决跨项目规则冲突；兑现「冲突可感知」「检索带出处」两条差异化；命名空间本就必要（防同名撞车），边际成本近零。配套铁律：外部根内 `CLAUDE.md`/`.claude/` 只当素材，不当可执行上下文。

> 详细技术方案见配套文档 [2026-09-08-linked-source-roots-design.md](./2026-09-08-linked-source-roots-design.md) 第〇节。

### 4.2 建议路线

- **阶段 A**：让 wiki-build 场景先跑（agent 已能跟 junction，Wiki 可建），验证价值。
- **阶段 B**：落「链接素材根」白名单（见配套设计文档），打通 UI 显示 / 读写 / 监听 / 安全四层。
- **阶段 C**：补「出处与作用域」原则，解决规则层冲突。

---

## 附：关键代码坐标

| 主题 | 位置 |
|---|---|
| 文件树扫描（不跟链接，显示层） | [knowledge.ts:80](apps/daemon/src/core/knowledge.ts#L80) |
| 真实路径校验（拦截外部根，读写层） | [knowledge.ts:453](apps/daemon/src/core/knowledge.ts#L453) |
| 边界守卫说明（为何存在） | [knowledge.ts:437](apps/daemon/src/core/knowledge.ts#L437) |
| 目录剪枝名单 | [vault-prune.ts:26](apps/daemon/src/core/vault-prune.ts#L26) |
| 文件监听（只 watch vault 根） | [vault-watcher.ts:96](apps/daemon/src/core/vault-watcher.ts#L96) |
| agent cwd = vault（操作规则来源） | [run-starter.ts:42](apps/daemon/src/core/conversations/run-starter.ts#L42) |
| wiki-build 扫描源文件规则 | `apps/daemon/src/tools/skills/wiki-build/SKILL.md` |
| 既有 Obsidian 全面对比 | [obsidian-comparison.md](./obsidian-comparison.md) |
