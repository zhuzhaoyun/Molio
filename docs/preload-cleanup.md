# 预下载（Preload）功能测试 — 清理已下载内容

> 在测试 docling / remotion 的「预下载」功能前，需要先把本地已预下载的内容清掉，让 daemon 重新判定为 `missing`，toast 才会再次弹出提示。
>
> 本文档列出所有预下载产物的位置和清理命令。

## 预下载产物位置一览

| 工具 | 产物 | 位置 | 删除？ |
|------|------|------|--------|
| docling | Python venv（含 docling + PyTorch） | `~/.molio/venv/` | ✅ 删 |
| docling | AI 模型（layout + table） | `~/.cache/huggingface/hub/models--docling-project--*` | ✅ 删（只删 docling 的） |
| remotion | 预下载完成标记 | `~/.molio/.remotion-preloaded` | ✅ 删 |
| remotion | npm 依赖缓存 | `~/.npm/` | ❌ 不删（共享缓存，删了拖慢全局） |
| 通用 | "不再提示" dismissed 状态 | `~/.molio/config.json` 的 `preload.dismissed` | 看情况 |

## 快速清理（一键脚本）

```bash
# 删 docling venv
rm -rf ~/.molio/venv

# 删 docling 的 HuggingFace 模型缓存（只删 docling-project 的，不动其他模型）
rm -rf ~/.cache/huggingface/hub/models--docling-project--*

# 删 remotion 预下载标记
rm -f ~/.molio/.remotion-preloaded

# （可选）如果之前点过「不再提示」，清掉 config 里的 dismissed 状态
# 用编辑器打开 ~/.molio/config.json，删掉 "preload": { "dismissed": [...] } 字段
```

> Windows PowerShell 对应：
> ```powershell
> Remove-Item -Recurse -Force $env:USERPROFILE\.molio\venv
> Remove-Item -Recurse -Force $env:USERPROFILE\.cache\huggingface\hub\models--docling-project--*
> Remove-Item -Force $env:USERPROFILE\.molio\.remotion-preloaded
> ```

## 验证清理干净

```bash
# 都应该输出「不存在」
ls -d ~/.molio/venv 2>/dev/null && echo "⚠ venv 还在" || echo "✓ venv 已清"
ls ~/.cache/huggingface/hub/models--docling-project--* 2>/dev/null && echo "⚠ 模型还在" || echo "✓ docling 模型已清"
ls ~/.molio/.remotion-preloaded 2>/dev/null && echo "⚠ marker 还在" || echo "✓ remotion marker 已清"
grep preload ~/.molio/config.json 2>/dev/null && echo "⚠ config 有 dismissed" || echo "✓ config 无 dismiss"
```

全绿后，`pnpm dev` 启动，daemon 的 `checkSkills()` 会判定 docling + remotion 都为 `missing`，web 端右下角会弹出预下载 toast。

## 关于 npm 缓存（remotion）

remotion 预下载只是把 npm 包灌进 `~/.npm` 共享缓存，**不建独立项目**。所以：

- 即使删了 `~/.molio/.remotion-preloaded` 标记，remotion 的 npm 包**可能还在 `~/.npm` 缓存里**——下次预下载会很快（命中缓存），这属于正常，不代表功能有问题。
- 想**冷测** remotion（强制重新下载）：`npm cache clean --force`。⚠️ 这会清空整个 npm 缓存，**会让后续 `pnpm install` / `pnpm dev` 变慢**，谨慎使用，测完不必恢复。

## 各产物说明

### `~/.molio/venv/`（docling 专用 Python 环境）

PreloadManager 用 `python -m venv` 创建的隔离环境，docling + PyTorch 等都装在里面。好处：不污染系统 Python、绕开 PEP 668、CLI 路径固定（`~/.molio/venv/bin/docling`），daemon spawn agent 时会自动把这个目录加到 PATH（见 `apps/daemon/src/core/runtimes/env.ts` 的 `augmentPath`）。

- 成功装完：约 1.5–2 GB（PyTorch 占大头）
- 只建了 venv 没装 docling：约 9 MB（空壳，说明 `pip install` 失败/超时）

### `~/.cache/huggingface/`（docling AI 模型）

docling 首次转换 PDF 时下载的 layout + table 模型，约 500 MB。目录结构：
- `hub/models--docling-project--docling-layout-heron/`（layout，~164M）
- `hub/models--docling-project--docling-models/`（table，~342M）

预下载的「模型预热」阶段（跑一次空 PDF）会主动触发这两个下载，让用户首次真正转换时不用等。⚠️ 这个目录是**共享**的——如果机器上还有别的 HuggingFace 工具（transformers 等），删的时候**只删 `models--docling-project--*`**，别 `rm -rf ~/.cache/huggingface` 整个删。

### `~/.molio/.remotion-preloaded`（remotion 标记文件）

PreloadManager 跑完 remotion npm 缓存预热后写的 marker 文件。`checkSkills()` 靠它判定 remotion 是否已预下载——存在就 `installed`（不弹窗），不存在就 `missing`（弹窗）。

## 故障排查：预下载没装成功

如果清理后重测，发现 toast 弹了但点「后台下载」后 docling 一直卡住或失败：

1. **venv 只有 ~9MB 空壳**：说明 `python -m venv` 成功但 `pip install docling` 失败/超时。常见原因：网络慢（PyTorch 很大）、清华镜像不通。可手动验证：
   ```bash
   ~/.molio/venv/bin/pip install docling -i https://pypi.tuna.tsinghua.edu.cn/simple
   ```
2. **docling 装了但模型下不动**：国内访问 HuggingFace 默认源常超时。docling SKILL.md 建议设 `HF_ENDPOINT=https://hf-mirror.com`。当前 PreloadManager 的模型预热**还没**自动注入这个镜像环境变量（待改进）。
3. **看 daemon 日志**：`pnpm dev:daemon` 的终端会打印 `[PreloadManager]` 的进度消息和子进程退出码。

## 相关代码

- daemon：`apps/daemon/src/core/preload-manager.ts`（检查 + 下载 + 状态机）
- daemon 路由：`apps/daemon/src/routes/preload.ts`（`GET /api/preload/status`、`POST /api/preload/start` 等）
- daemon PATH 注入：`apps/daemon/src/core/runtimes/env.ts` 的 `augmentPath`（把 `~/.molio/venv/bin` 加到 agent PATH）
- web：`apps/web/src/components/PreloadToast.tsx`（右下角 toast + 最小化/展开交互）
