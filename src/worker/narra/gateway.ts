import {
  sanitizeMobileLinks,
  type AgentSpec,
  type AgentUpdateItem,
  type InboundEvent,
  type LangCode,
  type RecallTurnResult,
  type TriageDecision,
} from '@manyfold/narra-agent-kit';
import type {
  NarraA2ACredentialResult,
  NarraGatewayConfig,
} from '@manyfold/narra-agent-kit/worker';
import { plainText, storyPosition, type Issue } from '../../shared/issue';
import { credentialFor } from '../connect';
import type { Env } from '../types';

export const AI5_AGENT_ID = 'agt_agq66pewgf2ovmibamfujrwdqi';
export const AI5_MATRIX_ID = '@agent-3add8bb6:matrix.netmind.chat';

const DEFAULT_SITE_URL = 'https://app.manyfold.ai/ai-news';
const DEFAULT_NARRA_ENDPOINT = 'https://api.netmind.chat';
const UPDATE_LOOKBACK_MS = 48 * 3_600_000;

export const AI5_AGENT_SPEC: AgentSpec = {
  id: 'ai5-chat',
  matrixId: AI5_MATRIX_ID,
  name: 'AI in 5',
  aliases: ['AI in 5', 'AI5', 'ai5', 'ai5-chat', 'AI新闻', 'AI新聞'],
  domainDescription:
    'Daily AI news briefing (AI in 5 / AI新闻): US, China, and global AI models, companies, launches, benchmarks, funding, policy, and issue corrections.',
  domainKeywords: [
    'ai news',
    'ai in 5',
    'ai5',
    'artificial intelligence',
    'llm',
    'llms',
    'model',
    'models',
    'openai',
    'anthropic',
    'claude',
    'gemini',
    'deepmind',
    'deepseek',
    'qwen',
    'kimi',
    'zhipu',
    'nvidia',
    'chatgpt',
    'gpt',
    'gpu',
    'chip',
    'chips',
    'benchmark',
    'briefing',
    'issue',
    'headline',
    'headlines',
    'correction',
    'corrections',
    'today in 3',
    'ai新闻',
    'ai新聞',
    '人工智能',
    '大模型',
    '模型',
    '芯片',
    '晶片',
    '算力',
    '今日要闻',
    '今日要聞',
    '今日ai',
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

export function formatIssueTop3(
  issue: Issue,
  lang: LangCode,
  siteUrl: string,
  options: { voice?: boolean; greeting?: boolean } = {},
): string {
  const fieldLang = lang === 'en' ? 'en' : 'zh';
  const stories = issue.stories.slice(0, 3);

  if (options.voice) {
    const headlines =
      stories.length > 0
        ? stories.map((s) => plainText(s.title[fieldLang]))
        : issue.today.slice(0, 3).map((t) => plainText(t.text[fieldLang]));
    const joined = headlines.join('；');
    if (lang === 'zh-Hant') {
      return `AI in 5 第 ${issue.number} 期重點新聞包括：${headlines.join('、')}。想聽哪一條的詳細內容？`;
    }
    if (lang === 'zh-Hans') {
      return `AI in 5 第 ${issue.number} 期重点新闻包括：${joined}。想听哪一条的详细内容？`;
    }
    return `Here is AI in 5 issue ${issue.number} for ${issue.date}. Top stories include ${headlines.join('; ')}. Which story would you like to hear more about?`;
  }

  const lines: string[] = [];
  if (options.greeting) {
    if (lang === 'zh-Hant') {
      lines.push(`你好！這是今天 AI in 5 第 ${issue.number} 期的重點速覽（${issue.date}）：`);
    } else if (lang === 'zh-Hans') {
      lines.push(`你好！这是今天 AI in 5 第 ${issue.number} 期的重点速览（${issue.date}）：`);
    } else {
      lines.push(`Hi! Here is today's AI in 5 issue ${issue.number} (${issue.date}):`);
    }
  } else if (lang === 'zh-Hant') {
    lines.push(`AI in 5 第 ${issue.number} 期（${issue.date}）今日焦點：`);
  } else if (lang === 'zh-Hans') {
    lines.push(`AI in 5 第 ${issue.number} 期（${issue.date}）今日焦点：`);
  } else {
    lines.push(`AI in 5 No. ${issue.number} (${issue.date}):`);
  }

  if (stories.length > 0) {
    stories.forEach((story, idx) => {
      const pos = storyPosition(issue, story.id) || idx + 1;
      const title = plainText(story.title[fieldLang]);
      const summary = plainText(story.summary[fieldLang]).slice(0, 140);
      const url = issueLink(siteUrl, lang, issue.date, pos);
      lines.push(`${idx + 1}. ${title} — ${summary}`);
      lines.push(url);
    });
  } else if (issue.today.length > 0) {
    issue.today.slice(0, 3).forEach((item, idx) => {
      lines.push(`${idx + 1}. ${plainText(item.text[fieldLang])}`);
    });
    lines.push(issueLink(siteUrl, lang, issue.date));
  } else {
    issue.briefs.slice(0, 3).forEach((brief, idx) => {
      lines.push(`${idx + 1}. ${plainText(brief.text[fieldLang])}`);
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

const BARE_GREETING_RE =
  /^(?:hi|hello|hey|yo|good\s*(?:morning|afternoon|evening)|早安|早上好|你好|您好|哈囉|哈啰|嗨|在嗎|在吗)[!！?？。\s]*$/i;

const SPECIFIC_QUERY_RE =
  /\b\d{4}-\d{2}-\d{2}\b|(?:story|第)\s*\d+|openai|anthropic|claude|gemini|deepmind|deepseek|qwen|kimi|zhipu|nvidia|meta|llama|apple|google|microsoft|tesla|xai|search|find|why|compare|correction|remember|forget|搜尋|搜索|查找|查一下|為什麼|为什么|怎麼看|怎么看|比較|比较|更正|記得|记得|忘掉|忘記|忘记/i;

const LATEST_NEWS_QUERY_RE =
  /(?:today'?s|latest|recent|new)\s+(?:ai\s+)?(?:issue|news|briefing|stories|headlines?|top\s*3|summary)|what'?s\s+(?:new|big|happening)\s+in\s+ai|anything\s+big\s+in\s+ai|today\s+in\s+3|ai\s+in\s+5\s+today|今天(?:有(?:什麼|什么))?\s*(?:ai)?\s*(?:新聞|新闻|要聞|要闻|頭條|头条|快報|快报|大新聞|大新闻)|今日\s*(?:ai)?\s*(?:新聞|新闻|要聞|要闻|三條|三条|簡報|简报|日報|日报|焦點|焦点)|最新(?:一期|的?\s*ai\s*(?:新聞|新闻|簡報|简报|要聞|要闻|消息))|今天的三[條条]/i;

export function isBareGreeting(text: string): boolean {
  return BARE_GREETING_RE.test((text ?? '').trim());
}

export function isLatestIssueQuery(text: string, chatType: 'dm' | 'group'): boolean {
  const clean = (text ?? '')
    .replace(/@[A-Za-z0-9._=\-/+]+:[A-Za-z0-9.-]+(?::\d{1,5})?/g, ' ')
    .replace(/@(?:AI in 5|ai5-chat|ai5|AI新闻|AI新聞)/gi, ' ')
    .trim();
  if (!clean) return chatType === 'dm';
  if (chatType === 'dm' && isBareGreeting(clean)) return true;
  if (SPECIFIC_QUERY_RE.test(clean)) return false;
  return LATEST_NEWS_QUERY_RE.test(clean);
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
    createdAt,
  }));
}

export async function fastRespondAi5(
  env: Env,
  event: InboundEvent,
  decision: TriageDecision,
  _memories: RecallTurnResult,
): Promise<string | null> {
  if (!isLatestIssueQuery(event.text, event.chatType)) {
    return null;
  }

  const latest = await fetchLatestPublishedIssue(env);
  if (!latest) return null;

  return formatIssueTop3(latest.issue, decision.detectedLang, siteBase(env), {
    voice: Boolean(event.isVoice),
    greeting: event.chatType === 'dm' && isBareGreeting(event.text),
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
  fetchUpdates: fetchAi5Updates,
  fastRespond: fastRespondAi5,
  resolveA2ACredential: resolveAi5A2ACredential,
};
