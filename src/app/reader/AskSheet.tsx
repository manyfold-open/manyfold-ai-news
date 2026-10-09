/**
 * "Ask your own question": a sheet scoped to one story. Asking is for subscribers, so
 * non-subscribers see the one-field gate. Free-form answers are not open yet (they need
 * the grounded-answer service described in the product plan), so subscribers see that
 * plainly, followed by the story's answered questions.
 */

import { useEffect, useRef } from 'react';
import type { Issue, Lang, Story } from '../../shared/issue';
import { COPY } from './i18n';
import { AskList } from './Story';
import SubscribeForm from './Subscribe';
import { useSubscribed } from './data';

export default function AskSheet({ issue, story, lang, onClose }: { issue: Issue; story: Story; lang: Lang; onClose: () => void }) {
  const T = COPY[lang];
  const subscribed = useSubscribed();
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    sheet.current?.querySelector<HTMLElement>('input, button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [onClose]);

  return (
    <div className="sheet-root">
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" ref={sheet}>
        <div className="handle" aria-hidden="true" />
        <div className="sheet-head">
          <p className="sheet-title" id="sheet-title">
            {T.sheetTitle}
          </p>
          <button type="button" className="text-btn" onClick={onClose}>
            {T.close}
          </button>
        </div>
        <p className="sheet-story">{story.title[lang]}</p>
        <p className="sheet-note">{T.sheetNote(story.sources.length)}</p>
        <div className="sheet-body">
          {subscribed ? (
            <>
              <p className="soon">{T.ownSoon}</p>
              <ul className="ask-list">
                <AskList issue={issue} story={story} lang={lang} idPrefix="sheet" />
              </ul>
            </>
          ) : (
            <div className="gate">
              <p>{T.gateText}</p>
              <SubscribeForm lang={lang} source="gate" button={T.gateButton} className="gate-form" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
