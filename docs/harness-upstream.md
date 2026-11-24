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
