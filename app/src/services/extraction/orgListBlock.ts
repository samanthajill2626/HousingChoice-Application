// The ORGANIZATION LIST block of the extraction USER content (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D8). The extraction job renders it ONCE per run from the stored list
// (repos/orgListRepo.ts) and hands the text to the driver through
// ExtractionInput.orgListBlock, so the SYSTEM prompt stays a static template
// whose memoized fingerprint keeps identifying one contract. `fingerprint`
// (sha256 hex of the text) is what the run log records as orgListFingerprint,
// so runs that saw the same list group together.
//
// Rules that keep the block safe inside newline-structured user content:
//   - prompt.ts places it BEFORE the TRANSCRIPT header, and the block never
//     contains that word: every line after the header must be a rendered
//     transcript line (the run log hashes them). A name or spelling holding
//     the word, in any case, is left out and counted as UNRENDERABLE - no
//     budget would ever bring it back, so it is no budget drop and no WARN;
//   - every name and spelling renders on ONE line: control characters
//     (newlines included) become spaces, so a staff-entered name can never
//     start a line of its own;
//   - a 16,000-character budget. Priority: housing authority names, then
//     agency names, then spellings. Over budget, spellings are dropped first,
//     then agency names, then the housing authority names that do not fit;
//     once a name of a higher class has not fit, nothing of a lower class is
//     added. The job logs these BUDGET drops (`dropped`) at WARN with their
//     counts (spec D8).
//
// Housing authorities carry their spellings (the model maps "AHA" or "Atlanta
// (AHA)" to a full name); agencies are listed by NAME only, under a "not
// housing authorities" heading. apply.ts resolves the model's text against the
// FULL list (agency spellings included), so an agency named by a spelling is
// still dropped as agency_not_authority.
import { createHash } from 'node:crypto';
import type { OrgEntry } from '../../lib/orgNames.js';

/** Spec D8: the block's character budget. */
export const ORG_LIST_BLOCK_BUDGET = 16_000;
/** The block's first line - the name the system prompt gives it. */
export const ORG_LIST_BLOCK_HEADER = 'ORGANIZATION LIST';

const AUTHORITY_HEADING = 'Housing authorities (full name, then its other spellings):';
const AGENCY_HEADING = 'Agencies (not housing authorities):';
const FIRST_SPELLING = ' | also: ';
const NEXT_SPELLING = ' | ';

export interface OrgListBlock {
  text: string;
  /** sha256 hex of `text` - the run log's orgListFingerprint. */
  fingerprint: string;
  /** Names and spellings the BUDGET left out (spec D8: the job WARNs on these). */
  dropped: { spellings: number; agencies: number; authorities: number };
  /** Names and spellings that can never be rendered (blank, or holding the
   *  word TRANSCRIPT) - a name's spellings go with it. No WARN. */
  unrenderable: { spellings: number; agencies: number; authorities: number };
}

/**
 * One line: C0 and C1 control characters (newlines and tabs included), DEL and
 * the Unicode line/paragraph separators become spaces; space runs collapse.
 * Character codes, not a regex, so no control character is typed into source.
 */
function oneLine(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    out += control ? ' ' : ch;
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

/** Renderable: not blank, and never the transcript header's word in any case. */
function renderable(text: string): boolean {
  return text.length > 0 && !/transcript/i.test(text);
}

/** Code-unit order: the text must not depend on the host's ICU data or on stored order. */
function byName(a: OrgEntry, b: OrgEntry): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function renderOrgListBlock(
  entries: readonly OrgEntry[],
  opts: { budget?: number } = {},
): OrgListBlock {
  const budget = opts.budget ?? ORG_LIST_BLOCK_BUDGET;
  const dropped = { spellings: 0, agencies: 0, authorities: 0 };
  const unrenderable = { spellings: 0, agencies: 0, authorities: 0 };
  const authorities = entries.filter((e) => e.kind === 'housing_authority').sort(byName);
  const agencies = entries.filter((e) => e.kind === 'agency').sort(byName);
  // The three fixed lines; every added line costs its length plus one newline.
  // A budget below the fixed lines renders the headings alone.
  let used = ORG_LIST_BLOCK_HEADER.length + 1 + AUTHORITY_HEADING.length + 1 + AGENCY_HEADING.length;
  const take = (cost: number): boolean => {
    if (used + cost > budget) return false;
    used += cost;
    return true;
  };

  // 1. Housing authority names - the highest priority.
  const kept: Array<{ entry: OrgEntry; name: string; spellings: string[] }> = [];
  let authorityCut = false;
  for (const entry of authorities) {
    const name = oneLine(entry.name);
    if (!renderable(name)) {
      // Never renderable: no budget would bring it (or its spellings) back.
      unrenderable.authorities += 1;
      unrenderable.spellings += entry.spellings.length;
      continue;
    }
    if (take(1 + 2 + name.length)) {
      kept.push({ entry, name, spellings: [] });
      continue;
    }
    authorityCut = true;
    dropped.authorities += 1;
    // Its spellings cannot be shown without it.
    dropped.spellings += entry.spellings.length;
  }

  // 2. Agency names - none at all once a housing authority name did not fit.
  const agencyNames: string[] = [];
  let agencyCut = false;
  for (const entry of agencies) {
    const name = oneLine(entry.name);
    if (!renderable(name)) {
      unrenderable.agencies += 1;
      continue;
    }
    if (!authorityCut && take(1 + 2 + name.length)) {
      agencyNames.push(name);
      continue;
    }
    if (!authorityCut) agencyCut = true;
    dropped.agencies += 1;
  }

  // 3. Spellings of the kept housing authorities - the lowest priority.
  for (const line of kept) {
    for (const raw of line.entry.spellings) {
      const spelling = oneLine(raw);
      const cost = (line.spellings.length === 0 ? FIRST_SPELLING.length : NEXT_SPELLING.length) + spelling.length;
      if (!renderable(spelling)) {
        unrenderable.spellings += 1;
      } else if (!authorityCut && !agencyCut && take(cost)) {
        line.spellings.push(spelling);
      } else {
        dropped.spellings += 1;
      }
    }
  }

  const authorityLine = (line: (typeof kept)[number]): string =>
    line.spellings.length === 0
      ? `- ${line.name}`
      : `- ${line.name}${FIRST_SPELLING}${line.spellings.join(NEXT_SPELLING)}`;
  const text = [
    ORG_LIST_BLOCK_HEADER,
    AUTHORITY_HEADING,
    ...kept.map(authorityLine),
    AGENCY_HEADING,
    ...agencyNames.map((name) => `- ${name}`),
  ].join('\n');
  return { text, fingerprint: createHash('sha256').update(text, 'utf8').digest('hex'), dropped, unrenderable };
}
