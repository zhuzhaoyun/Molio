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

回退已合并的升级时，在 Molio 回退 PR 中一并恢复宿主指针和配套适配，再运行上述检出命令。

## 构建 Molio 预装版

Windows x64 构建机使用 Node.js 24.22.3 或上游支持的更高版本，并启用 Corepack。两个仓库分别声明了自己的 pnpm 版本。在 Molio 根目录运行：

```sh
git submodule update --init --recursive
corepack pnpm install --frozen-lockfile
corepack pnpm build:harness
```

构建命令在 `.harness-build/host` 创建固定提交的独立构建副本，将 Molio 页面、知识工具、桌面入口和图标装入宿主。Windows 本地构建生成按用户安装的未签名 NSIS 安装包。构建产物目录为 `.harness-build/host/apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts`。上传、签名和自动更新渠道由正式发布流程单独配置。

在宿主左侧栏打开「知识库」「知识图谱」或「资源市场」。三个入口共用随包启动的本地服务。桌面知识工具连接同一实例的随机回环端口。资源市场使用 Molio 账号和原有云服务，保留发布、购买和下载。插件及知识管理界面随安装包交付。

升级时先执行 `git add vendor/deepseek-harness`，让构建读取待提交的版本指针，再执行上述构建命令。若上游改变集成入口，适配脚本会指出需要核对的文件。旧版构建副本会保留在 `.harness-build/host-before-*`。

本地调试可以用 `corepack pnpm build:harness --app` 生成桌面程序和预装资源，然后在 `.harness-build/host` 中运行 `corepack pnpm start:desktop`。完整交付使用上面的安装包构建命令。
