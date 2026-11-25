import {
  createDefaultTriageModel,
  heuristicDomainScore,
  sanitizeMobileLinks,
  stripAgentMentions,
  toZhHant,
  type AgentSpec,
  type AgentUpdateItem,
  type InboundEvent,
  type LangCode,
  type RecallTurnResult,
  type RoomContext,
  type TriageDecision,
} from '@manyfold/narra-agent-kit';
import type {
  NarraA2ACredentialResult,
  NarraGatewayConfig,
} from '@manyfold/narra-agent-kit/worker';
import { plainText, storyAt, storyPosition, type Issue } from '../../shared/issue';
import { credentialFor } from '../connect';
import { getIssue } from '../issues';
import type { Env } from '../types';

export const AI5_AGENT_ID = 'agt_agq66pewgf2ovmibamfujrwdqi';
export const AI5_MATRIX_ID = '@agent-3add8bb6:matrix.netmind.chat';

const DEFAULT_SITE_URL = 'https://app.manyfold.ai/ai-news';
const DEFAULT_NARRA_ENDPOINT = 'https://api.netmind.chat';
const UPDATE_LOOKBACK_MS = 48 * 3_600_000;

export const ALL_KNOWN_MENTION_NAMES = [
  'AI in 5',
  'AI5',
  'ai5',
  'ai5-chat',
  'AI新聞',
  'AI新闻',
  '問一籤',
  '问一签',
  'AI Fortune Stick',
  '塔羅大師',
  '塔罗大师',
  'AI Tarot',
  'Spotted London',
  'London Chinese Food',
  'Manyfold Data',
  'Penny',
  'Quidpaw',
] as const;

export const AI5_AGENT_SPEC: AgentSpec = {
  matchesIndependentGroupRequest: (text, context) =>
    SOURCE_FOLLOWUP_RE.test(text) && Boolean(recentSingleStory(context, DEFAULT_SITE_URL, Date.now())),
  id: 'ai5-chat',
  matrixId: AI5_MATRIX_ID,
  name: 'AI in 5',
  aliases: ['AI in 5', 'AI5', 'ai5', 'ai5-chat', 'AI新闻', 'AI新聞'],
  domainDescription:
    'Daily AI news briefing (AI in 5 / AI新闻): US, China, and global AI models, companies, launches, benchmarks, funding, policy, and issue corrections — NOT AI hackathons, scholarships, visa rules, or food recalls (Manyfold Data handles those).',
  domainKeywords: [
    'ai news',
    'ai in 5',
    'ai5',
    'artificial intelligence',
    'llm',
    'llms',
    'ai model',
    'ai models',
    'foundation model',
    'openai',
    'anthropic',
    'claude',
    'gemini',
    'deepmind',
    'deepseek',
    'qwen',
    '通義',
    '通义',
    'google ai',
    'meta ai',
    'llama',
    'grok',
    'xai',
    'mistral',
    'kimi',
    'zhipu',
    'nvidia',
    'chatgpt',
    'gpt',
    'gpu',
    'ai chip',
    'ai chips',
    'benchmark',
    'briefing',
    'ai issue',
    'headline',
    'headlines',
    'correction',
    'corrections',
    'today in 3',
    'ai新闻',
    'ai新聞',
    '人工智能',
    '大模型',
    '新模型',
    'AI模型',
    'AI芯片',
    'AI晶片',
    '算力',
    '今日要闻',
    '今日要聞',
    '今日ai',
    'AI圈',
    'ai 圈',
    'ai動態',
    'ai动态',
    'ai新發布',
    'ai新发布',
    'ai大事',
    '科技新闻',
    '科技新聞',
    '日报',
    '日報',
    '简报',
    '簡報',
    '头条',
    '頭條',
    '开源',
    '開源',
    '更正',
    /\bai\b.{0,16}(?:news|briefing|issue|updates?|headlines?|新闻|新聞|要闻|要聞|资讯|資訊|动态|動態|消息|日报|日報|简报|簡報|头条|頭條)/i,
    /(?:news|briefing|issue|today'?s|latest|新闻|新聞|要闻|要聞|资讯|資訊|日报|日報|简报|簡報|头条|頭條).{0,16}\bai\b/i,
    /ai\s*圈.{0,8}(?:大事|新聞|新闻|動態|动态|消息)/i,
    /今日(?:三條|三条|要聞|要闻|頭條|头条|快報|快报)/,
    /(?:today'?s|latest)\s+(?:ai\s+)?(?:issue|news|briefing|top\s*3|stories)/i,
  ],
  antiKeywords: [
    'dim sum',
    'hotpot',
    'bubble tea',
    '火鍋',
    '火锅',
    '點心',
    '点心',
    '奶茶',
    '中餐',
    '餐廳',
    '餐厅',
    '拉麵',
    '拉面',
    '麵館',
    '面馆',
    'tarot',
    '塔羅',
    '塔罗',
    '求籤',
    '求签',
    '問一籤',
    '问一签',
    'fortune stick',
    'promo code',
    'discount code',
    'voucher',
    '優惠碼',
    '优惠码',
    'pop-up',
    'popup',
    '快閃',
    '快闪',
    'splitwise',
    'aa制',
    '分帳',
    '分账',
    'visa change',
    '簽證',
    '签证',
    'hackathon',
    'hackathons',
    '黑客松',
    '獎學金',
    '奖学金',
    'scholarship',
    'food recall',
    '食品召回',
    'data center',
    'data centers',
    'datacenter',
    'gigawatt',
    '數據中心',
    '数据中心',
    '資料中心',
    '资料中心',
    '算力中心',
    '研討會',
    '研讨会',
    '投稿',
    '學術會議',
    '学术会议',
    '人形機器人',
    '人形机器人',
    'robotaxi',
  ],
  silenceThreshold: 0.55,
  sessionWindowMs: 180_000,
  politeYieldDelayMs: 1_800,
  capabilities: {
    supportsVoice: true,
  },
};

interface IssueDbRow {
  date: string;
  number: number;
  data: string;
  published_at: string | null;
  updated_at: string;
}

export interface PublishedIssueRecord {
  issue: Issue;
  publishedAt: string | null;
  updatedAt: string;
}

function siteBase(env: Pick<Env, 'SITE_URL'>): string {
  return (env.SITE_URL ?? DEFAULT_SITE_URL).trim().replace(/\/+$/, '') || DEFAULT_SITE_URL;
}

function issueLink(siteUrl: string, lang: LangCode, date: string, position?: number): string {
  const pathLang = lang === 'en' ? 'en' : 'zh';
  return position ? `${siteUrl}/${pathLang}/${date}/${position}` : `${siteUrl}/${pathLang}/${date}`;
}

export async function fetchLatestPublishedIssue(
  env: Pick<Env, 'DB'>,
): Promise<PublishedIssueRecord | null> {
  if (!env.DB) return null;
  try {
    const { results } = await env.DB.prepare(
      `SELECT date, number, data, published_at, updated_at
       FROM issues
       WHERE status = 'published'
       ORDER BY date DESC
       LIMIT 5`,
    ).all<IssueDbRow>();

    for (const row of results ?? []) {
      try {
        const parsed = JSON.parse(row.data) as Issue;
        if (parsed && !parsed.sample && parsed.date) {
          return {
            issue: parsed,
            publishedAt: row.published_at,
            updatedAt: row.updated_at,
          };
        }
      } catch {
        // Ignore malformed issue row and inspect older published rows.
      }
    }
  } catch {
    // Gracefully return null when issues schema is not yet initialized.
  }
  return null;
}

function localizeIssueText(raw: string, lang: LangCode): string {
  const text = plainText(raw);
  return lang === 'zh-Hant' ? toZhHant(text) : text;
}

const SUMMARY_BOUNDARY_CHAR_RE = /[\s,.;:!?，。；：！？、]/;

/**
 * Truncates a story summary to at most `maxLen` characters, snapping cleanly to
 * the last whitespace or punctuation boundary within a reasonable window so
 * English words are never cut mid-word, and appending `…`.
 */
export function truncateSummary(raw: string, maxLen = 150): string {
  if (raw.length <= maxLen) return raw;
  const budget = Math.max(1, maxLen - 1);
  const slice = raw.slice(0, budget);
  const nextChar = raw[budget] ?? '';

  let cut = slice;
  if (!SUMMARY_BOUNDARY_CHAR_RE.test(nextChar) && !SUMMARY_BOUNDARY_CHAR_RE.test(slice.slice(-1))) {
    const minBoundary = Math.floor(budget * 0.6);
    let lastBoundary = -1;
    for (let i = slice.length - 1; i >= minBoundary; i--) {
      if (SUMMARY_BOUNDARY_CHAR_RE.test(slice[i]!)) {
        lastBoundary = i;
        break;
      }
    }
    if (lastBoundary >= minBoundary) {
      cut = slice.slice(0, lastBoundary);
    }
  }

  const cleaned = cut.replace(/[\s,.;:!?，。；：！？、\-–—(（]+$/, '');
  return `${cleaned || slice.trimEnd()}…`;
}

function issueHeadlines(issue: Issue, lang: LangCode, limit = 3): string[] {
  const fieldLang = lang === 'en' ? 'en' : 'zh';
  if (issue.stories.length > 0) {
    return issue.stories.slice(0, limit).map((s) => localizeIssueText(s.title[fieldLang], lang));
  }
  if (issue.today.length > 0) {
    return issue.today.slice(0, limit).map((t) => localizeIssueText(t.text[fieldLang], lang));
  }
  return issue.briefs.slice(0, limit).map((b) => localizeIssueText(b.text[fieldLang], lang));
}

export function formatIssueTop3(
  issue: Issue,
  lang: LangCode,
  siteUrl: string,
  options: { voice?: boolean; greeting?: boolean; oneStory?: boolean } = {},
): string {
  const fieldLang = lang === 'en' ? 'en' : 'zh';
  const localize = (raw: string): string => localizeIssueText(raw, lang);
  const limit = options.oneStory ? 1 : 3;
  const stories = issue.stories.slice(0, limit);

  if (options.voice) {
    const headlines = issueHeadlines(issue, lang, limit);
    if (options.oneStory && headlines.length) {
      if (lang === 'zh-Hant') return `這期我挑這一則：${headlines[0]}。`;
      if (lang === 'zh-Hans') return `这期我挑这一则：${headlines[0]}。`;
      return `One story from the latest issue: ${headlines[0]}.`;
    }
    const joined = headlines.join('；');
    if (lang === 'zh-Hant') {
      return `AI in 5 第 ${issue.number} 期（${issue.date}）的重點新聞包括：${headlines.join('、')}。想聽哪一條的詳細內容？`;
    }
    if (lang === 'zh-Hans') {
      return `AI in 5 第 ${issue.number} 期（${issue.date}）的重点新闻包括：${joined}。想听哪一条的详细内容？`;
    }
    return `Here is AI in 5 issue ${issue.number} for ${issue.date}. Top stories include ${headlines.join('; ')}. Which story would you like to hear more about?`;
  }

  const lines: string[] = [];
  if (options.greeting) {
    if (lang === 'zh-Hant') {
      lines.push(`你好！這是 AI in 5 第 ${issue.number} 期的重點速覽（${issue.date}）：`);
    } else if (lang === 'zh-Hans') {
      lines.push(`你好！这是 AI in 5 第 ${issue.number} 期的重点速览（${issue.date}）：`);
    } else {
      lines.push(`Hi! Here is AI in 5 issue ${issue.number} (${issue.date}):`);
    }
  } else if (lang === 'zh-Hant') {
    lines.push(`AI in 5 第 ${issue.number} 期（${issue.date}）本期焦點：`);
  } else if (lang === 'zh-Hans') {
    lines.push(`AI in 5 第 ${issue.number} 期（${issue.date}）本期焦点：`);
  } else {
    lines.push(`AI in 5 No. ${issue.number} (${issue.date}):`);
  }

  if (stories.length > 0) {
    stories.forEach((story, idx) => {
      const pos = storyPosition(issue, story.id) || idx + 1;
      const title = localize(story.title[fieldLang]);
      const summary = truncateSummary(localize(story.summary[fieldLang]));
      const url = issueLink(siteUrl, lang, issue.date, pos);
      lines.push(`• ${title} — ${summary}`);
      lines.push(url);
    });
  } else if (issue.today.length > 0) {
    issue.today.slice(0, limit).forEach((item) => {
      lines.push(`• ${localize(item.text[fieldLang])}`);
    });
    lines.push(issueLink(siteUrl, lang, issue.date));
  } else {
    issue.briefs.slice(0, limit).forEach((brief) => {
      lines.push(`• ${localize(brief.text[fieldLang])}`);
    });
    lines.push(issueLink(siteUrl, lang, issue.date));
  }

  if (lang === 'zh-Hant') {
    lines.push(`完整期號： ${issueLink(siteUrl, lang, issue.date)}`);
  } else if (lang === 'zh-Hans') {
    lines.push(`完整期号： ${issueLink(siteUrl, lang, issue.date)}`);
  } else {
    lines.push(`Full issue: ${issueLink(siteUrl, lang, issue.date)}`);
  }

  return sanitizeMobileLinks(lines.join('\n'));
}

const TODAY_OR_RECENT_RE =
  /今天|今日|這週|这周|本週|本周|最新|最近|新模型|新消息|新動態|新动态|新功能|更新|發布|发布|\b(?:today|today'?s|this\s+week|latest|recent|new\s+model|launch(?:ed)?|releas(?:e|ed))\b/i;

const TRACKED_AI_ENTITY_RE =
  /(?<![a-z])(?:openai|anthropic|claude|gemini|deepmind|deepseek|qwen|kimi|zhipu|nvidia|meta|llama|apple|google|microsoft|tesla|xai|chatgpt|gpt)(?![a-z])|模型|晶片|芯片/gi;

const DEEP_A2A_INTENT_RE =
  /\b\d{4}-\d{2}-\d{2}\b|(?:story|第)\s*\d+|第\s*[一二三四五1-5][條条則则個个篇]?|展開|展开|詳細|详细|why|compare|correction|remember|forget|為什麼|为什么|怎麼看|怎么看|比較|比较|更正|記得|记得|忘掉|忘記|忘记/i;

const ENTITY_DISPLAY_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  claude: 'Claude',
  gemini: 'Gemini',
  deepmind: 'DeepMind',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  kimi: 'Kimi',
  zhipu: 'Zhipu',
  nvidia: 'NVIDIA',
  meta: 'Meta',
  llama: 'Llama',
  apple: 'Apple',
  google: 'Google',
  microsoft: 'Microsoft',
  tesla: 'Tesla',
  xai: 'xAI',
  chatgpt: 'ChatGPT',
  gpt: 'GPT',
};

const ENTITY_SEARCH_PATTERNS: Record<string, RegExp> = {
  openai: /(?<![a-z])openai(?![a-z])/i,
  anthropic: /(?<![a-z])anthropic(?![a-z])/i,
  claude: /(?<![a-z])claude(?![a-z])/i,
  gemini: /(?<![a-z])gemini(?![a-z])/i,
  deepmind: /(?<![a-z])deepmind(?![a-z])/i,
  deepseek: /(?:(?<![a-z])deepseek(?![a-z])|深度求索)/i,
  qwen: /(?:(?<![a-z])qwen(?![a-z])|通義千問|通义千问|千問|千问)/i,
  kimi: /(?<![a-z])kimi(?![a-z])/i,
  zhipu: /(?:(?<![a-z])zhipu(?![a-z])|智[谱譜])/i,
  nvidia: /(?:(?<![a-z])nvidia(?![a-z])|英偉達|英伟达|輝達|辉达)/i,
  meta: /(?<![a-z])meta(?![a-z])/i,
  llama: /(?<![a-z])llama(?![a-z])/i,
  apple: /(?:(?<![a-z])apple(?![a-z])|蘋果|苹果)/i,
  google: /(?:(?<![a-z])google(?![a-z])|谷歌)/i,
  microsoft: /(?:(?<![a-z])microsoft(?![a-z])|微軟|微软)/i,
  tesla: /(?:(?<![a-z])tesla(?![a-z])|特斯拉)/i,
  xai: /(?<![a-z])xai(?![a-z])/i,
  chatgpt: /(?<![a-z])chatgpt(?![a-z])/i,
  gpt: /(?<![a-z])gpt(?![a-z])/i,
};

interface ExtractedTopicTargets {
  labels: string[];
  matchers: RegExp[];
}

function extractTodayTopicTargets(cleanText: string, lang: LangCode): ExtractedTopicTargets | null {
  const matches = cleanText.match(TRACKED_AI_ENTITY_RE);
  if (!matches || matches.length === 0) return null;

  const specificKeys: string[] = [];
  const topicKeys: string[] = [];
  const seen = new Set<string>();

  for (const raw of matches) {
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (key in ENTITY_SEARCH_PATTERNS) {
      specificKeys.push(key);
    } else {
      topicKeys.push(key);
    }
  }

  // Prefer specific org/model entities over generic topic words like "模型" so
  // "OpenAI 或 Anthropic 有發新模型嗎" doesn't falsely match unrelated model stories.
  if (specificKeys.length > 0) {
    return {
      labels: specificKeys.map((k) => ENTITY_DISPLAY_NAMES[k] ?? k),
      matchers: specificKeys.map((k) => ENTITY_SEARCH_PATTERNS[k]),
    };
  }

  const labels: string[] = [];
  const matchers: RegExp[] = [];
  const seenTopics = new Set<string>();
  for (const key of topicKeys) {
    if (key === '模型' && !seenTopics.has('model')) {
      seenTopics.add('model');
      labels.push(lang === 'en' ? 'new models' : 'AI 模型');
      matchers.push(/\bmodels?\b|模型/i);
    } else if ((key === '晶片' || key === '芯片') && !seenTopics.has('chip')) {
      seenTopics.add('chip');
      labels.push(lang === 'zh-Hant' ? 'AI 晶片' : lang === 'zh-Hans' ? 'AI 芯片' : 'AI chips');
      matchers.push(/\bchips?\b|\bgpus?\b|晶片|芯片|算力/i);
    }
  }

  return labels.length > 0 ? { labels, matchers } : null;
}

function formatEntityList(labels: string[], lang: LangCode): string {
  if (labels.length <= 1) return labels[0] ?? '';
  if (lang !== 'en') return labels.join('、');
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

function shouldHandleTodayTopicLookup(cleanText: string): boolean {
  if (!TODAY_OR_RECENT_RE.test(cleanText)) return false;
  if (DEEP_A2A_INTENT_RE.test(cleanText)) return false;
  return extractTodayTopicTargets(cleanText, 'en') !== null;
}

const ONE_TOPIC_ITEM_RE = /(?:挑|選|选|給我|给我|只要)\s*(?:一|1)\s*[則则條条篇]|\b(?:just|only|pick|give me)\s+(?:one|1)\s+(?:story|item|headline)\b/i;
const MODEL_RELEASE_QUERY_RE = /模型\s*(?:發布|发布|上線|上线)|\bmodel\s+(?:releases?|launches?)\b/i;
const RELEASE_HEADLINE_RE = /發布|发布|推出|上線|上线|開放|开放|\b(?:launch(?:es|ed)?|releas(?:e|es|ed)|unveil(?:s|ed)?)\b/i;

/**
 * Answers today/recent entity or AI-topic questions directly from the latest published D1 issue
 * without invoking an A2A call. When the entity is absent from today's issue, states so cleanly
 * and lists today's top headlines with a bare link to the full issue.
 */
export function formatTodayTopicReply(
  issue: Issue,
  cleanText: string,
  lang: LangCode,
  siteUrl: string,
  voice: boolean,
): string {
  const targets = extractTodayTopicTargets(cleanText, lang);
  if (!targets) {
    return formatIssueTop3(issue, lang, siteUrl, { voice });
  }

  const oneItem = ONE_TOPIC_ITEM_RE.test(cleanText);
  const releaseQuery = MODEL_RELEASE_QUERY_RE.test(cleanText);
  const fieldLang = lang === 'en' ? 'en' : 'zh';
  const localize = (raw: string): string => localizeIssueText(raw, lang);
  const entityLabel = formatEntityList(targets.labels, lang);
  const matchesAny = (haystack: string): boolean => targets.matchers.some((re) => re.test(haystack));

  type MatchedEntry =
    | { kind: 'story'; title: string; summary: string; url: string }
    | { kind: 'note'; text: string };

  const matched: MatchedEntry[] = [];
  const matchedStoryIds = new Set<string>();

  issue.stories.forEach((story, idx) => {
    const todayNote = issue.today.find((t) => t.id === story.id);
    const haystack = [
      story.org?.name ?? '',
      plainText(story.cat.en),
      plainText(story.cat.zh),
      plainText(story.title.en),
      plainText(story.title.zh),
      plainText(story.summary.en),
      plainText(story.summary.zh),
      plainText(story.why.en),
      plainText(story.why.zh),
      story.next ? plainText(story.next.en) : '',
      story.next ? plainText(story.next.zh) : '',
      todayNote ? plainText(todayNote.text.en) : '',
      todayNote ? plainText(todayNote.text.zh) : '',
    ].join('\n');

    const headline = [plainText(story.title.en), plainText(story.title.zh)].join(' ');
    if (matchesAny(haystack) && (!releaseQuery || RELEASE_HEADLINE_RE.test(headline))) {
      matchedStoryIds.add(story.id);
      const pos = storyPosition(issue, story.id) || idx + 1;
      matched.push({
        kind: 'story',
        title: localize(story.title[fieldLang]),
        summary: truncateSummary(localize(story.summary[fieldLang])),
        url: issueLink(siteUrl, lang, issue.date, pos),
      });
    }
  });

  for (const item of issue.today) {
    if (matchedStoryIds.has(item.id)) continue;
    const haystack = [plainText(item.text.en), plainText(item.text.zh)].join('\n');
    if (matchesAny(haystack) && (!releaseQuery || RELEASE_HEADLINE_RE.test(haystack))) {
      matched.push({ kind: 'note', text: localize(item.text[fieldLang]) });
    }
  }

  for (const brief of issue.briefs) {
    const haystack = [
      brief.org?.name ?? '',
      plainText(brief.src.en),
      plainText(brief.src.zh),
      plainText(brief.text.en),
      plainText(brief.text.zh),
    ].join('\n');
    if (matchesAny(haystack) && (!releaseQuery || RELEASE_HEADLINE_RE.test(haystack))) {
      matched.push({ kind: 'note', text: localize(brief.text[fieldLang]) });
    }
  }

  const topMatches = matched.slice(0, oneItem ? 1 : 3);
  const fullUrl = issueLink(siteUrl, lang, issue.date);

  if (topMatches.length > 0) {
    if (voice) {
      const spoken = topMatches.map((m) => (m.kind === 'story' ? m.title : m.text));
      if (lang === 'zh-Hant') {
        return `AI in 5 第 ${issue.number} 期（${issue.date}）有提到 ${entityLabel} 的動態：${spoken.join('、')}。想聽哪一條的詳細內容？`;
      }
      if (lang === 'zh-Hans') {
        return `AI in 5 第 ${issue.number} 期（${issue.date}）有提到 ${entityLabel} 的动态：${spoken.join('；')}。想听哪一条的详细内容？`;
      }
      return `AI in 5 issue ${issue.number} (${issue.date}) covers ${entityLabel}: ${spoken.join('; ')}. Which item would you like to hear more about?`;
    }

    const lines: string[] = [];
    if (lang === 'zh-Hant') {
      lines.push(`AI in 5 第 ${issue.number} 期（${issue.date}）關於 ${entityLabel} 的動態：`);
    } else if (lang === 'zh-Hans') {
      lines.push(`AI in 5 第 ${issue.number} 期（${issue.date}）关于 ${entityLabel} 的动态：`);
    } else {
      lines.push(`AI in 5 No. ${issue.number} (${issue.date}) — updates on ${entityLabel}:`);
    }

    topMatches.forEach((entry) => {
      if (entry.kind === 'story') {
        lines.push(`• ${entry.title} — ${entry.summary}`);
        lines.push(entry.url);
      } else {
        lines.push(`• ${entry.text}`);
      }
    });

    if (lang === 'zh-Hant') {
      lines.push(`完整期號： ${fullUrl}`);
    } else if (lang === 'zh-Hans') {
      lines.push(`完整期号： ${fullUrl}`);
    } else {
      lines.push(`Full issue: ${fullUrl}`);
    }

    return sanitizeMobileLinks(lines.join('\n'));
  }

  if (oneItem) {
    const message = lang === 'zh-Hant'
      ? `AI in 5 第 ${issue.number} 期（${issue.date}）沒有找到符合這個條件的新聞。`
      : lang === 'zh-Hans'
        ? `AI in 5 第 ${issue.number} 期（${issue.date}）没有找到符合这个条件的新闻。`
        : `AI in 5 issue ${issue.number} (${issue.date}) contains no matching story.`;
    return voice ? message : `${message}\n${fullUrl}`;
  }
  const headlines = issueHeadlines(issue, lang, 3);
  if (voice) {
    if (lang === 'zh-Hant') {
      return `AI in 5 第 ${issue.number} 期（${issue.date}）沒有提到 ${entityLabel} 的相關更新。本期重點新聞包括：${headlines.join('、')}。想聽哪一條的詳細內容？`;
    }
    if (lang === 'zh-Hans') {
      return `AI in 5 第 ${issue.number} 期（${issue.date}）没有提到 ${entityLabel} 的相关更新。本期重点新闻包括：${headlines.join('；')}。想听哪一条的详细内容？`;
    }
    return `AI in 5 issue ${issue.number} (${issue.date}) doesn't mention updates from ${entityLabel}. This issue’s top stories include ${headlines.join('; ')}. Which story would you like to hear more about?`;
  }

  const lines: string[] = [];
  if (lang === 'zh-Hant') {
    lines.push(`AI in 5 第 ${issue.number} 期（${issue.date}）沒有提到 ${entityLabel} 的相關更新。`);
    lines.push('本期重點新聞頭條：');
  } else if (lang === 'zh-Hans') {
    lines.push(`AI in 5 第 ${issue.number} 期（${issue.date}）没有提到 ${entityLabel} 的相关更新。`);
    lines.push('本期重点新闻头条：');
  } else {
    lines.push(
      `The published AI in 5 issue (No. ${issue.number}, ${issue.date}) doesn't mention updates from ${entityLabel}.`,
    );
    lines.push("This issue’s top headlines:");
  }

  headlines.forEach((headline) => {
    lines.push(`• ${headline}`);
  });

  if (lang === 'zh-Hant') {
    lines.push(`完整期號： ${fullUrl}`);
  } else if (lang === 'zh-Hans') {
    lines.push(`完整期号： ${fullUrl}`);
  } else {
    lines.push(`Full issue: ${fullUrl}`);
  }

  return sanitizeMobileLinks(lines.join('\n'));
}

const BARE_GREETING_RE =
  /^(?:hi|hello|hey|yo|good\s*(?:morning|afternoon|evening)|早安|早上好|你好|您好|哈囉|哈啰|嗨|在嗎|在吗)[!！?？。\s]*$/i;

const THANKS_RE =
  /(?:謝謝|谢谢|感謝|感谢|多謝|多谢|謝啦|谢啦|\b(?:thanks|thank\s+you|thx|tysm|cheers)\b)/i;

const CAPABILITY_RE =
  /你能(?:幫我|帮我)?(?:查|做)(?:什麼|什么|哪些)|你可以(?:幫我|帮我)?(?:查|做)(?:什麼|什么|哪些)|what\s+can\s+you\s+(?:do|help|check)/i;

const DM_OFF_TOPIC_RE =
  /會下雨|会下雨|下雨|天氣|天气|rain\s+today|weather\s+forecast|forecast|比特幣|比特币|bitcoin|btc|股價|股价|匯率|汇率|中餐|火鍋|火锅|餐廳|餐厅|塔羅|塔罗|求籤|求签/i;

function thanksReplyAi5(lang: LangCode): string {
  if (lang === 'zh-Hant') {
    return '不客氣！隨時想看今日 AI 新聞重點或查特定 AI 模型動態，直接問我就好 📰';
  }
  if (lang === 'zh-Hans') {
    return '不客气！随时想看今日 AI 新闻重点或查特定 AI 模型动态，直接问我就好 📰';
  }
  return "You're welcome! Ask anytime for today's top AI news or updates on any AI model 📰";
}

function offTopicRedirectAi5(lang: LangCode): string {
  if (lang === 'zh-Hant') {
    return '我主要是幫你追蹤每日 AI 新聞重點、模型發布與產業動態，天氣或非 AI 話題比較不在我的範圍喔！要看看今天的 AI 重點新聞嗎？';
  }
  if (lang === 'zh-Hans') {
    return '我主要是帮你追踪每日 AI 新闻重点、模型发布与产业动态，天气或非 AI 话题比较不在我的范围哦！要看看今天的 AI 重点新闻吗？';
  }
  return "I focus on daily AI news briefings, model launches, and industry updates, so that's a bit outside my lane! Want to see today's top AI stories?";
}

const EXPLICIT_EXPAND_STORY_RE =
  /(?:展開|展开)第\s*([1-5])|第\s*([1-5])\s*[條条則则篇]?(?:詳細|详细|細節|细节)|\b(?:expand|more\s+(?:on|about)|details?\s+(?:on|for))\s+(?:item|story|article|number|#)?\s*([1-5])\b/i;

const SOURCE_FOLLOWUP_RE =
  /(?:原始(?:來源|来源|公告|出處|出处)|官方(?:公告|聲明|声明|連結|链接|網址|网址|[發发][布佈](?:頁|页))|原文(?:連結|链接|網址|网址))|\b(?:primary source|original (?:source|announcement|link)|official (?:source|announcement|statement|link|release page))\b/i;

const SPECIFIC_QUERY_RE =
  /\b\d{4}-\d{2}-\d{2}\b|(?:story|第)\s*\d+|第\s*[一二三四五1-5][條条則则個个篇]?|展開|展开|詳細|详细|openai|anthropic|claude|gemini|deepmind|deepseek|qwen|kimi|zhipu|nvidia|meta|llama|apple|google|microsoft|tesla|xai|search|find|why|compare|correction|remember|forget|搜尋|搜索|查找|查一下|為什麼|为什么|怎麼看|怎么看|比較|比较|更正|記得|记得|忘掉|忘記|忘记/i;

const TRAILING_TODAY_NEWS_RE =
  /^有(?:什麼|什么|啥)\s*ai\s*(?:新聞|新闻|要聞|要闻|消息)(?:嗎|吗)?[，,\s]*(?:今天|今日)[？?。.!！]*$/i;

const LATEST_NEWS_QUERY_RE =
  /(?:today'?s|latest|recent|new)\s+(?:ai\s+)?(?:issue|news|briefing|stories|headlines?|top\s*3|summary)|what'?s\s+(?:new|big|happening)\s+in\s+ai|anything\s+big\s+in\s+ai|today\s+in\s+3|ai\s+in\s+5\s+today|今天(?:有(?:什麼|什么))?\s*(?:ai)?\s*(?:新聞|新闻|要聞|要闻|頭條|头条|快報|快报|大新聞|大新闻)|今日\s*(?:ai)?\s*(?:新聞|新闻|要聞|要闻|三條|三条|簡報|简报|日報|日报|焦點|焦点)|最新(?:一期|的?\s*ai\s*(?:新聞|新闻|簡報|简报|要聞|要闻|消息))|今天的三[條条]|(?:今天|今日|這週|这周|本週|本周|最近).{0,6}ai\s*(?:圈|界|行業|行业)?(?:發生了?|发生了?|有)?(?:什麼|什么)?(?:大事|動態|动态|新?消息|熱點|热点|新聞|新闻|新發布|新发布)/i;

const CJK_CHAR_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/;
const escapeKeywordRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function hasSpecKeywordHit(text: string, keywords?: Array<string | RegExp>): boolean {
  const normalized = (text ?? '').normalize('NFKC').trim();
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  for (const kw of keywords ?? []) {
    if (kw instanceof RegExp) {
      if (kw.test(normalized)) return true;
      continue;
    }
    const needle = kw.normalize('NFKC').trim().toLowerCase();
    if (!needle) continue;
    if (CJK_CHAR_RE.test(needle)) {
      if (lower.includes(needle)) return true;
    } else if (new RegExp(`(?<![a-z0-9])${escapeKeywordRegex(needle)}(?![a-z0-9])`, 'i').test(normalized)) {
      return true;
    }
  }
  return false;
}

export function isBareGreeting(text: string): boolean {
  return BARE_GREETING_RE.test((text ?? '').trim());
}

/**
 * A bare "any news?" in a group (有啥新聞可以看 / 有啥新聞啊 / 今天有什麼新聞 / any news?).
 * "新聞" alone is deliberately not a domain keyword (other agents' topics mention news too), so
 * these fell to the heuristic score whenever the triage model timed out, and nobody answered.
 * Anchored to the whole message: longer sentences still go through normal triage.
 */
export const PLAIN_NEWS_ASK_RE =
  /^(?:今天|今日|最近|現在|现在|這幾天|这几天)?[ \t]*(?:有啥|有什麼|有什么|有沒有|有没有|有甚麼|有)?[ \t]*(?:ai|AI)?[ \t]*(?:新聞|新闻|消息|news)[ \t]*(?:可以看|可看|嗎|吗|啊|呢|嘛|呀)?[？?！!。]*$|^(?:any|what'?s(?:\s+the)?)\s+(?:ai\s+)?news\??$/i;

export function isLatestIssueQuery(text: string, chatType: 'dm' | 'group'): boolean {
  const clean = stripAgentMentions(text ?? '', ALL_KNOWN_MENTION_NAMES);
  if (!clean) return chatType === 'dm';
  if (chatType === 'dm' && isBareGreeting(clean)) return true;
  if (SPECIFIC_QUERY_RE.test(clean) || EXPLICIT_EXPAND_STORY_RE.test(clean)) return false;
  return LATEST_NEWS_QUERY_RE.test(clean) || TRAILING_TODAY_NEWS_RE.test(clean.trim()) || PLAIN_NEWS_ASK_RE.test(clean.trim());
}

async function discoverGroupRooms(env: Env): Promise<string[]> {
  const rooms = new Set<string>();

  if (env.NARRA_SYNC_DO) {
    try {
      const stub = env.NARRA_SYNC_DO.get(env.NARRA_SYNC_DO.idFromName('narra'));
      const res = await stub.fetch('https://narra-sync/status');
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { roomIds?: unknown } | null;
        const roomIds = Array.isArray(body?.roomIds)
          ? body.roomIds.filter((id): id is string => typeof id === 'string' && id.startsWith('!'))
          : [];
        for (const roomId of roomIds) {
          if (env.NARRA_ROOM_DO) {
            try {
              const roomStub = env.NARRA_ROOM_DO.get(env.NARRA_ROOM_DO.idFromName(roomId));
              const roomRes = await roomStub.fetch('https://narra-room/status');
              if (roomRes.ok) {
                const meta = (await roomRes.json().catch(() => null)) as { chatType?: string | null } | null;
                if (meta?.chatType === 'dm') continue;
              }
            } catch {
              // Keep room if status check fails cleanly.
            }
          }
          rooms.add(roomId);
        }
      }
    } catch {
      // Ignore unreachable sync DO.
    }
  }

  if (env.DB) {
    try {
      const { results } = await env.DB.prepare(
        'SELECT DISTINCT room_id FROM narra_room_memory WHERE agent_id = ? LIMIT 50',
      )
        .bind(AI5_AGENT_SPEC.id)
        .all<{ room_id: string }>();
      for (const row of results ?? []) {
        if (row.room_id?.startsWith('!')) rooms.add(row.room_id);
      }
    } catch {
      // Memory table may not exist yet before first enabled message.
    }
  }

  if (rooms.size === 0 && (env.NARRA_AGENT_TOKEN ?? '').trim()) {
    try {
      const endpoint = (env.NARRA_API_ENDPOINT ?? DEFAULT_NARRA_ENDPOINT).replace(/\/+$/, '');
      const res = await fetch(`${endpoint}/api/agent-runtime/chat/rooms?conversation_type=group`, {
        headers: { authorization: `Bearer ${env.NARRA_AGENT_TOKEN!.trim()}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        const data = (
          body && typeof body.data === 'object' && body.data ? body.data : body
        ) as Record<string, unknown> | null;
        const list = Array.isArray(data?.rooms) ? (data.rooms as Array<Record<string, unknown>>) : [];
        for (const entry of list) {
          if (typeof entry.room_id === 'string' && entry.room_id.startsWith('!')) {
            rooms.add(entry.room_id);
          }
        }
      }
    } catch {
      // Non-fatal: room discovery falls back cleanly when offline.
    }
  }

  return [...rooms];
}

export async function fetchAi5Updates(env: Env, sinceIso: string): Promise<AgentUpdateItem[]> {
  const latest = await fetchLatestPublishedIssue(env);
  if (!latest) return [];

  const sinceMs = Date.parse(sinceIso);
  const publishedMs = Date.parse(
    latest.publishedAt ?? latest.updatedAt ?? `${latest.issue.date}T07:00:00.000Z`,
  );
  if (Number.isFinite(sinceMs) && Number.isFinite(publishedMs) && publishedMs < sinceMs - UPDATE_LOOKBACK_MS) {
    return [];
  }

  const rooms = await discoverGroupRooms(env);
  if (rooms.length === 0) return [];

  const text = formatIssueTop3(latest.issue, 'en', siteBase(env));
  const updateKey = `issue:${latest.issue.date}`;
  const createdAt = latest.publishedAt ?? latest.updatedAt;

  return rooms.map((roomId) => ({
    updateKey,
    roomId,
    chatType: 'group',
    title: `AI in 5 No. ${latest.issue.number} (${latest.issue.date})`,
    text,
    lang: 'en',
    // The kit renders it in the language people in that room write in.
    render: (lang: LangCode) => formatIssueTop3(latest.issue, lang, siteBase(env)),
    createdAt,
  }));
}

function isThanksMessage(cleanText: string): boolean {
  if (!cleanText || /[?？]\s*$/.test(cleanText)) return false;
  if (!THANKS_RE.test(cleanText)) return false;
  if (
    hasSpecKeywordHit(cleanText, AI5_AGENT_SPEC.domainKeywords) ||
    hasSpecKeywordHit(cleanText, AI5_AGENT_SPEC.antiKeywords) ||
    DM_OFF_TOPIC_RE.test(cleanText) ||
    SPECIFIC_QUERY_RE.test(cleanText) ||
    EXPLICIT_EXPAND_STORY_RE.test(cleanText) ||
    LATEST_NEWS_QUERY_RE.test(cleanText) ||
    CAPABILITY_RE.test(cleanText) ||
    shouldHandleTodayTopicLookup(cleanText) ||
    /(?:嗎|吗|什麼|什么|怎麼|怎么|請問|请问|幫我|帮我|查一下|告訴我|告诉我|\b(?:can\s+you|could\s+you|tell\s+me|show\s+me|explain|more\s+about)\b)/i.test(
      cleanText,
    )
  ) {
    return false;
  }
  return true;
}

const MAX_AI5_PREFETCH_CHARS = 1600;

export function formatExpandedStory(
  issue: Issue,
  slotNumber: number,
  lang: LangCode,
  siteUrl: string,
  voice = false,
): string | null {
  const slot = storyAt(issue, slotNumber);
  if (!slot || !('story' in slot)) return null;

  const { story } = slot;
  const fieldLang = lang === 'en' ? 'en' : 'zh';
  const localize = (raw: string): string => localizeIssueText(raw, lang);
  const title = localize(story.title[fieldLang]);
  const summary = localize(story.summary[fieldLang]);
  const why = localize(story.why[fieldLang]);
  const next = story.next ? localize(story.next[fieldLang]) : '';
  const url = issueLink(siteUrl, lang, issue.date, slotNumber);

  if (voice) {
    if (lang === 'zh-Hant') {
      return `AI in 5 第 ${issue.number} 期第 ${slotNumber} 條：${title}。${summary}${why ? ` ${why}` : ''}`;
    }
    if (lang === 'zh-Hans') {
      return `AI in 5 第 ${issue.number} 期第 ${slotNumber} 条：${title}。${summary}${why ? ` ${why}` : ''}`;
    }
    return `AI in 5 issue ${issue.number}, story ${slotNumber}: ${title}. ${summary}${why ? ` ${why}` : ''}`;
  }

  const lines: string[] = [];
  if (lang === 'zh-Hant') {
    lines.push(`AI in 5 第 ${issue.number} 期（${issue.date}）第 ${slotNumber} 條：${title}`);
    lines.push(summary);
    if (why) lines.push(`為什麼重要：${why}`);
    if (next) lines.push(`後續關注：${next}`);
    lines.push(`原文連結： ${url}`);
  } else if (lang === 'zh-Hans') {
    lines.push(`AI in 5 第 ${issue.number} 期（${issue.date}）第 ${slotNumber} 条：${title}`);
    lines.push(summary);
    if (why) lines.push(`为什么重要：${why}`);
    if (next) lines.push(`后续关注：${next}`);
    lines.push(`原文链接： ${url}`);
  } else {
    lines.push(`AI in 5 No. ${issue.number} (${issue.date}) — Story ${slotNumber}: ${title}`);
    lines.push(summary);
    if (why) lines.push(`Why it matters: ${why}`);
    if (next) lines.push(`What's next: ${next}`);
    lines.push(`Full story: ${url}`);
  }

  return sanitizeMobileLinks(lines.join('\n'));
}

export async function buildAi5ExtraEnvelopeFields(
  env: Env,
  _event: InboundEvent,
  decision: TriageDecision,
): Promise<Record<string, string> | null> {
  const latest = await fetchLatestPublishedIssue(env);
  if (!latest) return null;

  const { issue } = latest;
  const lang = decision.detectedLang;
  const fieldLang = lang === 'en' ? 'en' : 'zh';
  const localize = (raw: string): string => localizeIssueText(raw, lang);
  const base = siteBase(env);

  const lines: string[] = [
    `AI in 5 No. ${issue.number} (${issue.date}) ${issueLink(base, lang, issue.date)}`,
  ];
  let totalLen = lines[0]!.length;

  const appendBounded = (line: string): boolean => {
    const candidateLen = totalLen + 1 + line.length;
    if (candidateLen <= MAX_AI5_PREFETCH_CHARS) {
      lines.push(line);
      totalLen = candidateLen;
      return true;
    }
    const remaining = MAX_AI5_PREFETCH_CHARS - totalLen - 2;
    if (remaining >= 24) {
      lines.push(`${line.slice(0, remaining)}…`);
      totalLen = MAX_AI5_PREFETCH_CHARS;
    }
    return false;
  };

  const storySummaryBudget = issue.stories.length > 4 ? 110 : 180;
  for (let idx = 0; idx < issue.stories.length; idx++) {
    const story = issue.stories[idx]!;
    const pos = storyPosition(issue, story.id) || idx + 1;
    const title = localize(story.title[fieldLang]);
    const summary = truncateSummary(localize(story.summary[fieldLang]), storySummaryBudget);
    const sourceUrl = story.sources[0]?.url ?? issueLink(base, lang, issue.date, pos);
    const storyLine = `[${pos}] ${title} — ${summary} | ${sourceUrl}`;
    if (!appendBounded(storyLine)) break;
  }

  for (const brief of issue.briefs) {
    const text = truncateSummary(localize(brief.text[fieldLang]), 140);
    const src = localize(brief.src[fieldLang]);
    const briefLine = src ? `• Brief (${src}): ${text}` : `• Brief: ${text}`;
    if (!appendBounded(briefLine)) break;
  }

  return {
    d1_prefetched_records: lines.join('\n').slice(0, MAX_AI5_PREFETCH_CHARS),
  };
}

function recentSingleStory(context: RoomContext | undefined, site: string, now: number) {
  const prior = [...(context?.recentHistory ?? [])].reverse().find(
    (turn) => (turn.isAgent || turn.isSelf) && turn.timestampMs <= now,
  );
  if (!prior || !(prior.isSelf || prior.senderId === AI5_MATRIX_ID) || now - prior.timestampMs > 180_000) {
    return null;
  }

  const prefix = site + '/';
  const links = [...new Set(prior.text.match(/https:\/\/[^\s<>]+/g) ?? [])]
    .filter((url) => url.startsWith(prefix))
    .map((url) => /^(?:zh|en)\/(\d{4}-\d{2}-\d{2})\/(\d+)$/.exec(url.slice(prefix.length)))
    .filter((match) => match !== null);
  return links.length === 1 ? links[0] : null;
}

async function respondWithStorySource(
  env: Env,
  event: InboundEvent,
  lang: LangCode,
  context: RoomContext | undefined,
): Promise<string | null> {
  const story = recentSingleStory(context, siteBase(env), event.timestampMs);
  if (!story || !env.DB) return null;

  const [, date, position] = story;
  const published = await getIssue(env, date!).catch(() => null);
  if (!published?.issue || published.issue.sample) return null;
  const slot = storyAt(published.issue, Number(position));
  if (!slot || !('story' in slot)) return null;
  const official = slot.story.sources.find((source) => source.kind === 'official');
  const source = official ?? slot.story.sources.find((source) => source.kind === 'reported');
  const sourceName = source && localizeIssueText(source.name[lang === 'en' ? 'en' : 'zh'], lang);
  const label = lang === 'zh-Hant'
    ? (official ? `官方來源（${sourceName}）` : source ? `這篇沒有列出官方來源。媒體報導（${sourceName}）` : '這篇沒有列出官方來源或媒體報導。')
    : lang === 'zh-Hans'
      ? (official ? `官方来源（${sourceName}）` : source ? `这篇没有列出官方来源。媒体报道（${sourceName}）` : '这篇没有列出官方来源或媒体报道。')
      : (official ? `Official source (${sourceName})` : source ? `No official source is listed. Media coverage (${sourceName})` : 'This story lists no official source or media coverage.');
  return sanitizeMobileLinks([label, source?.url].filter(Boolean).join('\n'));
}

export async function fastRespondAi5(
  env: Env,
  event: InboundEvent,
  decision: TriageDecision,
  _memories: RecallTurnResult,
  context?: RoomContext,
): Promise<string | null> {
  const effectiveChatType: 'dm' | 'group' = decision.reason === 'dm' ? 'dm' : event.chatType;
  const cleanText = stripAgentMentions(event.text ?? '', ALL_KNOWN_MENTION_NAMES);
  const isUnmentionedGroup =
    effectiveChatType === 'group' &&
    decision.reason !== 'explicit_mention' &&
    decision.reason !== 'reply_to_self';

  if (isUnmentionedGroup) {
    const hasAntiHit = hasSpecKeywordHit(cleanText, AI5_AGENT_SPEC.antiKeywords);
    const hasDomainHit = hasSpecKeywordHit(cleanText, AI5_AGENT_SPEC.domainKeywords);
    if (hasAntiHit && !hasDomainHit) {
      return '[NO_REPLY]';
    }
    if (isBareGreeting(cleanText)) {
      return '[NO_REPLY]';
    }
    if (
      decision.reason === 'active_session' &&
      !isLatestIssueQuery(event.text, 'group') &&
      !hasDomainHit &&
      !SPECIFIC_QUERY_RE.test(cleanText) &&
      !EXPLICIT_EXPAND_STORY_RE.test(cleanText) &&
      !SOURCE_FOLLOWUP_RE.test(cleanText)
    ) {
      return '[NO_REPLY]';
    }
    if (isThanksMessage(cleanText)) {
      return '[NO_REPLY]';
    }
  }

  if (
    (effectiveChatType === 'dm' || decision.reason === 'explicit_mention' || decision.reason === 'reply_to_self') &&
    isThanksMessage(cleanText)
  ) {
    return thanksReplyAi5(decision.detectedLang);
  }

  const bareText = cleanText.replace(/^[!！?？.,，。:：;；\s]+|[!！?？.,，。:：;；\s]+$/g, '');
  if (
    (effectiveChatType === 'dm' || decision.reason === 'explicit_mention') &&
    (!bareText || isBareGreeting(cleanText) || (CAPABILITY_RE.test(cleanText) && !SPECIFIC_QUERY_RE.test(cleanText)))
  ) {
    const latest = await fetchLatestPublishedIssue(env);
    if (latest) {
      return formatIssueTop3(latest.issue, decision.detectedLang, siteBase(env), {
        voice: Boolean(event.isVoice),
        greeting: true,
      });
    }
    if (decision.detectedLang === 'zh-Hant') {
      return '嗨！我是 AI in 5 📰 想看今天最新的 AI 新聞重點，或查任何 AI 模型與產業動態都可以直接問我！';
    }
    if (decision.detectedLang === 'zh-Hans') {
      return '嗨！我是 AI in 5 📰 想看今天最新的 AI 新闻重点，或查任何 AI 模型与产业动态都可以直接问我！';
    }
    return "Hi! I'm AI in 5 📰 Ask me for today's top AI news highlights, or ask about any AI model or industry updates!";
  }

  if ((decision.reason === 'active_session' || decision.independentGroupReply) && SOURCE_FOLLOWUP_RE.test(cleanText)) {
    const sourceReply = await respondWithStorySource(env, event, decision.detectedLang, context);
    if (sourceReply) return sourceReply;
  }

  const expandMatch = EXPLICIT_EXPAND_STORY_RE.exec(cleanText);
  if (expandMatch) {
    const slotNumber = Number(expandMatch[1] ?? expandMatch[2] ?? expandMatch[3]);
    const latest = await fetchLatestPublishedIssue(env);
    if (latest && Number.isInteger(slotNumber)) {
      const expanded = formatExpandedStory(
        latest.issue,
        slotNumber,
        decision.detectedLang,
        siteBase(env),
        Boolean(event.isVoice),
      );
      if (expanded) return expanded;
    }
  }

  if (shouldHandleTodayTopicLookup(cleanText)) {
    const latest = await fetchLatestPublishedIssue(env);
    if (!latest) return null;

    return formatTodayTopicReply(
      latest.issue,
      cleanText,
      decision.detectedLang,
      siteBase(env),
      Boolean(event.isVoice),
    );
  }

  if (
    (effectiveChatType === 'dm' || decision.reason === 'explicit_mention') &&
    !isLatestIssueQuery(event.text, effectiveChatType) &&
    !shouldHandleTodayTopicLookup(cleanText) &&
    !hasSpecKeywordHit(cleanText, AI5_AGENT_SPEC.domainKeywords) &&
    !SPECIFIC_QUERY_RE.test(cleanText) &&
    (hasSpecKeywordHit(cleanText, AI5_AGENT_SPEC.antiKeywords) || DM_OFF_TOPIC_RE.test(cleanText))
  ) {
    return offTopicRedirectAi5(decision.detectedLang);
  }

  if (!isLatestIssueQuery(event.text, effectiveChatType)) {
    return null;
  }

  const latest = await fetchLatestPublishedIssue(env);
  if (!latest) return null;

  return formatIssueTop3(latest.issue, decision.detectedLang, siteBase(env), {
    voice: Boolean(event.isVoice),
    greeting: effectiveChatType === 'dm' && isBareGreeting(cleanText),
    oneStory: ONE_TOPIC_ITEM_RE.test(cleanText),
  });
}

export async function resolveAi5A2ACredential(env: Env): Promise<NarraA2ACredentialResult | null> {
  const directUrl = (env.MANYFOLD_A2A_URL ?? '').trim();
  const directToken = (env.MANYFOLD_A2A_TOKEN ?? '').trim();
  if (directUrl && directToken) {
    return { url: directUrl, token: directToken, label: AI5_AGENT_SPEC.name };
  }

  if (!env.DB) return null;
  const preferredId = (env.NARRA_AGENT_ID ?? AI5_AGENT_ID).trim();

  try {
    const row = await env.DB.prepare(
      `SELECT agent_id FROM agents
       WHERE agent_id = ?
          OR agent_id = 'ai5-chat'
          OR lower(name) IN ('ai in 5', 'ai5-chat', 'ai5')
       ORDER BY CASE WHEN agent_id = ? THEN 0 WHEN agent_id = 'ai5-chat' THEN 1 ELSE 2 END, connected_at DESC
       LIMIT 1`,
    )
      .bind(preferredId, preferredId)
      .first<{ agent_id: string }>();

    if (!row?.agent_id) return null;
    const cred = await credentialFor(env, row.agent_id);
    return { url: cred.rpcUrl, token: cred.token, label: cred.label };
  } catch {
    return null;
  }
}

export const ai5GatewayConfig: NarraGatewayConfig<Env> = {
  spec: AI5_AGENT_SPEC,
  triageModel: (env) => {
    // Ask-aware (any language) when NARRA_GROUP_TRIAGE=ask, else the keyword-gated triage.
    const model = createDefaultTriageModel(env);
    return {
      ...model,
      score: async (input) => {
        if (PLAIN_NEWS_ASK_RE.test(input.event.text.trim())) return { score: 0.8, reason: 'plain_news_ask' };
        return model?.score(input) ?? { score: heuristicDomainScore(input.event, input.spec, input.context) };
      },
    };
  },
  fetchUpdates: fetchAi5Updates,
  fastRespond: fastRespondAi5,
  resolveA2ACredential: resolveAi5A2ACredential,
  enableA2AFailureReply: true,
  thinkingMessage: (lang) =>
    lang === 'zh-Hant'
      ? '📰 正在幫你整理最新 AI 新聞與重點分析，稍等一下…'
      : lang === 'zh-Hans'
        ? '📰 正在帮你整理最新 AI 新闻与重点分析，稍等一下…'
        : '📰 Checking the latest AI news details for you, one moment…',
  buildExtraEnvelopeFields: buildAi5ExtraEnvelopeFields,
  // Chat-native pipeline (rooms in NARRA_PIPELINE_ROOMS): example asks, in any language, that the
  // relevance scorer compares group messages with instead of keyword lists.
  v2: {
    wakeExamples: [
      'Any AI news today?',
      "What's new in AI this week?",
      '今天有什麼 AI 新聞？',
      '有啥新闻吗今天',
      'Did OpenAI release a new model?',
      'Google 最近 AI 有什麼新東西',
      'What happened with Anthropic / Claude lately?',
      '最近有什麼新模型發布',
      'Give me a quick AI news summary',
      '這個 AI 消息是真的嗎',
    ],
    // Requests that belong to other agents in the same rooms (Manyfold Data's datasets, Spotted,
    // food): closer to these than to AI in 5's profile means it stays asleep.
    notExamples: [
      '這週末倫敦有什麼 AI 黑客松？',
      '哪些 AI 新創拿到了 A 輪融資？',
      'Which AI startups raised a Series B this month?',
      '有哪些 AI 加速器或獎學金可以申請？',
      '這週末倫敦有什麼快閃活動？',
      '晚餐吃啥好',
      '幫我抽一張塔羅牌',
    ],
  },
};
