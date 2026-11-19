import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  heuristicDomainScore,
  isNarraGatewayEnabled,
  kickNarraGateway,
  routeEvent,
  staggerWindowMinute,
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
  fastRespondAi5,
  fetchAi5Updates,
  formatIssueTop3,
  isLatestIssueQuery,
  resolveAi5A2ACredential,
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
    expect(updates[0].text).toContain('https://app.manyfold.ai/ai-news/en/2026-11-19/1');
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
    expect(enReply).toContain('https://app.manyfold.ai/ai-news/en/2026-11-19/1');
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
    expect(hantReply).toContain('今日焦點');
    expect(hantReply).toContain('完整期號');
    expect(hantReply).toContain('https://app.manyfold.ai/ai-news/zh/2026-11-19/1');

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
    expect(hansReply).toContain('今日焦点');
    expect(hansReply).toContain('完整期号');

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
    expect(reply).toContain('今日焦點');
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
    expect(todayOnly).not.toMatch(/网络安全|亿美元|轮融资/);

    const briefsOnly = formatIssueTop3(
      { ...hansStoredIssue, stories: [], today: [] },
      'zh-Hant',
      'https://app.manyfold.ai/ai-news',
    );
    expect(briefsOnly).toContain('網絡安全');
    expect(briefsOnly).toContain('億美元');
    expect(briefsOnly).toContain('輪融資');
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
    expect(reply).toContain('AI in 5 第 42 期（2026-11-19）今日焦點');
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
    expect(dmReply).toContain('你好！這是今天 AI in 5 第 42 期的重點速覽（2026-11-19）：');
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
    expect(genuineActiveQuery).toContain('今日焦點');

    const specificFollowUp = await fastRespondAi5(
      baseEnv,
      makeEvent({ chatType: 'group', text: 'What did OpenAI announce in story 2?' }),
      { ...activeSessionDecision, detectedLang: 'en' },
      emptyMem,
    );
    expect(specificFollowUp).toBeNull();
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
});
