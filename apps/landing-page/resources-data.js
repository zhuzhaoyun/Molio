/**
 * Molio 知识库资源库 — 列表页 (resources.html) 与详情页 (resource.html) 共享数据。
 *
 * 本文件只含官方静态条目；社区条目来自运行时 API（GET {MOLIO_AUTH_BASE}/market/listings），
 * 由 resources.html / resource.html 的内联脚本动态合并渲染，云端不可达时静默回退纯静态。
 *
 * 上架新资源：往 MOLIO_RESOURCES 追加一条即可，官网列表页/详情页与桌面端资源页同时生效
 * （桌面端 apps/web/src/data/resources.ts 直接 import 本文件，随应用打包固化）。
 * - 付费资源（price: N，当前全部收费）：
 *   · payUrl 非空 → 详情页按钮跳外部支付页（面包多/虎皮椒等商品链接）；
 *   · payUrl 空且 MOLIO_PAY_BASE 已配置 → 走微信官方 Native 支付（后端在独立私有仓库 wxpay-fc，不公开）；
 *   · 两者都空 → 降级为“联系购买”（enterprise.html#contact）。
 *   注意：改价时需同步 OSS 上 molio-pay/config/products.json（服务端权威定价，FC 从 OSS 读取）。
 * - preview：专属效果预览图路径数组；空数组 → 详情页兜底显示通用应用截图。
 * - author / version：整理者署名与当前版本号。一个资源可能迭代多个版本，
 *   发新版时更新 version 并替换对应 file（如 v1.0 → v1.1，zip 名同步改）。
 * - 文案规范：对外内容不用直角引号，一律标准引号 “” / ‘’。
 */
(function () {
  'use strict';

  // 微信支付后端地址（正式域名，已绑定 wxpay-fc 函数）。
  // 留空则付费资源降级为“联系购买”。测试可用 add_init_script 注入 localhost 覆盖。
  window.MOLIO_PAY_BASE = window.MOLIO_PAY_BASE || 'https://pay.molio.cn';

  window.MOLIO_RES_BASE = 'https://molio-releases.oss-cn-guangzhou.aliyuncs.com/resources';

  window.MOLIO_RESOURCES = [
    {
      id: 'zizhi-tongjian',
      author: 'Molio 团队', version: 'v1.0',
      icon: '📖', tint: '#E8EDF2', name: '资治通鉴',
      desc: '1362 年的人物、事件互链成关系图谱，让 AI 梳理因果脉络、人物网络，一目了然',
      file: 'zizhi-tongjian-vault.zip', price: 2.9,
      tags: ['经典', '历史'],
      overview: [
        '《资治通鉴》全文整理版 Markdown 知识库：按卷次结构化为笔记，覆盖从三家分晋到五代末的一千三百六十二年史事，人物、事件互链成关系图谱。',
        '这张关系图谱正是 PDF 给不了的：让 AI 梳理某个人物周围的人物网络、某个事件的因果脉络，给出的不是泛泛而谈，而是基于图谱的清晰线索。',
      ],
      highlights: ['全文按卷结构化，人物事件互链成图谱', '与史记知识库互补：一为纪传，一为编年', 'Molio / Obsidian 均可直接加载'],
      preview: [
        'images/previews/zizhi-tongjian/1.png',
        'images/previews/zizhi-tongjian/2.png',
        'images/previews/zizhi-tongjian/3.png',
      ],
      payUrl: '',
    },
    {
      id: 'ronganguan-zhaji',
      author: 'Molio 团队', version: 'v1.0',
      icon: '🖋️', tint: '#F0E8DC', name: '容安馆札记',
      desc: '钱钟书读书札记分专题整理成 wiki 条目，研究与写作的查证、引文核对交给 AI',
      file: 'ronganguan-zhaji-vault.zip', price: 19.9,
      tags: ['文献', '札记'],
      overview: [
        '《容安馆札记》整理版知识库：钱钟书先生的读书札记与文献考订内容，分专题归档为 Markdown 笔记，检索与引用都方便。',
        '适合做古典文学与学术史研究的人：让 AI 基于整理过的资料做专题梳理、引文核对，而不是在散乱资料里翻找。',
      ],
      highlights: ['学术笔记分专题归档', '结构化 Markdown，AI 可引用', '研究与写作的查证底库'],
      preview: [
        'images/previews/ronganguan-zhaji/1.png',
        'images/previews/ronganguan-zhaji/2.png',
      ],
      payUrl: '',
    },
    {
      id: 'zhenyan-yifang-gekuo',
      author: 'Molio 团队', version: 'v1.0',
      icon: '🌿', tint: '#E8F0E4', name: '诊验医方歌括',
      desc: '医方以歌括体例整理成 wiki 条目，问 AI 方剂组成、主治，歌诀脱口而出',
      file: 'zhenyan-yifang-gekuo-vault.zip', price: 99,
      tags: ['中医', '方剂'],
      overview: [
        '诊验医方歌括整理版知识库：以歌括体例整理方剂，方名、组成、功效、主治以歌诀形式呈现，朗朗上口，便于记忆。',
        '既适合按方背诵，也方便临床、写作时快速检索方剂出处——问一味药的配伍、一首方的化裁，AI 的回答都有库内整理过的依据。',
      ],
      highlights: ['方剂以歌括体例整理', '歌诀朗朗上口，便于记诵', '方名、组成、主治可检索'],
      preview: [
        'images/previews/zhenyan-yifang-gekuo/1.png',
        'images/previews/zhenyan-yifang-gekuo/2.png',
        'images/previews/zhenyan-yifang-gekuo/3.png',
      ],
      payUrl: '',
    },
    {
      id: 'shiji',
      author: 'Molio 团队', version: 'v1.0',
      icon: '📜', tint: '#F5E9D3', name: '史记',
      desc: '五体整理成 wiki 条目，同一人物的事迹跨篇互链，让 AI 汇总生平、拼出全貌',
      file: 'shiji-vault.zip', price: 9.9,
      tags: ['经典', '历史'],
      overview: [
        '《史记》全文整理版 Markdown 知识库：本纪、表、书、世家、列传五体结构化为独立笔记，原文完整保留，同一人物、同一事件的事迹跨篇互链。',
        '纪传体把一个人的事迹散在本纪、世家、列传里，PDF 时代永远串不起来；现在互链把它们连成完整生平。让 AI 汇总人物生平、梳理事件始末，回答跨篇互证、原文可溯。',
      ],
      highlights: ['全文覆盖本纪、表、书、世家、列传五体', '同一人物事迹跨篇互链，生平可汇总成全貌', 'Obsidian 可直接打开，图谱视图同样好用'],
      preview: [
        'images/previews/shiji/1.png',
        'images/previews/shiji/2.png',
        'images/previews/shiji/3.png',
      ],
      payUrl: '',
    },
    {
      id: 'mingshi',
      author: 'Molio 团队', version: 'v1.0',
      icon: '🏯', tint: '#F2E3D5', name: '明史',
      desc: '清修《明史》全文结构化入库：306 位帝、后、妃、臣、宦实体互链成图谱，问 AI 明代人物与事件皆有原文可溯',
      file: 'mingshi-vault.zip', price: 9.9,
      tags: ['经典', '历史'],
      overview: [
        '《明史》整理版知识库：清修官修正史（本纪 24 · 志 75 · 列传 220 + 附录），全文 344 万言逐字整理为 Markdown，帝系、后妃、宗室、开国、大臣、武臣、宦官等 306 个实体互链成关系图谱，全部引文附稳定行号、可回溯原文。',
        '明代三百年的人物网络、朝局脉络与制度沿革，正是图谱与行号查得着的：问一个大臣的生平与交游、一场党争的来龙去脉、一项军制的沿革，AI 的回答都有库内原文依傍。',
      ],
      highlights: ['全文 344 万言整理入库，行号可回溯原文', '306 实体按帝系/后妃/宗室/大臣等十类互链', '明末三案、土木之变、郑和下西洋等知名事件独立成条'],
      preview: [
        'images/previews/mingshi/1.png',
        'images/previews/mingshi/2.png',
      ],
      payUrl: '',
    },
    {
      id: 'hongloumeng',
      author: 'Molio 团队', version: 'v1.0',
      icon: '🏮', tint: '#F5E3E0', name: '红楼梦',
      desc: '120 回通行本全文入库，人物、情节、判词互链成图谱，问 AI 任何红楼人物都有原文可溯',
      file: 'hongloumeng-vault.zip', price: 6.9,
      tags: ['经典', '文学'],
      overview: [
        '《红楼梦》整理版知识库：以 120 回通行本为底本，逐回转写为 Markdown，人物、概念、回目互链成关系图谱，引文附行号可回溯原文。',
        '贾府上百号人物、千头万绪的情节，PDF 时代只能逐回翻找；现在让 AI 梳理某人物的关系网络、某桩事件的来龙去脉、某首判词的对应情节，回答跨篇互证、原文可溯——曹雪芹埋的线，AI 替你一条条拣出来。',
      ],
      highlights: ['120 回全文逐回结构化，人物与情节互链成图谱', '人物、判词、回目引文附行号，可回溯原文', 'Molio / Obsidian 均可直接加载'],
      preview: [
        'images/previews/hongloumeng/1.png',
        'images/previews/hongloumeng/2.png',
      ],
      payUrl: '',
    },
  ];
})();