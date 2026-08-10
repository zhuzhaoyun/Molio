/**
 * Molio 知识库资源库 — 列表页 (resources.html) 与详情页 (resource.html) 共享数据。
 *
 * 上架新资源：往 MOLIO_RESOURCES 追加一条即可，两页同时生效。
 * - 付费资源（price: N，当前全部收费）：
 *   · payUrl 非空 → 详情页按钮跳外部支付页（面包多/虎皮椒等商品链接）；
 *   · payUrl 空且 MOLIO_PAY_BASE 已配置 → 走微信官方 Native 支付（后端在独立私有仓库 wxpay-fc，不公开）；
 *   · 两者都空 → 降级为“联系购买”（enterprise.html#contact）。
 *   注意：改价时需同步 OSS 上 molio-pay/config/products.json（服务端权威定价，FC 从 OSS 读取）。
 * - preview：专属效果预览图路径数组；空数组 → 详情页兜底显示通用应用截图。
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
      icon: '📖', tint: '#E8EDF2', name: '资治通鉴',
      desc: '《资治通鉴》整理版 Markdown 知识库，下载解压即用',
      file: 'zizhi-tongjian-vault.zip', price: 0.99,
      tags: ['经典', '历史'],
      overview: [
        '《资治通鉴》全文整理版 Markdown 知识库：按卷次结构化为笔记，覆盖从三家分晋到五代末的一千三百六十二年史事，编年脉络清晰。',
        '长时段编年史最适合交给 AI 检索：问某年发生了什么、某项制度如何演变，都能基于知识库给出带出处的梳理，而不是泛泛而谈。',
      ],
      highlights: ['全文按卷结构化，编年线索不断', '与史记知识库互补：一为纪传，一为编年', 'Molio / Obsidian 均可直接加载'],
      preview: [
        'images/previews/zizhi-tongjian/1.png',
        'images/previews/zizhi-tongjian/2.png',
        'images/previews/zizhi-tongjian/3.png',
      ],
      payUrl: '',
    },
    {
      id: 'ronganguan-zhaji',
      icon: '🖋️', tint: '#F0E8DC', name: '容安馆札记',
      desc: '钱钟书《容安馆札记》整理版知识库，学术笔记专题归档',
      file: 'ronganguan-zhaji-vault.zip', price: 69,
      tags: ['文献', '札记'],
      overview: [
        '《容安馆札记》整理版知识库：钱钟书先生的读书札记与文献考订内容，分专题归档为 Markdown 笔记，检索与引用都方便。',
        '适合做古典文学与学术史研究的人：让 AI 基于整理过的资料做专题梳理、引文核对，而不是在散乱资料里翻找。',
      ],
      highlights: ['学术笔记分专题归档', '结构化 Markdown，AI 可引用', '研究与写作的查证底库'],
      preview: [],
      payUrl: '',
    },
    {
      id: 'zhenyan-yifang-gekuo',
      icon: '🌿', tint: '#E8F0E4', name: '诊验医方歌括',
      desc: '医方歌括整理版知识库，方剂歌诀便于记诵应用',
      file: 'zhenyan-yifang-gekuo-vault.zip', price: 99,
      tags: ['中医', '方剂'],
      overview: [
        '诊验医方歌括整理版知识库：以歌括体例整理方剂，方名、组成、功效、主治以歌诀形式呈现，朗朗上口，便于记忆。',
        '既适合按方背诵，也方便临床、写作时快速检索方剂出处——问一味药的配伍、一首方的化裁，AI 的回答都有库内整理过的依据。',
      ],
      highlights: ['方剂以歌括体例整理', '歌诀朗朗上口，便于记诵', '方名、组成、主治可检索'],
      preview: [],
      payUrl: '',
    },
    {
      id: 'shiji',
      icon: '📜', tint: '#F5E9D3', name: '史记',
      desc: '《史记》整理版 Markdown 知识库，下载解压即用',
      file: 'shiji-vault.zip', price: 9.9,
      tags: ['经典', '历史'],
      overview: [
        '《史记》全文整理版 Markdown 知识库：本纪、表、书、世家、列传五体结构化为独立笔记，原文完整保留，并建立篇目间的交叉链接。',
        '你可以把它当一部全文可读的电子版循序阅读，也可以让 AI 基于它做专题研读——人物生平汇总、事件始末梳理、各篇观点对比，回答都有原文可溯。',
      ],
      highlights: ['全文覆盖本纪、表、书、世家、列传五体', '篇目独立成笔记，AI 引用、跳转方便', 'Obsidian 可直接打开，图谱视图同样好用'],
      preview: [],
      payUrl: '',
    },
  ];
})();