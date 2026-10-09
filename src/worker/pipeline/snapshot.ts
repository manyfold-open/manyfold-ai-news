/**
 * Source snapshots: the text of each cited page, fetched once and kept so the code
 * checks can confirm every quote and number against what the source actually said.
 * Source URLs come from feeds or from the agent, so every hop (redirects included)
 * goes through the SSRF guard. Snapshots are internal and never shown to readers.
 */

import { HttpError, type Env } from '../types';
import { fetchTimeout, safeErrorText, validateA2AUrl } from '../a2a';
import { now } from '../db';
import { decodeEntities } from './feeds';

export interface Snapshot {
  url: string;
  title: string;
  text: string;
  /** og:image, https only; used for official images. */
  image: string | null;
}

const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 4;
const MAX_TEXT = 40_000;

async function fetchFollowingSafely(rawUrl: string, production: boolean): Promise<{ response: Response; url: string }> {
  let url = validateA2AUrl(rawUrl, production, 'Source URL');
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchTimeout(
      url,
      { redirect: 'manual', headers: { 'user-agent': 'AIin5/1.0 (+daily AI briefing)', accept: 'text/html,application/xhtml+xml' } },
      FETCH_TIMEOUT_MS,
    );
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      url = validateA2AUrl(new URL(location, url).toString(), production, 'Source redirect');
      continue;
    }
    return { response, url };
  }
  throw new HttpError(502, 'too_many_redirects', 'The source redirected too many times.');
}

/** Pulls readable text, the title and og:image out of an HTML page. */
async function extract(response: Response): Promise<{ title: string; text: string; image: string | null }> {
  const parts: string[] = [];
  let current = '';
  let title = '';
  let ogTitle = '';
  let image: string | null = null;
  let inTitle = false;

  const rewriter = new HTMLRewriter()
    .on('title', {
      element(el) {
        inTitle = true;
        el.onEndTag(() => {
          inTitle = false;
        });
      },
      text(t) {
        if (inTitle) title += t.text;
      },
    })
    .on('meta[property="og:image"], meta[name="og:image"]', {
      element(el) {
        image ??= el.getAttribute('content');
      },
    })
    .on('meta[property="og:title"]', {
      element(el) {
        ogTitle ||= el.getAttribute('content') ?? '';
      },
    })
    .on('p, h1, h2, h3, h4, li, blockquote, figcaption, td, th, dd', {
      element(el) {
        el.onEndTag(() => {
          if (current.trim()) parts.push(current.trim());
          current = '';
        });
      },
      text(t) {
        current += t.text;
      },
    });

  await rewriter.transform(response).arrayBuffer();
  const text = decodeEntities(parts.join('\n')).replace(/[ \t ]+/g, ' ').slice(0, MAX_TEXT);
  const img = image as string | null;
  return {
    title: decodeEntities(ogTitle || title).trim().slice(0, 300),
    text,
    image: img && /^https:\/\//.test(img) ? img : null,
  };
}

export async function fetchSnapshot(env: Env, rawUrl: string): Promise<Snapshot> {
  const production = (env.ENVIRONMENT ?? 'production') === 'production';
  const { response, url } = await fetchFollowingSafely(rawUrl, production);
  if (!response.ok) throw new HttpError(502, 'source_unavailable', `The source answered HTTP ${response.status}.`);
  const type = response.headers.get('content-type') ?? '';
  if (!/html|xml/i.test(type)) throw new HttpError(502, 'source_not_html', 'The source is not a web page.');
  const page = await extract(response);
  const snapshot: Snapshot = { url: rawUrl, ...page };
  await env.DB.prepare(
    `INSERT INTO source_snapshots (url, final_url, title, text, image, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (url) DO UPDATE SET final_url = excluded.final_url, title = excluded.title, text = excluded.text,
       image = excluded.image, fetched_at = excluded.fetched_at`,
  )
    .bind(rawUrl, url, snapshot.title, snapshot.text, snapshot.image, now())
    .run();
  return snapshot;
}

/** Fetches many sources with bounded concurrency; failures are reported, not thrown. */
export async function fetchSnapshots(env: Env, urls: string[], concurrency = 6): Promise<{ snapshots: Map<string, Snapshot>; failures: { url: string; error: string }[] }> {
  const snapshots = new Map<string, Snapshot>();
  const failures: { url: string; error: string }[] = [];
  const queue = [...new Set(urls)];
  const worker = async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      try {
        const snap = await fetchSnapshot(env, url);
        if (snap.text.length < 200) failures.push({ url, error: 'The page had almost no readable text.' });
        snapshots.set(url, snap);
      } catch (error) {
        failures.push({ url, error: safeErrorText(error instanceof Error ? error.message : error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return { snapshots, failures };
}
