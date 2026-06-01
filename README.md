# 知识增长引擎

AI-Native 知识管理与内容创作平台。基于本地知识库，与 AI Agent 协作写作，一键适配多平台排版，全渠道分发。

## 核心理念

```
知识库 (raw/ → wiki/)  ×  判断力 (人)  ×  AI Agent  =  知识增长引擎
```

- **人做策展**：决定写什么、强调什么、跳过什么
- **AI 做执行**：整理、分类、生成、排版
- **知识库做原料**：结构化的 Markdown vault，LLM 可维护

## 功能

### 知识管理 (LLM-Wiki 模式)

三层知识库架构：

| 层级 | 说明 | 维护者 |
|------|------|--------|
| `raw/` | 原始资料，不可变 | 用户导入 |
| `wiki/` | 结构化页面（概念/案例/草稿/文章） | LLM 维护 |
| `CLAUDE.md` | 操作规范与行为定义 | 人 + LLM 协作 |

### AI 协作写作

1. 从 wiki 知识库选择素材页面
2. 选择写作方法论（正确非共识写作法 / 案例拆解法 / 技术实战教程）
3. AI Agent 生成大纲 → 人工审核 → 生成全文
4. 在编辑器中通过对话式交互迭代修订

### 全平台分发

支持多平台格式适配：

| 平台 | 格式策略 |
|------|----------|
| 微信公众号 | CSS 内联样式 HTML |
| 知乎 | Markdown 导入 |
| 掘金 | Markdown 导入 |
| Twitter/X | 短文 / Thread |

配合 [doocs/cose](https://github.com/doocs/cose) Chrome 扩展可实现 30+ 平台自动发布。

## 快速开始

无需构建，直接打开：

```bash
# 浏览器直接打开
start index.html

# 或使用任意静态服务器
npx serve .
python -m http.server 8080
```

## 技术栈

- **前端**: Vanilla HTML/CSS/JS（零依赖，零构建）
- **排版引擎**: 基于 [doocs/md](https://github.com/doocs/md) 架构（计划集成）
  - `marked` + `highlight.js` + 自定义 CSS 主题系统
- **分发引擎**: 基于 [doocs/cose](https://github.com/doocs/cose) Chrome 扩展（计划集成）
- **AI Runtime**: Claude Code（本地协作）
- **UI 设计**: 参考 multica / open-design 的 AI-Native 交互范式

## 项目结构

```
knowledge-growth-engine/
├── index.html          # 主应用（自包含，CSS + JS + 数据内联）
├── src/                # 模块化架构（早期版本，未接入主应用）
│   ├── js/
│   │   ├── app.js              # 主控制器（中介者模式）
│   │   ├── wiki-browser.js     # 知识库浏览器
│   │   ├── editor.js           # Markdown 编辑器
│   │   ├── ai-panel.js         # AI 协作面板
│   │   ├── publish-panel.js    # 发布预览面板
│   │   └── mock-data.js        # 模拟数据
│   ├── css/
│   │   └── main.css            # 样式表
│   └── assets/
│       └── icons/
├── CLAUDE.md           # AI 开发指南
└── README.md
```

## 开发路线

- [ ] 集成 doocs/md 渲染引擎（替换手写 Markdown 渲染器）
- [ ] 集成 doocs/cose 扩展实现自动发布
- [ ] 接入真实 AI Runtime（替换 mock 模拟）
- [ ] 本地知识库文件系统读写（raw/ 导入、wiki/ 持久化）
- [ ] 知识库搜索与交叉引用图谱可视化
- [ ] 更多写作方法论模板

## License

MIT
