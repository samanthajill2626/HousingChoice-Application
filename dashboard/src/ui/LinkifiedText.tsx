import Autolinker from 'autolinker';
import { Fragment } from 'react';
import { safeHttpUrl } from '../lib/safeUrl.js';
import styles from './LinkifiedText.module.css';

export type LinkifiedToken =
  | { kind: 'text'; start: number; end: number; text: string }
  | { kind: 'link'; start: number; end: number; text: string; href: string };

export interface LinkifiedTextProps {
  text: string;
  displayEnd?: number;
  suffix?: string;
}

const autolinkerOptions = {
  urls: { schemeMatches: true, tldMatches: true, ipV4Matches: false },
  email: false,
  phone: false,
  mention: false,
  hashtag: false,
} as const;

function maskedParserText(text: string): string {
  return text.replaceAll('<', '\uFF1C').replaceAll('>', '\uFF1E');
}

type AutolinkerMatch = Extract<ReturnType<typeof Autolinker.parse>[number], { type: 'url' }>;

function normalizedHref(match: AutolinkerMatch, source: string): string | null {
  const candidate = source.startsWith('//')
    ? `https:${source}`
    : match.getUrlMatchType() === 'tld'
      ? `https://${source}`
      : source;
  return safeHttpUrl(candidate);
}

export function tokenizeLinkifiedText(text: string, displayEnd?: number): LinkifiedToken[] {
  const visibleEnd = Math.max(0, Math.min(text.length, Math.trunc(displayEnd ?? text.length)));
  const tokens: LinkifiedToken[] = [];
  let cursor = 0;

  for (const match of Autolinker.parse(maskedParserText(text), autolinkerOptions)) {
    if (match.type !== 'url') continue;
    const start = match.getOffset();
    const matchEnd = start + match.getMatchedText().length;
    const source = text.slice(start, matchEnd);
    if (start >= visibleEnd) break;
    if (cursor < start) {
      tokens.push({ kind: 'text', start: cursor, end: start, text: text.slice(cursor, start) });
    }

    const end = Math.min(matchEnd, visibleEnd);
    const href = normalizedHref(match, source);
    const visible = text.slice(start, end);
    tokens.push(
      href === null
        ? { kind: 'text', start, end, text: visible }
        : { kind: 'link', start, end, text: visible, href },
    );
    cursor = end;
  }

  if (cursor < visibleEnd) {
    tokens.push({ kind: 'text', start: cursor, end: visibleEnd, text: text.slice(cursor, visibleEnd) });
  }
  return tokens;
}

export function LinkifiedText({ text, displayEnd, suffix }: LinkifiedTextProps): React.JSX.Element {
  const tokens = tokenizeLinkifiedText(text, displayEnd);
  return (
    <>
      {tokens.map((token) =>
        token.kind === 'text' ? (
          <Fragment key={`${token.start}-${token.end}`}>{token.text}</Fragment>
        ) : (
          <a
            key={`${token.start}-${token.end}`}
            className={styles.link}
            href={token.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            {token.text}
          </a>
        ),
      )}
      {suffix}
    </>
  );
}
