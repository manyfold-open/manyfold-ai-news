import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
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
});
