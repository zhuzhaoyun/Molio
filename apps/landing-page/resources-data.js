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

  // 微信支付后端地址（部署 wxpay-fc 后端函数并绑定域名后改为 'https://pay.molio.cn'）。
  // 留空则付费资源降级为“联系购买”。测试可用 add_init_script 注入 localhost 覆盖。
  window.MOLIO_PAY_BASE = window.MOLIO_PAY_BASE || 'https://wxpay-lgbessjewn.cn-shenzhen.fcapp.run';

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
      id: 'low-altitude-economy',
      icon: '🚁', tint: '#E3F0E7', name: '低空经济',
      desc: '低空经济产业精选资料库，政策与研究一网打尽',
      file: 'low-altitude-economy-vault.zip', price: 59,
      tags: ['产业', '研究'],
      overview: [
        '低空经济产业精选资料库：政策法规、产业研究、企业案例分专题归档，把一个快速演进的新兴行业装进一个知识库。',
        '适合从业者、研究者与投资人：问政策边界、产业链拆解、公司对比，AI 的回答都基于库内整理过的资料，而非网上碎片信息。',
      ],
      highlights: ['政策、研究、案例一站式收录', '专题归档，脉络清楚', '从业者与投资者的产业外脑'],
      preview: [],
      payUrl: '',
    },
    {
      id: 'qianzhongshu-shougao',
      icon: '🖋️', tint: '#F0E8DC', name: '钱钟书手稿库',
      desc: '钱钟书手稿资料整理版知识库，文献专题归档',
      file: 'qianzhongshu-shougao-vault.zip', price: 69,
      tags: ['文献', '手稿'],
      overview: [
        '钱钟书手稿资料整理版知识库：手稿目录、文本考订、研究文献分专题归档为 Markdown 笔记，检索与引用都方便。',
        '适合做现代文学与学术史研究的人：让 AI 基于整理过的资料做专题梳理、引文核对，而不是在散乱资料里翻找。',
      ],
      highlights: ['手稿文献分专题归档', '结构化 Markdown，AI 可引用', '研究与写作的查证底库'],
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
      id: 'mingshi',
      icon: '🏯', tint: '#E9E2D4', name: '明史',
      desc: '《明史》整理版 Markdown 知识库，下载解压即用',
      file: 'mingshi-vault.zip', price: 9.9,
      tags: ['经典', '历史'],
      overview: [
        '《明史》整理版 Markdown 知识库：按本纪、志、表、列传结构化为独立笔记，原文与线索完整保留，并建立人物、事件的交叉链接。',
        '与资治通鉴、史记衔接：编年有通鉴，纪传有明史，交给 AI 做专题研读、人物梳理，回答都有原文可溯。',
      ],
      highlights: ['本纪、志、表、列传结构化', '人物与事件交叉链接', 'Molio / Obsidian 均可直接加载'],
      preview: [],
      payUrl: '',
    },
  ];
})();