/**
 * A fictional sample issue, loaded into the local development database only (see
 * seedSampleIssue in issues.ts) so the reader can be built and checked without a live
 * pipeline. Every company, story, source and URL here is invented; the URLs use the
 * reserved .example domain. It is flagged `sample: true`, and the reader says so.
 */

import type { Issue } from '../shared/issue';

const svg = (body: string, viewBox = '0 0 24 24'): string =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`)}`;

const LOGO = {
  qilin: svg('<rect width="24" height="24" rx="5" fill="#0F766E"/><circle cx="11.3" cy="11.3" r="5" fill="none" stroke="#fff" stroke-width="2.2"/><path d="M14.4 14.4l4 4" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>'),
  northwind: svg('<circle cx="12" cy="12" r="12" fill="#2F6FED"/><path d="M7.6 16.4V7.6l8.8 8.8V7.6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'),
  aster: svg('<g stroke="#E8590C" stroke-width="2.6" stroke-linecap="round"><path d="M12 3.5v17M3.5 12h17M6 6l12 12M18 6L6 18"/></g>'),
  lingxin: svg('<rect width="24" height="24" rx="5" fill="#D7263D"/><rect x="7.5" y="7.5" width="9" height="9" rx="1.5" fill="none" stroke="#fff" stroke-width="2"/><path d="M10 4.5v2M14 4.5v2M10 17.5v2M14 17.5v2M4.5 10h2M4.5 14h2M17.5 10h2M17.5 14h2" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>'),
  harbor: svg('<rect width="24" height="24" rx="5" fill="#1E3A5F"/><path d="M4 9.5c2.7-2.7 5.3 2.7 8 0s5.3 2.7 8 0" fill="none" stroke="#7FB2E5" stroke-width="2" stroke-linecap="round"/><path d="M4 14.5c2.7-2.7 5.3 2.7 8 0s5.3 2.7 8 0" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>'),
  kumo: svg('<path d="M7.4 18.5a4.6 4.6 0 0 1-.5-9.17 5.6 5.6 0 0 1 10.8.3 4.4 4.4 0 0 1-.6 8.87z" fill="#0EA5E9"/>'),
};

// Stand-ins for images published with each announcement, drawn in the source's own style.
const SETTINGS_SCREENSHOT = svg(
  `<rect width="600" height="400" fill="#E8ECF2"/>
  <rect x="150" y="34" width="300" height="340" rx="26" fill="#FFFFFF"/>
  <g font-family="-apple-system, system-ui, sans-serif">
  <text x="178" y="82" font-size="19" font-weight="700" fill="#14171C">Personalization</text>
  <rect x="178" y="104" width="244" height="1" fill="#E3E6EB"/>
  <text x="178" y="140" font-size="15" font-weight="600" fill="#14171C">Memory</text>
  <text x="178" y="160" font-size="11.5" fill="#6B7380">Remembers details from your chats</text>
  <rect x="368" y="126" width="46" height="26" rx="13" fill="#2F6FED"/><circle cx="401" cy="139" r="10" fill="#FFFFFF"/>
  <rect x="178" y="182" width="244" height="1" fill="#E3E6EB"/>
  <text x="178" y="216" font-size="15" font-weight="600" fill="#14171C">Reference past chats</text>
  <text x="178" y="236" font-size="11.5" fill="#6B7380">Uses earlier chats in answers</text>
  <rect x="368" y="202" width="46" height="26" rx="13" fill="#2F6FED"/><circle cx="401" cy="215" r="10" fill="#FFFFFF"/>
  <rect x="178" y="258" width="244" height="1" fill="#E3E6EB"/>
  <text x="178" y="292" font-size="15" font-weight="600" fill="#2F6FED">Manage memories</text>
  <text x="178" y="312" font-size="11.5" fill="#6B7380">See, edit or delete what’s stored</text>
  </g>`,
  '0 0 600 400',
);

const pins = Array.from({ length: 12 }, (_, i) =>
  `<rect x="${204 + i * 16}" y="96" width="8" height="14" rx="1.5"/><rect x="${204 + i * 16}" y="290" width="8" height="14" rx="1.5"/>` +
  `<rect x="190" y="${110 + i * 15.4}" width="14" height="8" rx="1.5"/><rect x="396" y="${110 + i * 15.4}" width="14" height="8" rx="1.5"/>`,
).join('');

const CHIP_PHOTO = svg(
  `<defs>
    <radialGradient id="bg" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="#2A3038"/><stop offset="1" stop-color="#0D1013"/></radialGradient>
    <linearGradient id="die" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4A515B"/><stop offset=".5" stop-color="#2B3037"/><stop offset="1" stop-color="#1B1F24"/></linearGradient>
    <linearGradient id="pin" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E2C27A"/><stop offset="1" stop-color="#A9823A"/></linearGradient>
  </defs>
  <rect width="600" height="400" fill="url(#bg)"/>
  <ellipse cx="300" cy="318" rx="150" ry="16" fill="#000" opacity=".45"/>
  <g fill="url(#pin)">${pins}</g>
  <rect x="204" y="110" width="192" height="180" rx="10" fill="url(#die)"/>
  <rect x="214" y="120" width="172" height="160" rx="6" fill="none" stroke="#5E6670" stroke-width="1"/>
  <text x="300" y="196" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-size="15" letter-spacing="4" fill="#AEB6C0">LINGXIN</text>
  <text x="300" y="228" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-size="30" font-weight="700" fill="#D5DBE2">N2</text>
  <path d="M214 120 L300 120 L214 200 Z" fill="#fff" opacity=".05"/>`,
  '0 0 600 400',
);

export const SAMPLE_ISSUE: Issue = {
  date: '2026-10-05',
  number: 12,
  sample: true,
  today: [
    { id: 'qilin', text: { en: 'A Chinese lab open-sourced a near-top model that costs one-eighth as much to run.', zh: '中国实验室开源接近一线水平的模型，运行成本只要八分之一。' } },
    { id: 'northwind', text: { en: 'Northwind’s assistant now remembers your chats unless you switch it off.', zh: 'Northwind 助手开始默认记住你的对话，除非你手动关闭。' } },
    { id: 'aster', text: { en: 'Paris-based Aster raised €600M to build models in all 24 EU languages.', zh: '巴黎的 Aster 融资 6 亿欧元，要做覆盖欧盟 24 种语言的模型。' } },
  ],
  stories: [
    {
      id: 'qilin',
      region: 'cn',
      top: true,
      org: { name: 'Qilin Lab', logo: LOGO.qilin },
      place: { lon: 120.16, lat: 30.27 },
      cat: { en: 'Open models', zh: '开源模型' },
      title: { en: 'Qilin Lab open-sources a 70B model at 1/8 the running cost', zh: '麒麟实验室开源 70B 模型，运行成本仅为闭源模型的 1/8' },
      summary: {
        en: 'The Hangzhou lab released the weights of its Q3 model and a 40-page technical report. Qilin says Q3 costs <m0>one-eighth</m0> as much to run as comparable closed models, and scores within <m1>3 points</m1> of them on coding and math tests.',
        zh: '这家杭州实验室公开了 Q3 的模型权重和一份 40 页的技术报告。官方称，Q3 的运行成本约为同级闭源模型的<m0>八分之一</m0>，在代码和数学评测中与它们的差距在 <m1>3 分以内</m1>。',
      },
      why: {
        en: 'Running a near-frontier model on your own servers is now realistic for mid-size companies. That weakens the pricing power of closed labs.',
        zh: '中型公司在自己的服务器上运行接近一线水平的模型，开始变得现实。闭源实验室的定价权会因此被削弱。',
      },
      next: { en: 'Independent benchmark results. No one outside Qilin has reproduced its numbers yet.', zh: '独立评测的结果。目前还没有第三方复现麒麟公布的数据。' },
      sourceLine: { en: 'Official announcement, plus 2 reports', zh: '官方公告，另有 2 家媒体报道' },
      sources: [
        { kind: 'official', name: { en: 'Qilin Lab blog', zh: '麒麟实验室官方博客' }, lang: 'zh', time: '2026-10-04T14:10:00Z', url: 'https://qilinlab.example/blog/q3' },
        { kind: 'reported', name: { en: 'Harbor Tech Daily', zh: 'Harbor Tech Daily' }, lang: 'en', time: '2026-10-04T16:02:00Z', url: 'https://harbortech.example/qilin-q3' },
        { kind: 'reported', name: { en: 'The Ledger', zh: 'The Ledger' }, lang: 'en', time: '2026-10-04T18:40:00Z', url: 'https://ledger.example/ai/qilin', paywall: true },
      ],
      marks: [
        { src: 0, quote: '推理成本约为同级闭源模型的八分之一', tr: { en: 'Running cost is about one-eighth that of comparable closed models.' } },
        { src: 0, quote: '在代码与数学评测中，与领先闭源模型的差距在 3 分以内', tr: { en: 'On coding and math benchmarks, within 3 points of leading closed models.' } },
      ],
      visual: {
        type: 'compare',
        title: { en: 'Running cost compared with similar closed models', zh: '运行成本：与同级闭源模型相比' },
        note: { en: 'Qilin’s own estimate, not independently verified', zh: '麒麟自己的测算，未经独立验证' },
        rows: [
          { label: { en: 'Closed models', zh: '闭源模型' }, value: 1, shown: { en: '1', zh: '1' } },
          { label: { en: 'Qilin Q3', zh: '麒麟 Q3' }, value: 0.125, shown: { en: '1/8', zh: '1/8' }, mark: 0, focus: true },
        ],
        credit: { en: 'Chart: AI in 5, from Qilin Lab’s figures', zh: '图表：AI in 5，数据来自麒麟实验室' },
      },
      ask: [
        {
          status: 'answered',
          cites: [{ src: 0, quote: '模型权重以允许商用的许可证发布……完整模型需 8 张 80GB GPU，量化版本可在 2 张上运行', tr: { en: 'Weights are released under a license that permits commercial use… the full model needs eight 80GB GPUs, and a quantized version runs on two.' } }],
          q: { en: 'Can I run it on my own servers?', zh: '能部署在自己的服务器上吗？' },
          a: {
            en: 'Yes. The weights are released under a license that allows commercial use[1]. Qilin says the full model needs eight 80GB GPUs, and a compressed version runs on two[1].',
            zh: '可以。模型权重采用允许商用的许可证发布[1]。官方称，完整模型需要 8 张 80GB 显卡，压缩版本 2 张即可运行[1]。',
          },
        },
        {
          status: 'answered',
          cites: [
            { src: 0, quote: '根据我们的测算', tr: { en: 'According to our estimates' } },
            { src: 1, quote: 'Qilin says the model costs about an eighth as much to run, a figure we could not independently verify.', tr: { zh: '麒麟称该模型的运行成本约为八分之一，我们无法独立核实这一数字。' } },
          ],
          q: { en: 'Is the one-eighth cost figure independent?', zh: '“八分之一”的成本是独立测出来的吗？' },
          a: {
            en: 'No. It is Qilin’s own estimate[1]. Harbor Tech Daily repeats the figure and says it could not verify it[2].',
            zh: '不是。这是麒麟自己的测算[1]。Harbor Tech Daily 转述了这个数字，并表示无法独立核实[2]。',
          },
        },
        {
          status: 'none',
          cites: [{ src: 0, quote: '与领先闭源模型相比', tr: { en: 'Compared with leading closed models' } }],
          q: { en: 'How does it compare with Northwind’s newest model?', zh: '和 Northwind 最新的模型比怎么样？' },
          a: {
            en: 'These sources don’t compare Q3 with any Northwind model. They only compare it with “leading closed models” as a group[1].',
            zh: '这些来源没有拿 Q3 和 Northwind 的任何模型直接比较，只笼统地和“领先的闭源模型”做了对比[1]。',
          },
        },
      ],
    },
    {
      id: 'northwind',
      region: 'us',
      org: { name: 'Northwind', logo: LOGO.northwind },
      place: { lon: -122.42, lat: 37.77 },
      cat: { en: 'Products', zh: '产品' },
      title: { en: 'Northwind’s assistant now remembers past chats, on by default', zh: 'Northwind 助手默认开启记忆，会记住你以前的对话' },
      summary: {
        en: 'Northwind switched on long-term memory for its <m0>30 million</m0> paying users. People can see, edit or delete what it remembers in settings.',
        zh: 'Northwind 为 <m0>3,000 万</m0>付费用户默认打开了长期记忆。用户可以在设置里查看、修改或删除它记住的内容。',
      },
      why: {
        en: 'Memory makes an assistant harder to leave. Turning it on by default will also draw attention from privacy regulators, especially in Europe.',
        zh: '有了记忆，用户更难离开这个助手。默认开启也会引来隐私监管机构的关注，欧洲尤其如此。',
      },
      sourceLine: { en: 'Official announcement', zh: '官方公告' },
      sources: [{ kind: 'official', name: { en: 'Northwind blog', zh: 'Northwind 官方博客' }, lang: 'en', time: '2026-10-04T17:00:00Z', url: 'https://northwind.example/blog/memory' }],
      marks: [{ src: 0, quote: 'Starting today, memory is on for all 30 million Plus and Team subscribers.', tr: { zh: '从今天起，全部 3,000 万 Plus 和 Team 订阅用户的记忆功能都已开启。' } }],
      visual: {
        type: 'image',
        src: SETTINGS_SCREENSHOT,
        alt: { en: 'Northwind’s settings screen with Memory switched on', zh: 'Northwind 设置页，记忆功能已开启' },
        credit: { en: 'Image: Northwind, from its announcement', zh: '图片：Northwind，取自官方公告' },
      },
      ask: [
        {
          status: 'answered',
          cites: [{ src: 0, quote: 'You can turn memory off at any time in Settings > Personalization. Existing memories stay until you delete them.', tr: { zh: '你可以随时在“设置 > 个性化”中关闭记忆。已有的记忆会保留，直到你手动删除。' } }],
          q: { en: 'How do I turn it off?', zh: '怎么关闭？' },
          a: {
            en: 'Go to Settings, then Personalization, and switch off Memory[1]. Turning it off doesn’t delete what’s already stored. You delete that separately[1].',
            zh: '在“设置 > 个性化”里关闭“记忆”即可[1]。关闭后，已经记住的内容不会自动删除，需要另外手动删除[1]。',
          },
        },
        {
          status: 'answered',
          cites: [{ src: 0, quote: 'Memory will roll out to the EU and UK later this year.', tr: { zh: '记忆功能将于今年晚些时候在欧盟和英国推出。' } }],
          q: { en: 'Is it available in Europe?', zh: '欧洲能用吗？' },
          a: { en: 'Not yet. Northwind says it will come to the EU and UK “later this year”[1].', zh: '暂时不能。Northwind 表示将在“今年晚些时候”向欧盟和英国开放[1]。' },
        },
      ],
    },
    {
      id: 'aster',
      region: 'eu',
      org: { name: 'Aster', logo: LOGO.aster },
      place: { lon: 2.35, lat: 48.86 },
      cat: { en: 'Funding', zh: '融资' },
      title: { en: 'Paris lab Aster raises €600M to build models in 24 languages', zh: '巴黎实验室 Aster 融资 6 亿欧元，要做覆盖 24 种语言的模型' },
      summary: {
        en: 'The round values Aster at <m0>€6 billion</m0>. It plans to train models on all 24 official EU languages and release its smallest model openly.',
        zh: '本轮融资后，Aster 估值达到 <m0>60 亿欧元</m0>。它计划用欧盟全部 24 种官方语言训练模型，并开源其中最小的一个。',
      },
      why: {
        en: 'Europe’s leading bet on home-grown models now has real money, though still far less than the largest US labs raise in a single round.',
        zh: '欧洲押注的本土大模型终于有了真金白银，但和美国头部实验室单轮融资的规模相比仍差得远。',
      },
      sourceLine: { en: 'Official announcement, plus 1 report', zh: '官方公告，另有 1 家媒体报道' },
      sources: [
        { kind: 'official', name: { en: 'Aster press release', zh: 'Aster 新闻稿' }, lang: 'en', time: '2026-10-04T07:30:00Z', url: 'https://aster.example/press/series-b' },
        { kind: 'reported', name: { en: 'Le Signal', zh: 'Le Signal' }, lang: 'fr', time: '2026-10-04T09:15:00Z', url: 'https://lesignal.example/aster' },
      ],
      marks: [{ src: 0, quote: '…at a post-money valuation of €6 billion.', tr: { zh: '……投后估值为 60 亿欧元。' } }],
      ask: [
        {
          status: 'answered',
          cites: [
            { src: 0, quote: 'The round was led by Fonds Méridien and Nordkapp Ventures.', tr: { zh: '本轮由 Fonds Méridien 和 Nordkapp Ventures 领投。' } },
            { src: 1, quote: 'Selon nos informations, un fabricant américain de puces participe également.', tr: { en: 'According to our information, an American chipmaker is also taking part.', zh: '据我们了解，一家美国芯片制造商也参与了本轮融资。' } },
          ],
          q: { en: 'Who invested?', zh: '谁投的钱？' },
          a: {
            en: 'Two European funds led the round, according to Aster[1]. Le Signal reports that a US chipmaker also took part. Aster hasn’t confirmed that[2].',
            zh: '据 Aster 公告，本轮由两家欧洲基金领投[1]。Le Signal 报道称还有一家美国芯片公司参投，Aster 尚未证实[2]。',
          },
        },
      ],
    },
    {
      id: 'lingxin',
      region: 'cn',
      org: { name: 'Lingxin', logo: LOGO.lingxin },
      place: { lon: 114.06, lat: 22.54 },
      cat: { en: 'Hardware', zh: '硬件' },
      title: { en: 'Shenzhen’s Lingxin starts mass-producing an AI chip for phones', zh: '深圳灵芯开始量产手机 AI 芯片' },
      summary: {
        en: 'Lingxin says its N2 chip runs a 7-billion-parameter model on the phone itself at <m0>30 tokens per second</m0>. Two phone makers have announced handsets that use it.',
        zh: '灵芯称，它的 N2 芯片能在手机上以<m0>每秒 30 个 token</m0> 的速度运行 70 亿参数的模型。已有两家手机厂商宣布将推出搭载这款芯片的机型。',
      },
      why: {
        en: 'Running AI on the phone cuts cloud costs and keeps data on the device. China’s phone makers now have a domestic chip for it.',
        zh: '在手机上直接运行 AI，既能省下云端成本，也能让数据留在设备里。中国手机厂商现在有了国产芯片可选。',
      },
      sourceLine: { en: 'Official announcement, plus 1 report', zh: '官方公告，另有 1 家媒体报道' },
      sources: [
        { kind: 'official', name: { en: 'Lingxin announcement', zh: '灵芯官方公告' }, lang: 'zh', time: '2026-10-04T02:00:00Z', url: 'https://lingxin.example/news/n2' },
        { kind: 'reported', name: { en: 'Harbor Tech Daily', zh: 'Harbor Tech Daily' }, lang: 'en', time: '2026-10-04T05:20:00Z', url: 'https://harbortech.example/lingxin-n2' },
      ],
      marks: [{ src: 0, quote: 'N2 可在端侧以每秒 30 个 token 的速度运行 70 亿参数模型', tr: { en: 'N2 runs a 7-billion-parameter model on the device at 30 tokens per second.' } }],
      visual: {
        type: 'image',
        src: CHIP_PHOTO,
        alt: { en: 'Product photo of Lingxin’s N2 chip', zh: '灵芯 N2 芯片产品图' },
        credit: { en: 'Image: Lingxin, from its announcement', zh: '图片：灵芯，取自官方公告' },
      },
      ask: [
        {
          status: 'partial',
          cites: [{ src: 1, quote: 'Two Chinese handset makers said they would ship phones with the N2, without naming models.', tr: { zh: '两家中国手机厂商表示将推出搭载 N2 的手机，但未透露具体型号。' } }],
          q: { en: 'Which phones will use it?', zh: '哪些手机会用它？' },
          a: {
            en: 'Two phone makers have announced handsets with the N2[1]. The sources don’t name the models or say when they go on sale[1].',
            zh: '已有两家手机厂商宣布推出搭载 N2 的机型[1]，但来源没有提到具体型号和上市时间[1]。',
          },
        },
      ],
    },
    {
      id: 'cobalt',
      region: 'us',
      place: { lon: -71.06, lat: 42.36 },
      cat: { en: 'Research', zh: '研究' },
      title: { en: 'Study of 1,200 developers finds AI-written code needs more fixes', zh: '1,200 名开发者的研究：AI 写的代码返工更多' },
      summary: {
        en: 'Researchers at Cobalt University followed teams for six months. Time spent on code review fell by <m0>35%</m0>, but fixes after release rose by <m1>20%</m1>.',
        zh: 'Cobalt 大学的研究人员跟踪多个团队长达六个月。代码审查用时<m0>减少了 35%</m0>，但上线后的修复工作<m1>增加了 20%</m1>。',
      },
      why: {
        en: 'It is one of the largest real-world studies of AI coding tools so far. It suggests part of the speed gain is paid back later.',
        zh: '这是目前规模最大的 AI 编程工具实地研究之一。它说明一部分提速，要在后面还回去。',
      },
      sourceLine: { en: 'Research paper', zh: '研究论文' },
      sources: [{ kind: 'official', name: { en: 'Cobalt University paper', zh: 'Cobalt 大学论文' }, lang: 'en', time: '2026-10-03T22:00:00Z', url: 'https://cobalt.example/papers/ai-code-review' }],
      marks: [
        { src: 0, quote: 'median code review time fell by 35%', tr: { zh: '代码审查时间的中位数下降了 35%' } },
        { src: 0, quote: 'post-release defect fixes increased by 20%', tr: { zh: '上线后的缺陷修复增加了 20%' } },
      ],
      visual: {
        type: 'change',
        title: { en: 'Change after six months with AI coding assistants', zh: '使用 AI 编程助手六个月后的变化' },
        axis: { en: ['Decrease', 'Increase'], zh: ['减少', '增加'] },
        rows: [
          { label: { en: 'Code review time', zh: '代码审查时间' }, value: -35, shown: { en: '−35%', zh: '−35%' }, mark: 0 },
          { label: { en: 'Fixes after release', zh: '上线后的修复' }, value: 20, shown: { en: '+20%', zh: '+20%' }, mark: 1 },
        ],
        credit: { en: 'Chart: AI in 5, from the Cobalt University paper', zh: '图表：AI in 5，数据来自 Cobalt 大学论文' },
      },
      ask: [
        {
          status: 'none',
          cites: [{ src: 0, quote: 'participants used commercial AI coding assistants', tr: { zh: '参与者使用的是商用 AI 编程助手' } }],
          q: { en: 'Which tools did they test?', zh: '测试的是哪些工具？' },
          a: { en: 'The paper doesn’t name the tools. It describes them only as “commercial AI coding assistants”[1].', zh: '论文没有点名具体工具，只说是“商用 AI 编程助手”[1]。' },
        },
      ],
    },
  ],
  briefs: [
    {
      region: 'us',
      kind: 'official',
      org: { name: 'Harbor Cloud', logo: LOGO.harbor },
      place: { lon: -122.33, lat: 47.61 },
      src: { en: 'Harbor Cloud pricing page', zh: 'Harbor Cloud 价格页面' },
      text: { en: 'Harbor Cloud cut GPU rental prices by 15% in all US regions.', zh: 'Harbor Cloud 将美国所有区域的 GPU 租用价格下调 15%。' },
    },
    {
      region: 'cn',
      kind: 'rumor',
      place: { lon: 120.16, lat: 30.27 },
      src: { en: 'Harbor Tech Daily, citing unnamed people', zh: 'Harbor Tech Daily，援引匿名人士' },
      text: { en: 'Qilin Lab is said to be in talks to raise new funding. The company hasn’t commented.', zh: '传闻麒麟实验室正在洽谈新一轮融资，公司未予置评。' },
    },
    {
      region: 'jp',
      kind: 'official',
      org: { name: 'Kumo', logo: LOGO.kumo },
      place: { lon: 139.69, lat: 35.69 },
      src: { en: 'Kumo blog, in Japanese', zh: 'Kumo 官方博客（日文）' },
      text: { en: 'Tokyo-based Kumo released a speech model that handles 12 Asian languages.', zh: '东京的 Kumo 发布了支持 12 种亚洲语言的语音模型。' },
    },
  ],
};
