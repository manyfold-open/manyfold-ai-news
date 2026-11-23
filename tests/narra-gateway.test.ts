import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createWorkersAiTriageModel,
  heuristicDomainScore,
  isNarraGatewayEnabled,
  kickNarraGateway,
  routeEvent,
  staggerWindowMinute,
  toZhHant,
  type InboundEvent,
} from '@manyfold/narra-agent-kit';
import worker, { NarraMatrixSync, NarraRoomCoordinator } from '../src/worker/index';
import { seal } from '../src/worker/crypto';
import { ensureSchema } from '../src/worker/db';
import { saveIssue } from '../src/worker/issues';
import { SAMPLE_ISSUE } from '../src/worker/sample-issue';
import {
  AI5_AGENT_ID,
  AI5_AGENT_SPEC,
  AI5_MATRIX_ID,
  ai5GatewayConfig,
  buildAi5ExtraEnvelopeFields,
  fastRespondAi5,
  fetchAi5Updates,
  formatExpandedStory,
  formatIssueTop3,
  formatTodayTopicReply,
  isLatestIssueQuery,
  resolveAi5A2ACredential,
  truncateSummary,
} from '../src/worker/narra/gateway';
import type { Issue } from '../src/shared/issue';
import type { Env } from '../src/worker/types';

function sqliteD1(): D1Database {
  const db = new DatabaseSync(':memory:');
  type Value = null | number | string;
  const statement = (sql: string, params: Value[] = []) => ({
    bind: (...args: Value[]) => statement(sql, args),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...params).changes) } }),
  });
  return {
    prepare: (sql: string) => statement(sql),
    exec: async (sql: string) => {
      (db as unknown as { exec(statement: string): void }).exec(sql);
      return { count: 0, duration: 0 };
    },
    batch: async (statements: ReturnType<typeof statement>[]) => {
      const results = [];
      for (const s of statements) results.push(await s.run());
      return results;
    },
  } as unknown as D1Database;
}

function makePublishedIssue(date = '2026-11-19', number = 42): Issue {
  const cloned = structuredClone(SAMPLE_ISSUE);
  cloned.date = date;
  cloned.number = number;
  cloned.sample = undefined;
  return cloned;
}

function makeEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    roomId: '!room1:matrix.netmind.chat',
    chatType: 'group',
    eventId: '$ev1',
    senderId: '@alice:matrix.netmind.chat',
    senderName: 'Alice',
    type: 'm.room.message',
    kind: 'text',
    msgtype: 'm.text',
    text: "What's in today's AI news?",
    timestampMs: 1_763_550_000_000,
    timeIso: '2026-11-19T11:00:00.000Z',
    mentions: [],
    ...overrides,
  };
}

function makeCtx(): ExecutionContext {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {},
    props: {},
    async flush() {
      await Promise.all(pending);
    },
  } as unknown as ExecutionContext & { flush(): Promise<void> };
}

describe('manyfold-ai-news Narra Gateway', () => {
  const db = sqliteD1();
  const baseEnv: Env = {
    DB: db,
    ASSETS: { fetch: async () => new Response('ok') } as unknown as Fetcher,
    ENVIRONMENT: 'production',
    SITE_URL: 'https://app.manyfold.ai/ai-news',
    CONFIG_ENCRYPTION_KEY: 'test-config-encryption-key-at-least-32-chars',
    ADMIN_PASSWORD: 'super-secret-admin-password',
    NARRA_GATEWAY_ENABLED: 'off',
    NARRA_SYNC: 'off',
    NARRA_AGENT_ID: AI5_AGENT_ID,
    NARRA_MATRIX_ID: AI5_MATRIX_ID,
  };

  beforeAll(async () => {
    await ensureSchema(db);
    await saveIssue(baseEnv, '2026-11-18', { ...makePublishedIssue('2026-11-18', 41), sample: true }, 'published');
    await saveIssue(baseEnv, '2026-11-19', makePublishedIssue('2026-11-19', 42), 'published');
    await saveIssue(baseEnv, '2026-11-20', makePublishedIssue('2026-11-20', 43), 'draft');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('defines ai5-chat AgentSpec with voice support and routes across DM, voice, and multi-agent groups', async () => {
    expect(AI5_AGENT_SPEC.id).toBe('ai5-chat');
    expect(AI5_AGENT_SPEC.matrixId).toBe(AI5_MATRIX_ID);
    expect(AI5_AGENT_SPEC.aliases).toEqual(
      expect.arrayContaining(['AI in 5', 'AI5', 'ai5', 'ai5-chat', 'AI新闻', 'AI新聞']),
    );
    expect(AI5_AGENT_SPEC.capabilities?.supportsVoice).toBe(true);

    const nowMs = 1_763_550_000_000;
    const dmDecision = await routeEvent(
      makeEvent({ chatType: 'dm', text: '今天有什麼 AI 新聞？', timestampMs: nowMs }),
      { roomId: '!dm:matrix.netmind.chat', chatType: 'dm', members: [], recentHistory: [] },
      AI5_AGENT_SPEC,
      { nowMs },
    );
    expect(dmDecision.shouldReply).toBe(true);
    expect(dmDecision.detectedLang).toBe('zh-Hant');

    const groupMatch = await routeEvent(
      makeEvent({ text: '今天AI有什么新闻？', timestampMs: nowMs }),
      { roomId: '!grp:matrix.netmind.chat', chatType: 'group', members: [], recentHistory: [] },
      AI5_AGENT_SPEC,
      { nowMs },
    );
    expect(groupMatch.shouldReply).toBe(true);
    expect(groupMatch.detectedLang).toBe('zh-Hans');

    const otherDomain = await routeEvent(
      makeEvent({ text: 'Recommend Sichuan hotpot and dim sum in Chinatown', timestampMs: nowMs }),
      { roomId: '!grp:matrix.netmind.chat', chatType: 'group', members: [], recentHistory: [] },
      AI5_AGENT_SPEC,
      { nowMs },
    );
    expect(otherDomain.shouldReply).toBe(false);
  });

  it('guarantees zero external/D1/DO calls when NARRA_GATEWAY_ENABLED is off', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const prepareSpy = vi.fn();
    const doFetchSpy = vi.fn();
    const disabledEnv: Env = {
      ...baseEnv,
      DB: { prepare: prepareSpy } as unknown as D1Database,
      NARRA_GATEWAY_ENABLED: 'off',
      NARRA_SYNC: 'on',
      NARRA_AGENT_TOKEN: 'narra_tok_disabled',
      NARRA_SYNC_DO: {
        idFromName: (n: string) => n as unknown as DurableObjectId,
        get: () => ({ fetch: doFetchSpy }),
      } as unknown as DurableObjectNamespace,
    };

    expect(isNarraGatewayEnabled(disabledEnv)).toBe(false);
    const res = await kickNarraGateway(disabledEnv, ai5GatewayConfig);
    expect(res).toEqual({
      enabled: false,
      syncKicked: false,
      syncRunning: false,
      broadcast: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(doFetchSpy).not.toHaveBeenCalled();
  });

  it('fetchUpdates queries latest real published issue Top 3 keyed by date and skips sample/draft', async () => {
    const groupRoom = '!ai-news-group:matrix.netmind.chat';
    const dmRoom = '!ai-news-dm:matrix.netmind.chat';
    const syncNs = {
      idFromName: (n: string) => n as unknown as DurableObjectId,
      get: () => ({
        fetch: async () => Response.json({ roomIds: [groupRoom, dmRoom] }),
      }),
    } as unknown as DurableObjectNamespace;
    const roomNs = {
      idFromName: (n: string) => n as unknown as DurableObjectId,
      get: (id: DurableObjectId) => ({
        fetch: async () =>
          Response.json({
            roomId: String(id),
            chatType: String(id) === dmRoom ? 'dm' : 'group',
          }),
      }),
    } as unknown as DurableObjectNamespace;

    const updates = await fetchAi5Updates(
      { ...baseEnv, NARRA_SYNC_DO: syncNs, NARRA_ROOM_DO: roomNs },
      '2026-11-18T00:00:00.000Z',
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].roomId).toBe(groupRoom);
    expect(updates[0].updateKey).toBe('issue:2026-11-19');
    expect(updates[0].text).toContain('AI in 5 No. 42 (2026-11-19)');
    expect(updates[0].text).toContain('• Qilin Lab open-sources a 70B model at 1/8 the running cost —');
    expect(updates[0].text).toContain('• Northwind’s assistant now remembers past chats, on by default —');
    expect(updates[0].text).toContain('• Paris lab Aster raises €600M to build models in 24 languages —');
    expect(updates[0].text).toContain('https://app.manyfold.ai/ai-news/en/2026-11-19/1');
    expect(updates[0].text).not.toContain('\n1. ');
    expect(updates[0].text).not.toMatch(/\n\d+\.\s/);
    expect(updates[0].text).not.toMatch(/\]\(https?:\/\//);

    // Deduplicated across staggered kickNarraGateway runs
    const minute = staggerWindowMinute('ai5-chat', groupRoom, 60);
    const fixedDate = new Date('2026-11-19T19:00:00.000Z');
    fixedDate.setUTCMinutes(minute, 0, 0);
    const sendSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/agent-runtime/chat/send')) {
        return Response.json({ status: 'ok', data: { event_id: '$bcast_1' } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', sendSpy);

    const enabledEnv: Env = {
      ...baseEnv,
      NARRA_GATEWAY_ENABLED: 'on',
      NARRA_SYNC: 'off',
      NARRA_AGENT_TOKEN: 'narra_secret_live_token',
      NARRA_SYNC_DO: {
        idFromName: (n: string) => n as unknown as DurableObjectId,
        get: () => ({
          fetch: async (url: string) =>
            url.endsWith('/kick')
              ? Response.json({ ok: true, enabled: true, running: true })
              : Response.json({ roomIds: [groupRoom] }),
        }),
      } as unknown as DurableObjectNamespace,
      NARRA_ROOM_DO: roomNs,
    };

    const cfg = { ...ai5GatewayConfig, now: () => fixedDate.getTime() };
    const firstKick = await kickNarraGateway(enabledEnv, cfg);
    expect(firstKick.broadcast?.sent).toHaveLength(1);
    const secondKick = await kickNarraGateway(enabledEnv, cfg);
    expect(secondKick.broadcast?.sent).toHaveLength(0);
    expect(secondKick.broadcast?.skipped).toEqual(
      expect.arrayContaining([{ roomId: groupRoom, updateKey: 'issue:2026-11-19', reason: 'duplicate_update_key' }]),
    );
  });

  it('fastRespond answers latest issue queries in zh-Hant, zh-Hans, en, voice, and falls back on specific questions', async () => {
    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };

    const enReply = await fastRespondAi5(
      baseEnv,
      makeEvent({ text: "What is in today's AI news?" }),
      {
        shouldReply: true,
        tier: 0,
        reason: 'explicit_mention',
        confidence: 1,
        detectedLang: 'en',
        shouldQuote: false,
      },
      emptyMem,
    );
    expect(enReply).toContain('AI in 5 No. 42 (2026-11-19)');
    expect(enReply).toContain('• Qilin Lab open-sources a 70B model at 1/8 the running cost —');
    expect(enReply).toContain('• Northwind’s assistant now remembers past chats, on by default —');
    expect(enReply).toContain('• Paris lab Aster raises €600M to build models in 24 languages —');
    expect(enReply).toContain('https://app.manyfold.ai/ai-news/en/2026-11-19/1');
    expect(enReply).not.toContain('\n1. ');
    expect(enReply).not.toMatch(/\n\d+\.\s/);
    expect(enReply).not.toMatch(/\]\(https?:\/\//);

    const hantReply = await fastRespondAi5(
      baseEnv,
      makeEvent({ text: '今天有什麼 AI 新聞？' }),
      {
        shouldReply: true,
        tier: 1,
        reason: 'domain_match',
        confidence: 0.8,
        detectedLang: 'zh-Hant',
        shouldQuote: false,
      },
      emptyMem,
    );
    expect(hantReply).toContain('本期焦點');
    expect(hantReply).toContain('完整期號');
    expect(hantReply).toContain('https://app.manyfold.ai/ai-news/zh/2026-11-19/1');
    expect(hantReply).toContain('\n• ');
    expect(hantReply).not.toContain('\n1. ');
    expect(hantReply).not.toMatch(/\n\d+\.\s/);

    const hansReply = await fastRespondAi5(
      baseEnv,
      makeEvent({ text: '今天有什么AI新闻？' }),
      {
        shouldReply: true,
        tier: 1,
        reason: 'domain_match',
        confidence: 0.8,
        detectedLang: 'zh-Hans',
        shouldQuote: false,
      },
      emptyMem,
    );
    expect(hansReply).toContain('本期焦点');
    expect(hansReply).toContain('完整期号');
    expect(hansReply).toContain('\n• ');
    expect(hansReply).not.toContain('\n1. ');
    expect(hansReply).not.toMatch(/\n\d+\.\s/);

    const voiceReply = await fastRespondAi5(
      baseEnv,
      makeEvent({ chatType: 'dm', text: "Give me today's AI news", isVoice: true }),
      {
        shouldReply: true,
        tier: 0,
        reason: 'dm',
        confidence: 1,
        detectedLang: 'en',
        shouldQuote: false,
      },
      emptyMem,
    );
    expect(voiceReply).toContain('AI in 5 issue 42');
    expect(voiceReply).not.toMatch(/https?:\/\//);
    expect(voiceReply).not.toContain('[');

    const deepQuestion = await fastRespondAi5(
      baseEnv,
      makeEvent({ text: 'What did OpenAI announce in story 2?' }),
      {
        shouldReply: true,
        tier: 0,
        reason: 'explicit_mention',
        confidence: 1,
        detectedLang: 'en',
        shouldQuote: false,
      },
      emptyMem,
    );
    expect(deepQuestion).toBeNull();
  });

  it('resolves Manyfold A2A credential from env override or sealed D1 agents row', async () => {
    const direct = await resolveAi5A2ACredential({
      ...baseEnv,
      MANYFOLD_A2A_URL: 'https://api.manyfold.ai/a2a/ai5/rpc',
      MANYFOLD_A2A_TOKEN: 'a2a_direct_secret',
    });
    expect(direct).toEqual({
      url: 'https://api.manyfold.ai/a2a/ai5/rpc',
      token: 'a2a_direct_secret',
      label: 'AI in 5',
    });

    const sealed = await seal(baseEnv, 'a2a_sealed_secret_tok');
    await db
      .prepare(
        `INSERT OR REPLACE INTO agents
         (agent_id, name, description, rpc_url, card_url, token_ct, token_iv, expires_at, verified, warning, connected_at)
         VALUES (?, ?, '', ?, NULL, ?, ?, NULL, 1, NULL, ?)`,
      )
      .bind(
        AI5_AGENT_ID,
        'AI in 5',
        'https://api.manyfold.ai/api/a2a/agents/agt_agq66pewgf2ovmibamfujrwdqi/rpc',
        sealed.ciphertext,
        sealed.iv,
        new Date().toISOString(),
      )
      .run();

    const fromDb = await resolveAi5A2ACredential(baseEnv);
    expect(fromDb).toEqual({
      url: 'https://api.manyfold.ai/api/a2a/agents/agt_agq66pewgf2ovmibamfujrwdqi/rpc',
      token: 'a2a_sealed_secret_tok',
      label: 'AI in 5',
    });
  });

  it('gates GET /api/gateway/status strictly behind ADMIN_PASSWORD and redacts secrets', async () => {
    const ctx = makeCtx();
    const envWithTokens: Env = {
      ...baseEnv,
      NARRA_AGENT_TOKEN: 'narra_top_secret_never_leak',
      MATRIX_ACCESS_TOKEN: 'syt_matrix_never_leak',
      MANYFOLD_A2A_TOKEN: 'a2a_never_leak',
    };

    const unauth = await worker.fetch(new Request('https://app.manyfold.ai/api/gateway/status'), envWithTokens, ctx);
    expect(unauth.status).toBe(401);

    const unsetAdmin = await worker.fetch(
      new Request('https://app.manyfold.ai/ai-news/api/gateway/status'),
      { ...envWithTokens, ADMIN_PASSWORD: '' },
      ctx,
    );
    expect(unsetAdmin.status).toBe(401);

    const unsetWithEmptyHeader = await worker.fetch(
      new Request('https://app.manyfold.ai/ai-news/api/gateway/status', {
        headers: { 'x-admin-password': '' },
      }),
      { ...envWithTokens, ADMIN_PASSWORD: '' },
      ctx,
    );
    expect(unsetWithEmptyHeader.status).toBe(401);

    const wrongPass = await worker.fetch(
      new Request('https://app.manyfold.ai/ai-news/api/gateway/status', {
        headers: { 'x-admin-password': 'wrong-password' },
      }),
      envWithTokens,
      ctx,
    );
    expect(wrongPass.status).toBe(401);

    const ok = await worker.fetch(
      new Request('https://app.manyfold.ai/ai-news/api/gateway/status', {
        headers: { 'x-admin-password': 'super-secret-admin-password' },
      }),
      envWithTokens,
      ctx,
    );
    expect(ok.status).toBe(200);
    const json = (await ok.json()) as Record<string, unknown>;
    expect(json.enabled).toBe(false);
    expect(json.agentId).toBe('ai5-chat');
    expect(json.matrixId).toBe(AI5_MATRIX_ID);

    const text = JSON.stringify(json);
    expect(text).not.toContain('narra_top_secret_never_leak');
    expect(text).not.toContain('syt_matrix_never_leak');
    expect(text).not.toContain('a2a_never_leak');
    expect(text).not.toContain('super-secret-admin-password');
  });

  it('exports static DO classes and handles */5 * * * * scheduled kick without triggering pipeline', async () => {
    expect(typeof NarraMatrixSync).toBe('function');
    expect(typeof NarraRoomCoordinator).toBe('function');

    const ctx = makeCtx() as ExecutionContext & { flush(): Promise<void> };
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    worker.scheduled(
      { cron: '*/5 * * * *', scheduledTime: Date.UTC(2026, 10, 19, 12, 0, 0), noRetry() {} } as ScheduledController,
      baseEnv,
      ctx,
    );
    await ctx.flush();

    expect(fetchSpy).not.toHaveBeenCalled();
    const runs = await db.prepare('SELECT COUNT(*) AS n FROM pipeline_runs').first<{ n: number }>();
    expect(runs?.n ?? 0).toBe(0);
  });

  it('UC-4: converts Simplified-stored issue content to pure Traditional Chinese when detectedLang is zh-Hant', async () => {
    const uc4Db = sqliteD1();
    await uc4Db.exec(
      `CREATE TABLE IF NOT EXISTS issues (
        date TEXT PRIMARY KEY,
        number INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        data TEXT NOT NULL,
        published_at TEXT,
        updated_at TEXT NOT NULL
      );`,
    );
    const uc4Env: Env = { ...baseEnv, DB: uc4Db };

    const hansStoredIssue = makePublishedIssue('2026-11-19', 88);
    hansStoredIssue.stories[0].title.zh = '网络安全初创完成 5 亿美元轮融资';
    hansStoredIssue.stories[0].summary.zh =
      '这家专注于人工智能网络安全防御的公司宣布完成新一轮融资，规模达 <m0>5 亿美元</m0>。';
    hansStoredIssue.today[0].text.zh = '网络安全平台获 5 亿美元轮融资。';
    hansStoredIssue.briefs[0].text.zh = '某网络安全实验室公布 2 亿美元新轮融资。';
    await saveIssue(uc4Env, '2026-11-19', hansStoredIssue, 'published');

    const event = makeEvent({ text: '@AI in 5 今日 AI 新聞' });
    const decision = await routeEvent(
      event,
      { roomId: event.roomId, chatType: 'group', members: [], recentHistory: [] },
      AI5_AGENT_SPEC,
      { nowMs: event.timestampMs },
    );
    expect(decision.shouldReply).toBe(true);
    expect(decision.detectedLang).toBe('zh-Hant');

    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const reply = await fastRespondAi5(uc4Env, event, decision, emptyMem);
    expect(reply).not.toBeNull();
    expect(reply).toContain('本期焦點');
    expect(reply).toContain('網絡安全');
    expect(reply).toContain('億美元');
    expect(reply).toContain('輪融資');
    expect(reply).not.toContain('网络安全');
    expect(reply).not.toContain('亿美元');
    expect(reply).not.toContain('轮融资');

    // Also verify today-only, briefs-only, and voice branches convert to zh-Hant.
    const todayOnly = formatIssueTop3(
      { ...hansStoredIssue, stories: [] },
      'zh-Hant',
      'https://app.manyfold.ai/ai-news',
    );
    expect(todayOnly).toContain('網絡安全');
    expect(todayOnly).toContain('億美元');
    expect(todayOnly).toContain('輪融資');
    expect(todayOnly).toContain('\n• ');
    expect(todayOnly).not.toContain('\n1. ');
    expect(todayOnly).not.toMatch(/\n\d+\.\s/);
    expect(todayOnly).not.toMatch(/网络安全|亿美元|轮融资/);

    const briefsOnly = formatIssueTop3(
      { ...hansStoredIssue, stories: [], today: [] },
      'zh-Hant',
      'https://app.manyfold.ai/ai-news',
    );
    expect(briefsOnly).toContain('網絡安全');
    expect(briefsOnly).toContain('億美元');
    expect(briefsOnly).toContain('輪融資');
    expect(briefsOnly).toContain('\n• ');
    expect(briefsOnly).not.toContain('\n1. ');
    expect(briefsOnly).not.toMatch(/\n\d+\.\s/);
    expect(briefsOnly).not.toMatch(/网络安全|亿美元|轮融资/);

    const voiceOut = formatIssueTop3(
      hansStoredIssue,
      'zh-Hant',
      'https://app.manyfold.ai/ai-news',
      { voice: true },
    );
    expect(voiceOut).toContain('網絡安全');
    expect(voiceOut).toContain('億美元');
    expect(voiceOut).toContain('輪融資');
    expect(voiceOut).not.toMatch(/网络安全|亿美元|轮融资/);
  });

  it('serves the same published headlines when today comes at the end of the question', async () => {
    const memories = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const post = async (text: string) => {
      const event = makeEvent({ text });
      const context = { roomId: event.roomId, chatType: 'group' as const, members: [], recentHistory: [] };
      const decision = await routeEvent(event, context, AI5_AGENT_SPEC, { nowMs: event.timestampMs });
      expect(decision.shouldReply).toBe(true);
      return fastRespondAi5(baseEnv, event, decision, memories);
    };
    const standard = await post('今天有什麼 AI 新聞？');
    expect(standard).toContain('本期焦點');
    expect(await post('有什麼AI新聞嗎今天')).toEqual(standard);
    expect(isLatestIssueQuery('有什麼 OpenAI 新聞嗎今天', 'group')).toBe(false);
  });

  it('UC-12: strips sibling agent mentions cleanly so @問一籤 @AI in 5 今日 AI 新聞 triggers AI5', async () => {
    const query = '@問一籤 @AI in 5 今日 AI 新聞';
    expect(isLatestIssueQuery(query, 'group')).toBe(true);
    expect(isLatestIssueQuery('@AI Tarot @AI Fortune Stick @AI in 5 latest AI news', 'group')).toBe(true);

    const event = makeEvent({ text: query });
    const decision = await routeEvent(
      event,
      {
        roomId: event.roomId,
        chatType: 'group',
        members: [
          { matrixId: '@agent-fortune:matrix.netmind.chat', displayName: '問一籤', isAgent: true },
          { matrixId: AI5_MATRIX_ID, displayName: 'AI in 5', isAgent: true },
        ],
        recentHistory: [],
      },
      AI5_AGENT_SPEC,
      { nowMs: event.timestampMs },
    );
    expect(decision.shouldReply).toBe(true);
    expect(decision.detectedLang).toBe('zh-Hant');

    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const reply = await fastRespondAi5(baseEnv, event, decision, emptyMem);
    expect(reply).not.toBeNull();
    expect(reply).toContain('AI in 5 第 42 期（2026-11-19）本期焦點');
  });

  it('UC-16: DM bare 你好 (via chatType or decision.reason === "dm") returns instant greeting + Top 3 in zh-Hant', async () => {
    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };

    const dmEvent = makeEvent({ chatType: 'dm', text: '你好' });
    const dmDecision = await routeEvent(
      dmEvent,
      { roomId: '!dm:matrix.netmind.chat', chatType: 'dm', members: [], recentHistory: [] },
      AI5_AGENT_SPEC,
      { nowMs: dmEvent.timestampMs },
    );
    expect(dmDecision.shouldReply).toBe(true);
    expect(dmDecision.reason).toBe('dm');
    expect(dmDecision.detectedLang).toBe('zh-Hant');

    const dmReply = await fastRespondAi5(baseEnv, dmEvent, dmDecision, emptyMem);
    expect(dmReply).not.toBeNull();
    expect(dmReply).toContain('你好！這是 AI in 5 第 42 期的重點速覽（2026-11-19）：');
    expect(dmReply).toContain('https://app.manyfold.ai/ai-news/zh/2026-11-19/1');

    // Also works when event.chatType is 'group' on the wire but router inferred decision.reason === 'dm'
    const inferredDmEvent = makeEvent({ chatType: 'group', text: '你好' });
    const inferredDmReply = await fastRespondAi5(baseEnv, inferredDmEvent, dmDecision, emptyMem);
    expect(inferredDmReply).toBe(dmReply);

    // And when the user explicitly @mentions AI5 alongside the DM greeting
    const mentionedDmEvent = makeEvent({ chatType: 'group', text: '@AI in 5 你好' });
    const mentionedDmReply = await fastRespondAi5(baseEnv, mentionedDmEvent, dmDecision, emptyMem);
    expect(mentionedDmReply).toBe(dmReply);
  });

  it('guards unmentioned group active_session chatter and off-topic turns with [NO_REPLY] instead of falling back to A2A', async () => {
    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const activeSessionDecision = {
      shouldReply: true,
      tier: 0 as const,
      reason: 'active_session',
      confidence: 0.95,
      detectedLang: 'zh-Hant' as const,
      shouldQuote: false,
    };

    const chatterReply = await fastRespondAi5(
      baseEnv,
      makeEvent({ chatType: 'group', text: '今天天氣真不錯，晚上想早點休息' }),
      activeSessionDecision,
      emptyMem,
    );
    expect(chatterReply).toBe('[NO_REPLY]');

    const offTopicAntiReply = await fastRespondAi5(
      baseEnv,
      makeEvent({ chatType: 'group', text: '這週末 Soho 有什麼免費快閃活動？' }),
      activeSessionDecision,
      emptyMem,
    );
    expect(offTopicAntiReply).toBe('[NO_REPLY]');

    const bareGreetingReply = await fastRespondAi5(
      baseEnv,
      makeEvent({ chatType: 'group', text: '你好' }),
      activeSessionDecision,
      emptyMem,
    );
    expect(bareGreetingReply).toBe('[NO_REPLY]');

    const genuineActiveQuery = await fastRespondAi5(
      baseEnv,
      makeEvent({ chatType: 'group', text: '今天有什麼 AI 新聞？' }),
      activeSessionDecision,
      emptyMem,
    );
    expect(genuineActiveQuery).toContain('本期焦點');

    const sourceFollowUp = await fastRespondAi5(
      baseEnv,
      makeEvent({ chatType: 'group', text: '那有原始公告嗎？丟官方連結就好。' }),
      activeSessionDecision,
      emptyMem,
    );
    expect(sourceFollowUp).toBeNull();

    const specificFollowUp = await fastRespondAi5(
      baseEnv,
      makeEvent({ chatType: 'group', text: 'What did OpenAI announce in story 2?' }),
      { ...activeSessionDecision, detectedLang: 'en' },
      emptyMem,
    );
    expect(specificFollowUp).toBeNull();
  });

  it('distinguishes a single story’s media report from an official release page', async () => {
    const env = baseEnv;
    const issue = makePublishedIssue('2026-11-17', 40);
    issue.stories[0]!.sources = issue.stories[0]!.sources.map((source) => ({
      ...source, kind: 'reported', name: { en: 'Example News', zh: '新聞媒體' },
      lang: 'zh', time: '2026-11-17T11:00:00Z', url: 'https://example.com/coverage',
    }));
    await saveIssue(env, issue.date, issue, 'published');

    const event = makeEvent({ text: '這則有官方發布頁嗎？只有媒體來源也可以直接說。' });
    const context = {
      roomId: event.roomId, chatType: 'group' as const, members: [],
      activeSession: { active: true },
      recentHistory: [{
        eventId: '$single-story', senderId: AI5_MATRIX_ID, isAgent: true, isSelf: true,
        text: 'https://app.manyfold.ai/ai-news/zh/2026-11-17/1\nhttps://app.manyfold.ai/ai-news/zh/2026-11-17',
        timestampMs: event.timestampMs - 1000,
      }],
    };
    const decision = await routeEvent(event, context, AI5_AGENT_SPEC, { nowMs: event.timestampMs });
    expect(decision.reason).toBe('active_session');
    const memories = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const reply = await fastRespondAi5(env, event, decision, memories, context);
    expect(reply).toContain('沒有列出官方來源');
    expect(reply).toContain('https://example.com/coverage');
    expect(await fastRespondAi5(env, event, decision, memories)).toBeNull();
  });

  it('requires AI-qualified terms so non-AI bare model/chip/issue/模型 do not false-trigger heuristicDomainScore', async () => {
    const grpCtx = { roomId: '!grp:matrix.netmind.chat', chatType: 'group' as const, members: [], recentHistory: [] };

    expect(heuristicDomainScore(makeEvent({ text: 'I bought a new model train kit today' }), AI5_AGENT_SPEC, grpCtx)).toBeLessThan(0.55);
    expect(heuristicDomainScore(makeEvent({ text: 'Want some fish and chips tonight?' }), AI5_AGENT_SPEC, grpCtx)).toBeLessThan(0.55);
    expect(heuristicDomainScore(makeEvent({ text: 'My car has a brake issue on the motorway' }), AI5_AGENT_SPEC, grpCtx)).toBeLessThan(0.55);
    expect(heuristicDomainScore(makeEvent({ text: '我買了一盒鋼彈模型要組裝' }), AI5_AGENT_SPEC, grpCtx)).toBeLessThan(0.55);
    expect(heuristicDomainScore(makeEvent({ text: '手機晶片好像有點發熱問題' }), AI5_AGENT_SPEC, grpCtx)).toBeLessThan(0.55);

    const nonAiRoute = await routeEvent(
      makeEvent({ text: '我朋友昨天去秋葉原買了超帥的鋼彈模型' }),
      grpCtx,
      AI5_AGENT_SPEC,
      { nowMs: 1_763_550_000_000 },
    );
    expect(nonAiRoute.shouldReply).toBe(false);

    // AI-qualified terms continue to trigger >= 0.55
    expect(heuristicDomainScore(makeEvent({ text: 'Any new AI models launched this week?' }), AI5_AGENT_SPEC, grpCtx)).toBeGreaterThanOrEqual(0.55);
    expect(heuristicDomainScore(makeEvent({ text: 'Any new AI chip updates?' }), AI5_AGENT_SPEC, grpCtx)).toBeGreaterThanOrEqual(0.55);
    expect(heuristicDomainScore(makeEvent({ text: 'Any foundation model releases today?' }), AI5_AGENT_SPEC, grpCtx)).toBeGreaterThanOrEqual(0.55);
    expect(heuristicDomainScore(makeEvent({ text: 'AI模型最近表現如何？' }), AI5_AGENT_SPEC, grpCtx)).toBeGreaterThanOrEqual(0.55);
    expect(heuristicDomainScore(makeEvent({ text: 'AI晶片和大模型有什麼消息？' }), AI5_AGENT_SPEC, grpCtx)).toBeGreaterThanOrEqual(0.55);
    expect(heuristicDomainScore(makeEvent({ text: 'AI芯片最新動態？' }), AI5_AGENT_SPEC, grpCtx)).toBeGreaterThanOrEqual(0.55);
    expect(
      heuristicDomainScore(
        makeEvent({ text: '剛跟朋友逛完 Camden 市集超累，順便問一下大家今天 Anthropic 或 OpenAI 有發新模型嗎？' }),
        AI5_AGENT_SPEC,
        grpCtx,
      ),
    ).toBeGreaterThanOrEqual(0.55);
  });

  it('defers AI hackathons/scholarships/food-recalls to Manyfold Data and delegates Chinese numeral story follow-ups to A2A', async () => {
    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const grpCtx = { roomId: '!grp:matrix.netmind.chat', chatType: 'group' as const, members: [], recentHistory: [] };

    const hackathonQuery = '下個月倫敦有什麼 AI 黑客松可以報名嗎？';
    expect(heuristicDomainScore(makeEvent({ text: hackathonQuery }), AI5_AGENT_SPEC, grpCtx)).toBeLessThan(AI5_AGENT_SPEC.silenceThreshold ?? 0.55);

    const unmentionedDecision = {
      shouldReply: true,
      tier: 1 as const,
      reason: 'model_triage',
      confidence: 0.7,
      detectedLang: 'zh-Hant' as const,
      shouldQuote: false,
    };
    const hackathonReply = await fastRespondAi5(
      baseEnv,
      makeEvent({ chatType: 'group', text: hackathonQuery }),
      unmentionedDecision,
      emptyMem,
    );
    expect(hackathonReply).toBe('[NO_REPLY]');

    const activeSessionDecision = {
      shouldReply: true,
      tier: 0 as const,
      reason: 'active_session',
      confidence: 0.95,
      detectedLang: 'zh-Hant' as const,
      shouldQuote: false,
    };
    const zhNumeralFollowup = await fastRespondAi5(
      baseEnv,
      makeEvent({ chatType: 'group', text: '詳細講講第一條？' }),
      activeSessionDecision,
      emptyMem,
    );
    expect(zhNumeralFollowup).toBeNull();
  });

  it('I2: responds immediately to bare @AI in 5 or explicit_mention greetings with issue + greeting or trilingual fallback', async () => {
    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const grpCtx = {
      roomId: '!grp_bare:matrix.netmind.chat',
      chatType: 'group' as const,
      userLanguageHint: 'zh-Hant' as const,
      members: [
        { matrixId: '@alice:matrix.netmind.chat', displayName: 'Alice', isAgent: false },
        { matrixId: AI5_MATRIX_ID, displayName: 'AI in 5', isAgent: true },
      ],
      recentHistory: [],
    };

    const bareMentionEv = makeEvent({
      roomId: grpCtx.roomId,
      chatType: 'group',
      text: '@AI in 5',
      mentions: [AI5_MATRIX_ID],
    });
    const bareDecision = await routeEvent(bareMentionEv, grpCtx, AI5_AGENT_SPEC, {
      nowMs: bareMentionEv.timestampMs,
    });
    expect(bareDecision.shouldReply).toBe(true);
    expect(bareDecision.reason).toBe('explicit_mention');
    expect(bareDecision.detectedLang).toBe('zh-Hant');

    const bareReplyWithIssue = await fastRespondAi5(baseEnv, bareMentionEv, bareDecision, emptyMem);
    expect(bareReplyWithIssue).not.toBeNull();
    expect(bareReplyWithIssue).toContain('你好！這是 AI in 5 第 42 期的重點速覽（2026-11-19）：');
    expect(bareReplyWithIssue).toContain('https://app.manyfold.ai/ai-news/zh/2026-11-19/1');

    // Explicit mention with greeting also triggers greeting + issue
    const explicitHiEv = makeEvent({
      roomId: grpCtx.roomId,
      chatType: 'group',
      text: '@AI in 5 hello',
      mentions: [AI5_MATRIX_ID],
    });
    const explicitHiDecision = await routeEvent(
      explicitHiEv,
      { ...grpCtx, userLanguageHint: undefined },
      AI5_AGENT_SPEC,
      { nowMs: explicitHiEv.timestampMs },
    );
    expect(explicitHiDecision.reason).toBe('explicit_mention');
    expect(explicitHiDecision.detectedLang).toBe('en');
    const explicitHiReply = await fastRespondAi5(baseEnv, explicitHiEv, explicitHiDecision, emptyMem);
    expect(explicitHiReply).toContain("Hi! Here is AI in 5 issue 42 (2026-11-19):");

    // When no published issue exists yet, returns friendly trilingual greeting fallback instead of null
    const emptyIssueDb = sqliteD1();
    await ensureSchema(emptyIssueDb);
    const noIssueEnv: Env = { ...baseEnv, DB: emptyIssueDb };

    const hantFallback = await fastRespondAi5(noIssueEnv, bareMentionEv, bareDecision, emptyMem);
    expect(hantFallback).toContain('嗨！我是 AI in 5');
    expect(hantFallback).toContain('新聞重點');

    const hansFallback = await fastRespondAi5(
      noIssueEnv,
      bareMentionEv,
      { ...bareDecision, detectedLang: 'zh-Hans' },
      emptyMem,
    );
    expect(hansFallback).toContain('嗨！我是 AI in 5');
    expect(hansFallback).toContain('新闻重点');

    const enFallback = await fastRespondAi5(noIssueEnv, explicitHiEv, explicitHiDecision, emptyMem);
    expect(enFallback).toContain("Hi! I'm AI in 5");
    expect(enFallback).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('H1/H3 kit routing: answers post-pivot AI question after hotpot backdrop and suppresses ramen/noodle shop queries', async () => {
    const grpCtx = {
      roomId: '!grp_h1_h3:matrix.netmind.chat',
      chatType: 'group' as const,
      members: [
        { matrixId: '@alice:matrix.netmind.chat', displayName: 'Alice', isAgent: false },
        { matrixId: AI5_MATRIX_ID, displayName: 'AI in 5', isAgent: true },
        { matrixId: '@agent-b2b526f3:matrix.netmind.chat', displayName: 'London Chinese Food', isAgent: true },
      ],
      recentHistory: [],
    };
    const aiMock = {
      run: vi.fn(async () => ({ response: JSON.stringify({ score: 0.1, reason: 'peer_domain' }) })),
    };
    const triageModel = createWorkersAiTriageModel(aiMock);

    // H1: Past-tense food backdrop + pivot + primary AI question -> deterministic domain_match (0 LLM calls)
    const h1Text = '剛在唐人街吃完火鍋超撐，順便問一下今天 OpenAI 或 Anthropic 有發新模型嗎？';
    const h1Decision = await routeEvent(
      makeEvent({ text: h1Text, timestampMs: 1_763_550_000_000 }),
      grpCtx,
      AI5_AGENT_SPEC,
      { nowMs: 1_763_550_000_000, triageModel },
    );
    expect(h1Decision.shouldReply).toBe(true);
    expect(h1Decision.reason).toBe('domain_match');
    expect(h1Decision.confidence).toBeGreaterThanOrEqual(0.92);
    expect(aiMock.run).not.toHaveBeenCalled();

    // H3 primary AI ask before pivot -> deterministic domain_match
    const h3PrimaryAi = '今天 OpenAI 或 Anthropic 有發什麼新模型嗎？順便問一下倫敦中國城有好吃的拉麵館嗎？';
    const h3PrimaryDecision = await routeEvent(
      makeEvent({ text: h3PrimaryAi, timestampMs: 1_763_550_000_000 }),
      grpCtx,
      AI5_AGENT_SPEC,
      { nowMs: 1_763_550_000_000, triageModel },
    );
    expect(h3PrimaryDecision.shouldReply).toBe(true);
    expect(h3PrimaryDecision.reason).toBe('domain_match');
    expect(aiMock.run).not.toHaveBeenCalled();

    // Ramen/noodle shop queries (antiKeywords) score below threshold and yield
    expect(AI5_AGENT_SPEC.antiKeywords).toEqual(
      expect.arrayContaining(['拉麵', '拉面', '麵館', '面馆']),
    );
    for (const ramenText of [
      '倫敦中國城哪家拉麵館比較好吃？',
      '伦敦有什么正宗拉面馆推荐吗？',
      '倫敦中國城有什麼好吃的拉麵館嗎？順便問一下今天 OpenAI 有發新模型嗎？',
    ]) {
      expect(heuristicDomainScore(makeEvent({ text: ramenText }), AI5_AGENT_SPEC, grpCtx), ramenText).toBeLessThan(
        AI5_AGENT_SPEC.silenceThreshold ?? 0.55,
      );
      const dec = await routeEvent(
        makeEvent({ text: ramenText, timestampMs: 1_763_550_000_000 }),
        grpCtx,
        AI5_AGENT_SPEC,
        { nowMs: 1_763_550_000_000, triageModel },
      );
      expect(dec.shouldReply, ramenText).toBe(false);
    }
  });

  it('H1 local D1 today-topic lookup answers OpenAI/Anthropic model question without A2A calls', async () => {
    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const grpCtx = {
      roomId: '!grp_h1_local:matrix.netmind.chat',
      chatType: 'group' as const,
      members: [
        { matrixId: '@alice:matrix.netmind.chat', displayName: 'Alice', isAgent: false },
        { matrixId: AI5_MATRIX_ID, displayName: 'AI in 5', isAgent: true },
        { matrixId: '@agent-b2b526f3:matrix.netmind.chat', displayName: 'London Chinese Food', isAgent: true },
      ],
      recentHistory: [],
    };
    const h1Text = '剛在唐人街吃完火鍋超撐，順便問一下今天 OpenAI 或 Anthropic 有發新模型嗎？';
    const h1Event = makeEvent({ roomId: grpCtx.roomId, text: h1Text, timestampMs: 1_763_550_000_000 });
    const h1Decision = await routeEvent(h1Event, grpCtx, AI5_AGENT_SPEC, { nowMs: h1Event.timestampMs });
    expect(h1Decision.shouldReply).toBe(true);
    expect(h1Decision.detectedLang).toBe('zh-Hant');

    // No OpenAI/Anthropic in SAMPLE_ISSUE -> clean zh-Hant reply noting absence + top headlines + bare URL, 0 A2A calls
    const h1Reply = await fastRespondAi5(baseEnv, h1Event, h1Decision, emptyMem);
    expect(h1Reply).not.toBeNull();
    expect(h1Reply).toContain('第 42 期（2026-11-19）沒有提到 OpenAI、Anthropic 的相關更新');
    expect(h1Reply).toContain('本期重點新聞頭條');
    expect(h1Reply).toContain('• 麒麟實驗室開源 70B 模型');
    expect(h1Reply).toContain('https://app.manyfold.ai/ai-news/zh/2026-11-19');
    expect(h1Reply).not.toContain('\n1. ');
    expect(h1Reply).not.toMatch(/\n\d+\.\s/);
    expect(h1Reply).not.toMatch(/\]\(https?:\/\//);
    expect(h1Reply).not.toMatch(/实验室|开源|默认|记忆/);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Also test when latest issue DOES contain Anthropic & OpenAI updates (with Simplified Chinese converted to zh-Hant)
    const createIssuesTable = async (targetDb: D1Database) => {
      await targetDb.exec(
        `CREATE TABLE IF NOT EXISTS issues (
          date TEXT PRIMARY KEY,
          number INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft',
          data TEXT NOT NULL,
          published_at TEXT,
          updated_at TEXT NOT NULL
        );`,
      );
    };
    const topicDb = sqliteD1();
    await createIssuesTable(topicDb);
    const topicEnv: Env = { ...baseEnv, DB: topicDb };
    const matchedIssue = makePublishedIssue('2026-11-20', 43);
    matchedIssue.stories[0].org = { name: 'Anthropic', logo: matchedIssue.stories[0].org!.logo };
    matchedIssue.stories[0].title = {
      en: 'Anthropic launches Claude 4.5 for coding agents',
      zh: 'Anthropic 发布 Claude 4.5 编码模型',
    };
    matchedIssue.stories[0].summary = {
      en: 'Anthropic released Claude 4.5 with <m0>40%</m0> lower latency on tool-use tasks.',
      zh: 'Anthropic 宣布发布新一代模型，工具调用延迟降低 <m0>40%</m0>。',
    };
    matchedIssue.briefs[0].org = { name: 'OpenAI', logo: matchedIssue.briefs[0].org!.logo };
    matchedIssue.briefs[0].text = {
      en: 'OpenAI lowered GPT API batch pricing by 25%.',
      zh: 'OpenAI 将 GPT 批量接口价格下调 25%。',
    };
    await saveIssue(topicEnv, '2026-11-20', matchedIssue, 'published');

    const matchedHant = await fastRespondAi5(topicEnv, h1Event, h1Decision, emptyMem);
    expect(matchedHant).not.toBeNull();
    expect(matchedHant).toContain('第 43 期（2026-11-20）關於 OpenAI、Anthropic 的動態');
    expect(matchedHant).toContain('• Anthropic 發布 Claude 4.5 編碼模型 —');
    expect(matchedHant).toContain('• OpenAI 將 GPT 批量接口價格下調 25%');
    expect(matchedHant).toContain('https://app.manyfold.ai/ai-news/zh/2026-11-20/1');
    expect(matchedHant).toContain('https://app.manyfold.ai/ai-news/zh/2026-11-20');
    expect(matchedHant).not.toContain('\n1. ');
    expect(matchedHant).not.toMatch(/\n\d+\.\s/);
    expect(matchedHant).not.toMatch(/\]\(https?:\/\//);
    expect(matchedHant).not.toMatch(/发布|编码|将|价格/);

    // English & voice variants (and multi-story topic reply bullet formatting)
    const enMatchReply = formatTodayTopicReply(
      matchedIssue,
      'Did OpenAI or Anthropic launch anything today?',
      'en',
      'https://app.manyfold.ai/ai-news',
      false,
    );
    expect(enMatchReply).toContain('AI in 5 No. 43 (2026-11-20) — updates on OpenAI and Anthropic:');
    expect(enMatchReply).toContain('• Anthropic launches Claude 4.5 for coding agents —');
    expect(enMatchReply).toContain('• OpenAI lowered GPT API batch pricing by 25%.');
    expect(enMatchReply).toContain('https://app.manyfold.ai/ai-news/en/2026-11-20/1');
    expect(enMatchReply).toContain('Full issue: https://app.manyfold.ai/ai-news/en/2026-11-20');
    expect(enMatchReply).not.toContain('\n1. ');
    expect(enMatchReply).not.toMatch(/\n\d+\.\s/);

    const multiStoryTopicIssue = structuredClone(matchedIssue);
    multiStoryTopicIssue.stories[1].org = { name: 'OpenAI', logo: matchedIssue.stories[1].org!.logo };
    multiStoryTopicIssue.stories[1].title = {
      en: 'OpenAI expands memory controls',
      zh: 'OpenAI 扩展记忆控制功能',
    };
    const multiStoryTopicReply = formatTodayTopicReply(
      multiStoryTopicIssue,
      'Did OpenAI or Anthropic launch anything today?',
      'en',
      'https://app.manyfold.ai/ai-news',
      false,
    );
    expect(multiStoryTopicReply).toContain('• Anthropic launches Claude 4.5 for coding agents —');
    expect(multiStoryTopicReply).toContain('https://app.manyfold.ai/ai-news/en/2026-11-20/1');
    expect(multiStoryTopicReply).toContain('• OpenAI expands memory controls —');
    expect(multiStoryTopicReply).toContain('https://app.manyfold.ai/ai-news/en/2026-11-20/2');
    expect(multiStoryTopicReply).not.toContain('\n1. ');
    expect(multiStoryTopicReply).not.toMatch(/\n\d+\.\s/);

    const oneRelease = formatTodayTopicReply(
      matchedIssue,
      '活動先放著，最近有什麼 AI 模型發布的新聞？有的話挑一則。',
      'zh-Hant',
      'https://app.manyfold.ai/ai-news',
      false,
    );
    expect(oneRelease).toContain('Anthropic 發布 Claude 4.5 編碼模型');
    expect(oneRelease.match(/^• /gm)).toHaveLength(1);
    expect(oneRelease).not.toContain('價格下調');

    const voiceNoMatch = formatTodayTopicReply(
      matchedIssue,
      'Any recent DeepSeek model launches?',
      'en',
      'https://app.manyfold.ai/ai-news',
      true,
    );
    expect(voiceNoMatch).toContain("doesn't mention updates from DeepSeek");
    expect(voiceNoMatch).not.toMatch(/https?:\/\//);
    expect(voiceNoMatch).not.toContain('[');

    // Deep/A2A intents, non-today entity queries, and empty D1 still return null for A2A fallback
    for (const a2aText of [
      '為什麼今天 OpenAI 發布新模型？',
      '詳細講講今天 Anthropic 發布的新模型',
      'Compare today OpenAI launch with Anthropic',
      '2026-11-18 OpenAI 有發新模型嗎？',
      'OpenAI 有什麼消息',
    ]) {
      const a2aReply = await fastRespondAi5(
        topicEnv,
        makeEvent({ roomId: grpCtx.roomId, text: a2aText }),
        { ...h1Decision, reason: 'explicit_mention' },
        emptyMem,
      );
      expect(a2aReply, a2aText).toBeNull();
    }

    const emptyDb = sqliteD1();
    await createIssuesTable(emptyDb);
    const noIssueReply = await fastRespondAi5({ ...baseEnv, DB: emptyDb }, h1Event, h1Decision, emptyMem);
    expect(noIssueReply).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('handles 1v1 DM thanks, capability prompts, off-topic redirects, and toZhHant leak fixes cleanly', async () => {
    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const dmCtx = { roomId: '!dm_1v1:matrix.netmind.chat', chatType: 'dm' as const, members: [], recentHistory: [] };

    // 1. DM off-topic redirect (zh-Hant, zh-Hans, en)
    const rainEv = makeEvent({ roomId: dmCtx.roomId, chatType: 'dm', text: '倫敦今天會下雨嗎？' });
    const rainDecision = await routeEvent(rainEv, dmCtx, AI5_AGENT_SPEC, { nowMs: rainEv.timestampMs });
    expect(rainDecision.shouldReply).toBe(true);
    expect(rainDecision.detectedLang).toBe('zh-Hant');
    const rainReply = await fastRespondAi5(baseEnv, rainEv, rainDecision, emptyMem);
    expect(rainReply).toBe(
      '我主要是幫你追蹤每日 AI 新聞重點、模型發布與產業動態，天氣或非 AI 話題比較不在我的範圍喔！要看看今天的 AI 重點新聞嗎？',
    );

    const btcEv = makeEvent({ roomId: dmCtx.roomId, chatType: 'dm', text: '今天比特币多少钱？' });
    const btcDecision = await routeEvent(btcEv, dmCtx, AI5_AGENT_SPEC, { nowMs: btcEv.timestampMs });
    expect(btcDecision.detectedLang).toBe('zh-Hans');
    expect(await fastRespondAi5(baseEnv, btcEv, btcDecision, emptyMem)).toBe(
      '我主要是帮你追踪每日 AI 新闻重点、模型发布与产业动态，天气或非 AI 话题比较不在我的范围哦！要看看今天的 AI 重点新闻吗？',
    );

    const forecastEv = makeEvent({ roomId: dmCtx.roomId, chatType: 'dm', text: "What's the weather forecast today?" });
    const forecastDecision = await routeEvent(forecastEv, dmCtx, AI5_AGENT_SPEC, { nowMs: forecastEv.timestampMs });
    expect(forecastDecision.detectedLang).toBe('en');
    expect(await fastRespondAi5(baseEnv, forecastEv, forecastDecision, emptyMem)).toBe(
      "I focus on daily AI news briefings, model launches, and industry updates, so that's a bit outside my lane! Want to see today's top AI stories?",
    );

    // 2. DM thanks reply (zh-Hant, zh-Hans, en) + unmentioned group active_session silence + AI-question guard
    const thxEv = makeEvent({ roomId: dmCtx.roomId, chatType: 'dm', text: '謝謝' });
    const thxDecision = await routeEvent(thxEv, dmCtx, AI5_AGENT_SPEC, { nowMs: thxEv.timestampMs });
    expect(thxDecision.detectedLang).toBe('zh-Hant');
    expect(await fastRespondAi5(baseEnv, thxEv, thxDecision, emptyMem)).toBe(
      '不客氣！隨時想看今日 AI 新聞重點或查特定 AI 模型動態，直接問我就好 📰',
    );

    const thxHansEv = makeEvent({ roomId: dmCtx.roomId, chatType: 'dm', text: '谢谢！' });
    const thxHansDecision = await routeEvent(thxHansEv, dmCtx, AI5_AGENT_SPEC, { nowMs: thxHansEv.timestampMs });
    expect(thxHansDecision.detectedLang).toBe('zh-Hans');
    expect(await fastRespondAi5(baseEnv, thxHansEv, thxHansDecision, emptyMem)).toBe(
      '不客气！随时想看今日 AI 新闻重点或查特定 AI 模型动态，直接问我就好 📰',
    );

    const thxEnEv = makeEvent({ roomId: dmCtx.roomId, chatType: 'dm', text: 'thanks!' });
    const thxEnDecision = await routeEvent(thxEnEv, dmCtx, AI5_AGENT_SPEC, { nowMs: thxEnEv.timestampMs });
    expect(thxEnDecision.detectedLang).toBe('en');
    expect(await fastRespondAi5(baseEnv, thxEnEv, thxEnDecision, emptyMem)).toBe(
      "You're welcome! Ask anytime for today's top AI news or updates on any AI model 📰",
    );

    expect(
      await fastRespondAi5(
        baseEnv,
        makeEvent({ chatType: 'group', text: '謝謝' }),
        {
          shouldReply: true,
          tier: 0,
          reason: 'active_session',
          confidence: 0.95,
          detectedLang: 'zh-Hant',
          shouldQuote: false,
        },
        emptyMem,
      ),
    ).toBe('[NO_REPLY]');

    // Thanks + AI question still answers the AI question rather than thanks reply
    const thxWithNewsEv = makeEvent({ roomId: dmCtx.roomId, chatType: 'dm', text: '謝謝，今天有什麼 AI 新聞？' });
    const thxWithNewsDecision = await routeEvent(thxWithNewsEv, dmCtx, AI5_AGENT_SPEC, {
      nowMs: thxWithNewsEv.timestampMs,
    });
    expect(await fastRespondAi5(baseEnv, thxWithNewsEv, thxWithNewsDecision, emptyMem)).toContain('本期焦點');

    // 3. Capability questions trigger greeting + Top 3
    const capEv = makeEvent({ roomId: dmCtx.roomId, chatType: 'dm', text: '你能幫我查什麼？' });
    const capDecision = await routeEvent(capEv, dmCtx, AI5_AGENT_SPEC, { nowMs: capEv.timestampMs });
    const capReply = await fastRespondAi5(baseEnv, capEv, capDecision, emptyMem);
    expect(capReply).toContain('你好！這是 AI in 5 第 42 期的重點速覽（2026-11-19）：');
    expect(capReply).toContain('https://app.manyfold.ai/ai-news/zh/2026-11-19/1');

    const capEnEv = makeEvent({ roomId: dmCtx.roomId, chatType: 'dm', text: 'what can you do?' });
    const capEnDecision = await routeEvent(capEnEv, dmCtx, AI5_AGENT_SPEC, { nowMs: capEnEv.timestampMs });
    const capEnReply = await fastRespondAi5(baseEnv, capEnEv, capEnDecision, emptyMem);
    expect(capEnReply).toContain("Hi! Here is AI in 5 issue 42 (2026-11-19):");

    // 4. Deep AI follow-ups in DM preserve null return for A2A
    for (const deepText of ['why?', 'story 2', 'compare OpenAI and Anthropic']) {
      const deepEv = makeEvent({ roomId: dmCtx.roomId, chatType: 'dm', text: deepText });
      const deepDecision = await routeEvent(deepEv, dmCtx, AI5_AGENT_SPEC, { nowMs: deepEv.timestampMs });
      expect(await fastRespondAi5(baseEnv, deepEv, deepDecision, emptyMem), deepText).toBeNull();
    }

    // 5. Upgraded narra-agent-kit toZhHant fixes 监控/诉讼/遭袭/基础/账单 -> 監控/訴訟/遭襲/基礎/帳單
    expect(toZhHant('监控/诉讼/遭袭/基础/账单')).toBe('監控/訴訟/遭襲/基礎/帳單');
    const leakIssue = makePublishedIssue('2026-11-20', 44);
    leakIssue.stories[0].title.zh = '监管监控与诉讼遭袭事件升级';
    leakIssue.stories[0].summary.zh = '基础设施账单成本受到关注。';
    const formattedLeak = formatIssueTop3(leakIssue, 'zh-Hant', 'https://app.manyfold.ai/ai-news');
    expect(formattedLeak).toContain('監管監控與訴訟遭襲事件升級');
    expect(formattedLeak).toContain('基礎設施帳單成本受到關注');
    expect(formattedLeak).not.toMatch(/监控|诉讼|遭袭|基础|账单/);
  });

  it('wires enableA2AFailureReply, trilingual thinkingMessage, and <=1600 char D1 prefetch in ai5GatewayConfig', async () => {
    expect(ai5GatewayConfig.enableA2AFailureReply).toBe(true);
    expect(typeof ai5GatewayConfig.thinkingMessage).toBe('function');
    expect(typeof ai5GatewayConfig.buildExtraEnvelopeFields).toBe('function');

    const dummyEv = makeEvent({ chatType: 'dm', text: 'compare OpenAI and Anthropic' });
    const dummyDecision = {
      shouldReply: true,
      tier: 0 as const,
      reason: 'dm',
      confidence: 1,
      detectedLang: 'zh-Hant' as const,
      shouldQuote: false,
    };

    expect(ai5GatewayConfig.thinkingMessage!('zh-Hant', dummyEv, dummyDecision)).toBe(
      '📰 正在幫你整理最新 AI 新聞與重點分析，稍等一下…',
    );
    expect(ai5GatewayConfig.thinkingMessage!('zh-Hans', dummyEv, { ...dummyDecision, detectedLang: 'zh-Hans' })).toBe(
      '📰 正在帮你整理最新 AI 新闻与重点分析，稍等一下…',
    );
    expect(ai5GatewayConfig.thinkingMessage!('en', dummyEv, { ...dummyDecision, detectedLang: 'en' })).toBe(
      '📰 Checking the latest AI news details for you, one moment…',
    );

    // English prefetch includes issue number, date, all stories with headlines, summaries, and source URLs
    const enPrefetch = await buildAi5ExtraEnvelopeFields(baseEnv, dummyEv, { ...dummyDecision, detectedLang: 'en' });
    expect(enPrefetch).not.toBeNull();
    expect(enPrefetch!.d1_prefetched_records).toContain('AI in 5 No. 42 (2026-11-19)');
    expect(enPrefetch!.d1_prefetched_records).toContain('Qilin Lab open-sources a 70B model');
    expect(enPrefetch!.d1_prefetched_records).toContain('Northwind’s assistant now remembers past chats');
    expect(enPrefetch!.d1_prefetched_records).toContain('Paris lab Aster raises €600M');
    expect(enPrefetch!.d1_prefetched_records).toMatch(/https?:\/\//);
    expect(enPrefetch!.d1_prefetched_records.length).toBeLessThanOrEqual(1600);

    // Traditional Chinese prefetch converts Simplified-stored issue text cleanly and caps <= 1600 chars even for packed issues
    const packedDb = sqliteD1();
    await packedDb.exec(
      `CREATE TABLE IF NOT EXISTS issues (
        date TEXT PRIMARY KEY,
        number INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        data TEXT NOT NULL,
        published_at TEXT,
        updated_at TEXT NOT NULL
      );`,
    );
    const packedEnv: Env = { ...baseEnv, DB: packedDb };
    const packedIssue = makePublishedIssue('2026-11-20', 99);
    const baseStory = structuredClone(packedIssue.stories[0]!);
    packedIssue.stories = Array.from({ length: 8 }, (_, idx) => {
      const s = structuredClone(baseStory);
      s.id = `story-${idx + 1}`;
      s.title.zh = `网络安全实验室第 ${idx + 1} 轮融资与开源模型进展`;
      s.summary.zh =
        '这家专注于人工智能网络安全防御与基础设施研发的公司发布新一代开源模型，推理成本大幅下降并且开放商业授权给全球开发者。'.repeat(
          3,
        );
      return s;
    });
    packedIssue.today = packedIssue.stories.slice(0, 3).map((s) => ({
      id: s.id,
      text: s.title,
    }));
    await saveIssue(packedEnv, '2026-11-20', packedIssue, 'published');

    const hantPrefetch = await buildAi5ExtraEnvelopeFields(packedEnv, dummyEv, dummyDecision);
    expect(hantPrefetch).not.toBeNull();
    expect(hantPrefetch!.d1_prefetched_records).toContain('AI in 5 No. 99 (2026-11-20)');
    expect(hantPrefetch!.d1_prefetched_records).toContain('網絡安全實驗室');
    expect(hantPrefetch!.d1_prefetched_records).not.toMatch(/网络安全|实验室|开源|融资/);
    expect(hantPrefetch!.d1_prefetched_records.length).toBeLessThanOrEqual(1600);

    // Empty DB returns null cleanly
    const emptyDb = sqliteD1();
    await ensureSchema(emptyDb);
    expect(await buildAi5ExtraEnvelopeFields({ ...baseEnv, DB: emptyDb }, dummyEv, dummyDecision)).toBeNull();
  });

  it('handles explicit local expand requests (展開第 2 條 / 第 2 条详细说说) in pure zh-Hant/zh-Hans/en while keeping A2A follow-ups null', async () => {
    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const dmCtx = { roomId: '!dm_expand:matrix.netmind.chat', chatType: 'dm' as const, members: [], recentHistory: [] };

    const expandHantEv = makeEvent({ roomId: dmCtx.roomId, chatType: 'dm', text: '展開第 2 條' });
    const expandHantDecision = await routeEvent(expandHantEv, dmCtx, AI5_AGENT_SPEC, { nowMs: expandHantEv.timestampMs });
    expect(expandHantDecision.detectedLang).toBe('zh-Hant');
    const expandHantReply = await fastRespondAi5(baseEnv, expandHantEv, expandHantDecision, emptyMem);
    expect(expandHantReply).not.toBeNull();
    expect(expandHantReply).toContain('AI in 5 第 42 期（2026-11-19）第 2 條');
    expect(expandHantReply).toContain('為什麼重要：');
    expect(expandHantReply).toContain('https://app.manyfold.ai/ai-news/zh/2026-11-19/2');
    expect(expandHantReply).not.toMatch(/\]\(https?:\/\//);
    expect(expandHantReply).not.toMatch(/默认|记忆|为什么/);

    const expandHansEv = makeEvent({ roomId: dmCtx.roomId, chatType: 'dm', text: '第 2 条详细说说' });
    const expandHansDecision = await routeEvent(expandHansEv, dmCtx, AI5_AGENT_SPEC, { nowMs: expandHansEv.timestampMs });
    expect(expandHansDecision.detectedLang).toBe('zh-Hans');
    const expandHansReply = await fastRespondAi5(baseEnv, expandHansEv, expandHansDecision, emptyMem);
    expect(expandHansReply).not.toBeNull();
    expect(expandHansReply).toContain('AI in 5 第 42 期（2026-11-19）第 2 条');
    expect(expandHansReply).toContain('为什么重要：');
    expect(expandHansReply).toContain('https://app.manyfold.ai/ai-news/zh/2026-11-19/2');

    // Voice expand omits URLs
    const expandVoiceReply = await fastRespondAi5(
      baseEnv,
      makeEvent({ roomId: dmCtx.roomId, chatType: 'dm', text: '展開第 1 條', isVoice: true }),
      expandHantDecision,
      emptyMem,
    );
    expect(expandVoiceReply).not.toBeNull();
    expect(expandVoiceReply).toContain('第 42 期第 1 條');
    expect(expandVoiceReply).not.toMatch(/https?:\/\//);

    // English formatter helper
    const enExpanded = formatExpandedStory(makePublishedIssue('2026-11-19', 42), 2, 'en', 'https://app.manyfold.ai/ai-news');
    expect(enExpanded).toContain('AI in 5 No. 42 (2026-11-19) — Story 2:');
    expect(enExpanded).toContain('Why it matters:');
    expect(enExpanded).toContain('https://app.manyfold.ai/ai-news/en/2026-11-19/2');

    // Out-of-range story slot on a shorter issue returns null so A2A can handle gracefully
    const shortDb = sqliteD1();
    await shortDb.exec(
      `CREATE TABLE IF NOT EXISTS issues (
        date TEXT PRIMARY KEY,
        number INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        data TEXT NOT NULL,
        published_at TEXT,
        updated_at TEXT NOT NULL
      );`,
    );
    const shortEnv: Env = { ...baseEnv, DB: shortDb };
    const shortIssue = makePublishedIssue('2026-11-19', 42);
    shortIssue.stories = shortIssue.stories.slice(0, 2);
    shortIssue.today = shortIssue.stories.map((s) => ({ id: s.id, text: s.title }));
    await saveIssue(shortEnv, '2026-11-19', shortIssue, 'published');
    const outOfRangeEv = makeEvent({ roomId: dmCtx.roomId, chatType: 'dm', text: '展開第 5 條' });
    expect(await fastRespondAi5(shortEnv, outOfRangeEv, expandHantDecision, emptyMem)).toBeNull();
  });

  it('fast-expands English expand commands ("Expand item 1", "more on story 2", "details for #3") and works in group active_session', async () => {
    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const dmCtx = { roomId: '!dm_expand_en:matrix.netmind.chat', chatType: 'dm' as const, members: [], recentHistory: [] };

    const expand1Ev = makeEvent({ roomId: dmCtx.roomId, chatType: 'dm', text: 'Expand item 1' });
    const expand1Dec = await routeEvent(expand1Ev, dmCtx, AI5_AGENT_SPEC, { nowMs: expand1Ev.timestampMs });
    expect(expand1Dec.shouldReply).toBe(true);
    expect(expand1Dec.detectedLang).toBe('en');
    const expand1Reply = await fastRespondAi5(baseEnv, expand1Ev, expand1Dec, emptyMem);
    expect(expand1Reply).not.toBeNull();
    expect(expand1Reply).toContain('AI in 5 No. 42 (2026-11-19) — Story 1:');
    expect(expand1Reply).toContain('Qilin Lab open-sources a 70B model');
    expect(expand1Reply).toContain('Why it matters:');
    expect(expand1Reply).toContain('https://app.manyfold.ai/ai-news/en/2026-11-19/1');
    expect(expand1Reply).not.toMatch(/\]\(https?:\/\//);
    expect(expand1Reply).not.toMatch(/[\u4e00-\u9fff]/);

    // Additional English variants: "more on story 2" and "details for #3"
    const more2Ev = makeEvent({ roomId: dmCtx.roomId, chatType: 'dm', text: 'more on story 2' });
    const more2Dec = await routeEvent(more2Ev, dmCtx, AI5_AGENT_SPEC, { nowMs: more2Ev.timestampMs });
    const more2Reply = await fastRespondAi5(baseEnv, more2Ev, more2Dec, emptyMem);
    expect(more2Reply).toContain('AI in 5 No. 42 (2026-11-19) — Story 2:');
    expect(more2Reply).toContain('https://app.manyfold.ai/ai-news/en/2026-11-19/2');

    const details3Ev = makeEvent({ roomId: dmCtx.roomId, chatType: 'dm', text: 'details for #3' });
    const details3Dec = await routeEvent(details3Ev, dmCtx, AI5_AGENT_SPEC, { nowMs: details3Ev.timestampMs });
    const details3Reply = await fastRespondAi5(baseEnv, details3Ev, details3Dec, emptyMem);
    expect(details3Reply).toContain('AI in 5 No. 42 (2026-11-19) — Story 3:');
    expect(details3Reply).toContain('https://app.manyfold.ai/ai-news/en/2026-11-19/3');

    // Unmentioned group active_session follow-up "Expand item 1" must expand (not [NO_REPLY])
    const groupExpandReply = await fastRespondAi5(
      baseEnv,
      makeEvent({ roomId: '!grp_expand_en:matrix.netmind.chat', chatType: 'group', text: 'Expand item 1' }),
      {
        shouldReply: true,
        tier: 0,
        reason: 'active_session',
        confidence: 0.9,
        detectedLang: 'en',
        shouldQuote: false,
      },
      emptyMem,
    );
    expect(groupExpandReply).toContain('AI in 5 No. 42 (2026-11-19) — Story 1:');
  });

  it('truncates long English summaries cleanly at word boundaries with … in truncateSummary, formatIssueTop3, and formatTodayTopicReply', () => {
    const shortText = 'Short summary stays intact.';
    expect(truncateSummary(shortText, 150)).toBe(shortText);

    const longEn =
      'European regulators warned that current model evaluations and enterprise guardrails are still not adequate to protect downstream healthcare operators from subtle reasoning failures.';
    // Verify the naive slice(0, 140) would have cut mid-word ("adequate to prote" / "downstream healthca")
    const truncated116 = truncateSummary(longEn, 116);
    expect(truncated116.length).toBeLessThanOrEqual(116);
    expect(truncated116.endsWith('…')).toBe(true);
    expect(truncated116).not.toContain('adequate to prote');
    expect(truncated116).toContain('adequate to…');

    const truncated150 = truncateSummary(longEn, 150);
    expect(truncated150.length).toBeLessThanOrEqual(150);
    expect(truncated150.endsWith('…')).toBe(true);
    // Must end on a complete word before '…' (last word matches a whole word in original text)
    const lastWord = truncated150.slice(0, -1).split(/\s+/).pop()!;
    expect(new RegExp(`\\b${lastWord}\\b`).test(longEn)).toBe(true);

    // End-to-end through formatIssueTop3 and formatTodayTopicReply
    const longIssue = makePublishedIssue('2026-11-20', 43);
    longIssue.stories[0]!.title.en = 'OpenAI safety audit raises enterprise questions';
    // Length before "protect" is 144 chars so a naive 149-char slice would cut mid-word to "adequate to prote"
    longIssue.stories[0]!.summary.en =
      'OpenAI published a new safety framework after independent external auditors warned that current enterprise guardrails are still not adequate to protect regulated deployments in finance and healthcare.';
    expect(longIssue.stories[0]!.summary.en.slice(0, 149)).toMatch(/adequate to prote$/);

    const top3Out = formatIssueTop3(longIssue, 'en', 'https://app.manyfold.ai/ai-news');
    const storyLine = top3Out.split('\n').find((l) => l.includes('OpenAI safety audit raises enterprise questions'))!;
    expect(storyLine).toBeDefined();
    expect(storyLine.endsWith('…')).toBe(true);
    expect(storyLine).toContain('adequate to…');
    expect(storyLine).not.toMatch(/adequate to pr[a-z]*…$/);
    const top3LastWord = storyLine.slice(0, -1).split(/\s+/).pop()!;
    expect(new RegExp(`\\b${top3LastWord}\\b`).test(longIssue.stories[0]!.summary.en)).toBe(true);

    const topicOut = formatTodayTopicReply(
      longIssue,
      'Any OpenAI news today?',
      'en',
      'https://app.manyfold.ai/ai-news',
      false,
    );
    const topicStoryLine = topicOut.split('\n').find((l) => l.includes('OpenAI safety audit raises enterprise questions'))!;
    expect(topicStoryLine).toBeDefined();
    expect(topicStoryLine.endsWith('…')).toBe(true);
    expect(topicStoryLine).toContain('adequate to…');
    expect(topicStoryLine).not.toMatch(/adequate to pr[a-z]*…$/);
    const topicLastWord = topicStoryLine.slice(0, -1).split(/\s+/).pop()!;
    expect(new RegExp(`\\b${topicLastWord}\\b`).test(longIssue.stories[0]!.summary.en)).toBe(true);
  });

  it('matches expanded AI5 domainKeywords and yields cleanly on MFD structured dataset antiKeywords', async () => {
    const grpCtx = {
      roomId: '!grp_qa160:matrix.netmind.chat',
      chatType: 'group' as const,
      members: [
        { matrixId: '@alice:matrix.netmind.chat', displayName: 'Alice', isAgent: false },
        { matrixId: AI5_MATRIX_ID, displayName: 'AI in 5', isAgent: true },
        { matrixId: '@agent-37b08ab6:matrix.netmind.chat', displayName: 'Manyfold Data', isAgent: true },
      ],
      recentHistory: [],
    };
    const nowMs = 1_763_550_000_000;
    const threshold = AI5_AGENT_SPEC.silenceThreshold ?? 0.55;

    expect(AI5_AGENT_SPEC.domainKeywords).toEqual(
      expect.arrayContaining([
        'AI圈',
        'ai 圈',
        'google ai',
        'meta ai',
        'llama',
        'grok',
        'xai',
        'mistral',
        'qwen',
        '通義',
        '通义',
        'ai動態',
        'ai动态',
        'ai新發布',
        'ai新发布',
        'ai大事',
      ]),
    );
    expect(AI5_AGENT_SPEC.antiKeywords).toEqual(
      expect.arrayContaining([
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
      ]),
    );

    for (const aiNewsQuery of [
      '今天 AI 圈发生了什么大事？',
      'Google AI 这周有什么新发布？',
      'Meta Llama 最近有什么新消息？',
    ]) {
      const ev = makeEvent({ roomId: grpCtx.roomId, text: aiNewsQuery, timestampMs: nowMs });
      expect(heuristicDomainScore(ev, AI5_AGENT_SPEC, grpCtx), aiNewsQuery).toBeGreaterThanOrEqual(threshold);
      const decision = await routeEvent(ev, grpCtx, AI5_AGENT_SPEC, { nowMs });
      expect(decision.shouldReply, aiNewsQuery).toBe(true);
      expect(decision.reason, aiNewsQuery).toBe('domain_match');
    }

    const mfdDataCenterQuery = '最近有哪些新的 AI 数据中心或算力中心项目？';
    const mfdEv = makeEvent({ roomId: grpCtx.roomId, text: mfdDataCenterQuery, timestampMs: nowMs });
    expect(heuristicDomainScore(mfdEv, AI5_AGENT_SPEC, grpCtx), mfdDataCenterQuery).toBeLessThan(threshold);
    const mfdDecision = await routeEvent(mfdEv, grpCtx, AI5_AGENT_SPEC, { nowMs });
    expect(mfdDecision.shouldReply).toBe(false);
    expect(mfdDecision.reason).toBe('below_threshold');
  });

  it('fast-responds to "今天 AI 圈发生了什么大事？" (top 3 in zh-Hans) and "Meta Llama 或 Google AI 这周有什么新消息？" (topic lookup in zh-Hans)', async () => {
    const emptyMem = { userMemories: [], roomMemories: [], promptSafeLines: [] };
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const grpCtx = {
      roomId: '!grp_qa_bugs_2_3:matrix.netmind.chat',
      chatType: 'group' as const,
      members: [
        { matrixId: '@alice:matrix.netmind.chat', displayName: 'Alice', isAgent: false },
        { matrixId: AI5_MATRIX_ID, displayName: 'AI in 5', isAgent: true },
        { matrixId: '@agent-37b08ab6:matrix.netmind.chat', displayName: 'Manyfold Data', isAgent: true },
      ],
      recentHistory: [],
    };
    const nowMs = 1_763_550_000_000;
    const aiMock = {
      run: vi.fn(async () => ({ response: JSON.stringify({ score: 0.1, reason: 'should_not_be_called' }) })),
    };
    const triageModel = createWorkersAiTriageModel(aiMock);

    // Bug #2: "今天 AI 圈发生了什么大事？" -> deterministic keywordHits >= 2 + isLatestIssueQuery -> Top 3 in zh-Hans
    const aiCircleQuery = '今天 AI 圈发生了什么大事？';
    expect(isLatestIssueQuery(aiCircleQuery, 'group')).toBe(true);
    const aiCircleEv = makeEvent({ roomId: grpCtx.roomId, text: aiCircleQuery, timestampMs: nowMs });
    const aiCircleDecision = await routeEvent(aiCircleEv, grpCtx, AI5_AGENT_SPEC, { nowMs, triageModel });
    expect(aiCircleDecision.shouldReply).toBe(true);
    expect(aiCircleDecision.reason).toBe('domain_match');
    expect(aiCircleDecision.detectedLang).toBe('zh-Hans');
    expect(aiCircleDecision.confidence).toBeGreaterThanOrEqual(0.9);
    expect(aiMock.run).not.toHaveBeenCalled();

    const aiCircleReply = await fastRespondAi5(baseEnv, aiCircleEv, aiCircleDecision, emptyMem);
    expect(aiCircleReply).not.toBeNull();
    expect(aiCircleReply).toContain('AI in 5 第 42 期（2026-11-19）本期焦点：');
    expect(aiCircleReply).toContain('完整期号： https://app.manyfold.ai/ai-news/zh/2026-11-19');
    expect(aiCircleReply).toContain('https://app.manyfold.ai/ai-news/zh/2026-11-19/1');
    expect(aiCircleReply).toContain('\n• ');
    expect(aiCircleReply).not.toMatch(/\]\(https?:\/\//);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Bug #3: "Meta Llama 或 Google AI 这周有什么新消息？" -> deterministic domain_match + shouldHandleTodayTopicLookup in zh-Hans
    const thisWeekQuery = 'Meta Llama 或 Google AI 这周有什么新消息？';
    const thisWeekEv = makeEvent({ roomId: grpCtx.roomId, text: thisWeekQuery, timestampMs: nowMs });
    const thisWeekDecision = await routeEvent(thisWeekEv, grpCtx, AI5_AGENT_SPEC, { nowMs, triageModel });
    expect(thisWeekDecision.shouldReply).toBe(true);
    expect(thisWeekDecision.reason).toBe('domain_match');
    expect(thisWeekDecision.detectedLang).toBe('zh-Hans');
    expect(aiMock.run).not.toHaveBeenCalled();

    // When latest issue has no Meta/Llama/Google mention -> clean zh-Hans absence + top headlines, 0 A2A calls
    const noMatchReply = await fastRespondAi5(baseEnv, thisWeekEv, thisWeekDecision, emptyMem);
    expect(noMatchReply).not.toBeNull();
    expect(noMatchReply).toContain('AI in 5 第 42 期（2026-11-19）没有提到 Meta、Llama、Google 的相关更新。');
    expect(noMatchReply).toContain('本期重点新闻头条：');
    expect(noMatchReply).toContain('完整期号： https://app.manyfold.ai/ai-news/zh/2026-11-19');
    expect(fetchSpy).not.toHaveBeenCalled();

    // When latest issue contains Google & Llama updates -> clean zh-Hans topic lookup with matching items
    const topicDb = sqliteD1();
    await topicDb.exec(
      `CREATE TABLE IF NOT EXISTS issues (
        date TEXT PRIMARY KEY,
        number INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        data TEXT NOT NULL,
        published_at TEXT,
        updated_at TEXT NOT NULL
      );`,
    );
    const topicEnv: Env = { ...baseEnv, DB: topicDb };
    const matchedIssue = makePublishedIssue('2026-11-20', 44);
    matchedIssue.stories[0]!.org = { name: 'Google', logo: matchedIssue.stories[0]!.org!.logo };
    matchedIssue.stories[0]!.title = {
      en: 'Google AI unveils Gemini 3 developer tools',
      zh: 'Google AI 发布 Gemini 3 开发者工具',
    };
    matchedIssue.stories[0]!.summary = {
      en: 'Google rolled out new Gemini agent APIs with lower latency.',
      zh: 'Google 推出新一代 Gemini 智能体接口，显著降低推理延迟。',
    };
    matchedIssue.briefs[0]!.org = { name: 'Meta', logo: matchedIssue.briefs[0]!.org!.logo };
    matchedIssue.briefs[0]!.text = {
      en: 'Meta published Llama 4 quantization benchmarks for edge devices.',
      zh: 'Meta 公布 Llama 4 在端侧设备上的量化基准测试结果。',
    };
    await saveIssue(topicEnv, '2026-11-20', matchedIssue, 'published');

    const matchedReply = await fastRespondAi5(topicEnv, thisWeekEv, thisWeekDecision, emptyMem);
    expect(matchedReply).not.toBeNull();
    expect(matchedReply).toContain('AI in 5 第 44 期（2026-11-20）关于 Meta、Llama、Google 的动态：');
    expect(matchedReply).toContain('• Google AI 发布 Gemini 3 开发者工具 —');
    expect(matchedReply).toContain('• Meta 公布 Llama 4 在端侧设备上的量化基准测试结果。');
    expect(matchedReply).toContain('https://app.manyfold.ai/ai-news/zh/2026-11-20/1');
    expect(matchedReply).toContain('完整期号： https://app.manyfold.ai/ai-news/zh/2026-11-20');
    expect(matchedReply).not.toMatch(/\]\(https?:\/\//);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

it('speaks only on its own topic in mixed group chatter', async () => {
  const cases = [
    '晚上能吃啥',
    '我先去開個會',
    '今晚倫敦有什麼市集',
    '今天 AI 圈有啥新消息',
    '能抽張塔羅看看工作嗎',
    '幫我求一支籤',
    '有英國簽證資料可以查嗎',
    '晚餐 £80 我付的，四個人怎麼分',
    'Boots 有折扣碼嗎',
    '昨天吃火鍋超爽',
  ];
  const nowMs = Date.now();
  const replies: string[] = [];
  for (const text of cases) {
    const event = makeEvent({ text, timestampMs: nowMs, chatType: 'group', mentions: [] });
    const context = { roomId: event.roomId, chatType: 'group' as const, members: [], recentHistory: [] };
    if ((await routeEvent(event, context, AI5_AGENT_SPEC, { nowMs })).shouldReply) replies.push(text);
  }
  expect(replies).toEqual(["今天 AI 圈有啥新消息"]);

  const text = '今天 AI 圈有啥新消息';
  const directedEvent = makeEvent({ text: `@Ken ${text}`, timestampMs: nowMs, chatType: 'group', mentions: ['@ken:example.com'] });
  const directedContext = { roomId: directedEvent.roomId, chatType: 'group' as const, members: [], recentHistory: [] };
  expect((await routeEvent(directedEvent, directedContext, AI5_AGENT_SPEC, { nowMs })).shouldReply).toBe(false);
});
