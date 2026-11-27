# Molio for DeepSeek Harness

在 DSH 侧栏打开知识库、知识图谱和资源市场。插件使用 Molio 自己的界面和本地知识库服务，第一次访问时启动服务，停用插件时退出。原生 Molio 和插件默认使用当前用户的 Molio 数据目录。

## 安装和使用

在官方 DSH 桌面版的插件管理中添加插件包。开发版可以从本仓库构建安装包。使用 DSH Web 时，在对应的 profile 中安装：

```sh
dsh plugin --profile web add /path/to/dsh-plugin-molio-0.2.2.tgz
```

重新启动该 profile，在桌面端的「知识库」中点「打开知识库」即可通过系统目录选择器选库。打开一篇笔记后点「问答」，当前笔记会作为附件加入知识库会话，输入框留给你的问题。「知识图谱」显示笔记之间的引用，「资源市场」用于浏览和导入资源。对话的「＋」菜单中选择「文件入库」，选择目标知识库和来源，再确认草稿。知识库内的工作区按路径匹配，其他工作区可按会话选库。

对话回答和右侧 Obsidian 预览支持笔记双链和别名。预览顶部的属性区可以折叠，标签和笔记引用按宽度自动换行，点击属性或正文中的笔记引用即可继续阅读。右侧工具栏的「在知识库中打开」会定位到原笔记。插件的只读工具包括 `molio_status`、`molio_kb_vaults`、`molio_kb_tree`、`molio_kb_search` 和 `molio_kb_read`。

已有独立部署时，可用 `MOLIO_DAEMON_URL` 或 `MOLIO_PORT` 指定服务。三个界面入口需要该地址同时提供 Molio Web 页面和 API。内置服务面向在同一台机器上运行的浏览器和 DSH 宿主。

## 本地构建

仓库根目录使用 Node.js 24 和项目指定的 pnpm：

```sh
pnpm install --frozen-lockfile
pnpm build:contracts
pnpm --filter dsh-plugin-molio build
pnpm --filter dsh-plugin-molio test
cd packages/dsh-plugin-molio
npm pack
```

生成的 tgz 包含宿主入口、DSH 浏览器入口、Molio 页面、知识库服务和内置技能。构建使用 DSH 公开的客户端插槽，直接在官方 DSH 中运行。插件通过 `dsh-plugin-v*` 标签独立发布。原生 Molio 桌面版沿用自己的构建和发布命令。

在临时 DSH profile 中安装打包产物并启动 DSH Web 后，将该实例的本地启动 URL 传入环境变量 `MOLIO_DSH_SMOKE_URL`，在仓库根目录运行 `node --test packages/dsh-plugin-molio/test/official-host.mjs` 可验证三个模块、会话草稿、双链和右侧跳转。
