# 「链接素材根」设计 — 让 Molio 知识库接入分散在各处的本地文件（不需移动，也不需复制）

- **日期**：2026-09-08
- **状态**：**已实现**（代码在分支 `feat/external-source-roots`）
- **配套纪要**：[2026-09-08-cross-folder-kb-strategy.md](./2026-09-08-cross-folder-kb-strategy.md)（产品立场、Obsidian 差异化、风险分析）
- **一句话**：给 vault 增加「外部素材根」——用**真实文件系统链接（Windows junction / macOS·Linux symlink）**把本机任意位置的素材文件夹挂进 vault 的 `external/<label>/` 命名空间，作为**只读源材料**纳入文件树 / 图谱 / 搜索 / wiki-build；物理文件留在原位。
- **落地偏差**（实现相对本设计的调整，实施期由 review 实测驱动）：
  1. **写拒绝用 realpath 判定**（「目标最近存在祖先的 realpath 必须落在 vault 内」），而非按路径字符串匹配 —— 字符串匹配在 Windows/macOS 上可被 `External/AgentA` 这类**大小写变体击穿**（实测可覆盖/删除挂载内文件）。
  2. **链接存活判定用 `lstat`**，不用 `existsSync` —— 后者对**悬挂链接**返回 false，而「目标盘拔掉 → 链接悬空」正是本功能的核心场景；用错会导致卸载后残留永久无法清理的链接、且可能误删同名用户文件。
  3. **剪枝豁免按「真实目标是否在 vault 内」收窄**：链接名/目标名为剪枝名（`dist`、`.notes` 等）时，只对 **vault 内**的逃逸链接生效；否则一个**已登记**的根会被静默隐藏而 API 却报 `valid: true`。
  4. **外部根 CRUD 响应经 `db.ts` 的 row mapper 输出 camelCase**，与既有 KB 契约（route 负责翻译、不裸传存储列名）保持一致。
  5. **启动自愈未实现**（§3.2 / §4.2 的「链接缺失则重建」）—— 目前仅挂载路由创建链接，daemon 启动 / vault 打开不做注册表↔磁盘比对。目标消失的**失效态检测**不受影响（走的是 `lstat` 判定）。
  6. **失效处理只有「解除」**（§4.2 写的是「重新定位 / 解除」）—— UI 仅提供移除挂载，「重新定位」待做。
  7. **前端「改 label」未实现**（§六）—— label 恒取 `basename(target)`，设置面板只有添加 / 移除 / 查看失效态。
  8. **D3 只落了命名空间**—— `external/<label>/` 出处锚点已就位；「wiki-build 对比页」「检索带出处」属阶段 C，未实现。对外表述（文章 / 官网）不得提前引用。
- **合并门禁**：整个功能依赖「Windows junction 被 `isSymbolicLink()` 识别为 true」这一**仅在 macOS 上开发、需由 `windows-latest` CI 验证**的假设；若不成立，兜底检测为 `realpathSync(p) !== path.resolve(p)`。

---

## 〇、决策记录（2026-09-08）

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D1 | 接入机制 | **真实链接（Molio 创建）+ 白名单登记 + daemon 跟随** | 纯虚拟引用 agent 看不到（见 2.1）；真实链接是**零改动兼容 wiki-build**的唯一路径 |
| D2 | 写回策略 | **只读，且第一版不提供可写开关** | Obsidian 数据损坏根因就是写穿透；daemon 无鉴权，开放写=任意文件写。素材在外、产物回库，语义自洽 |
| D3 | 作用域标注 | **`external/<label>/` 即出处锚点，强制** | 解决跨项目规则冲突；支撑「冲突可感知」差异化；防止项目私有约定被洗成普适结论 |

---

## 一、需求与场景

系统里有多个 AI Agent（Claude Code、Qoder、Trae、WorkBuddy 等），各自在自己的项目目录下维护 `memory/` 文件夹，散落在 C: 和 D: 各处，无法统一检索。

目标：**建一个公共记忆空间（`agent-memory` vault），把分散各处的记忆聚合、构建成可检索的 Wiki**，且**不移动、不复制**原始文件。

更一般化：让 Molio 知识库能引用本机任意位置的素材文件夹，把这些素材当作 vault 的**只读源材料**，纳入文件树 / 图谱 / 搜索 / wiki-build。

---

## 二、现状分析：为什么裸 junction 不行（已实测）

### 2.1 关键事实：Molio 内部有「两套文件世界观」

| 消费方 | 实现 | 对链接的态度 |
|---|---|---|
| **Agent（wiki-build）** | `cwd=vault`，`find`/Read 逛**真实文件系统** | ✅ 跟随（OS 级访问） |
| **Daemon / Web UI** | `scanTree` / `findFileByStem` / `searchFiles` / `readFile` | ❌ 不跟随 |

**这条事实决定了 D1**：wiki-build 是零改动约束下的关键消费方，它只认**真实文件系统**。所以外部素材必须在磁盘上有真实可达的路径——**纯虚拟引用（只在 daemon 注册表里合成）会让 build 漏掉全部外部源文件**。真实链接是唯一能同时喂饱 agent 和 UI 的接入方式。

### 2.2 被拦截的三个点（实测证据）

实测（macOS symlink ≡ Windows junction 在 `Dirent` 中表现一致）：

```
readdirSync → { name:"raw", isDirectory:false, isFile:false, isSymbolicLink:true }
```

**拦截点 A — 显示层**：[knowledge.ts:80](apps/daemon/src/core/knowledge.ts#L80) 用 `entry.isDirectory()`/`isFile()` 判断，链接两者皆 `false` → 条目被静默丢弃。同款判断还在 `findFileByStem`（[L344](apps/daemon/src/core/knowledge.ts#L344)）、`searchFiles`（[L808](apps/daemon/src/core/knowledge.ts#L808)）。

**拦截点 B — 读写层**：[readFile → `resolveRealWithinVault`](apps/daemon/src/core/knowledge.ts#L453)，链接真实路径在 vault 外，`realpathSync` 后逃出根 → `Path traversal not allowed`。

**拦截点 C — 监听层**：[vault-watcher.ts:96](apps/daemon/src/core/vault-watcher.ts#L96) 只 `chokidar.watch(vaultPath)`，外部根变化不触发 `tree-changed`。

### 2.3 安全边界（必须显式设计）

[resolveRealWithinVault](apps/daemon/src/core/knowledge.ts#L437) 的注释说明其存在原因：**daemon 无鉴权 + CORS 放开 localhost，边界防「任意本地网页读取磁盘任意路径」**。

放宽它 → 外部根必须收敛为**用户显式登记的白名单**，读取校验 realpath 落「vault 内 ∪ 登记的外部根内」。这是 Molio 独有的、Obsidian（纯桌面应用、无网络面）不需要面对的约束。

---

## 三、方案选择

### 3.1 否定路线

| 路线 | 结论 |
|---|---|
| 裸 junction（只接线到 raw/） | 只通 wiki-build，**UI 层全盲** → 不完整 |
| 索引 + 直读（纯虚拟引用） | **agent 抓不到 → build 漏源**（2.1）→ 不可行 |
| junction + 快照双层 | 复杂度翻倍 → 过度设计 |
| 纯改判断条件 | 半截修复（显示层通、realpath 仍拦）；直接放宽=安全漏洞 |

### 3.2 采纳路线：真实链接 + 白名单 + 命名空间

**三件套**：
1. **真实链接**：Molio 用 `mklink /J`（Windows，免管理员、跨盘可用）/ `ln -s`（macOS·Linux）在 `<vault>/external/<label>` 建立指向外部素材根的链接；
2. **白名单登记**：`external/` 由 Molio 托管，注册表（SQLite）为唯一事实源，启动时自检自愈（链接丢失则重建、目标消失则标记失效）；
3. **命名空间隔离**：`external/<label>/` 同时充当**出处锚点**（D3）。

---

## 四、数据模型

### 4.1 外部根注册表

```sql
CREATE TABLE vault_external_roots (
  id         TEXT PRIMARY KEY,
  vault_id   TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,      -- 命名空间名 + 出处锚点（默认取 basename，可改，需唯一）
  target     TEXT NOT NULL,      -- 外部真实根，登记时 canonicalize(realpath)
  created_at INTEGER,
  UNIQUE (vault_id, label),
  UNIQUE (vault_id, target)
);
```

约束（对应 Obsidian 的「disjoint」保护，**必须显式强制**）：
- `target` 与 vault 根**互不包含**（不能是 vault 的父/子目录）；
- 任意两个外部根**互不包含**；
- `label` 在 vault 内唯一、且是合法目录名。
- 违反 → 拒绝登记并给出可读原因。

### 4.2 挂载与链接生命周期

- **挂载路径**：`<vault>/external/<label>` → `<target>`。
- **创建**：用户「添加外部素材根」→ 校验（存在性、disjoint）→ 建链接 → 写注册表。
- ~~**自愈**：daemon 启动 / vault 打开时比对注册表与磁盘，链接缺失则重建。~~ **未实现，见落地偏差 5。**
- ~~**失效处理**：`target` 不存在 → 标记「已失效」，UI 显示断链态并提供「重新定位 / 解除」。~~ **失效标记 + 解除已实现；「重新定位」未做，见落地偏差 6。**
- **解除**：删链接（**不碰 target**）+ 删注册表行。
- **环检测（必须）**：扫描需带 visited 集合（按 realpath 去重），防符号链接环导致无限递归。这是 Obsidian 明确列出的崩溃原因。

### 4.3 读取映射

- **文件树 / 图谱 / 搜索**：`external/<label>/...` 虚路径 → 解析到 `target/...` → realpath 校验落白名单 → 读取。
- **write / rename / delete / import**：**一律拒绝** `external/` 下的写操作（D2）。
- **wiki-build**：agent 用 `find`/Read 在 `external/<label>/` 下遍历——**真实链接对它是透明的，零 skill 改动**。

---

## 五、daemon 层改动

### 5.1 扫描跟随链接（显示层）

`scanTree` / `findFileByStem` / `searchFiles` 遇 `entry.isSymbolicLink()` 时用 `fs.stat`（跟随）解析真实类型；**只有 realpath 落白名单（vault 内 ∪ 登记外部根）才继续遍历**，否则视为不可见（不报错）。配合环检测（4.2）。

### 5.2 边界校验（读写层）

`resolveRealWithinVault` 放宽为 `resolveRealWithinBoundary`：真实路径落 vault 内 **或** 任一登记外部根内则放行，否则抛错。**绝不无脑放开任意路径**。

### 5.3 监听（监听层）

`VaultWatcher.watch` 对每个登记的外部根也 `chokidar.watch`（`followSymlinks: true`），保证「刷新边界 == 扫描边界」。注意沿用现有 `isPrunedDirName` 剪枝与 `MAX_DIR_ENTRIES` 兜底。

### 5.4 端点

- `GET/POST/DELETE /api/knowledge/vaults/:id/external-roots`
- 校验：存在性、disjoint、label 唯一；返回失效态供 UI 呈现。

---

## 六、前端改动

- **Vault 设置**：外部素材根列表（~~添加/移除/改 label/查看失效态~~ → 实际落地：**添加 / 移除 / 查看失效态**；改 label 未做，见落地偏差 7；面板交互定论见下节增补）。
- **文件树**：渲染 `external/<label>/` 挂载点。
- **只读态**：外部根内禁用新建/编辑/删除/拖入。
- **图谱/搜索**：纳入外部根节点，节点带出处标识。

### 6.1 增补：仓库管理器交互定论（2026-09-10，实装于本分支）

外部素材根的配置入口在仓库管理器（VaultManager）右栏，其交互经两轮用户反馈后定论：

- **选中仓库不关面板**：`selectVault` 不再自动收起管理器——右栏就地保持「当前仓库 · <名>」的作用域头，选中即可挂载，不需要重开面板（用户反馈第一轮）。
- **多窗口语义保留**：已 pin 窗口（URL 有 `?vault=`）选中**别的**仓库 → 仍按 Obsidian 式多窗口另开新窗口，原窗口不动（用户明确要求保留，曾误删被 rewind）。新窗口 URL 带 **`manage=1`**，vault 解析后自动打开管理器并随即剥掉该参数（同 `?panel=graph` 的一次性意图套路）——配置新仓库不用在新窗口里再点开一次。
- **显式出口**：✕ 按钮 / Esc / 点遮罩空白。Esc 在删除确认框弹着时只关确认框不关面板。

> 教训（写代码前先数分支）：仓库选择手势在 `handleVaultPick` 有 pinned / in-place 两条路径，且 URL 镜像 effect 会让几乎每个窗口立刻变成 pinned——只修一条 = 没修。

---

## 七、只读策略与安全（D2）

- **只读，且第一版不提供可写开关**。理由：
  1. Obsidian 数据损坏的根因就是写穿透链接；只读从根上删掉这一整类风险；
  2. daemon 无鉴权 + CORS 放开 localhost——**读**已需白名单约束，**写**则是任意文件写，量级更严重；
  3. 语义自洽：外部=输入（素材），vault=输出（产物、wiki）。
- 后续若确有需求，再作为**独立开关**（显式 opt-in）单独立项。

---

## 八、出处与作用域（D3）

- `external/<label>` 即出处锚点，贯穿文件树、图谱、wiki-build、检索。
- **wiki-build**：外部源生成的 source 页记录其 scope；跨 scope 出现矛盾约定 → **生成对比页显式呈现**，不静默二选一。
- **检索/问答**：命中带出处；项目私有约定按「关于某项目的陈述」对待，**不当作全库通用规则**。
- **嵌套规则文件**：外部根内的 `CLAUDE.md` / `.claude/` 视为**待引用素材**，**不作为可执行上下文**注入 agent。

---

## 九、测试计划

### 后端单测（apps/daemon/test/core/knowledge-external-roots.test.ts，node:test）
- `scanTree` 跟随链接，外部根内容以 `external/<label>/...` 出现。
- `findFileByStem` / `searchFiles` 命中外部根文件。
- `readFile` 对白名单内可读；未登记真实路径抛 `Path traversal not allowed`。
- 外部根内部再有 symlink 指向白名单外 → 仍拦截（二次逃逸）。
- **符号链接环 → 有限终止**（不栈溢出 / 不无限递归）。
- disjoint 校验：登记 vault 子目录 / 父目录 / 与既有根重叠 → 拒绝。
- 链接失效 → 注册表返回失效态、不崩。
- **写操作**（write/rename/delete/import）落 `external/` → 一律拒绝。

### E2E（apps/web/e2e/kb-external-roots.spec.ts，P2 @kb）
- 登记外部根 → 文件树出现挂载点 → 打开文件成功。
- 外部根内只读（新建/编辑/删除入口禁用）。
- 目标目录消失 → UI 呈现失效态 + 可解除。

### 回归
- 无外部根的 vault 行为完全不变；graph / search / split-view 不回归。

---

## 十、成本估计

- daemon：扫描跟随 + 白名单 + 环检测 + 链接生命周期 + 注册表 + 端点 + 单测 ≈ 3–4 天。
- 前端：设置面板 + 挂载点 + 只读态 + 失效态 ≈ 1.5–2 天。
- E2E + 回归 ≈ 1 天。

---

## 十一、范围边界（本轮不做）

- **外部根可写**（写回外部源）——待独立授权开关。
- 自动发现/批量导入外部根。
- 云端/网络盘（仅本地文件系统）。
- 性能缓存（mtime 缓存）——沿用现有剪枝兜底。
- 移动端（Molio 无移动端）。

---

## 十二、已知代价（诚实记录）

1. **vault 内引入真实链接的代价**：vault 被整体复制/打包/第三方同步时，链接可能被跟随或复制成链接（Obsidian 警告 #3 同款）。缓解：`external/` 为 Molio 托管、注册表为事实源、启动自愈；文档明确「vault 含链接，勿用会跟随链接的工具打包」。
2. **平台差异**：Windows junction 免管理员；macOS/Linux symlink 需要时可能涉及权限。创建失败要有可读降级提示。
3. **两个文件世界观仍并存**：agent 跟链接、daemon 跟白名单——两者边界必须一致（5.1/5.3），否则又回到「agent 看得到、UI 看不到」。
