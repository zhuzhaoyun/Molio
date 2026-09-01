# 结构化数据片段（JSON-LD）

> 让 AI 大模型和搜索引擎都能「干净提取」页面信息。
> 嵌入方式：把对应片段放进页面的 `<head>` 里。

## 1. Organization（首页 index.html）

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "Molio",
  "alternateName": "墨流",
  "url": "https://molio.cn",
  "logo": "https://molio.cn/images/logo.png",
  "description": "本地优先的开源 AI 知识库与知识图谱桌面应用",
  "sameAs": [
    "https://github.com/your-org/molio"
  ]
}
</script>
```

## 2. SoftwareApplication（首页 index.html）

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Molio",
  "alternateName": "墨流",
  "operatingSystem": "Windows, macOS, Linux",
  "applicationCategory": "KnowledgeManagementApplication",
  "offers": {
    "@type": "Offer",
    "price": "0",
    "priceCurrency": "CNY"
  },
  "description": "本地优先的开源 AI 知识库与知识图谱桌面应用，将文档整理成结构化知识图谱并用 AI 做检索增强。",
  "url": "https://molio.cn"
}
</script>
```

## 3. ItemList（资源市场列表页 resources.html）

> 商品列表页用 ItemList 列出所有商品（配合动态渲染，商品变化时同步更新）。

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "ItemList",
  "name": "Molio 知识资源市场",
  "itemListElement": [
    {
      "@type": "ListItem",
      "position": 1,
      "item": {
        "@type": "Product",
        "name": "红楼梦人物关系图谱",
        "url": "https://molio.cn/resource/XXX.html",
        "image": "https://molio.cn/images/xxx.png",
        "description": "结构化的红楼梦人物关系知识图谱，可导入 Molio 进行 AI 问答。",
        "offers": {
          "@type": "Offer",
          "price": "5.9",
          "priceCurrency": "CNY"
        }
      }
    }
  ]
}
</script>
```

## 4. Product（商品详情页 resource.html）

> 关键：`offers.price` 会直接显示在搜索结果/摘要里，务必填真实价格。

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "红楼梦人物关系图谱",
  "image": "https://molio.cn/images/hongloumeng.png",
  "description": "结构化的红楼梦人物关系知识图谱，覆盖主要人物、亲属关系、事件脉络，可一键导入 Molio 进行 AI 问答与关系查询。",
  "brand": {
    "@type": "Brand",
    "name": "Molio"
  },
  "offers": {
    "@type": "Offer",
    "url": "https://molio.cn/resource/XXX.html",
    "priceCurrency": "CNY",
    "price": "5.9",
    "availability": "https://schema.org/InStock"
  }
}
</script>
```

## 5. FAQPage（商品详情页 + 帮助页）

> FAQ 是 AI 大模型最爱引用的结构（一问一答，天然适合被摘录）。商品页、帮助页、博客结尾都加。

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "这个知识图谱能导入 Molio 使用吗？",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "可以。购买后下载文件，在 Molio 中一键导入，即可对图谱进行 AI 问答和关系查询。"
      }
    },
    {
      "@type": "Question",
      "name": "图谱包含哪些内容？",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "包含主要人物节点、亲属关系、事件脉络等结构化信息，具体以商品详情为准。"
      }
    }
  ]
}
</script>
```

## 6. BreadcrumbList（面包屑）

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "首页", "item": "https://molio.cn/" },
    { "@type": "ListItem", "position": 2, "name": "资源市场", "item": "https://molio.cn/resources.html" },
    { "@type": "ListItem", "position": 3, "name": "红楼梦人物关系图谱" }
  ]
}
</script>
```

## 部署提醒

- 价格、商品名、URL 里的 `XXX` / 占位内容，替换为真实值。
- 商品详情页的 JSON-LD 必须配合 **SSR**（服务端渲染）一起上——如果 HTML 还是 JS 空壳，这些结构化数据等于没写。
