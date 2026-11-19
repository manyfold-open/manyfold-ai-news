#!/usr/bin/env python3
"""AI in 5 lookups for the chat guide.

Read-only: every call is a GET to the site's public reader API. Prints short
plain text meant to be read by the agent, with each story's page link. Each
issue is in English (the master) and Chinese.

  python3 news.py latest [--lang en|zh]          today's issue: Today in 3, the stories, the briefs
  python3 news.py issue <YYYY-MM-DD> [--lang ...]
  python3 news.py list                           every issue with its date and headline
  python3 news.py search <words> [--lang ...]    stories and briefs in every issue that mention the words
  python3 news.py story <YYYY-MM-DD> <n> [--lang ...]   one story in full, with its sources
  python3 news.py corrections
  python3 news.py updates [--lang en|zh] [--mark]      check for a new issue vs last-announced state
"""

import argparse
import datetime
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = 'https://app.manyfold.ai/ai-news'
CACHE = os.path.expanduser(os.environ.get('AI_NEWS_CACHE_DIR', '~/.cache/ai-news'))
UA = 'ai-in-5-chat-guide (Manyfold)'
KIND = {'official': 'official', 'reported': 'reported', 'rumor': 'rumor'}


def _write_json_atomic(path, data):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


def _read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def get(path, timeout=20):
    req = urllib.request.Request(BASE + path, headers={'User-Agent': UA, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.load(res)


# A published issue changes only through a correction, so past issues keep for
# a day; the list and today's issue for ten minutes.
def cached(name, path, ttl):
    file = os.path.join(CACHE, name)
    try:
        if time.time() - os.path.getmtime(file) < ttl:
            with open(file) as f:
                return json.load(f)
    except (OSError, ValueError):
        pass
    data = get(path)
    _write_json_atomic(file, data)
    return data


def issues():
    return cached('issues.json', '/api/issues', 600)['issues']


def issue(date):
    latest = issues()[0]['date'] if issues() else None
    try:
        return cached(f'{date}.json', f'/api/issues/{urllib.parse.quote(date)}', 600 if date == latest else 86400)['issue']
    except urllib.error.HTTPError:
        sys.exit(f'no issue on {date}: run list for the dates there are')


# <m0>…</m0> marks a number the site matched against its source; the words stay.
MARK = re.compile(r'</?m\d+>')


def t(value, lang):
    if isinstance(value, dict):
        value = value.get(lang) or value.get('en') or ''
    return MARK.sub('', value) if isinstance(value, str) else ''


def link(lang, date, n=None):
    return f'{BASE}/{lang}/{date}' + (f'/{n}' if n else '')


def sources(story, lang):
    out = []
    for s in story.get('sources') or []:
        out.append(f"{t(s.get('name'), lang)} ({KIND.get(s.get('kind'), s.get('kind'))}, {(s.get('time') or '')[:10]}): {s.get('url')}")
    return out


def _print_story_entry(iss, n, s, lang, full=False):
    org = (s.get('org') or {}).get('name') or ''
    tags = ', '.join(x for x in (org, s.get('region'), t(s.get('cat'), lang)) if x)
    print(f"{n}. {t(s.get('title'), lang)}" + (f" [{tags}]" if tags else ""))
    print(f"   {t(s.get('summary'), lang)}")
    if full:
        if s.get('why'):
            print(f"   Why it matters: {t(s['why'], lang)}")
        if s.get('next'):
            print(f"   What to watch: {t(s['next'], lang)}")
    kinds = ', '.join(sorted({KIND.get(x.get('kind'), x.get('kind')) for x in s.get('sources') or []}))
    src_prefix = f"Sources: {kinds}. " if kinds else ""
    print(f"   {src_prefix}{link(lang, iss['date'], n)}")


def print_issue(iss, lang, full=False):
    print(f"AI in 5 No. {iss['number']}, {iss['date']}: {link(lang, iss['date'])}")
    print('Today in 3:')
    for item in iss.get('today') or []:
        print(f"- {t(item.get('text'), lang)}")
    print('Stories:')
    for n, s in enumerate(iss.get('stories') or [], 1):
        _print_story_entry(iss, n, s, lang, full=full)
    briefs = iss.get('briefs') or []
    if briefs:
        print('Briefs:')
        for b in briefs:
            print(f"- {t(b.get('text'), lang)} ({t(b.get('src'), lang)}, {KIND.get(b.get('kind'), b.get('kind'))})")


def cmd_latest(args):
    if not issues():
        sys.exit('no issue has been published yet')
    print_issue(issue(issues()[0]['date']), args.lang)


def cmd_issue(args):
    print_issue(issue(args.date), args.lang, full=True)


def cmd_list(args):
    for i in issues():
        print(f"- {i['date']} No. {i['number']}: {t(i.get('headline'), args.lang)}")


def cmd_story(args):
    iss = issue(args.date)
    stories = iss.get('stories') or []
    if not 1 <= args.n <= len(stories):
        sys.exit(f"the {args.date} issue has stories 1 to {len(stories)}")
    s = stories[args.n - 1]
    print(t(s.get('title'), args.lang))
    print('; '.join(x for x in ((s.get('org') or {}).get('name'), f"region {s.get('region')}", t(s.get('cat'), args.lang)) if x))
    print(f"Summary: {t(s.get('summary'), args.lang)}")
    if s.get('why'):
        print(f"Why it matters: {t(s['why'], args.lang)}")
    if s.get('next'):
        print(f"What to watch: {t(s['next'], args.lang)}")
    if s.get('sourceLine'):
        print(f"Source line: {t(s['sourceLine'], args.lang)}")
    print('Sources:')
    for line in sources(s, args.lang):
        print(f'- {line}')
    print(f"Page: {link(args.lang, args.date, args.n)}")


def cmd_search(args):
    words = [w.lower() for w in args.words]
    hits = 0
    for meta in issues():
        iss = issue(meta['date'])
        for n, s in enumerate(iss.get('stories') or [], 1):
            text = ' '.join([t(s.get(k), lang) for k in ('title', 'summary', 'why', 'next') for lang in ('en', 'zh')] + [(s.get('org') or {}).get('name') or '']).lower()
            if all(w in text for w in words):
                hits += 1
                print(f"- {meta['date']} story {n}: {t(s.get('title'), args.lang)}\n  {t(s.get('summary'), args.lang)}\n  {link(args.lang, meta['date'], n)}")
        for b in iss.get('briefs') or []:
            text = ' '.join(t(b.get('text'), lang) for lang in ('en', 'zh')).lower()
            if all(w in text for w in words):
                hits += 1
                print(f"- {meta['date']} brief: {t(b.get('text'), args.lang)} ({t(b.get('src'), args.lang)})\n  {link(args.lang, meta['date'])}")
        if hits >= args.limit:
            break
    if not hits:
        print(f'No issue of AI in 5 mentions "{" ".join(args.words)}" (issues since {issues()[-1]["date"] if issues() else "-"}).')


def cmd_corrections(args):
    items = cached('corrections.json', '/api/issues/corrections', 600).get('corrections') or []
    if not items:
        print('No corrections so far.')
    for c in items:
        print(f'- {json.dumps(c, ensure_ascii=False)[:400]}')
    print(f'{BASE}/en/corrections')


def cmd_updates(args):
    """Print Top 3 stories + link if a newer issue exists than last-announced.json."""
    all_issues = issues()
    if not all_issues:
        print('NO_UPDATES')
        return
    latest_date = all_issues[0]['date']
    state_path = os.path.join(CACHE, 'last-announced.json')
    state = _read_json(state_path) or {}
    last_date = state.get('date')
    if isinstance(last_date, str) and latest_date <= last_date:
        print('NO_UPDATES')
        return

    iss = issue(latest_date)
    print(f"AI in 5 No. {iss['number']}, {iss['date']}: {link(args.lang, iss['date'])}")
    stories = (iss.get('stories') or [])[:3]
    if stories:
        print('Top 3 stories:')
        for n, s in enumerate(stories, 1):
            _print_story_entry(iss, n, s, args.lang)
    else:
        for item in (iss.get('today') or [])[:3]:
            print(f"- {t(item.get('text'), args.lang)}")

    if args.mark:
        _write_json_atomic(state_path, {
            'date': iss['date'],
            'number': iss.get('number'),
            'announced_at': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        })


def main():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--lang', choices=['en', 'zh'], default='en')
    ap = argparse.ArgumentParser(description='AI in 5 lookups')
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('latest', parents=[common]).set_defaults(fn=cmd_latest)
    s = sub.add_parser('issue', parents=[common])
    s.add_argument('date')
    s.set_defaults(fn=cmd_issue)
    sub.add_parser('list', parents=[common]).set_defaults(fn=cmd_list)
    s = sub.add_parser('story', parents=[common])
    s.add_argument('date')
    s.add_argument('n', type=int)
    s.set_defaults(fn=cmd_story)
    s = sub.add_parser('search', parents=[common])
    s.add_argument('words', nargs='+')
    s.add_argument('--limit', type=int, default=8)
    s.set_defaults(fn=cmd_search)
    sub.add_parser('corrections', parents=[common]).set_defaults(fn=cmd_corrections)
    s = sub.add_parser('updates', parents=[common])
    s.add_argument('--mark', action='store_true')
    s.set_defaults(fn=cmd_updates)
    args = ap.parse_args()
    try:
        args.fn(args)
    except urllib.error.URLError as err:
        sys.exit(f'AI in 5 did not answer ({err}); say it is unreachable right now')


if __name__ == '__main__':
    main()
