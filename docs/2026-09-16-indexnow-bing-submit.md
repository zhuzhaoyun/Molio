# IndexNow（Bing）主动推送

> 日期：2026-09-16　｜　承接本次收录核查结论：Bing 是当前唯一已经出结果的搜索渠道

## 一、为什么先做 Bing

2026-09-16 实测三个搜索引擎对同一批页面的处理：

| 引擎 | 收录情况 | 实测排名 |
|---|---|---|
| **Bing** | 正常收录 | 妇产超声知识图谱 **第 2**；金瓶梅知识图谱 **第 1 + 2** |
| Google | 15 已编入 / 19 未编入 | 12 个商品词全部不进首页 |
| 百度 | **仅 2 个页面** | 中文 AI（豆包）因此完全检索不到本站 |

同一批页面、同样的 SSR 内容，Bing 给了排名而 Google 说「已抓取 - 尚未编入索引」——说明
**页面本身的竞争力是够的**，Google 卡的是新站信任度，百度卡的是主体权益。

## 二、IndexNow 是两步，txt 只是第一步

```
1. 站点根目录放 key.txt        ← 只是"证件"，不触发任何事
2. POST 一批 URL 到提交接口     ← 这一步才通知搜索引擎
```

txt 的作用是**证明提交方有权代表本站**：Bing 收到 POST 后，会反过来 `GET https://molio.cn/<key>.txt`
校验，通过才把 URL 放进抓取队列。IndexNow **没有自动发现机制**——不放 txt 会被拒，只放 txt
而从不 POST，则什么都不会发生。

## 三、本仓库的做法（手动，不接代码）

| 文件 | 作用 |
|---|---|
| `apps/landing-page/2dfd7fe5fed37f25dfcd49287d9eb227.txt` | key 文件，随 landing-page 部署 |
| `scripts/indexnow-submit.mjs` | 提交 CLI：读 sitemap 全量推 / 指定 URL 补推 |
| `apps/landing-page/test/indexnow-key.test.mjs` | 钉住「文件名 = 内容」这个静默失败点 |

**刻意没接商品上架流程**：接入初期的量级（约 25 条 URL、上架频率不高）用命令行手动跑足够，
不值得在 cloud 里加钩子。等手动跑变成负担了再自动化。

## 四、协议约束

1. **key 文件必须能公开访问**：`GET https://molio.cn/<key>.txt` 返回 key 本身。
   nginx `location /` 走 `try_files`，根目录 `.txt` 会正常直出（robots.txt 同理），无需改配置。
2. **文件名 = 文件内容 = 提交用的 key**，三者不一致会被拒（`indexnow-key.test.mjs` 守住这条）。
3. **urlList 必须全部属于本站**，混入外站 URL 会被整体拒绝（422）。脚本已做过滤。
4. **单次上限 10,000 条**；脚本按 500 条一批提交。

key 是**公开值**（任何人都能 GET 到），不是密钥，放仓库没有安全问题。

## 五、使用步骤（顺序不能颠倒）

**第 1 步：先发布 landing-page，确认 key 文件可访问**

```powershell
curl.exe -sS https://molio.cn/2dfd7fe5fed37f25dfcd49287d9eb227.txt
# 期望输出：2dfd7fe5fed37f25dfcd49287d9eb227
```

**这一步是硬前置。** 在 key 文件上线前提交，接口会返回 202（已受理）但随后异步校验失败——
白推一次，反复失败还可能让 key 被限流。

**第 2 步：提交 URL**

```powershell
node scripts/indexnow-submit.mjs                  # 推 sitemap.xml 里全部 URL（首次回填）
node scripts/indexnow-submit.mjs <url> [url...]   # 只推指定 URL（补推）
$env:INDEXNOW_DRY="1"; node scripts/indexnow-submit.mjs   # 只打印不提交
```

脚本会读 `sitemap.xml`（索引型）并递归展开两个子 sitemap，当前约 25 条。

**第 3 步：记一个习惯**

新商品上架后跑一次 `node scripts/indexnow-submit.mjs`。脚本每次都重新读 sitemap，
重复提交已有 URL 没有副作用。

## 六、验证

1. key 文件可访问（第 1 步的 curl）
2. 提交返回 `HTTP 200` 或 `HTTP 202`——**403 表示 key 校验失败**（文件没部署或内容不匹配）
3. Bing 站点管理后台（bing.com/webmasters）看 IndexNow 的提交流水
4. 次日用 `site:molio.cn` 或搜具体商品词观察收录变化

## 七、后续

- **百度仍是最关键的缺口**：中文 AI（豆包）检索底层走百度，不解决百度收录，GEO 就是空的。
  卡点是站点未关联主体 + 主体备案号未填写
- 若手动提交成为负担，再把提交逻辑接进 cloud 的商品上架流程（当前刻意不做）
