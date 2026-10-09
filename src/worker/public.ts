/**
 * The reader's write routes: subscribe, "was this useful", and "report a problem".
 * They are open to the public (no admin password), so each one validates strictly and
 * is throttled per client. A client is a salted SHA-256 of the connecting IP; the IP
 * itself is never stored.
 */

import { LANGS, type Lang } from '../shared/issue';
import { HttpError, type Env } from './types';
import { getSetting, now, setSettingIfAbsent } from './db';

type Body = Record<string, unknown> | null;

const SALT_KEY = 'client_hash_salt';

async function salt(env: Env): Promise<string> {
  const existing = await getSetting(env, SALT_KEY);
  if (existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  await setSettingIfAbsent(env, SALT_KEY, Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));
  return (await getSetting(env, SALT_KEY)) ?? '';
}

export async function clientKey(env: Env, ip: string | undefined): Promise<string> {
  const data = new TextEncoder().encode(`${await salt(env)}:${ip ?? 'unknown'}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** At most `limit` requests per client per hour for this bucket. */
async function throttle(env: Env, bucket: string, client: string, limit: number): Promise<void> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND client = ? AND created_at > ?')
    .bind(bucket, client, since)
    .first<{ n: number }>();
  if ((row?.n ?? 0) >= limit) throw new HttpError(429, 'too_many_requests', 'Too many requests. Try again later.');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO rate_events (bucket, client, created_at) VALUES (?, ?, ?)').bind(bucket, client, now()),
    env.DB.prepare('DELETE FROM rate_events WHERE created_at < ?').bind(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
  ]);
}

function lang(value: unknown): Lang {
  if (typeof value !== 'string' || !LANGS.includes(value as Lang)) throw new HttpError(400, 'bad_request', 'lang must be en or zh.');
  return value as Lang;
}

function issueDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, 'bad_request', 'date must be YYYY-MM-DD.');
  return value;
}

async function assertPublished(env: Env, date: string): Promise<void> {
  const row = await env.DB.prepare("SELECT 1 AS ok FROM issues WHERE date = ? AND status = 'published'").bind(date).first();
  if (!row) throw new HttpError(404, 'issue_not_found', 'There is no published issue for that date.');
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

export async function subscribe(env: Env, body: Body, client: string): Promise<void> {
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email.length > 254 || !EMAIL.test(email)) throw new HttpError(400, 'invalid_email', 'Enter a valid email address.');
  const timezone = typeof body?.timezone === 'string' && /^[A-Za-z0-9_+\-/]{1,64}$/.test(body.timezone) ? body.timezone : 'UTC';
  const source = body?.source === 'gate' ? 'gate' : 'done';
  await throttle(env, 'subscribe', client, 5);
  const at = now();
  await env.DB.prepare(
    `INSERT INTO subscribers (email, lang, timezone, status, source, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)
     ON CONFLICT (email) DO UPDATE SET lang = excluded.lang, timezone = excluded.timezone, updated_at = excluded.updated_at`,
  )
    .bind(email, lang(body?.lang), timezone, source, at, at)
    .run();
}

export async function recordFeedback(env: Env, body: Body, client: string): Promise<void> {
  const date = issueDate(body?.date);
  const value = body?.value === 'useful' || body?.value === 'not_useful' ? body.value : null;
  if (!value) throw new HttpError(400, 'bad_request', 'value must be useful or not_useful.');
  await assertPublished(env, date);
  await throttle(env, 'feedback', client, 20);
  await env.DB.prepare('INSERT INTO feedback (issue_date, value, created_at) VALUES (?, ?, ?)').bind(date, value, now()).run();
}

export async function recordReport(env: Env, body: Body, client: string): Promise<void> {
  const date = issueDate(body?.date);
  const storyId = typeof body?.storyId === 'string' && /^[a-z0-9-]{1,60}$/.test(body.storyId) ? body.storyId : null;
  const target = typeof body?.target === 'string' && /^(story|answer|proof)(:\d{1,2})?$/.test(body.target) ? body.target : null;
  if (!storyId || !target) throw new HttpError(400, 'bad_request', 'storyId and target are required.');
  await assertPublished(env, date);
  await throttle(env, 'report', client, 20);
  await env.DB.prepare('INSERT INTO reports (issue_date, story_id, target, lang, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(date, storyId, target, lang(body?.lang), now())
    .run();
}
