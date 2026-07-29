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

## ⚠️ docling 可能装在两个不同位置（测试同事的"路径不一样"）

docling 有**两个合法安装位置**，取决于谁装的。这是设计取舍，不是 bug，但清理时要删对地方：

| 谁装的 | 装在哪 | 怎么来的 |
|--------|--------|---------|
| **预下载**（PreloadManager） | `~/.molio/venv/bin/docling`（隔离 venv） | 本功能的后台预下载 |
| **手动 / agent 自愈**（按 SKILL.md 的 `pip install docling`） | 全局或用户 Python，如 `~/.local/bin/docling` + 用户 site-packages；或 homebrew/系统 python 的 Scripts | 用户或 agent 在首次用到 docling 时按 SKILL.md 指令自行安装 |

两者**都被 agent 认可**：daemon 的 `augmentPath` 把 `~/.molio/venv/bin` 和 `~/.local/bin` 都加进 agent 的 PATH，`detectInstalled` 先查 venv 再查 PATH。所以全局装的 docling 照样能用，预下载也会识别成「已安装」不再重复装 venv。

**怎么判断 docling 实际装在哪**：

```bash
# macOS/Linux
which -a docling          # 列出 PATH 上所有 docling
pip show docling          # 看装在哪个 site-packages
ls ~/.molio/venv/bin/docling 2>/dev/null   # venv 里有没有
# Windows (PowerShell)
where.exe docling
```

**全局安装的清理**（如果要清掉同事/手动装的全局 docling 来重测）：

```bash
pip uninstall docling           # 或 pip3 / 对应的 python -m pip
# 注意别误删 venv 里的：venv 的要用 ~/.molio/venv/bin/pip uninstall docling
```

## ⚠️ docling 预下载前提：Python ≥3.10

docling 要求 **Python ≥3.10**。预下载会自动寻找 3.10+ 的解释器（版本名 `python3.12` 等、Homebrew 路径、`uv` 托管的 python）来建 venv。如果本机只有 3.9（老 macOS 常见），预下载会**直接报清晰错误**（不再像早期那样撞 pyobjc 编译失败给哑巴错）。这种情况需先装 3.10+：

- macOS：`brew install python@3.12`（推荐，无需 sudo）或 python.org 安装包
- Windows：python.org 安装包 / `winget install Python.Python.3.12`
- Linux：`sudo apt install python3.12 python3.12-venv` 等

> 注意：`brew install python@3.x` **不会**把无版本的 `python3` 软链放到 PATH 上（只在 `$(brew --prefix)/opt/python@3.x/libexec/bin`），所以 PATH 上的 `python3` 可能仍是 3.9——预下载是按**版本号**找 `python3.12` 的，不受影响。

## ⚠️ remotion 没有"全局安装路径"这个概念

remotion 是**每个项目各自的依赖**：agent 在 vault 里 `.molio/remotion/<项目>/node_modules` 安装。预下载**不装 remotion 本身**，只把它的 npm 包灌进共享缓存 `~/.npm/` 并写标记 `~/.molio/.remotion-preloaded`。所以「同事看到的 remotion 路径」是他 vault 里那个项目的 `node_modules`，跟预下载的 marker/缓存本来就不是一个东西，**无需也无法对齐**。重测 remotion 只需删 marker（见下表）；要连 npm 缓存一起冷测才用 `npm cache clean --force`（影响全局，谨慎）。

## 🔍 先定位，再卸载（跨平台，兼容旧/全局地址）

docling 可能装在**两个地方**（venv 或全局），remotion 的「安装」又分**三种东西**（marker / npm 缓存 / 项目 node_modules）。**别假设路径**——先问系统「它到底在哪」，再删对应的那个。这也覆盖了「用旧版本/SKILL.md/手动 pip 装到全局」的历史安装。

**docling 实际位置**（任一命中即「已安装」）：

```bash
# macOS / Linux
which -a docling                 # PATH 上所有 docling（含 venv 与全局）
ls -la ~/.molio/venv/bin/docling # 预下载的 venv 副本
pip show docling                 # 看装在哪个 site-packages（全局/用户/conda）
# Windows (PowerShell / CMD)
where.exe docling                # PATHEXT 解析出 docling.exe 的所有位置
dir %USERPROFILE%\.molio\venv\Scripts\docling.exe
pip show docling
```

> 全局 docling 的常见落点（`pip show` 的 Location 对应的 Scripts 目录）：
> - macOS/Linux 用户级：`~/.local/bin/docling`
> - **Windows 用户级**：`%APPDATA%\Python\Python3xx\Scripts\docling.exe`（**不是** `~/.local/bin`！）
> - **Windows 安装目录**：`%LOCALAPPDATA%\Programs\Python\Python3xx\Scripts\docling.exe`
> - conda：当前环境的 `<env>/bin` 或 `<env>\Scripts`（环境未激活时不在 PATH）
>
> daemon 的 `GET /api/preload/status` 现在会**直接返回每个工具的真实路径**（`statuses.<skill>.path`），web toast 也会显示「已装在 X」——所以不用猜，看 UI/接口即可。

**remotion 实际「安装」在哪**：marker = `~/.molio/.remotion-preloaded`；npm 缓存 = `~/.npm`；项目 = `<vault>/.molio/remotion/<项目>/node_modules`。三者性质不同，按需删（见下）。

## 快速清理 / 重测（一键脚本，跨平台）

> ⚠️ **测试端复现的关键陷阱**：点过「不再提示」会写 `~/.molio/config.json` 的 `preload.dismissed`，**它在你删 venv/marker 之后仍然压着 toast**——清产物却不清 dismissed，重启后 toast 永不出现，你会以为「功能坏了」。所以下面脚本**同时清 dismissed**，缺一不可。

**macOS / Linux**

```bash
# 1. docling：venv + HF 模型（只删 docling-project 的，不动其他模型）
rm -rf ~/.molio/venv
rm -rf ~/.cache/huggingface/hub/models--docling-project--*
# 2. 若 docling 还装在全局/用户级（旧版本/手动 pip 装的），一并卸（按 pip show 的 Location 选）
pip uninstall -y docling            # 系统/用户 python
# ~/.local/bin 残留脚本（如有）：rm -f ~/.local/bin/docling
# 3. remotion 标记
rm -f ~/.molio/.remotion-preloaded
# 4. ⚠️ 清「不再提示」，否则 toast 不会重弹（用 jq 安全删除该字段；无 jq 见下注）
jq 'del(.preload.dismissed)' ~/.molio/config.json > /tmp/c.json && mv /tmp/c.json ~/.molio/config.json
```

> 无 `jq` 时：用编辑器打开 `~/.molio/config.json`，删掉 `"preload": { "dismissed": [...] }` 整段（注意逗号）。

**Windows (PowerShell)**

```powershell
# 1. docling venv + HF 模型
Remove-Item -Recurse -Force $env:USERPROFILE\.molio\venv
Get-ChildItem $env:USERPROFILE\.cache\huggingface\hub -Filter "models--docling-project--*" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
# 2. 全局/用户级 docling（按 pip show 的 Location；用户级常见 %APPDATA%\Python\Python3xx\Scripts）
pip uninstall -y docling
# 3. remotion 标记
Remove-Item -Force $env:USERPROFILE\.molio\.remotion-preloaded -ErrorAction SilentlyContinue
# 4. ⚠️ 清「不再提示」（无 jq：用编辑器删 config.json 里 "preload":{ "dismissed":[...] } 整段）
```

## 验证清理干净

```bash
# macOS/Linux：以下都应输出「不存在 / ✓」
ls -d ~/.molio/venv 2>/dev/null && echo "⚠ venv 还在" || echo "✓ venv 已清"
ls ~/.cache/huggingface/hub/models--docling-project--* 2>/dev/null && echo "⚠ 模型还在" || echo "✓ docling 模型已清"
which docling 2>/dev/null && echo "⚠ PATH 上还有 docling（全局未卸）" || echo "✓ 无全局 docling"
ls ~/.molio/.remotion-preloaded 2>/dev/null && echo "⚠ marker 还在" || echo "✓ marker 已清"
grep -q '"dismissed"' ~/.molio/config.json 2>/dev/null && echo "⚠ config 仍有 dismissed（toast 不会重弹！）" || echo "✓ 无 dismissed"
```

全绿后，**重启** `pnpm dev`（`checkSkills()` 只在启动跑一次），daemon 会判定 docling + remotion 都为 `missing`，右下角弹 toast。

## 关于 npm 缓存（remotion）

remotion 预下载只是把 npm 包灌进 `~/.npm` 共享缓存，**不建独立项目**。所以：

- 即使删了 `~/.molio/.remotion-preloaded` 标记，remotion 的 npm 包**可能还在 `~/.npm` 缓存里**——下次预下载会很快（命中缓存），这属于正常，不代表功能有问题。
- 想**冷测** remotion（强制重新下载）：`npm cache clean --force`。⚠️ 这会清空整个 npm 缓存，**会让后续 `pnpm install` / `pnpm dev` 变慢**，谨慎使用，测完不必恢复。

## 各产物说明

### `~/.molio/venv/`（docling 专用 Python 环境）

PreloadManager 用 `python -m venv` 创建的隔离环境，docling + PyTorch 等都装在里面。好处：不污染系统 Python、绕开 PEP 668、CLI 路径固定（`~/.molio/venv/bin/docling`），daemon spawn agent 时会自动把这个目录加到 PATH（见 `apps/daemon/src/core/runtimes/env.ts` 的 `augmentPath`）。

- 成功装完：约 1.5–2 GB（PyTorch 占大头）
- 只建了 venv 没装 docling：约 9 MB（空壳，说明 `pip install` 失败/超时）

> ⚠️ toast 上的「停止」/「停止并清理预下载」**只删这个 venv + docling 的 HF 模型 + remotion marker**，**绝不会动全局/用户级/conda 里手动或旧版本装的 docling**（乱删用户全局包是危险的）。所以全局 docling 要靠上面的 `pip uninstall docling` 卸。

### `~/.cache/huggingface/`（docling AI 模型）

docling 首次转换 PDF 时下载的 layout + table 模型，约 500 MB。目录结构：
- `hub/models--docling-project--docling-layout-heron/`（layout，~164M）
- `hub/models--docling-project--docling-models/`（table，~342M）

预下载的「模型预热」阶段（跑一次空 PDF）会主动触发这两个下载，让用户首次真正转换时不用等。⚠️ 这个目录是**共享**的——如果机器上还有别的 HuggingFace 工具（transformers 等），删的时候**只删 `models--docling-project--*`**，别 `rm -rf ~/.cache/huggingface` 整个删。

> ⚠️ 装了 `hf-xet` 时，模型 blob 可能另存一份在 `~/.cache/huggingface/xet/`（全局内容寻址、跨模型共享）。**无法只删 docling 的那部分**——删 `hub/models--docling-project--*` 后这些 xet blob 会变成孤儿，仅占空间、不影响功能/复现，属 HuggingFace 的内在限制，可忽略或定期 `huggingface-cli scan-cache` 清理。

### `~/.molio/.remotion-preloaded`（remotion 标记文件）

PreloadManager 跑完 remotion npm 缓存预热后写的 marker 文件。`checkSkills()` 靠它判定 remotion 是否已预下载——存在就 `installed`（不弹窗），不存在就 `missing`（弹窗）。

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
3. **docling 装了但模型下不动**：国内访问 HuggingFace 默认源常超时。docling SKILL.md 建议设 `HF_ENDPOINT=https://hf-mirror.com`。当前 PreloadManager 的模型预热**还没**自动注入这个镜像环境变量（待改进）。
4. **路径含空格（Windows 用户名带空格等）失败**：已修复——python/pip/docling 调用现在走无 shell 的参数数组，不再因空格断命令。若仍异常，看 daemon 日志里的真实子进程退出码。
5. **看 daemon 日志**：`pnpm dev:daemon` 的终端会打印 `[PreloadManager]` 的进度消息和子进程退出码。
6. **remotion 报 `No matching version found for @remotion/xxx@4.0.y`（ETARGET）**：npm 源是镜像（如 npmmirror）且 remotion 刚发新版时会出现。remotion 每次联动发布约 20 个包，镜像对每个包**独立、按需同步**——常见主包（`@remotion/cli`）已同步、传递依赖（如 `@remotion/player`）还没同步，于是 `npm install` 报 ETARGET。预下载现在会**自动换源降级重试**：默认源（重试 2 次）→ 官方源 `registry.npmjs.org`（同步源头，版本永远齐全；国内慢但后台预下载可接受）→ npmmirror 兜底。进度消息里会出现「换下一个 npm 源」。若三个源全失败，错误信息会带步骤名 + 子进程输出尾部（不再是以前的空消息「进程退出码 1:」），按提示判断是网络还是版本问题。
   > 历史教训：旧版本用 `npm install --prefer-offline`，它让 npm 跳过缓存元数据的过期检查——如果恰好在镜像同步完成**前**缓存了缺版本的 packument，同步完成后仍会一直 ETARGET。现已移除该参数（在线模式照样按 integrity 复用已缓存的 tarball，暖缓存效果不变）。

## 相关代码

- daemon：`apps/daemon/src/core/preload-manager.ts`（检查 + 下载 + 状态机）
- daemon 路由：`apps/daemon/src/routes/preload.ts`（`GET /api/preload/status`、`POST /api/preload/start` 等）
- daemon PATH 注入：`apps/daemon/src/core/runtimes/env.ts` 的 `augmentPath`（把 `~/.molio/venv/bin` 加到 agent PATH）
- web：`apps/web/src/components/PreloadToast.tsx`（右下角 toast + 最小化/展开交互）
