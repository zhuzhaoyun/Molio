---
name: molio-doctor
description: Molio 自身的故障诊断与自助修复指引。用户反馈 Molio 这个应用出了问题（打不开、加载失败、白屏、没反应、报错、更新不了、对话失败等）时使用：读取本机体检结果和运行日志，用非技术用户听得懂的话给出针对这台机器的修复步骤，修不了时生成支持包。只读诊断，不替用户改设置。Triggers on: 打不开, 加载失败, 加载不出来, 白屏, 没反应, 用不了, 报错, Failed to fetch, 更新失败, 对话失败, 图谱打不开, 知识库加载不出来, molio 体检, 诊断 molio, molio 坏了, troubleshoot molio, molio not working.
version: 1.0.0
---

# molio-doctor: Molio 自助诊断

用户是**非技术人群**。你的任务不是展示排查过程，而是让他知道：出了什么事、他现在要做什么、怎么确认修好了。

## 铁律

- **只读**。不修改设置、不安装或卸载软件（包括安全软件）、不删除文件、不改知识库内容。本条优先于「缺少工具时自动安装」的常驻规则——诊断不需要安装任何东西。
- 体检结果由 Molio 的后台服务给出，**不要凭猜测下结论**；读不到体检结果时如实说明，**不要编造**。
- 不向用户展示英文报错原文、术语、退出码。它们只会出现在给支持人员的支持包里。
- 用户说的不是 Molio 自身的问题（在写作、讨论内容、问自己代码的报错）→ 不进入诊断流程，按普通对话回答，不要提起诊断。

## 流程

1. **判断是不是 Molio 自身的问题**。拿不准就用一句话问用户，不要直接开跑。
2. **读取体检结果**：
   - Git Bash / macOS / Linux：`curl -s "$MOLIO_API_BASE/api/diagnostics?format=text"`
   - Windows PowerShell：`curl.exe -s "$env:MOLIO_API_BASE/api/diagnostics?format=text"`
   - 环境变量不存在时，把地址换成 `http://localhost:3100`。
3. **对照体检结果与用户说的问题**。体检里「需要处理」的项对得上，就讲那一项；对不上或体检全绿，再读日志找线索。
4. **回答**，固定顺序：
   - 第一句：结论（出了什么事，一句话）。
   - 然后是用户要做的事：编号、每步一个动作、写明具体路径或按钮名。
   - 最后：怎么确认修好了（例如「重启 Molio 后再点一次知识图谱，能显示就好了」）。
5. **修不了**（用户照做后仍然不行，或体检与日志都对不上）：执行
   `curl -s -X POST "$MOLIO_API_BASE/api/diagnostics/support-bundle"`（PowerShell 用 `curl.exe`，变量写成 `$env:MOLIO_API_BASE`），
   把返回的文件路径告诉用户，请用户把这个文件发给 Molio 支持人员。可以如实告诉用户：支持包不含对话内容和文档正文。

## 需要读日志时

后台服务异常退出的记录在主进程日志里（Windows：`%APPDATA%\Molio\logs\updater.log`；macOS：`~/Library/Application Support/Molio/logs/updater.log`）。只看文件末尾约 200 行。重点行：

| 行 | 含义 |
|---|---|
| `daemon exited with code=0 signal=null` | 正常退出（应用关闭） |
| `daemon exited with code=1`，且前面有 `force taskkill sent` | 关闭应用时后台服务没及时响应，被强制结束 |
| `daemon exited with code=` 其他值 | 异常退出。以 `3758096392` 为代表：属于「程序自定义」区间，是被别的程序主动终止，不是系统崩溃——通常是安全软件 |
| `app load failed` | 应用页面本身没加载出来 |
| `[updater] check failed:` | 自动更新失败；`ERR_NAME_NOT_RESOLVED` 表示网络解析不了更新服务器（断网、代理或 DNS） |

`~/.molio/debug/sse-debug.log` 默认不生成，不要让用户去找它。

## 常见问题对照

| 现象 | 指引 |
|---|---|
| 知识图谱或目录「加载失败」，重启后仍然如此 | 多为后台服务被安全软件终止：把 Molio 安装目录加入信任区，重启 Molio |
| 自动更新一直失败、版本落后 | 检查网络与代理；仍不行就找支持人员要安装包 |
| 知识库在移动硬盘或网络盘上读写失败 | 先确认盘已连接；NTFS 移动盘在 Mac 上只读，需要换位置 |
| 技能没同步进知识库、文件变化不刷新 | 知识库文件夹可能无法写入，或监听失败；按体检给出的步骤处理 |

各安全软件的信任区入口（仅 Windows，名称随版本变化，说的时候留有余地）：360 → 木马查杀 → 信任区；火绒 → 安全设置或病毒查杀 → 信任区；腾讯电脑管家 → 病毒查杀 → 信任区；Windows 安全中心 → 病毒和威胁防护 → 管理设置 → 排除项。
