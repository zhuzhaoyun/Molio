# DeepSeek Harness 上游版本管理

Molio 发行版通过 `vendor/deepseek-harness` 子模块锁定宿主提交。知识库、图谱、完整资源市场以及它们的预装配置由 Molio 仓库维护。子模块供开发和构建使用，最终用户从安装包获得插件。

## 检出发行版源码

在 Molio 仓库根目录运行以下命令，恢复当前分支指定的宿主版本。CI 在构建发行包前也应执行此步。

```sh
git submodule update --init --recursive -- vendor/deepseek-harness
```

## 导入上游更新

在独立的 Molio 升级分支中运行以下命令。第二条命令展示新旧宿主之间的提交，便于检查插件接口和打包变化。

```sh
git submodule update --remote --checkout -- vendor/deepseek-harness
git diff --submodule=log -- vendor/deepseek-harness
```

如需选择特定版本，在子模块内执行 `git checkout --detach <tag-or-commit>`。在 Molio 侧适配插件后，将子模块指针和适配改动放入同一 PR。发行前用新用户目录安装构建产物，检查三个预装入口、知识库打开与图谱加载，并通过测试账号和支付测试环境验证市场发布、购买和导入。

「文件入库」注册在 DSH 的输入框「＋」指令菜单（`/molio-ingest`），选择后通过 `conversation.input.dock` 挂载选库对话框，文件预览中的「在知识库中打开」使用 `sidebar.right.tab.document.actions`。注册入口在 [molio-chat-slots.tsx](../packages/dsh-plugin-molio/desktop/molio-chat-slots.tsx)。升级涉及聊天插件入口、插槽名或参数时，先核对这里。右侧文档预览通过 MolioMarkdownBody 包装 DSH 的 MarkdownBody，按打开文件所属库解析 Wiki 引用。聊天内的 Wiki 引用和 Windows 盘符处理仍在 [桌面构建适配脚本](../scripts/harness-desktop.mjs) 中接入 Markdown 渲染器。

升级分支可先运行 `pnpm test:desktop`，在临时目录检验适配脚本对锁定版本的首次应用和重复应用。桌面开发环境构建就绪后，运行 `node distribution/test/desktop/harness/host-smoke.mjs`，用独立用户目录验证会话选库、入库草稿及知识库跳转。

回退已合并的升级时，在 Molio 回退 PR 中一并恢复宿主指针和配套适配，再运行上述检出命令。

## 构建 Molio 预装版

Windows x64 构建机使用 Node.js 24.22.3 或上游支持的更高版本，并启用 Corepack。两个仓库分别声明了自己的 pnpm 版本。在 Molio 根目录运行：

```sh
git submodule update --init --recursive
corepack pnpm install --frozen-lockfile
corepack pnpm build:harness
```

构建命令在 `.harness-build/host` 创建固定提交的独立构建副本，将 Molio 页面、知识工具、桌面入口和图标装入宿主。Windows 本地构建生成按用户安装的未签名 NSIS 安装包。构建产物目录为 `.harness-build/host/apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts`。上传、签名和自动更新渠道由正式发布流程单独配置。

在宿主左侧栏打开「知识库」「知识图谱」或「资源市场」。三个入口在 DSH 主窗口的内容区切换，左侧栏始终可用。选择会话即可回到对话，剪藏文件也会在同一内容区打开。三个入口共用随包启动的本地服务。桌面知识工具连接同一实例的随机回环端口。资源市场使用 Molio 账号和原有云服务，保留发布、购买和下载。插件及知识管理界面随安装包交付。

升级时先执行 `git add vendor/deepseek-harness`，让构建读取待提交的版本指针，再执行上述构建命令。若上游改变集成入口，适配脚本会指出需要核对的文件。旧版构建副本会保留在 `.harness-build/host-before-*`。

本地调试可以用 `corepack pnpm build:harness --app` 生成桌面程序和预装资源，然后在 `.harness-build/host` 中运行 `corepack pnpm start:desktop`。完整交付使用上面的安装包构建命令。

## 插件与宿主的维护边界

桌面只有 deepseek-harness 一套 Electron。侧栏、窗口内导航和会话适配位于 `packages/dsh-plugin-molio/desktop`，桌面桥接和品牌资源位于 `distribution/`。上游接口变动集中在 `scripts/harness-*.mjs` 适配，子模块保留上游提交。

预装版的界面入口是 `apps/web/src/harness-main.tsx`，本地服务入口是 `apps/daemon/src/harness-sidecar.ts`。它们复用知识库、图谱、资源市场和账号源码。NAS/Web 保留自己的入口。首次本地构建并启动用 `corepack pnpm desktop:run`，已有构建用 `corepack pnpm dev:desktop`，修改插件源码后重新运行 `desktop:run`。`pnpm dev` 启动独立 Web 开发服务。

预装版发布使用独立标签 `harness-v<版本>`。手动触发 Release 工作流会生成测试安装包；推送预装版标签会发布 GitHub Release 和对应版本的 OSS 下载文件。旧桌面版自动更新地址保留给原版本系列。

知识库会话沿用 DSH 的项目技能发现机制。现有库启动时、新库注册时，将内置技能及配套脚本复制到项目的 `.agents/skills/`。技能始终写入知识库本身。知识库嵌套在其他 Git 仓库中时，预装版也识别该库的项目技能，并保留宿主原有技能来源。已有同名技能优先保留。问答、建库、检查和摄取入口仅生成任务草稿，由模型按技能描述选择。
