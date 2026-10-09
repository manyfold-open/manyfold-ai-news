/**
 * Check 2 of 3: an independent review agent (a different agent, ideally a different
 * model family, from the writer) reads the checked draft beside its sources and returns
 * a verdict per item: pass, fix or cut. Code applies the verdicts and then runs check 1
 * again, so a reviewer's correction can never bring in a quote or number the sources do
 * not hold. It fails closed: an item the reviewer did not judge is cut.
 */

import { repairMarkers, type Draft, type DraftBrief, type DraftStory } from './draft';
import { checkDraft, type SourceText } from './checks';

export type Verdict = 'pass' | 'fix' | 'cut';

export interface ReviewVerdict {
  id: string;
  verdict: Verdict;
  problems: string[];
  fix: Record<string, string>;
  remove: string[];
}

export interface ReviewItem {
  id: string;
  title: string;
  verdict: Verdict | 'missing';
  problems: string[];
  /** What the reviewer's fix changed or dropped. */
  changed: string[];
  kept: boolean;
  /** Why code overruled or could not apply the verdict. */
  notes: string[];
}

export interface ReviewReply {
  verdicts: Map<string, ReviewVerdict>;
  /** The story the reviewer says should lead, when it disagrees with the writer. */
  top: string | null;
}

export interface ReviewReport {
  agent: string;
  items: ReviewItem[];
  /** Set when the reviewer moved the top story. */
  top?: { from: string; to: string };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {});
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Coerces the reviewer's reply. Unknown verdicts become "cut": the review fails closed. */
export function readReview(raw: unknown): ReviewReply {
  const verdicts = new Map<string, ReviewVerdict>();
  const items = obj(raw).items;
  for (const v of Array.isArray(items) ? items : []) {
    const item = obj(v);
    const id = text(item.id);
    if (!id || verdicts.has(id)) continue;
    const verdict = item.verdict === 'pass' || item.verdict === 'fix' ? item.verdict : 'cut';
    const fix: Record<string, string> = {};
    Object.entries(obj(item.fix)).forEach(([key, value]) => {
      if (text(value)) fix[key] = repairMarkers(text(value));
    });
    verdicts.set(id, {
      id,
      verdict,
      problems: (Array.isArray(item.problems) ? item.problems : []).map(text).filter(Boolean).slice(0, 8),
      fix,
      remove: (Array.isArray(item.remove) ? item.remove : []).map(text).filter(Boolean),
    });
  }
  return { verdicts, top: text(obj(raw).top) || null };
}

const QUESTION = /^q(\d+)$/;

/** Applies a "fix" verdict to one story. Returns what changed and what could not be applied. */
function fixStory(story: DraftStory, v: ReviewVerdict, today: Draft['today']): { story: DraftStory; changed: string[]; unknown: string[] } {
  const next: DraftStory = { ...story, questions: story.questions.map((q) => ({ ...q })), chart: story.chart ? { ...story.chart } : null };
  const changed: string[] = [];
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(v.fix)) {
    const q = QUESTION.exec(key);
    if (key === 'title' || key === 'summary' || key === 'why' || key === 'next') next[key] = value;
    else if (key === 'today') {
      const line = today.find((t) => t.story === story.id);
      if (line) line.text = value;
      else {
        unknown.push(key);
        continue;
      }
    } else if (q && next.questions[Number(q[1])]) next.questions[Number(q[1])].a = value;
    else if (key === 'chart.title' && next.chart) next.chart.title = value;
    else if (key === 'chart.note' && next.chart) next.chart.note = value;
    else {
      unknown.push(key);
      continue;
    }
    changed.push(key);
  }
  const drop = new Set<number>();
  for (const key of v.remove) {
    const q = QUESTION.exec(key);
    if (key === 'next' && next.next) next.next = null;
    else if (key === 'chart' && next.chart) next.chart = null;
    else if (key === 'image' && next.image) next.image = null;
    else if (q && next.questions[Number(q[1])]) drop.add(Number(q[1]));
    else {
      unknown.push(`remove ${key}`);
      continue;
    }
    changed.push(`removed ${key}`);
  }
  next.questions = next.questions.filter((_, i) => !drop.has(i));
  return { story: next, changed, unknown };
}

/**
 * Applies the verdicts to the checked draft, then runs check 1 over the result. A story
 * or brief whose fix fails check 1 is cut; so is anything the reviewer did not judge.
 */
export function applyReview(draft: Draft, reply: ReviewReply, sources: Map<string, SourceText>, agent: string): { draft: Draft; review: ReviewReport } {
  const { verdicts } = reply;
  const items: ReviewItem[] = [];
  const today = draft.today.map((t) => ({ ...t }));
  // What goes on to check 1 again, each with the review item it belongs to.
  const stories: { story: DraftStory; item: ReviewItem }[] = [];
  const briefs: { brief: DraftBrief; item: ReviewItem }[] = [];

  for (const story of draft.stories) {
    const v = verdicts.get(story.id);
    const item: ReviewItem = { id: story.id, title: story.title, verdict: v?.verdict ?? 'missing', problems: v?.problems ?? [], changed: [], kept: false, notes: [] };
    items.push(item);
    if (!v) {
      item.notes.push('The reviewer gave no verdict, so the story was cut.');
      continue;
    }
    if (v.verdict === 'cut') continue;
    if (v.verdict === 'pass') {
      stories.push({ story, item });
      continue;
    }
    const fixed = fixStory(story, v, today);
    item.changed = fixed.changed;
    if (fixed.unknown.length) item.notes.push(`Could not apply: ${fixed.unknown.join(', ')}.`);
    if (fixed.changed.length === 0) {
      item.notes.push('The reviewer asked for a fix but gave none that applies, so the story was cut.');
      continue;
    }
    stories.push({ story: fixed.story, item });
  }

  draft.briefs.forEach((brief, i) => {
    const id = `brief-${i + 1}`;
    const v = verdicts.get(id);
    const item: ReviewItem = { id, title: brief.text.slice(0, 90), verdict: v?.verdict ?? 'missing', problems: v?.problems ?? [], changed: [], kept: false, notes: [] };
    items.push(item);
    if (!v) {
      item.notes.push('The reviewer gave no verdict, so the brief was cut.');
      return;
    }
    if (v.verdict === 'cut') return;
    if (v.verdict === 'fix') {
      if (!v.fix.text) {
        item.notes.push('The reviewer asked for a fix but gave no corrected text, so the brief was cut.');
        return;
      }
      item.changed = ['text'];
      briefs.push({ brief: { ...brief, text: v.fix.text }, item });
      return;
    }
    briefs.push({ brief, item });
  });

  // The reviewer may move the top story to another story that is still in the issue.
  const writerTop = draft.stories.find((s) => s.top)?.id ?? null;
  let top: ReviewReport['top'];
  if (reply.top && reply.top !== writerTop && stories.some((s) => s.story.id === reply.top)) {
    stories.forEach((s) => (s.story = { ...s.story, top: s.story.id === reply.top }));
    top = { from: writerTop ?? '', to: reply.top };
  }

  // Check 1 again: a correction must hold up exactly like the writer's text did.
  // checkDraft reports stories first, then briefs, in the order given.
  const rechecked = checkDraft(
    { today, stories: stories.map((s) => s.story), briefs: briefs.map((b) => b.brief) },
    sources,
    new Set(),
  );
  [...stories, ...briefs].forEach(({ item }, i) => {
    const check = rechecked.checks[i];
    item.kept = check?.kept === true;
    if (!item.kept) item.notes.push(`After the review it failed check 1${check?.reasons.length ? `: ${check.reasons.join(' ')}` : '.'}`);
  });
  return { draft: rechecked.draft, review: { agent, items, ...(top ? { top } : {}) } };
}
