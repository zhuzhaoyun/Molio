# 外部链接改为系统浏览器打开 — 设计说明

日期：2026-09-29（最后修订：2026-11-22）

## 问题

知识库 / 聊天渲染出的 markdown 里是普通的 `<a href="https://…">`（无
`target="_blank"`）。在 Electron 桌面端点击后，整个应用窗口被原地导航到
外部网站，Molio 界面被替换掉，知识库无法继续操作。

## 怎么复现（修复前）

1. 用桌面端：`pnpm dev:desktop`（或已安装的 Molio）。
2. 知识库里建一篇含外链的笔记，例如正文写：
   `[ Anthropic 官网 ](https://www.anthropic.com)`，保存并打开这篇笔记。
3. 点击渲染出来的链接。

**预期 bug 现象**：整个 Molio 窗口原地跳转到 anthropic.com，知识库、
导航栏全部消失；Alt+← 也回不到应用状态（SPA 状态已丢），只能重启应用。
在纯浏览器（`pnpm dev` 开 http://localhost:5173）里点同样的链接，则是
当前标签页被跳走、回退后聊天/KB 状态丢失。

## 修复（两层）

### Web 层（主修复，浏览器与桌面端同效）

`apps/web/src/utils/externalLinks.ts` 提供：

- `isExternalHttpUrl(href, currentOrigin)`：纯函数，仅当 URL 可解析、协议为
  http/https、且 origin 与当前页面不同才判为外部链接（同源、相对、锚点与
  mailto/tel/molio:// 等协议不走这个处理器，浏览器按默认行为处理）。
- `installExternalLinkHandler()`：在 document 上挂委托 click 监听，命中
  外部 `<a href>` 时 `preventDefault()` + `window.open(url, '_blank',
  'noopener')`。

`App.tsx` 根部 useEffect 挂载一次。效果：

- 普通浏览器 / Web 部署：新标签页打开，当前页状态不丢。
- Electron 壳：window.open 走已有的 `setWindowOpenHandler` →
  `shell.openExternal` → 用户系统浏览器。

### Desktop 层（兜底）

`apps/desktop/src/main.js` 在 `setWindowOpenHandler` 旁新增
`will-navigate` 监听，判定逻辑抽在 `apps/desktop/src/navigation-policy.js`
（纯函数，便于单测）：拦截一切 web 层没拦到的原地导航（如程序化的
`location.assign`）。应用 origin（生产 = daemon origin，dev = vite :5173）
与 file:（错误页）原地导航；http(s) 交给系统浏览器，mailto/tel 交给系统
邮件客户端 / 电话应用；`javascript:`、`data:`、`molio://` 等其余协议只
`preventDefault()`，不交给 OS。

## 修改后怎么验证

### 手工验证（桌面端，核心场景）

1. `pnpm dev:desktop` 启动桌面端。
2. 打开上面那篇含外链的笔记，点击链接。
3. **修好标志**：系统默认浏览器弹出并打开目标网站；Molio 窗口停在原地，
   知识库、聊天、图谱都能继续正常操作。
4. 回归对照：点笔记里的 wikilink（`[[另一篇]]`）应仍在 KB 内正常跳转；
   「发布」流程打开的 COSE 桥接页也仍应在系统浏览器打开（原有行为不变）。
5. 协议对照：正文里的 `[发邮件](mailto:test@example.com)` 点击后由系统
   邮件客户端接管；`[坏链接](javascript:alert(1))` 点了无反应且窗口不导航。

### 手工验证（浏览器）

`pnpm dev` 后开 http://localhost:5173，点同一链接 → 新开标签页，
Molio 标签页不动。

### 自动化

- `apps/web/e2e/external-links.spec.ts`（P0）：点击 KB 外链 → 断言弹出
  新页面（Playwright popup）且当前页停留 /knowledge；同源相对链接不弹新
  页面。跨源目标是 spec 内临时起的本地 HTTP 服务，不依赖外网。这条证明
  web 层不再原地导航；Electron 的 `setWindowOpenHandler` → 系统浏览器
  这一段目前只有 `window-open-handler.test.js` 的结构断言 + 手工验证，
  没有行为级自动化（要断言 `shell.openExternal` 得先在壳里做依赖注入）。
- `apps/web/src/utils/externalLinks.test.ts`：跨源/同源/相对/锚点/非 http
  协议/非法输入的分类单测。
- `apps/desktop/test/will-navigate-handler.test.js`：直接喂 URL 断言
  `decideNavigation` 的分类（外链 / 应用 origin / file: / mailto / tel /
  javascript: / data: / molio:// / 非法输入）与 `shouldClearReadiness`
  的清空条件，另有两项接线检查（will-navigate 先 `preventDefault()` 再外发；
  did-start-navigation 先判定再清 readiness）。
- `apps/web/src/utils/externalLinks.test.ts` 另覆盖 `shouldHandleExternalClick`
  （修饰键 / 非左键点击不接管）。

## 注意

- `will-navigate` 不拦截 `loadURL`（molio:// 协议唤起、初始加载不受影响），
  也不拦截 SPA 的 pushState。
- **被取消的导航不清 renderer readiness**。Electron 的事件顺序是
  `did-start-navigation` → `will-navigate`，后者 `preventDefault()` 后前者
  并无回滚。若在 `did-start-navigation` 里就清掉就绪标志，取消后的窗口既
  没有 `did-navigate` 也没有路由变化，标志永远恢复不了——之后每次
  `molio://` 剪藏都会退化成整页重载、打断流式输出。所以只有会被放行的
  主框架跨文档导航（应用 origin / file:）才清（`shouldClearReadiness`）。
- 带 Ctrl/Cmd/Shift 的点击、中键点击保持浏览器原生语义（后台新标签 / 新
  窗口），不强制改成前台新标签。
- KB 内链（wikilink）渲染为无 href 的 `<a class="kb-wiki-link">`，不经过该
  处理器，行为不变。
