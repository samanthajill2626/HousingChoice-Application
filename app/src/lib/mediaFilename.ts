// The download name for one served media attachment. PURE - no I/O, no config.
//
// Two rules carry the security weight here, and both exist because the stored
// filename originates in a MIME part the SENDER controls (inboundEmail.ts
// persists it verbatim):
//
//  1. The extension is always chosen from one of our own closed sets, never
//     copied from stored data as a string. The point of this feature is a name
//     the operating system ACTS ON, which is precisely why the sender must not
//     choose it: today's extensionless `attachment-0` is inert, and
//     `invoice.exe` would not be.
//  2. Everything that reaches a header is stripped of CR, LF, quotes and
//     backslashes, so a stored name cannot inject a second header.
import { isAcceptedExtension, type ResolvedMediaType } from './mediaTypes.js';

/** Max stem length. Bounds the STEM, never the emitted name - see below. */
const MAX_STEM = 100;

/** emailMime.ts synthesizes this for a nameless MIME part; it is not a name. */
const SYNTHESIZED = /^attachment-\d+$/;

/**
 * The Windows RESERVED DEVICE NAMES. `CON`, `NUL`, `COM1` and friends are not
 * filenames on Windows at all - they name devices, and they do so regardless of
 * extension, so `PRN.mov` is as unusable as `PRN`. Matched on the STEM and
 * case-insensitively, which is why `CONTRACT` (a prefix, not the whole stem) is
 * untouched.
 */
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** An ASCII name for `filename=`, plus the original for `filename*` when they
 *  differ. */
export interface MediaFilename {
  ascii: string;
  utf8?: string | undefined;
}

/**
 * SANITIZE FIRST, THEN SPLIT. The order is load-bearing and is the single
 * easiest thing to get wrong here: splitting first finds the dot at index 4 of
 * `../../etc/passwd` and hands `./etc/passwd` to the extension logic. Removing
 * the separators and traversal first leaves `etcpasswd`, which has no
 * extension at all - the correct reading.
 *
 * Every rule REMOVES or REPLACES matched characters; none rejects the whole
 * name. Control characters become a SPACE rather than vanishing, so `a\r\nb`
 * is `a b` and not the silently-joined `ab`.
 */
function sanitizeName(raw: string): string {
  let s = raw;
  s = s.replace(/[\r\n\t\0]/g, ' ');
  s = s.replace(/["\\]/g, '');
  s = s.replace(/\//g, '');
  // Windows-reserved characters. A name we hand to an operator's browser has
  // to be a legal filename on their machine, and `:` in particular survives
  // every other rule here.
  s = s.replace(/[<>:|?*]/g, '');
  // Unicode DIRECTION CONTROLS, the one class this REMOVES rather than
  // replaces. They are invisible, carry no meaning inside a filename, and
  // reverse the display of everything after them - so `report<U+202E>fdp.csv`
  // is shown by any client honouring `filename*` as `reportvsc.pdf`, a CSV
  // wearing a PDF's face. The ASCII form already folds them to `_`; only the
  // UTF-8 companion carried them through. Removal cannot damage a legitimate
  // name, because a legitimate name does not depend on an override to read
  // correctly.
  s = s.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
  s = s.replace(/\.\./g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Split a SANITIZED name at the LAST dot: everything before is the stem, the
 * dot and everything after is the extension. Interior dots stay in the stem
 * (`data.tar.csv` -> `data.tar` + `.csv`). A name whose only dot is LEADING
 * (`.env`) is all extension and has an EMPTY stem - which is why the `dot > 0`
 * test is strict.
 */
function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return { stem: name, ext: '' };
  if (dot === 0) return { stem: '', ext: name };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/** True when nothing a human would recognise as a USABLE name survived
 *  sanitizing: empty, only separators/underscores/spaces, emailMime's
 *  placeholder, or a Windows reserved device name. Every one of these falls
 *  through to the synthesized `attachment-N` stem. */
function isUnusableStem(stem: string): boolean {
  return (
    stem.length === 0 ||
    /^[_\s]+$/.test(stem) ||
    SYNTHESIZED.test(stem) ||
    RESERVED_DEVICE.test(stem)
  );
}

/**
 * Drop a TRAILING LONE HIGH SURROGATE. `slice` cuts by UTF-16 code unit, so
 * capping the stem can land between the halves of an astral character; a high
 * surrogate at the very END of a string is unpaired by definition. Left in
 * place it makes `encodeURIComponent` throw, and the catch in `rfc5987` then
 * drops `filename*` ENTIRELY - so a merely long international name loses the
 * parameter that exists for it. The catch is for hostile input; this stops the
 * code manufacturing that condition out of valid input.
 */
function dropLoneHighSurrogate(s: string): string {
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
}

/** RFC 5987 ext-value. encodeURIComponent leaves five characters bare that the
 *  grammar reserves, so they are escaped explicitly. Returns undefined when the
 *  value cannot be encoded at all - encodeURIComponent THROWS URIError on a
 *  lone surrogate, and a stored filename is untrusted data, so an unpaired
 *  surrogate must degrade to "no filename* parameter" rather than 500 the
 *  authed media route. */
function rfc5987(value: string): string | undefined {
  try {
    return encodeURIComponent(value).replace(
      /['()*!]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  } catch {
    return undefined;
  }
}

/**
 * The filename for attachment `index` (ZERO-based, as the URL carries it) of a
 * message, given its resolved type. The emitted name is one-based to match the
 * "Attachment N" the dashboard shows for the same attachment.
 */
export function buildMediaFilenameParts(
  storedFilename: string | undefined,
  index: number,
  resolved: ResolvedMediaType,
): MediaFilename {
  const cleaned = typeof storedFilename === 'string' ? sanitizeName(storedFilename) : '';
  const stored = cleaned.length > 0 ? splitName(cleaned) : undefined;

  // Trailing dots AND whitespace are stripped BEFORE the cap and AGAIN after
  // it: the cap can turn an interior dot into a trailing one (emitting
  // `name..mp4`), and can equally expose a trailing space (`report .mp4`).
  const trimEnd = (s: string): string => s.replace(/[\s.]+$/, '');
  const stem = trimEnd(dropLoneHighSurrogate(trimEnd(stored?.stem ?? '').slice(0, MAX_STEM)));

  // Replace, never drop: dropping empties a wholly non-ASCII stem, and an
  // empty ASCII stem would emit filename=".xlsx".
  const asciiStem = stem.replace(/[^\x20-\x7e]/g, '_');
  const ext = extFor(resolved, stored);

  // The two forms are decided INDEPENDENTLY, and that is the point. A wholly
  // non-ASCII name folds to all-underscores, which is not a usable ASCII name -
  // but the ORIGINAL is still a perfectly good `filename*`, and clients that
  // understand it will show the operator their real filename. Collapsing both
  // decisions into one loses `filename*` for exactly the population it exists
  // for.
  const ascii = isUnusableStem(asciiStem)
    ? `attachment-${index + 1}${ext}`
    : `${asciiStem}${ext}`;
  // The SAME usability test on the original: a reserved device name is not a
  // usable `filename*` either, and offering one there would simply move the
  // problem into the parameter clients prefer.
  const utf8Usable = !isUnusableStem(stem) && stem !== asciiStem;

  return { ascii, ...(utf8Usable && { utf8: `${stem}${ext}` }) };
}

/**
 * Inline and declarable: the type is known, so the extension is ours.
 * Opaque: the type is unrecoverable, so a stored extension we RECOGNISE is
 * better information than `.bin` - a membership test against our closed set,
 * never a passthrough.
 */
function extFor(
  resolved: ResolvedMediaType,
  stored: { stem: string; ext: string } | undefined,
): string {
  if (resolved.tier === 'opaque' && stored !== undefined && isAcceptedExtension(stored.ext)) {
    return stored.ext.toLowerCase();
  }
  return resolved.ext;
}

/** The ASCII name alone - what most callers and every test want. */
export function buildMediaFilename(
  storedFilename: string | undefined,
  index: number,
  resolved: ResolvedMediaType,
): string {
  return buildMediaFilenameParts(storedFilename, index, resolved).ascii;
}

/**
 * Assemble the header value. The two parameters are made safe by DIFFERENT
 * mechanisms, which is worth stating because the asymmetry looks like an
 * oversight: `filename=` is a quoted string, so it is STRIPPED of CR, LF, NUL,
 * quote and backslash (defence in depth - the builder already removed them);
 * `filename*` is percent-encoded end to end, so no character in it can escape
 * the header at all.
 */
export function contentDispositionHeader(
  kind: 'inline' | 'attachment',
  name: MediaFilename,
): string {
  const safe = name.ascii.replace(/[\r\n\0"\\]/g, '');
  const base = `${kind}; filename="${safe}"`;
  if (name.utf8 === undefined || name.utf8 === name.ascii) return base;
  const encoded = rfc5987(name.utf8);
  if (encoded === undefined) return base;
  return `${base}; filename*=UTF-8''${encoded}`;
}
