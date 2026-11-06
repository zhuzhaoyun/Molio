# 预下载（Preload）功能测试 — 清理已下载内容

> 在测试 docling 的「预下载」功能前，需要先把本地已预下载的内容清掉，让 daemon 重新判定为 `missing`，toast 才会再次弹出提示。
>
> 本文档列出所有预下载产物的位置和清理命令。
>
> **remotion 预下载已下线（2026-08）**：remotion 不再是内置技能（改由技能商店的 `am-will/remotion` 按需安装，首次使用时现装依赖），它的预下载随之移除。旧机器上可能残留 `~/.molio/.remotion-preloaded` 标记文件——新版 daemon 完全不读它，留着无害，想清理直接删即可。下文所有 remotion 相关命令仅用于清理这种历史残留。

---

## 🚀 快速重测预下载（按操作系统，复制即用）

> 目标：把 docling 清回 `missing`，让右下角 toast 重新弹出。**只清预下载产物，绝不动你 vault 里的 remotion 项目**（那些是你自己的视频工程，见末尾避坑 4）。
> 下面 `~` = 用户主目录：macOS/Linux 是 `/Users/<你>` 或 `/home/<你>`；Windows 是 `C:\Users\<你>`（即 `$env:USERPROFILE`）。

### macOS / Linux（zsh / bash）

```bash
# 1) docling：预下载 venv + AI 模型
rm -rf ~/.molio/venv
rm -rf ~/.cache/huggingface/hub/models--docling-project--*
# 2) docling：若还全局/用户级装过（旧版本 / 手动 pip / SKILL.md 自愈装的），一并卸
python3 -m pip uninstall -y docling 2>/dev/null
#    残留脚本（如有）：rm -f ~/.local/bin/docling
# 3)（可选）旧版本遗留的 remotion 预下载标记——新版已不读，删不删都行
rm -f ~/.molio/.remotion-preloaded
# 4) 清掉「不再提示」，否则 toast 永不重弹
jq 'del(.preload.dismissed)' ~/.molio/config.json > /tmp/c.json && mv /tmp/c.json ~/.molio/config.json
#    没有 jq 就用编辑器删掉 config.json 里的 "preload": { "dismissed": [...] } 整段
```

### Windows（PowerShell）

```powershell
# 1) docling：预下载 venv + AI 模型
Remove-Item -Recurse -Force $env:USERPROFILE\.molio\venv -ErrorAction SilentlyContinue
Get-ChildItem $env:USERPROFILE\.cache\huggingface\hub -Directory -Filter "models--docling-project--*" -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force
# 2) docling：若还全局/用户级装过，一并卸（用装它的那个 python；不确定就都试）
python -m pip uninstall -y docling 2>$null
py -3 -m pip uninstall -y docling 2>$null
# 3)（可选）旧版本遗留的 remotion 预下载标记——新版已不读，删不删都行
Remove-Item -Force $env:USERPROFILE\.molio\.remotion-preloaded -ErrorAction SilentlyContinue
# 4) 清掉「不再提示」（无 jq：用编辑器删 config.json 里 "preload": { "dismissed": [...] } 整段，注意逗号）
```

### 验证清干净（两平台通用思路）

```bash
# macOS/Linux：以下应全 ✓ / 无
ls -d ~/.molio/venv 2>/dev/null && echo "⚠ venv 还在" || echo "✓ venv 无"
ls -d ~/.cache/huggingface/hub/models--docling-project--* 2>/dev/null && echo "⚠ HF 还在" || echo "✓ HF 无"
which docling 2>/dev/null && echo "⚠ PATH 还有全局 docling" || echo "✓ 无全局 docling"
grep -q '"dismissed"' ~/.molio/config.json 2>/dev/null && echo "⚠ 仍有 dismissed" || echo "✓ 无 dismissed"
```
```powershell
# Windows：以下应全 ✓ / 无
Test-Path $env:USERPROFILE\.molio\venv                                    # 应 False
Get-ChildItem $env:USERPROFILE\.cache\huggingface\hub -Directory -Filter "models--docling-project--*" -ErrorAction SilentlyContinue   # 应空
where.exe docling 2>$null                                                  # 应无输出
Select-String '"dismissed"' $env:USERPROFILE\.molio\config.json -Quiet     # 应 False
```

### 让 toast 重新弹（关键，二选一）

- **最稳**：重启 `pnpm dev`（`checkSkills()` 只在启动跑一次）。
- **不想重启**（daemon 还在跑）：`/status` 读的是 daemon **内存**状态，光删文件它仍记 `installed`，toast 不弹。删完产物后对**运行中** daemon 调一次重探测：
  ```bash
  curl -s -X POST http://localhost:3100/api/preload/undismiss \
    -H 'Content-Type: application/json' -d '{"skills":["docling"]}'
  curl -s http://localhost:3100/api/preload/status   # 确认 status=missing、path=null
  ```
  ```powershell
  Invoke-RestMethod -Method Post -Uri http://localhost:3100/api/preload/undismiss -ContentType 'application/json' -Body '{"skills":["docling"]}'
  Invoke-RestMethod http://localhost:3100/api/preload/status
  ```
  ⚠️ skills 数组里只能放 `docling`——预下载宇宙现在只有它，传其它 slug 会被路由校验拒成 400。

清完 + 重探测/重启后，右下角会弹 docling 一张卡，点「后台下载」即可重测。

### ⚠️ 避坑（同事复测最常踩的 4 个）

1. **删了文件 toast 还不弹** → 99% 是 daemon 内存没重探测：按上面「undismiss 或重启」处理；或之前点过「不再提示」没清 `dismissed`。
2. **docling 清不干净** → 它可能装在**两个地方**（预下载 venv + 全局/用户 pip）。只删 venv 不够，全局那份要 `pip uninstall docling`（Win 上全局在 `%APPDATA%\Python\Python3xx\Scripts`，不是 `~/.local/bin`）。
3. **zsh 下 `rm -rf ...models--docling-project--*` 报 `no matches found`** → 该 glob 没匹配到（模型本来就没下/已删），**无害**，忽略即可；怕报错就在命令尾加 `2>/dev/null` 或先 `setopt NULL_GLOB`。
4. **别删 vault 里的 remotion 项目** → `<vault>/.molio/remotion/<项目>/` 是 agent 给你做的视频工程（含你的 `src/` 源码 + 渲染产物），**跟预下载毫无关系**（remotion 预下载已下线，见顶部说明）。注意 create-video 常把工程建在**嵌套**的 `<项目>/<项目>/` 里，别被外层空目录骗了误删。

---

## 产物位置与「为什么这么删」（参考，命令见顶部「快速重测」）

| 工具 | 产物 | 位置 | 重测时删？ |
|------|------|------|--------|
| docling | 隔离 venv（docling + PyTorch） | `~/.molio/venv/` | ✅ |
| docling | AI 模型（layout + table） | `~/.cache/huggingface/hub/models--docling-project--*` | ✅（只删 docling 的，别整个删 `huggingface/`） |
| docling | 全局/用户级副本（若有） | `which/where docling`、`pip show docling` 的 Location | ✅ 用 `pip uninstall docling` |
| remotion（已下线） | 旧版预下载标记 | `~/.molio/.remotion-preloaded` | ❌（新版不读它，留着无害，想删直接删） |
| 通用 | 「不再提示」 | `~/.molio/config.json` 的 `preload.dismissed` | ✅（不清则 toast 永不重弹） |

**docling 有两个合法位置**：预下载的 venv，和手动/agent 自愈装的全局/用户 Python（mac/Linux 用户级 `~/.local/bin`；**Windows 用户级在 `%APPDATA%\Python\Python3xx\Scripts`，不是 `~/.local/bin`**；还有 conda / homebrew）。两者都被 agent 认可（`augmentPath` 把 venv bin 和 `~/.local/bin` 都加进 PATH，`detectInstalled` 先查 venv 再查 PATH），所以**重测要两处都清**，否则全局那份会让它仍判 `installed`。不知道装哪了？看 `GET /api/preload/status` 的 `statuses.<skill>.path`，或 `which -a`/`where.exe`/`pip show docling`——别猜。

**remotion 没有预下载产物可清**：它的预下载已下线（2026-08）。remotion 依赖改为首次使用时现装，装在各 vault 项目自己的 `node_modules` 里——「同事看到的 remotion 路径」是他 vault 里的项目，跟预下载不是一回事，**什么都别删**（vault 项目更别碰，见顶部避坑 4）。旧版遗留的只有 `~/.molio/.remotion-preloaded` 标记文件，新版 daemon 不读它。

## ⚠️ docling 预下载前提：Python ≥3.10

docling 要求 ≥3.10；预下载会自动找 3.10+（版本名 `python3.12`、Homebrew、`uv`、Windows 的 `py -3.X` 与各安装目录、conda）。本机只有 3.9（老 macOS 常见）时会**直接报清晰错误**（不再撞 pyobjc 编译哑巴错），需先装 3.10+：macOS `brew install python@3.12`、Windows python.org 安装包（**勾 Add to PATH**）/ `winget install Python.Python.3.12`、Linux `apt install python3.12 python3.12-venv`。

> `brew install python@3.x` 不会把无版本 `python3` 软链到 PATH（只在 `$(brew --prefix)/opt/python@3.x/libexec/bin`），所以 PATH 上的 `python3` 可能仍是 3.9——预下载按**版本号**找 `python3.12`，不受影响。

## 各产物说明

### `~/.molio/venv/`（docling 专用 Python 环境）

PreloadManager 用 `python -m venv` 创建的隔离环境，docling + PyTorch 等都装在里面。好处：不污染系统 Python、绕开 PEP 668、CLI 路径固定（`~/.molio/venv/bin/docling`），daemon spawn agent 时会自动把这个目录加到 PATH（见 `apps/daemon/src/core/runtimes/env.ts` 的 `augmentPath`）。

- 成功装完：约 1.5–2 GB（PyTorch 占大头）
- 只建了 venv 没装 docling：约 9 MB（空壳，说明 `pip install` 失败/超时）

> ⚠️ toast 上的「停止」/「停止并清理预下载」**只删这个 venv + docling 的 HF 模型**，**绝不会动全局/用户级/conda 里手动或旧版本装的 docling**（乱删用户全局包是危险的）。所以全局 docling 要靠上面的 `pip uninstall docling` 卸。

### `~/.cache/huggingface/`（docling AI 模型）

docling 首次转换 PDF 时下载的 layout + table 模型，约 500 MB。目录结构：
- `hub/models--docling-project--docling-layout-heron/`（layout，~164M）
- `hub/models--docling-project--docling-models/`（table，~342M）

预下载的「模型预热」阶段会喂一个**最小 PDF** 触发 `StandardPdfPipeline`，在 init 时下载这两个模型（注意：**不能用空输入或 markdown**——空输入在格式识别阶段就被拒、markdown 走 `SimplePipeline`，两者都不加载模型，预热等于白跑）。⚠️ 这个目录是**共享**的——如果机器上还有别的 HuggingFace 工具（transformers 等），删的时候**只删 `models--docling-project--*`**，别 `rm -rf ~/.cache/huggingface` 整个删。

> ⚠️ 装了 `hf-xet` 时，模型 blob 可能另存一份在 `~/.cache/huggingface/xet/`（全局内容寻址、跨模型共享）。**无法只删 docling 的那部分**——删 `hub/models--docling-project--*` 后这些 xet blob 会变成孤儿，仅占空间、不影响功能/复现，属 HuggingFace 的内在限制，可忽略或定期 `huggingface-cli scan-cache` 清理。

### `~/.molio/.remotion-preloaded`（历史遗留，已无用途）

旧版本 PreloadManager 跑完 remotion npm 缓存预热后写的 marker 文件。remotion 预下载下线后，`checkSkills()` 不再检查 remotion，这个文件**没有任何代码会读**——留着无害，嫌碍眼直接删。

## 故障排查：预下载没装成功

如果清理后重测，发现 toast 弹了但点「后台下载」后 docling 一直卡住或失败：

1. **venv 只有 ~9MB 空壳**：说明 `python -m venv` 成功但 `pip install docling` 失败/超时。常见原因：网络慢（PyTorch 很大）、清华镜像不通。可手动验证（路径按平台）：
   ```bash
   # macOS / Linux
   ~/.molio/venv/bin/pip install docling -i https://pypi.tuna.tsinghua.edu.cn/simple
   # Windows (PowerShell)
   & "$env:USERPROFILE\.molio\venv\Scripts\pip.exe" install docling -i https://pypi.tuna.tsinghua.edu.cn/simple
   ```
2. **报「docling 需要 Python ≥3.10」**：本机的 `python3` 是 3.9（老 macOS 常见），docling 在 3.9 上会撞 `pyobjc-core` 编译失败。预下载会自动找 3.10+（含 `py -3.X` 启动器、各安装目录、conda、uv）；若仍找不到，按提示装 3.10+（macOS `brew install python@3.12`；Windows python.org 安装包**勾选 Add to PATH**；Linux `apt install python3.12 python3.12-venv`）。
3. **docling 装了但模型没预热全**：预热已自动注入 `HF_ENDPOINT=https://hf-mirror.com`（用户自己设了就不覆盖），并喂最小 PDF 触发模型下载。但**镜像覆盖可能不全**——实测 layout 模型能下、table 模型在某些镜像报 `FileMetadataError`，于是只预热了一部分。这**非致命**：预热失败被 catch，缺的模型在首次真正转换时重试下载。要预热更全，可在自己环境设一个含全量 docling 模型的 `HF_ENDPOINT` 后再触发预下载。
4. **路径含空格（Windows 用户名带空格等）失败**：已修复——python/pip/docling 调用现在走无 shell 的参数数组，不再因空格断命令。若仍异常，看 daemon 日志里的真实子进程退出码。
5. **看 daemon 日志**：`pnpm dev:daemon` 的终端会打印 `[PreloadManager]` 的进度消息和子进程退出码。
6. **预下载时 Windows 弹黑色 cmd 窗口（macOS 不弹）**：根因有两层——①旧 `spawn` 带 `detached` 却没设 `windowsHide`，libuv 在 Windows 把 `detached` 映射成 `DETACHED_PROCESS`，顶掉隐藏标志；②即便补了 `windowsHide`，`cmd /c` 与 `pip.exe`/`docling.exe` 这类 launcher 还会再 spawn python 孙进程。修复：Windows 上关掉 `detached`（tree-kill 走 `taskkill /T`，不需要 detached），并把长任务改成解释器直跑、进程内执行——docling 用 `python -m pip` + `python -c` 调 docling 入口（in-process，无孙进程）——长下载阶段全程无窗。macOS/Linux 无控制台窗口概念，不受影响。
7. **docling 报「未生成 docling 可执行文件」但 venv 里其实装好了（Windows 专属）**：安装后校验曾写死无扩展名的 `docling`，匹配不到 pip 生成的 `docling.exe`，于是成功的安装被判失败（macOS 二进制本就无扩展名，不受影响）。已改用平台正确名校验，且与检测共用同一判定。若你撞上过：venv 里 docling 已装好，重启 daemon 即显示 installed，不必重下；想重测预下载流程才需删 venv。

## 相关代码

- daemon：`apps/daemon/src/core/preload-manager.ts`（检查 + 下载 + 状态机）
- daemon 路由：`apps/daemon/src/routes/preload.ts`（`GET /api/preload/status`、`POST /api/preload/start` 等）
- daemon PATH 注入：`apps/daemon/src/core/runtimes/env.ts` 的 `augmentPath`（把 `~/.molio/venv/bin` 加到 agent PATH）
- web：`apps/web/src/components/PreloadToast.tsx`（右下角 toast + 最小化/展开交互）
