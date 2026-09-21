---
version: alpha
name: Molio Landing Page
description: 墨与纸的品牌视觉，落到首页上是一张会被内容撑满的纸色画布。
colors:
  primary: "#0D0D0D"
  ink-80: "#1A1A1A"
  ink-60: "#404040"
  ink-40: "#666666"
  ink-20: "#A0A0A0"
  paper: "#F5F0E8"
  paper-2: "#EDE6D8"
  paper-3: "#E4DBCB"
  tertiary: "#C41E24"
  tertiary-dark: "#8B1519"
  hair: "#D8D0C2"
  rule: "#C8BFB0"
  on-dark: "#F5F0E8"
  on-dark-muted: "#A0A0A0"
typography:
  display-2xl:
    fontFamily: Noto Serif SC
    fontSize: 78px
    fontWeight: 900
    lineHeight: 1.08
    letterSpacing: -0.02em
  display-xl:
    fontFamily: Noto Serif SC
    fontSize: 56px
    fontWeight: 700
    lineHeight: 1.16
    letterSpacing: -0.02em
  display-lg:
    fontFamily: Noto Serif SC
    fontSize: 38px
    fontWeight: 700
    lineHeight: 1.2
  body-lg:
    fontFamily: Source Serif 4
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.8
  body-md:
    fontFamily: system-ui
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.7
  body-sm:
    fontFamily: system-ui
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.7
  label-md:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0.14em
  label-sm:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: 0.08em
spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  section: 96px
  hero-block: 72px
rounded:
  none: 0px
  sm: 3px
  md: 4px
  lg: 6px
  full: 9999px
components:
  button-primary:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.on-dark}"
    rounded: "{rounded.sm}"
    height: 50px
    padding: 16px
  button-primary-hover:
    backgroundColor: "{colors.tertiary-dark}"
    textColor: "{colors.on-dark}"
    rounded: "{rounded.sm}"
  button-ink:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-dark}"
    rounded: "{rounded.sm}"
    height: 50px
    padding: 16px
  button-ghost-light:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-60}"
    rounded: "{rounded.sm}"
    height: 50px
    padding: 16px
  card-surface:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.primary}"
    rounded: "{rounded.md}"
    padding: 24px
  card-meta:
    backgroundColor: "{colors.paper-3}"
    textColor: "{colors.ink-60}"
    rounded: "{rounded.md}"
  chip-light:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink-60}"
    rounded: "{rounded.full}"
    height: 28px
    padding: 10px
  chip-dark:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-dark-muted}"
    rounded: "{rounded.full}"
    height: 28px
    padding: 10px
  divider-light:
    backgroundColor: "{colors.hair}"
    rounded: "{rounded.none}"
  divider-ink:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.ink-20}"
    rounded: "{rounded.none}"
  hero-surface:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.primary}"
    rounded: "{rounded.none}"
  hero-surface-soft:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink-40}"
    rounded: "{rounded.none}"
  section-surface:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink-60}"
    rounded: "{rounded.none}"
  section-body:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-40}"
    rounded: "{rounded.none}"
  section-body-inset:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink-40}"
    rounded: "{rounded.none}"
  ink-band:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-dark}"
    rounded: "{rounded.none}"
  rule-line:
    backgroundColor: "{colors.rule}"
    textColor: "{colors.ink-60}"
    rounded: "{rounded.none}"
  hero-graph-edge:
    backgroundColor: "{colors.ink-60}"
    rounded: "{rounded.none}"
  hero-graph-edge-live:
    backgroundColor: "{colors.tertiary}"
    rounded: "{rounded.none}"
  hero-world:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-40}"
    rounded: "{rounded.none}"
  hero-veil:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.none}"
  download-btn-primary:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.paper}"
    rounded: "{rounded.sm}"
  download-btn-ink:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.paper}"
    rounded: "{rounded.sm}"
  footer-surface:
    backgroundColor: "{colors.ink-80}"
    textColor: "{colors.on-dark-muted}"
    rounded: "{rounded.none}"
---

## Overview

Molio 首页是一张关于墨与纸的技术白皮书封面，同时承担售卖「整理好的领域知识底座」的商业转化任务。它必须同时做到两件相反的事：让不看技术细节的普通用户 5 秒内明白产品价值，又让开发者确认这是一套可以接入 Agent 的本地知识系统。

**整体是亮色的。** 默认基底是暖纸色，墨色只在需要强调技术纵深与品牌重量时出现，而且出现得克制——它属于页脚、一条强调带，或者某个单独的技术区块，而不是整个首屏。首屏是一张被内容撑满的纸，而不是一块深色幕布。

排版像一份装订过的研究报告：结构清楚、允许留白、内容跟随视口铺开，绝不被挤进屏幕中央一条窄柱里。印章红仍然是唯一的强调色，只出现在最重要的那个动作上。

## Colors

一套「纸为主、墨为辅、印章红点睛」的系统。

- **Paper** {colors.paper} 是首页的默认底色，也是首屏底色。它是一张暖白纸，不是纯白，也不是深色。所有首屏文字、按钮、卡片都建立在这张纸之上。
- **Paper 2** {colors.paper-2} 用于次级区块底色，让相邻章节之间有层次而不需要边框或阴影。
- **Paper 3** {colors.paper-3} 只用于需要再深一层的纸色分区，例如卡片内部或需要与纸 2 分开的区块。
- **Primary** {colors.primary} 是墨色。它不再作为首屏底色，而是用于文字、边框与少量强调带（ink band）。墨色文字对纸底是 17.13:1。
- **Ink 80** {colors.ink-80} 只用于页脚这种需要明确“结束”的深色区块，保持站点的段落感。
- **Ink 60** {colors.ink-60} 用于浅底上的标签、次级链接与卡片标题，对纸底 9.14:1。
- **Ink 40** {colors.ink-40} 是浅底上的正文与说明文字，取 #666666：对纸底 5.06:1、对纸 2 底 4.62:1、对白底 5.74:1，全部满足 WCAG AA。
- **Ink 20** {colors.ink-20} 只用于墨色底上的次要文字，对墨底 7.43:1。
- **Tertiary** {colors.tertiary} 是「印章红」。它是唯一的强调色，只出现在主 CTA、关键数字、资源库入口与数据流线路上。**它绝不出现在正文标题、正文强调或普通图标上。**
- **Tertiary Dark** {colors.tertiary-dark} 只用于印章红控件的 hover 态。
- **Hair** {colors.hair} 是浅底上的分隔线。
- **Rule** {colors.rule} 是稍重的分隔线，用于卡片边界与需要更明确分段的浅底区块。
- **On-dark** {colors.on-dark} 与 **On-dark-muted** {colors.on-dark-muted} 只在墨色区块内部使用，不允许溢出到纸色区块。

## Typography

排版策略是「中文用宋、英文与数据用 Fraunces、元数据用等宽」。

- **Display 2XL** {typography.display-2xl} 用于首屏主标题，只在首屏使用一次。它在宽屏上必须能排成 2–3 行；超过 3 行说明容器宽度错了。
- **Display XL** {typography.display-xl} 用于章节标题。
- **Display LG** {typography.display-lg} 用于卡片标题与流程节点。
- **Body MD** {typography.body-md} 是正文与副标题，单行长度控制在 30–38 个中文字符。
- **Label MD / SM** {typography.label-md} {typography.label-sm} 只用于元数据、文件名、版本号与数据流标签，不用于正文段落。

字重只允许 400 与 700/900。不要让标题与正文在同一个视觉重量上竞争。

## Layout

**核心规则：宽屏铺满，内容收窄。** 屏幕越宽，画布越应被内容使用，而不是把内容锁进固定宽度的居中容器。

- **首屏容器**：`max-width: none`，左右内边距 `clamp(24px, 4vw, 96px)`。在 2560px 屏幕上内容必须横跨大部分屏宽。
- **首屏网格**：文字列与数据流列按比例分配，宽屏时文字列约占 52%。数据流必须完整显示 {typography.label-sm} 尺寸下的 `Claude Code`、`WorkBuddy`、`豆包工作`。
- **首屏构图（三层叠在同一画布）**：
  1. **背景层 · 知识加工流程世界**：整屏底图是一张加工流程图 —— 左：资料来源页片（PDF / 网页 / Word / 笔记 / 书籍）收拢；中：**加工舱**（虚线框 + 四角刻度），舱里坐着真实的《资治通鉴》图谱，即「结构化图谱」本体；右：Agent 端点（Claude Code / Codex / WorkBuddy / 豆包工作 / Molio AI）分发。三站用等宽标注 `01 导入 / 02 加工 / 03 调用` 讲清流程。整体 slice 铺满、**不加框、不模糊**；径向遮罩把中央压到约 8% 对比、四周渐清到约 25%，加工舱内的真图谱比管线家具强一档（`.wf-core`）。叠加 90s 极慢漂移 + 行进虚线，制造「知识在生长」的感觉。
  2. **纸色柔光**：中央一层径向纸色渐变（veil），把世界再推远一点，托住文字。
  3. **前景 · 居中栈**：顶部导轨（眉标 + 信任标签）；中央 Slogan「把过去的积累，变成今天的生产力」/ 说明 / 两个按钮 / 演示小字，居中排布，是整屏唯一的高对比区域。两个按钮是 **下载 Molio**（{components.button-primary}，锚到下载屏）与 **获取领域知识**（{components.button-ink}，直接跳资源页 resources.html）。
- **首屏图谱**：必须是真图，不是示意图，且**只以背景层出现** —— 作为加工舱里的产物（结构化图谱本体），绝不加框做成产品截图。节点按领域聚类（《资治通鉴》按战国 / 秦汉 / 魏晋 / 隋唐 / 制度分簇），节点大小体现权重。两种版式：桌面横版（约 2000×600）、竖屏竖版（约 900×1500）；竖屏时流程改由两行整句标注（01 导入 · 来源清单 / 03 调用 · Agent 清单）讲述，不画页片列。
- **首屏垂直**：`min-height: 100svh`；CTA 必须在首屏内可见（390px 实测）。
- **流程解释下移**：01 导入 → 02 加工 → 03 调用 → 04 回流 放在演示屏讲；现成知识底座独立成资源屏；首屏只承担「价值 + 转化」，不堆功能。
- **下载入口收敛**：首屏的下载按钮**只锚到下载屏**（`#download`），不直接挂任何平台的安装包；Windows / macOS 的选择只在下载屏完成。首屏第二动作是「获取领域知识」（锚到资源屏）。不要在页尾再加第三块 CTA 卡片。
- **内容列**：首屏之外的阅读区容器保持 1440px 居中。
- **墨色带**：深色只能以「整条带」的形式出现，宽度铺满，用于页脚、强调带或单个技术区块；不允许把半屏做成深色、半屏做成纸色。
- **移动端**：单列，先文字后数据流，CTA 必须在首屏内可见。

## Elevation & Depth

深度来自**纸的层次与线条**，而不是深色背景或大阴影。

- 首屏使用纸色基底 + 极淡的径向渐变，制造“有光落在纸上”的层次，而不是“暗房”感。
- 墨色只通过线条、文字、描边和 1px 分隔参与画面。
- 背景世界的对比度由「整体不透明度 × 径向遮罩」控制（中央约 8%、四周约 25%），**不用模糊、不用深色底**；印章红留给图谱主线——它是首屏唯一的发光元素。
- 卡片使用 1px 描边 + 极轻投影，保持纸的平面感。

## Shapes

- 主要容器、按钮、卡片使用 {rounded.sm}–{rounded.md} 的 3–4px 圆角。
- 只有芯片与信任标签使用 {rounded.full}。
- 首屏的单一焦点是 **Slogan**；图谱退为背景世界，属于第二眼。
- 不使用 8px 以上的大圆角，不使用卡片套卡片，不使用玻璃拟态。

## Components

- **Button Primary** {components.button-primary}：印章红实底、纸色文字、3px 圆角、50px 高。每个屏幕上只允许一个。
- **Button Ink** {components.button-ink}：墨色实底、纸色文字，用于与 primary 并排的第二个动作，不能比 primary 更亮。
- **Button Ghost Light** {components.button-ghost-light}：纸色底、墨色描边、次级动作（例如「看演示视频」）。
- **Button Download Ink** {components.button-ink}：墨色实底、纸色文字，用于与主按钮并排的第二个平台。Download 区里 Windows 走 {components.button-primary}，macOS 走墨色——一屏只允许一个印章红实底按钮。
- **Hero Graph**：首屏中景的真图谱。节点为墨色实心圆（fill-opacity 0.30–0.88，随权重），连边为墨色 1px（stroke-opacity 0.15–0.21），关键节点标签用 {typography.display-lg} 级别的衬线中文、墨色 0.72 不透明度。主线为 {colors.tertiary}，带一段沿路径行进的脉冲；`prefers-reduced-motion` 下退化为静态淡红。
- **Hero World（背景层）**：铺满首屏的加工流程世界（来源页片 → 加工舱 + 真图谱 → Agent 端点）。对比度 = 整体不透明度 0.58 × 径向遮罩（中央 0.14 → 四周 0.55）；舱内真图谱经 `.wf-core` 提升一档。90s 极慢漂移 + 行进虚线；`prefers-reduced-motion` 下静止。
- **Hero Veil（中央柔光）**：径向纸色渐变（0.94 → 0），只负责把世界推远、把 Slogan 托出来，不产生任何边框或卡片感。
- **Chip** {components.chip-light} {components.chip-dark}：文字必须完整可读，绝不截断。空间不足时改变列数或换行，而不是 ellipsis。
- **Card Surface** {components.card-surface}：纸色底、24px 内边距、4px 圆角，同一区块内等高。

## Do's and Don'ts

- **Do** 让首屏是一张亮色纸，字是墨色，印章红只用于主 CTA。
- **Do** 让首屏画布铺满屏幕，内容跟随视口宽度扩展。
- **Do** 保证每个 Agent 名称、每个 chip 文本完整可读。
- **Do** 把墨色限制在整条带或页脚这类明确的区块里。
- **Don't** 把首屏做成大面积深色背景。
- **Don't** 用 `max-width: 1440px` + `margin: auto` 把首屏锁进居中窄柱。
- **Don't** 用 `overflow: hidden` + `white-space: nowrap` 截断芯片文本。
- **Don't** 在 2560px 屏幕上让内容只占中间 1/3。
- **Don't** 在纸色区块里使用墨色区块专用的 On-dark 文字色。
- **Don't** 让主标题在宽屏上超过 3 行。
- **Don't** 用印章红做装饰——标题下的横线、正文左侧的竖线、步骤序号 `01/02/03`、普通图标，全部用墨色。红只在主 CTA、资源库入口和两条数据流连线上出现。红用得越多，越没有一处是重点。
- **Don't** 用 `flex: 0 0 100%` 配 `max-width` 来实现「独占一行」——宽视口下会失效，而窄视口下看起来完全正常。
- **Don't** 在纸上放白点或纸色的连线（`rgba(245,240,232,…)`）——它们只在墨底上成立，换到纸底就等于消失。
- **Don't** 把图谱模糊成抽象粒子 / 神经网络背景 —— 它的价值恰恰是「真实构建出来的知识网络」，模糊掉就掉进 AI-slop。
- **Don't** 给图谱加框、加边框或做成居中矩形 —— 那会让它读作产品截图；它应该从屏幕四边进入。
- **Don't** 在首屏直接挂具体平台的安装包链接 —— 首屏的下载按钮只负责把人送到下载屏，平台选择在那里做。
- **Do** 让 Slogan 成为首屏唯一的高对比元素；世界再真实，也只是第二眼。
- **Don't** 给标题用渐变文字（`-webkit-text-fill-color: transparent` + `background-clip: text`）——亮色下几乎看不出差别，却会在裁剪失效时让整行标题变透明。
