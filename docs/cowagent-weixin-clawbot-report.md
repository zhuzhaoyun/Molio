# CowAgent 微信 ClawBot 式通信实现研究报告

## 结论摘要

CowAgent 的“微信 ClawBot 式原生联系人”不是公众号回调，也不是桌面微信 hook。它实现的是一个独立的 `weixin` channel，通过微信 iLink Bot API 接入：

```txt
微信客户端扫码授权
  -> CowAgent 获取 bot_token
  -> CowAgent 调用 ilink/bot/getupdates 长轮询收消息
  -> 消息转成 CowAgent Context
  -> ChatChannel 队列和 Agent 处理
  -> CowAgent 调用 ilink/bot/sendmessage 回复
```

用户侧体验是微信里新增/出现一个可搜索的“微信ClawBot”会话，所以看起来像原生联系人。代码注释和文档都把它描述为“基于官方接口”“扫码登录”“会话中新增一个机器人助手”。

对 Molio 的启发是：如果能使用同类 iLink Bot API，Molio 不需要让微信发消息到公众号，也不需要监听用户桌面微信。Molio 可以做一个 `wechat_clawbot` 或 `weixin_ilink` channel，由桌面端或云端持有 bot token，长轮询微信消息，再转成 Molio 本地指令或知识库投递。

## 入口与通道类型

CowAgent 的 channel factory 中，`weixin` 和历史别名 `wx` 都映射到 `channel.weixin.weixin_channel.WeixinChannel`。这和 `wechatmp` / `wechatmp_service` 完全不同：

```txt
wechatmp          -> 公众号被动回复
wechatmp_service  -> 公众号服务号/客服类主动回复
weixin / wx       -> 微信 ClawBot 式原生联系人
```

关键文件：

- `D:\work\02-code\CowAgent-master\channel\channel_factory.py`
- `D:\work\02-code\CowAgent-master\channel\weixin\weixin_channel.py`
- `D:\work\02-code\CowAgent-master\channel\weixin\weixin_api.py`
- `D:\work\02-code\CowAgent-master\channel\weixin\weixin_message.py`
- `D:\work\02-code\CowAgent-master\docs\zh\channels\weixin.mdx`

配置入口在 `config.py` 里：

```json
{
  "channel_type": "weixin"
}
```

相关配置项包括：

```txt
weixin_token
weixin_base_url = https://ilinkai.weixin.qq.com
weixin_cdn_base_url = https://novac2c.cdn.weixin.qq.com/c2c
weixin_credentials_path = ~/.weixin_cow_credentials.json
```

`WeixinChannel.__init__()` 还把 `single_chat_prefix` 设成 `[""]`，意味着用户私聊这个 ClawBot 时不需要输入 `bot` 前缀，任意文本都会进入 Agent。

## 登录与授权流程

CowAgent 首次启动 `weixin` channel 时，会先读 `weixin_token` 或本地凭证文件。如果没有 token，就进入二维码登录。

流程：

```txt
startup()
  -> load ~/.weixin_cow_credentials.json
  -> 没有 token 则 _login_with_retry()
  -> _qr_login()
  -> WeixinApi.fetch_qr_code()
  -> 用户微信扫码确认
  -> WeixinApi.poll_qr_status()
  -> status == confirmed
  -> 保存 bot_token / bot_id / user_id / base_url
```

`weixin_api.py` 里的二维码接口是：

```txt
GET /ilink/bot/get_bot_qrcode?bot_type=3
GET /ilink/bot/get_qrcode_status?qrcode=...
```

登录成功后保存到：

```txt
~/.weixin_cow_credentials.json
```

保存内容包含：

```json
{
  "token": "...",
  "base_url": "...",
  "bot_id": "...",
  "user_id": "..."
}
```

这个 token 后续作为 `Authorization: Bearer <token>` 调用 iLink Bot API。

文档说明用户扫码后，会在微信会话中创建一个机器人助理，并且用户可以搜索“微信ClawBot”、改头像/备注、置顶。这就是它接近“原生联系人”的产品体验来源。

## 收消息机制

CowAgent 不需要公网回调地址。`WeixinChannel` 登录成功后直接进入 `_poll_loop()`，通过长轮询拉取消息：

```txt
POST https://ilinkai.weixin.qq.com/ilink/bot/getupdates
```

请求体里带：

```json
{
  "get_updates_buf": "..."
}
```

`get_updates_buf` 是同步游标。服务端返回新的 `get_updates_buf` 后，CowAgent 更新本地游标，下一轮继续带上它，避免重复拉取。

收到响应后，CowAgent 遍历：

```txt
resp["msgs"]
```

然后 `_process_message(raw_msg)` 处理每条消息。

收消息时有几个关键点：

- 只处理 `message_type == 1` 的用户消息。
- 用 `message_id` 或 `seq` 做去重，去重缓存保留约 7.1 小时。
- 从消息里拿 `from_user_id` 作为用户身份。
- 从消息里拿 `context_token`，并按用户缓存。
- 把原始消息包装成 `WeixinMessage`，再转成 CowAgent 的统一 `Context`。

`context_token` 很关键。iLink 要求后续给某个用户发消息时，必须带该用户最近一次 inbound message 的 `context_token`。CowAgent 因此维护：

```txt
user_id -> context_token
```

并把它写回 credentials 文件。这样即使进程重启，也能在一定条件下继续给用户发计划任务或异步消息。

## 消息类型解析

`WeixinMessage` 把 iLink 的 `item_list` 转成 CowAgent 内部类型。

支持的 item 类型：

```txt
1 TEXT
2 IMAGE
3 VOICE
4 FILE
5 VIDEO
```

文本消息：

```txt
ITEM_TEXT -> ContextType.TEXT
```

语音消息：

- 如果微信侧已经给了语音识别文本，直接转成文本。
- 如果没有识别文本，则下载 `.silk` 文件，转成 `ContextType.VOICE`。

图片、视频、文件：

- 图片会立即下载到 workspace tmp 目录。
- 视频/文件使用 lazy prepare，真正处理时再下载。
- 下载地址来自消息里的 CDN 加密参数。

引用消息：

`WeixinMessage` 还会读取 `ref_msg`。如果用户引用一条文本消息，它会拼成：

```txt
[引用: title | body]
```

如果引用的是图片/视频/文件，它会把引用的 media item 当作附件下载。这说明它能处理微信里“回复/引用”场景，但代码里没有专门把公众号文章分享卡片识别成独立 `SHARING` 类型。公众号文章如果通过 iLink item 进入，是否能拿到完整 URL，取决于微信返回的 item 结构；当前代码只显式处理 text/image/voice/file/video 和 ref media。

## 转成 Agent 上下文

`WeixinChannel._compose_context()` 会创建 CowAgent `Context`，并设置：

```txt
context["channel_type"] = "weixin"
context["origin_ctype"] = 原始类型
context["session_id"] = from_user_id
context["receiver"] = from_user_id
```

这意味着一个微信用户对应一个独立会话。由于 `is_group=False`，`weixin` channel 当前只支持单聊，不支持群聊。

随后：

```txt
self.produce(context)
```

进入 `ChatChannel` 的统一处理队列。

`ChatChannel` 的关键逻辑：

- 每个 `session_id` 有独立队列。
- 默认 `concurrency_in_session = 1`，同一用户串行处理。
- 后台 `consume()` 线程从各 session 队列取任务。
- 用 `ThreadPoolExecutor(max_workers=8)` 处理消息。
- `_handle()` 内部完成：生成回复、装饰回复、发送回复。

因此微信通道本身只负责“收发和格式转换”，Agent 调用和多轮上下文是统一基础设施处理的。

## 发送消息机制

Agent 生成 `Reply` 后，`WeixinChannel.send()` 根据类型调用不同发送方法。

文本：

```txt
POST /ilink/bot/sendmessage
```

消息体核心字段：

```json
{
  "msg": {
    "to_user_id": "<receiver>",
    "message_type": 2,
    "message_state": 2,
    "item_list": [
      {
        "type": 1,
        "text_item": {
          "text": "..."
        }
      }
    ],
    "context_token": "<context_token>"
  }
}
```

图片、文件、视频：

1. 本地文件先 AES-128-ECB 加密。
2. 调用 `ilink/bot/getuploadurl` 获取上传地址。
3. 上传到微信 CDN。
4. 再调用 `sendmessage` 发送对应 media item。

相关 CDN：

```txt
https://novac2c.cdn.weixin.qq.com/c2c
```

语音回复：

代码注释写明 iLink bot protocol 没有 outbound voice item，所以 CowAgent 把 TTS 语音当文件附件发送。

长文本：

CowAgent 把单条文本限制在 4000 字以内，超过后按段落/换行拆分多条发送。

## Session 过期与重登

iLink API 如果返回 `errcode == -14` 或 `ret == -14`，CowAgent 认为 session 过期。

处理方式：

```txt
getupdates 返回 -14
  -> _relogin()
  -> 清空 context_tokens
  -> 删除旧 credentials
  -> 重新二维码登录
```

发送消息时如果返回 -14，则只删除对应用户的 `context_token`，等待下一次用户消息刷新 token。

这点对 Molio 很重要：不能假设 token 永久在线，也不能假设任意时间都能主动推送。iLink 的回复能力和 `context_token` 绑定，工程上需要有“等待用户新消息刷新 token”的兜底状态。

## Web 控制台与云控制台

CowAgent 支持两种接入方式：

1. 本地配置 `channel_type = "weixin"`，终端打印二维码。
2. Web 控制台/LinkAI 云控制台动态创建 channel。

云控制台相关逻辑在 `common/cloud_client.py`：

- `channel_create` / `channel_update` / `channel_delete` 可以动态增删 channel。
- 对 `weixin` channel，云端可以接收并显示二维码 URL。
- channel 登录状态包括 `waiting_scan`、`scanned`、`logged_in`。

`WeixinChannel._notify_cloud_qrcode()` 会在云模式下把二维码 URL 发给控制台；扫码成功后 `_notify_cloud_connected()` 回传 connected。

这说明 CowAgent 的 ClawBot 接入可以本地跑，也可以由云控制台管理登录流程。但微信消息收发仍然发生在运行 CowAgent 的进程内。

## 与公众号方案的本质区别

| 维度 | CowAgent `weixin` | CowAgent `wechatmp` |
| --- | --- | --- |
| 用户体验 | 微信里像一个联系人/ClawBot | 公众号会话 |
| 接入方式 | 扫码授权拿 bot token | 公众号后台配置 URL/Token |
| 收消息 | CowAgent 主动 long-poll `getupdates` | 微信服务器 POST 回调 |
| 是否需要公网回调 | 不需要 | 需要 |
| 身份字段 | `from_user_id` | 公众号 openId / `FromUserName` |
| 回复机制 | `sendmessage` + `context_token` | 被动回复或客服消息 |
| 支持媒体 | 文本、图片、文件、视频、语音接收 | 取决于公众号接口 |
| 风险点 | iLink Bot API 的开放性、权限、版本要求 | 公众号能力和分享入口限制 |

所以你前面说的“不是微信机器人，是微信 ClawBot 方案”是准确的。CowAgent 的 `weixin` 确实是独立于公众号的另一条路线。

## 对 Molio 的实现建议

Molio 如果要做同类体验，建议不要把它混进“公众号中转服务”模型，而是抽象成一个新的入口：

```txt
WechatClawBotChannel
```

推荐架构：

```txt
微信 ClawBot 会话
  -> iLink getupdates
  -> Molio weixin channel
  -> Molio Inbox / Command Router
  -> 本地 daemon / Agent / Knowledge
  -> iLink sendmessage
```

如果 Molio 只面向个人桌面用户，最小实现可以直接在桌面 daemon 内跑这个 channel：

```txt
desktop daemon
  -> 展示二维码
  -> 保存 bot_token 到本地加密存储
  -> long-poll 微信消息
  -> 将 text/link/file 转成 Molio 本地任务
```

如果 Molio 要做多设备/跨端同步，建议拆成：

```txt
Molio Cloud Weixin Connector
  -> 持有 bot_token
  -> 拉取微信消息
  -> 按绑定关系写入 device inbox
desktop daemon
  -> 拉取 inbox
  -> 执行本地任务
```

但这会带来 token 托管、用户隐私、服务端成本和合规责任。个人版可以优先本地跑，SaaS 版再考虑云 connector。

## Molio 需要实现的模块

1. `weixin_ilink_api`
   - `fetchQrCode()`
   - `pollQrStatus(qrcode)`
   - `getUpdates(cursor)`
   - `sendMessage(to, items, contextToken)`
   - `getUploadUrl()`
   - CDN upload/download

2. `weixin_channel`
   - 登录状态机：idle / waiting_scan / scanned / logged_in / expired
   - token 加密保存
   - cursor 保存
   - long-poll loop
   - 消息去重
   - `from_user_id -> context_token` 缓存

3. `message_parser`
   - text
   - image
   - voice
   - file
   - video
   - ref_msg
   - 需要额外研究分享卡片/公众号文章在 iLink 中的 item 结构

4. `molio_command_router`
   - 文本指令 -> `POST /api/runs`
   - `mp.weixin.qq.com` 链接 -> 文章抓取/总结/入库
   - 文件/图片 -> 知识库附件或待处理卡片
   - 高风险动作 -> 桌面端确认

5. `desktop_settings_ui`
   - 显示二维码
   - 显示登录状态
   - 解绑/重新登录
   - 指定默认知识库/默认 agent

## 风险和待验证点

1. iLink Bot API 是否对所有开发者开放

CowAgent 代码直接调用 `https://ilinkai.weixin.qq.com`，但仓库里没有看到常规开放平台 appId/appSecret 流程。Molio 不能只假设复制代码就能稳定接入，需要实际验证该 API 的可用权限、服务条款、版本限制。

2. 公众号文章分享卡片是否能拿到原始 URL

CowAgent 当前 `WeixinMessage` 只显式解析 text/image/voice/file/video 和 `ref_msg`。如果用户把公众号文章转发给“微信ClawBot”，iLink 返回的 item 类型是否是文本、文件、卡片、引用，代码里没有完整覆盖。Molio 要先抓真实 raw message 样本。

3. 主动推送能力受 `context_token` 约束

CowAgent 的实现说明 iLink 发送消息需要最近的 `context_token`。这意味着 Molio 不能把它当成无限制 push 通道。更可靠的模型是“用户发来消息后，在该上下文内回复”；定时任务/异步完成通知要处理 token 失效。

4. 本地保存凭证要加密

CowAgent 把凭证保存到 JSON，并尝试 chmod 600。Molio 桌面端应使用系统密钥链或 Electron safeStorage，而不是明文 JSON。

5. API 变化风险

这套接口不是传统公众号文档里的稳定模式。Molio 要把 channel 做成可替换适配器，避免核心知识库/Agent 逻辑依赖具体 iLink 字段。

## 建议下一步验证

1. 在 CowAgent 本地启动 `channel_type = "weixin"`，扫码登录。
2. 给“微信ClawBot”发送：
   - 普通文本
   - 公众号文章转发卡片
   - 公众号文章链接文本
   - 图片
   - 文件
   - 引用消息
3. 在 `_process_message()` 打印完整 `raw_msg` 到脱敏日志。
4. 确认公众号文章卡片的 item 结构和 URL 字段。
5. 再决定 Molio 的 parser 是否能直接支持“一键转发公众号文章给 ClawBot”。

## 最终判断

CowAgent 已经实现了你说的 ClawBot 式微信原生联系人方案。它靠的是 `weixin` channel + iLink Bot API：

```txt
扫码授权拿 bot_token
长轮询 getupdates 收消息
context_token 约束下 sendmessage 回复
CDN 加密上传/下载媒体
转成统一 Context 后进入 Agent
```

对 Molio 来说，这条路线比公众号复制粘贴更接近你要的体验。真正要确认的是：Molio 是否能合法、稳定地使用同一套 iLink Bot API，以及公众号文章转发卡片在该 API 下是否暴露原文 URL。
