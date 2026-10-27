# 商品页结构化内容（MarketContent）

每个文件对应一个上架商品，文件名 = `market_listings.id`。内容会写入数据库 `market_listings.content`（JSONB），由 `apps/cloud/src/ssr/render.ts` 统一 SSR 渲染。

## 文件格式

```json
{
  "version": 1,
  "positioning": {
    "what": "这是什么（1-3 段，直接回答，不写营销口号）",
    "who": ["适合谁 1", "适合谁 2"],
    "notFor": ["不是什么 1", "不是什么 2"]
  },
  "facts": [
    { "label": "概念页", "value": "200 个" }
  ],
  "themes": [
    { "name": "主题名", "summary": "这个主题覆盖什么", "items": ["真实条目名"] }
  ],
  "questions": [
    { "question": "用户会问的问题", "answer": "直接结论 + 例子/对比", "source": "《对应知识页》" }
  ],
  "samples": [
    { "title": "样例标题", "body": "从知识库摘编的段落", "source": "《对应知识页》" }
  ],
  "delivery": {
    "format": "Markdown 本地知识库（.zip）",
    "includes": ["包含什么"],
    "requirements": ["使用要求"],
    "steps": ["使用步骤"]
  },
  "review": {
    "basis": "依据哪些资料整理；核对到什么程度",
    "reviewedAt": "2026-10-26",
    "status": "draft"
  },
  "seo": {
    "title": "面向用户搜索词的标题",
    "description": "150 字以内的描述",
    "aliases": ["用户可能使用的叫法"]
  }
}
```

## 写作规则

1. **只写资源里真实存在的内容。** 数字、条目名、来源必须能在对应 wiki 中核对；不确定就删掉或标成待核。
2. **`questions` 是知识问题，不是购买 FAQ。** 购买/下载/支付问题放到 `delivery` 或页面侧栏。
3. **`themes` 按知识主题分组，不按教材章节硬套。** 一个主题 5–20 个条目；条目名用真实概念/实体名。
4. **`samples` 只放 1–3 段**，从 `comparisons/`、`concepts/` 或总览页摘编；必须写来源。
5. **`notFor` 必须写。** 明确不是什么，避免 AI 把竞品能力拼到本商品上。
6. **`status` 先写 `draft`。** 人工核对数字、来源、公开边界后再改 `reviewed`。
7. **标题/H1 面向用户语言。** 例如“高中数学知识点体系”，不要只写内部产品名“体系化知识库”。

## 关联 wiki

商品 ID 与本地 wiki 目录的对应关系见 `content/market/product-map.json`（待补全/核对）。生成草稿时优先读：

- `wiki/concepts/INDEX.md`：主题与条目
- `wiki/comparisons/INDEX.md`：对比页
- `wiki/entities/`：人物/实体页
- `wiki/sources/`：来源摘要
- `wiki/*总览*.md` 或 `wiki/INDEX.md`：定位与主线

## 发布方式

1. 写/审 `content/market/<id>.json`
2. 跑 `node apps/cloud/scripts/backfill-market-content.mjs`（需要 `DATABASE_URL`）
3. 重新请求商品页，确认 SSR HTML 中出现事实卡、问答、内容范围、样例和来源
4. 复测豆包：同样的问题是否开始引用 `molio.cn`

> 当前只有高中数学一个样例；其余 19 个商品的内容稿由 subagents 按本规范并行起草，主线程审核后回填。
