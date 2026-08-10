/**
 * Molio Knowledge Base Resource Library — shared data for the list page (resources.html) and detail page (resource.html).
 *
 * Publishing new resources: just append an entry to MOLIO_RESOURCES, it will take effect on both pages simultaneously.
 * - Paid resource (price: N, currently all paid):
 *   · payUrl not empty → the detail page button jumps to an external payment page (product links from mianbaoduo/hupijiao, etc.);
 *   · payUrl empty and MOLIO_PAY_BASE configured → uses WeChat official Native payment (backend in a separate private repo wxpay-fc, not public);
 *   · both empty → downgrades to "contact to purchase" (enterprise.html#contact).
 *   Note: when changing prices, sync with config/products.json on OSS molio-pay (authoritative server-side pricing, FC reads from OSS).
 * - preview: array of dedicated preview image paths; empty array → the detail page falls back to displaying common app screenshots.
 * - Writing conventions: do not use corner brackets for public-facing content, use standard quotes “” / ‘’ uniformly.
 */
(function () {
  'use strict';

  // WeChat payment backend address (official domain, already bound to the wxpay-fc function).
  // If left empty, paid resources downgrade to "contact to purchase". For testing, you can override with localhost injection via add_init_script.
  window.MOLIO_PAY_BASE = window.MOLIO_PAY_BASE || 'https://pay.molio.cn';

  window.MOLIO_RES_BASE = 'https://molio-releases.oss-cn-guangzhou.aliyuncs.com/resources';

  window.MOLIO_RESOURCES = [
    {
      id: 'zizhi-tongjian',
      icon: '📖', tint: '#E8EDF2', name: 'Zizhi Tongjian (Erta Chronicles)',
      desc: '《Zizhi Tongjian》organized version Markdown knowledge base, ready to use after download and extraction',
      file: 'zizhi-tongjian-vault.zip', price: 0.99,
      tags: ['Classics', 'History'],
      overview: [
        '《Zizhi Tongjian》full-text organized version Markdown knowledge base: structured into notes by volume, covering 1,362 years of historical events from the Partition of Jin by the Three Families to the end of the Five Dynasties, with a clear chronological thread.',
        'Long-span chronological history is best suited for AI search: when asked what happened in a certain year or how a certain institution evolved, it can provide organized answers with sources based on the knowledge base, rather than vague generalities.',
      ],
      highlights: ['Full text structured by volume, unbroken chronological clues', 'Complementary to the Shiji knowledge base: one biographical-chronological, one chronological', 'Directly loadable in Molio / Obsidian'],
      preview: [
        'images/previews/zizhi-tongjian/1.png',
        'images/previews/zizhi-tongjian/2.png',
        'images/previews/zizhi-tongjian/3.png',
      ],
      payUrl: '',
    },
    {
      id: 'low-altitude-economy',
      icon: '🚁', tint: '#E3F0E7', name: 'Low-altitude Economy',
      desc: 'Low-altitude economy industry curated materials library, policies and research all covered',
      file: 'low-altitude-economy-vault.zip', price: 59,
      tags: ['Industry', 'Research'],
      overview: [
        'Low-altitude economy industry curated materials library: policies and regulations, industry research, and corporate case studies archived by topic, packing a rapidly evolving emerging industry into a single knowledge base.',
        'Suitable for practitioners, researchers, and investors: when asked about policy boundaries, industry chain breakdowns, or company comparisons, AI answers are based on organized materials within the library, not fragmented information online.',
      ],
      highlights: ['One-stop collection of policies, research, and case studies', 'Topic-based archiving with clear threads', 'An industry think-tank for practitioners and investors'],
      preview: [],
      payUrl: '',
    },
    {
      id: 'qianzhongshu-shougao',
      icon: '🖋️', tint: '#F0E8DC', name: 'Qian Zhongshu Manuscript Library',
      desc: 'Qian Zhongshu manuscript materials organized version knowledge base, literature topic archive',
      file: 'qianzhongshu-shougao-vault.zip', price: 69,
      tags: ['Literature', 'Manuscripts'],
      overview: [
        'Qian Zhongshu manuscript materials organized version knowledge base: manuscript catalogs, textual research, and research literature archived by topic into Markdown notes, convenient for search and citation.',
        'For those doing modern literature and academic history research: have AI organize topics and verify citations based on organized materials, rather than rummaging through scattered materials.',
      ],
      highlights: ['Manuscript literature archived by topic', 'Structured Markdown, AI-citable', 'A research and writing verification base library'],
      preview: [],
      payUrl: '',
    },
    {
      id: 'zhenyan-yifang-gekuo',
      icon: '🌿', tint: '#E8F0E4', name: 'Zhenyan Medical Prescriptions in Verse',
      desc: 'Medical prescription verse organized version knowledge base, prescription mnemonic verses easy to memorize and apply',
      file: 'zhenyan-yifang-gekuo-vault.zip', price: 99,
      tags: ['Traditional Chinese Medicine', 'Prescriptions'],
      overview: [
        'Zhenyan Medical Prescriptions in Verse organized version knowledge base: prescriptions organized in verse form, with prescription names, compositions, effects, and indications presented as mnemonic verses, rhythmic and easy to memorize.',
        'Suitable for both reciting prescription by prescription and for quick searching of prescription sources during clinical practice or writing — when asked about the combination of a certain medicinal herb or the modification of a certain prescription, AI answers have organized grounds within the library.',
      ],
      highlights: ['Prescriptions organized in verse form', 'Mnemonic verses rhythmic and easy to memorize', 'Searchable by prescription name, composition, and indication'],
      preview: [],
      payUrl: '',
    },
    {
      id: 'mingshi',
      icon: '🏯', tint: '#E9E2D4', name: 'History of Ming',
      desc: '《History of Ming》organized version Markdown knowledge base, ready to use after download and extraction',
      file: 'mingshi-vault.zip', price: 9.9,
      tags: ['Classics', 'History'],
      overview: [
        '《History of Ming》organized version Markdown knowledge base: structured into independent notes by basic annals, treatises, tables, and biographies, with original text and clues fully preserved, and cross-links established for persons and events.',
        'Linked with Zizhi Tongjian and Shiji: chronological in Tongjian, biographical-chronological in History of Ming — hand it to AI for specialized study and person organization, and answers have original text to trace back to.',
      ],
      highlights: ['Basic annals, treatises, tables, biographies structured', 'Cross-links for persons and events', 'Directly loadable in Molio / Obsidian'],
      preview: [],
      payUrl: '',
    },
  ];
})();