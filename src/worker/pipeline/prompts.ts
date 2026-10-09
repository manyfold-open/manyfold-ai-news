/**
 * The three instructions the pipeline sends to the writer agent: pick, write, translate.
 * The writing rules mirror docs/product-plan.md §4; the agent is told plainly that code
 * will check every quote and number afterwards, and that anything unsupported is cut.
 */

import type { Candidate } from './feeds';
import type { Snapshot } from './snapshot';

const json = (value: unknown) => JSON.stringify(value);

export function selectPrompt(issueDate: string, candidates: Candidate[]): string {
  const list = candidates.map((c) => ({
    id: c.id,
    source: c.sourceName.en,
    kind: c.kind,
    lang: c.lang,
    published: c.published,
    title: c.title,
    summary: c.summary.slice(0, 400),
  }));
  return `You are the editor of "AI in 5", a daily AI news briefing read in about five minutes, in English and Chinese, by tech professionals worldwide. The issue for ${issueDate} is being prepared.

Pick what goes in it from the candidates below.

Rules:
- Aim for 5 or 6 stories and 3 or 4 briefs, at most 10 items. Go below 5 stories only when the news is genuinely thin. Never pad.
- Score each event on impact, novelty, credibility and relevance to people who build with or decide about AI. New models, products, prices, funding, policy, research results and hardware come first.
- Leave out: event and ticket promotions, conference agendas, sponsored posts, minor maintenance or deprecation notices, interviews and opinion pieces with no news, and stories that are not about AI.
- Cover both the US and China (and Europe or elsewhere when it matters). Do not force a quota.
- One item per event. If several candidates report the same event, list all their ids in one item. When an official candidate (kind "official") covers the event, always include it, first.
- Prefer official announcements and first-hand sources. A rumor (unconfirmed report) can only be a brief.
- When an important event has no official candidate, you may open the company's own newsroom or blog to find the official announcement and add its exact URL in "extraUrls" (up to 2 per item). Only add pages you have opened and confirmed cover the same event. Never guess a URL: every one is fetched and checked, and a wrong one wastes the slot.

Reply with JSON only, no prose:
{"items":[{"type":"story"|"brief","candidates":["c3","c9"],"extraUrls":[],"reason":"one short sentence"}]}

Candidates:
${json(list)}`;
}

export interface WriteItem {
  type: 'story' | 'brief';
  sources: { url: string; name: string; kind: string; lang: string; published: string | null; snapshot: Snapshot }[];
}

const SOURCE_CHARS = 5000;

export function writePrompt(issueDate: string, items: WriteItem[]): string {
  const material = items.map((item, i) => ({
    item: i + 1,
    type: item.type,
    sources: item.sources.map((s, j) => ({
      index: j,
      url: s.url,
      name: s.name,
      kind: s.kind,
      lang: s.lang,
      published: s.published,
      hasImage: Boolean(s.snapshot.image),
      title: s.snapshot.title,
      text: s.snapshot.text.slice(0, SOURCE_CHARS),
    })),
  }));
  return `You are writing the English edition of "AI in 5" for ${issueDate}: a daily AI briefing that takes about five minutes, for tech professionals worldwide.

Write ONLY from the source texts below. Code will check your work afterwards: every quote must appear word for word in the cited source text, and every number you write must appear in the sources. Anything that fails is cut, so never write a number or claim you cannot quote.

Length: the whole issue is read in about four minutes, so aim for 800 to 1,000 words in total. Write every story you were given unless its sources do not support it.

Style:
- Headline: who + did what + the key number, at most 12 words. No questions. No hype.
- Banned words: game-changer, revolutionary, shocking, insane, mind-blowing, breaking, groundbreaking, unprecedented.
- Summary: at most 40 words, what happened, plain language. Explain jargon on first use.
- "why": at most 30 words, a real consequence for the industry or the reader. No platitudes like "this marks a new era".
- "next": optional, one sentence on what to watch. Only for the top story.
- Attribution: "announced" for official sources, "according to"/"reportedly" for media, "rumored" for unconfirmed.
- The whole issue stays under 1,000 words.

Checked numbers ("marks"):
- Numbers are what readers come for. When the sources give figures (prices, money raised, valuations, model sizes, scores, user counts, percentages, dates something ships), put the one to three that matter most into the headline or summary. Leave numbers out only when the sources have none.
- Every number in the summary is wrapped as <m0>number words</m0>, <m1>…</m1>, numbered from 0 within the story. Numbers in the headline need no marker but must also appear in the sources.
- Each mark has an entry in "marks": the source index and a VERBATIM quote from that source's text that contains the number (copy it exactly; you may skip text with "…"). If the source is not in English, add an English "translation" of the quote.

Questions readers would ask (2 or 3 per story, specific to the story):
- Answer only from the sources, at most 60 words, citing with [1], [2] that point at "cites" (verbatim quotes, same rules as marks).
- "status": "answered" if the sources answer it, "partial" if only partly, "none" if they do not. A "none" answer says plainly what the sources do and do not cover.

Visuals (optional):
- "chart" only when two comparable numbers or a change are in the sources: {"type":"compare"|"change","title","note"?,"axis"?:["Decrease","Increase"],"rows":[{"label","value","shown","mark"?,"focus"?}]}. "compare" values are non-negative; "change" values are signed percentages. "shown" is how the number is written, and "mark" links the row to a mark when it is one. If the figure is a company's own estimate, say so in "note".
- "image": {"source": index, "alt": "what the image shows"} only when that source is official and hasImage is true.

Also give each story: "id" (short kebab-case), "region" (us, cn, eu, jp or other, by where the main company or institution is), "org" (the main company or null), "lon"/"lat" of its home city, "category" (Models, Products, Companies, Funding, Research, Open Source, Policy or Hardware), and exactly one story with "top": true (the most important).
Briefs are one sentence of at most 25 words each.
"today" is three sentences of at most 15 words, one per most important story, each pointing at a story id.

Reply with JSON only, no prose, in this shape:
{"today":[{"story":"id","text":"…"}],
 "stories":[{"id","region","top","org","lon","lat","category","title","summary","why","next",
   "sources":[{"url","name","kind","lang","published"}],
   "marks":[{"source":0,"quote":"…","translation":"…"}],
   "chart":null,"image":null,
   "questions":[{"q","status","a","cites":[{"source":0,"quote":"…","translation":"…"}]}]}],
 "briefs":[{"region","org","lon","lat","kind","text","sourceName","url"}]}

In "sources", copy url, name, kind, lang and published from the material for the sources you used, in the order you index them, official sources first.

Material:
${json(material)}`;
}

export function translatePrompt(entries: Record<string, string>): string {
  return `Translate the English values below into Simplified Chinese for the Chinese edition of "AI in 5", a daily AI briefing.

Rules:
- Keep markers exactly as they are: <m0>…</m0> (translate the words inside, keep the tags and the digit) and [1], [2].
- Keep every number in digits. Units may change (30 million → 3,000 万) but never round or invent a number.
- Keep company, product and model names in their usual form; use the established Chinese name only when there is one.
- Plain, direct Chinese. Do not use 震惊, 炸裂, 重磅, 颠覆, 王炸.
- Do not add or drop information.

Reply with JSON only: an object with the same keys and the Chinese text as values.

${json(entries)}`;
}
