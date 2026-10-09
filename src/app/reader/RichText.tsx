/**
 * Renders story text with its two markers: <mN>…</mN> becomes a highlighted, checked
 * number (tap to see the source), [n] becomes a citation link. Plain React elements
 * only — issue text is never injected as HTML.
 */

import { Fragment, type KeyboardEvent } from 'react';
import { tokenize } from '../../shared/issue';

export interface MarkControls {
  storyId: string;
  open: number | null;
  toggle: (index: number) => void;
}

export function MarkButton({ index, text, controls }: { index: number; text: string; controls: MarkControls }) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      controls.toggle(index);
    }
  };
  return (
    <span
      className="mark"
      role="button"
      tabIndex={0}
      aria-expanded={controls.open === index}
      aria-controls={`proof-${controls.storyId}`}
      onClick={() => controls.toggle(index)}
      onKeyDown={onKey}
    >
      {text}
    </span>
  );
}

export default function RichText({ text, marks, citeKey }: { text: string; marks?: MarkControls; citeKey?: string }) {
  return (
    <>
      {tokenize(text).map((t, i) => {
        if (t.type === 'text') return <Fragment key={i}>{t.text}</Fragment>;
        if (t.type === 'mark') {
          return marks ? <MarkButton key={i} index={t.index} text={t.text} controls={marks} /> : <span key={i} className="mark">{t.text}</span>;
        }
        if (!citeKey) return null;
        const target = `${citeKey}-${t.n}`;
        return (
          <a
            key={i}
            className="cite-ref"
            href={`#${target}`}
            aria-label={`Source ${t.n}`}
            onClick={(e) => {
              e.preventDefault();
              document.getElementById(target)?.scrollIntoView({ block: 'nearest' });
            }}
          >
            {t.n}
          </a>
        );
      })}
    </>
  );
}
