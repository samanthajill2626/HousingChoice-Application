# Inbound media content-type fidelity - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve inbound media with its true Content-Type and a correctly typed
filename, and repair the production rows and S3 objects whose original type was
already destroyed.

**Architecture:** One resolver (`resolveMediaTier`) classifies every stored
media type into inline / declarable / opaque and returns the canonical type
plus its extension. The write side normalizes through it, the serve route
branches on it, and a pure filename builder turns it plus any stored filename
into a safe `Content-Disposition`. A one-time ops script recovers lost types
from the Twilio Media API and rewrites the S3 object, the pointer row and the
message row, in that order.

**Tech Stack:** TypeScript, Node 24, Express 5, DynamoDB (Local for tests),
S3/MinIO, Vitest, Playwright, React 19.

**Spec:** `docs/superpowers/specs/2026-08-26-media-content-type-fidelity-design.md`
- read it before Task 1. This plan implements it; where the plan is silent the
spec governs. Design review: R1-R4, 52 findings, adjudications preserved at
`W:\tmp\handbacks\media-content-type-fidelity\design-review\`.

## Global Constraints

- ASCII-only in every new or touched line: source, comments, test names, log
  strings, docs. The two dashboard components already contain non-ASCII emoji
  glyphs; do not add more and do not "fix" the existing ones.
- Never use `git add -A`. Stage explicit paths only. Read bare `git status`
  before every commit and check `.git/MERGE_HEAD`.
- Every commit gets `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Vendor SDK imports live only in `app/src/adapters`. Services, routes, jobs and
  scripts depend on the interfaces, never on `twilio` or `@aws-sdk/client-s3`
  directly.
- Media movement is STREAMS ONLY. No whole-file buffers. (Task 6 moves no
  bytes at all - `CopyObject` is server-side.)
- No new runtime dependencies. Everything here uses what is already installed.
- Do not touch `isInlineMediaType`'s set OR its exact-match semantics. It gates
  the outbound upload endpoint. See Task 1 Step 3.
- Log lines carry IDs and counts only - never filenames, bodies, phone numbers,
  media URLs or bytes.

## Slice integrity - READ BEFORE STARTING

Tasks 1-8 are individually reviewable but the BRANCH IS NOT MERGEABLE UNTIL
TASK 4 IS DONE. Task 1 widens what the mirror stores, so a newly received HEIC
photo would be stored as `image/heic`; until Task 4 lands, both dashboard
galleries still branch on `contentType.startsWith('image/')` and would render
it as a broken `<img>`. That is the exact regression the spec forbids.

Nothing between Tasks 1 and 4 is deployed independently, so this is a review
constraint, not a runtime one - but do not let anyone cherry-pick Task 1 alone.

---

### Task 1: The tier resolver and the two extension sets

**Files:**
- Modify: `app/src/lib/mediaTypes.ts`
- Test: `app/test/mediaTypes.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type MediaTier = 'inline' | 'declarable' | 'opaque'`
  - `interface ResolvedMediaType { tier: MediaTier; canonical: string; ext: string }`
  - `resolveMediaTier(raw: string | undefined): ResolvedMediaType`
  - `isAcceptedExtension(ext: string): boolean`
  - `DECLARABLE_MEDIA_TYPES: ReadonlySet<string>`
  - `normalizeStoredMediaType(raw: string | undefined): string` (existing name,
    reimplemented on the resolver, same signature)

- [ ] **Step 1: Write the failing tests**

Append to `app/test/mediaTypes.test.ts`:

```ts
describe('resolveMediaTier', () => {
  it('classifies the inline allowlist and returns the canonical type + extension', () => {
    expect(resolveMediaTier('image/png')).toEqual({
      tier: 'inline',
      canonical: 'image/png',
      ext: '.png',
    });
    expect(resolveMediaTier('application/pdf').tier).toBe('inline');
  });

  it('classifies the declarable allowlist', () => {
    expect(resolveMediaTier('video/mp4')).toEqual({
      tier: 'declarable',
      canonical: 'video/mp4',
      ext: '.mp4',
    });
    expect(resolveMediaTier('image/heic').tier).toBe('declarable');
    expect(resolveMediaTier('text/vcard').tier).toBe('declarable');
  });

  it('matches on the media-type ESSENCE, so parameterized wire forms are not lost', () => {
    // The whole feature is defeated for text/plain and video/3gpp without this.
    expect(resolveMediaTier('text/plain; charset=utf-8')).toEqual({
      tier: 'declarable',
      canonical: 'text/plain',
      ext: '.txt',
    });
    expect(resolveMediaTier('IMAGE/PNG ; charset=x').canonical).toBe('image/png');
  });

  it('refuses every script-capable type regardless of parameters', () => {
    for (const raw of [
      'text/html',
      'text/html; charset=utf-8',
      'image/svg+xml',
      'application/xhtml+xml',
      'text/xml',
      'application/xml',
      'application/javascript',
    ]) {
      expect(resolveMediaTier(raw)).toEqual({
        tier: 'opaque',
        canonical: 'application/octet-stream',
        ext: '.bin',
      });
    }
  });

  it('treats unknown and absent as opaque', () => {
    expect(resolveMediaTier('application/x-made-up').tier).toBe('opaque');
    expect(resolveMediaTier(undefined).tier).toBe('opaque');
    expect(resolveMediaTier('').tier).toBe('opaque');
  });
});

describe('isAcceptedExtension', () => {
  it('accepts spelling variants the emission map does not emit', () => {
    // REGRESSION GUARD: deriving this set from the emission map's values
    // rejects .jpeg and turns photo.jpeg into photo.bin - the exact outcome
    // the opaque-tier extension rule exists to prevent.
    expect(isAcceptedExtension('.jpg')).toBe(true);
    expect(isAcceptedExtension('.jpeg')).toBe(true);
    expect(isAcceptedExtension('.tif')).toBe(true);
    expect(isAcceptedExtension('.3gp')).toBe(true);
    expect(isAcceptedExtension('.vcf')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isAcceptedExtension('.XLSX')).toBe(true);
  });

  it('never accepts an executable or script extension', () => {
    for (const ext of ['.exe', '.js', '.html', '.htm', '.svg', '.bat', '.sh', '.ps1']) {
      expect(isAcceptedExtension(ext)).toBe(false);
    }
  });
});

describe('normalizeStoredMediaType (widened)', () => {
  it('keeps declarable types now, not just inline ones', () => {
    expect(normalizeStoredMediaType('video/mp4')).toBe('video/mp4');
    expect(normalizeStoredMediaType('image/heic')).toBe('image/heic');
  });

  it('still collapses script-capable and unknown types', () => {
    expect(normalizeStoredMediaType('text/html')).toBe('application/octet-stream');
    expect(normalizeStoredMediaType('image/svg+xml')).toBe('application/octet-stream');
    expect(normalizeStoredMediaType(undefined)).toBe('application/octet-stream');
  });

  it('returns the canonical member for a parameterized type', () => {
    expect(normalizeStoredMediaType('text/csv; charset=utf-8')).toBe('text/csv');
  });
});

describe('isInlineMediaType is NOT widened (outbound upload gate)', () => {
  it('still refuses declarable types', () => {
    // routes/mmsMedia.ts:78 gates staff uploads on this. Widening it would
    // silently let video and documents through to Twilio, which cannot carry
    // them (error 12300).
    expect(isInlineMediaType('video/mp4')).toBe(false);
    expect(isInlineMediaType('text/vcard')).toBe(false);
  });

  it('keeps its exact-match semantics', () => {
    expect(isInlineMediaType('image/png; charset=x')).toBe(false);
  });
});
```

Add `resolveMediaTier` and `isAcceptedExtension` to the file's existing import
from `../src/lib/mediaTypes.js`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npx vitest run test/mediaTypes.test.ts`
Expected: FAIL - `resolveMediaTier is not a function`.

- [ ] **Step 3: Implement**

In `app/src/lib/mediaTypes.ts`, ADD below the existing `INLINE_MEDIA_TYPES`
block (leave `IMAGE_MEDIA_TYPES`, `INLINE_MEDIA_TYPES`, `isInlineMediaType` and
`isImageMediaType` exactly as they are):

```ts
/**
 * Types served with their TRUE Content-Type but ALWAYS as a download
 * (Content-Disposition: attachment) - never rendered same-origin. None is
 * script-capable, which is the whole entry criterion: a browser handed one of
 * these cannot execute anything in the dashboard origin.
 *
 * DELIBERATELY EXCLUDED, permanently: text/html, application/xhtml+xml,
 * image/svg+xml, text/xml, application/xml, application/javascript. Those DO
 * run script on top-level navigation and stay on the opaque tier forever.
 */
export const DECLARABLE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'video/mp4',
  'video/quicktime',
  'video/3gpp',
  'video/3gpp2',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/amr',
  'audio/wav',
  'image/heic',
  'image/heif',
  'image/bmp',
  'image/tiff',
  'text/vcard',
  'text/x-vcard',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/**
 * The EMISSION map: canonical type -> the ONE extension we synthesize for it.
 * Do NOT build the accepted-extension set below out of these values - see the
 * comment there for why that is a defect rather than a shortcut.
 *
 * Duplicated by design with EMAIL_EXTENSIONS (services/sendEmailMessage.ts),
 * which names an OUTBOUND MIME part rather than a download we offer. Neither
 * feeds a security decision, so the divergence is cosmetic and merging them is
 * out of scope (spec non-goal 4).
 */
const MEDIA_TYPE_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['application/pdf', '.pdf'],
  ['video/mp4', '.mp4'],
  ['video/quicktime', '.mov'],
  ['video/3gpp', '.3gp'],
  ['video/3gpp2', '.3g2'],
  ['video/webm', '.webm'],
  ['audio/mpeg', '.mp3'],
  ['audio/mp4', '.m4a'],
  ['audio/aac', '.aac'],
  ['audio/ogg', '.ogg'],
  ['audio/amr', '.amr'],
  ['audio/wav', '.wav'],
  ['image/heic', '.heic'],
  ['image/heif', '.heif'],
  ['image/bmp', '.bmp'],
  ['image/tiff', '.tiff'],
  ['text/vcard', '.vcf'],
  ['text/x-vcard', '.vcf'],
  ['text/plain', '.txt'],
  ['text/csv', '.csv'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
]);

/**
 * Extensions we will KEEP off a stored filename when the type itself is
 * unrecoverable (the opaque tier). Wider than the emission map on purpose: the
 * map emits `.jpg`, so a set derived from its values would reject `photo.jpeg`
 * and produce `photo.bin` - exactly the outcome the opaque-tier rule exists to
 * prevent. Hand-written, exhaustive, and containing no active extension EVER:
 * this set decides what reaches an operator's filesystem.
 */
const ACCEPTED_EXTENSIONS: ReadonlySet<string> = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif',
  '.mp4', '.m4v', '.mov', '.3gp', '.3g2', '.webm',
  '.mp3', '.m4a', '.aac', '.oga', '.ogg', '.amr', '.wav',
  '.pdf', '.txt', '.csv', '.vcf', '.docx', '.xlsx',
]);

export type MediaTier = 'inline' | 'declarable' | 'opaque';

export interface ResolvedMediaType {
  tier: MediaTier;
  /** The allowlist's OWN string - never the caller's. */
  canonical: string;
  /** The extension we synthesize for `canonical`. `.bin` on the opaque tier. */
  ext: string;
}

/** Fresh object per call - never a shared mutable constant a caller could
 *  alter for everyone else. */
function opaque(): ResolvedMediaType {
  return { tier: 'opaque', canonical: 'application/octet-stream', ext: '.bin' };
}

/**
 * THE one tier decision. Every caller - the serve route, the write-side
 * normalizer - goes through this, so the tier, the response Content-Type and
 * the synthesized extension can never disagree with each other.
 *
 * Matches on the media-type ESSENCE (everything before the first `;`) because
 * `text/plain; charset=utf-8` and `video/3gpp; codecs=...` are ordinary wire
 * forms; an exact-string lookup drops them to the opaque tier and silently
 * defeats the feature for the types it adds.
 *
 * SECURITY: this NEWLY ADMITS the parameterized forms of ALLOWLISTED types -
 * `image/png; charset=x` now reaches the inline tier. That is safe because of
 * the CANONICAL OUTPUT, not the matching: the response header is our own
 * constant, so a caller-supplied parameterized string never reaches a header.
 * Non-allowlisted types are unaffected - `text/html; charset=x` has essence
 * `text/html` and still fails both sets.
 */
export function resolveMediaTier(raw: string | undefined): ResolvedMediaType {
  if (typeof raw !== 'string') return opaque();
  const essence = raw.split(';')[0]!.trim().toLowerCase();
  if (essence.length === 0) return opaque();
  const tier: MediaTier | undefined = INLINE_MEDIA_TYPES.has(essence)
    ? 'inline'
    : DECLARABLE_MEDIA_TYPES.has(essence)
      ? 'declarable'
      : undefined;
  if (tier === undefined) return opaque();
  return { tier, canonical: essence, ext: MEDIA_TYPE_EXTENSIONS.get(essence) ?? '.bin' };
}

/** True when `ext` (leading dot included) is one we are willing to emit. */
export function isAcceptedExtension(ext: string): boolean {
  return ACCEPTED_EXTENSIONS.has(ext.trim().toLowerCase());
}
```

Then REPLACE the body of the existing `normalizeStoredMediaType` (keep its
export name and signature; update its docblock to say it now keeps declarable
types too):

```ts
export function normalizeStoredMediaType(raw: string | undefined): string {
  return resolveMediaTier(raw).canonical;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && npx vitest run test/mediaTypes.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove BOTH callers of the widened function actually changed**

`normalizeStoredMediaType` has exactly two callers and this task changes the
behavior of both. Neither is covered by Step 1's tests, which only exercise the
helper directly. Add one test per caller.

To `app/test/mediaMirror.test.ts`, using the file's existing `mirrorMediaSet`
harness:

```ts
it('stores a declarable sender type truthfully', async () => {
  // The reported bug: a relay member's video was stored as octet-stream and
  // its real type lost forever the moment the object landed in S3.
  const out = await mirrorMediaSet(deps, {
    conversationId: 'c1',
    messageSid: 'MM1',
    targets: [{ index: 0, url: 'https://api.twilio.com/x', contentType: 'video/mp4' }],
    delaysMs: [],
  });
  expect(out.attachments[0]?.attachment.contentType).toBe('video/mp4');
  expect(putSpy).toHaveBeenCalledWith('media/c1/MM1/0', expect.anything(), 'video/mp4');
});

it('still collapses a script-capable sender type at rest', async () => {
  const out = await mirrorMediaSet(deps, {
    conversationId: 'c1',
    messageSid: 'MM2',
    targets: [{ index: 0, url: 'https://api.twilio.com/x', contentType: 'text/html' }],
    delaysMs: [],
  });
  expect(out.attachments[0]?.attachment.contentType).toBe('application/octet-stream');
});
```

To `app/test/inboundEmail.test.ts`, using its existing inbound-email harness:

```ts
it('stores an inbound docx attachment with its real type', async () => {
  // Same defect, different channel: an inbound .docx collapsed to
  // octet-stream exactly like an MMS video did.
  const stored = await ingestWithAttachment({
    filename: 'lease.docx',
    contentType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  expect(stored.media_attachments?.[0]?.contentType).toBe(
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
});
```

Run: `cd app && npx vitest run test/mediaTypes.test.ts test/mediaMirror.test.ts test/inboundEmail.test.ts test/mmsMedia.test.ts`
Expected: PASS. If an EXISTING mirror or inbound-email assertion says a
non-inline type collapses to octet-stream, that assertion is now WRONG by
design - update it and say so in the commit message. Do NOT weaken
`normalizeStoredMediaType` to keep an old assertion green.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/mediaTypes.ts app/test/mediaTypes.test.ts app/test/mediaMirror.test.ts app/test/inboundEmail.test.ts
git commit
```

Message: `feat(media): add the declarable tier and one resolveMediaTier`

---

### Task 2: The filename builder (pure)

**Files:**
- Create: `app/src/lib/mediaFilename.ts`
- Test: `app/test/mediaFilename.test.ts`

**Interfaces:**
- Consumes: `ResolvedMediaType`, `isAcceptedExtension` (Task 1).
- Produces:
  - `buildMediaFilename(storedFilename: string | undefined, index: number, resolved: ResolvedMediaType): string`
  - `contentDispositionHeader(kind: 'inline' | 'attachment', filename: string): string`

`index` is the ZERO-BASED attachment index from the URL; the function emits a
one-based name.

- [ ] **Step 1: Write the failing tests**

Create `app/test/mediaFilename.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildMediaFilename, contentDispositionHeader } from '../src/lib/mediaFilename.js';
import { resolveMediaTier } from '../src/lib/mediaTypes.js';

const MP4 = resolveMediaTier('video/mp4');
const XLSX = resolveMediaTier(
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
);
const OPAQUE = resolveMediaTier(undefined);

describe('buildMediaFilename - the extension is always ours', () => {
  it('synthesizes a ONE-based name when there is no stored filename', () => {
    // The header is 0-based today while the UI says "Attachment 1"; the
    // synthesized name matches the UI.
    expect(buildMediaFilename(undefined, 0, MP4)).toBe('attachment-1.mp4');
    expect(buildMediaFilename(undefined, 2, OPAQUE)).toBe('attachment-3.bin');
  });

  it('takes the stem from a stored filename but NEVER its extension', () => {
    // The stored name comes off a MIME part the sender controls. Honouring its
    // extension would let a sender choose what the operator's OS opens.
    expect(buildMediaFilename('invoice.exe', 0, MP4)).toBe('invoice.mp4');
    expect(buildMediaFilename('holiday.mov', 0, MP4)).toBe('holiday.mp4');
  });

  it('keeps an ACCEPTED stored extension on the opaque tier only', () => {
    // Historical inbound email: the type is unrecoverable but the real name
    // survives, so budget.xlsx must not download as budget.bin.
    expect(buildMediaFilename('budget.xlsx', 0, OPAQUE)).toBe('budget.xlsx');
    expect(buildMediaFilename('photo.jpeg', 0, OPAQUE)).toBe('photo.jpeg');
  });

  it('refuses an unaccepted stored extension on the opaque tier', () => {
    expect(buildMediaFilename('invoice.exe', 0, OPAQUE)).toBe('invoice.bin');
    expect(buildMediaFilename('run.ps1', 0, OPAQUE)).toBe('run.bin');
  });

  it('treats emailMime\'s synthesized name as absent', () => {
    // lib/emailMime.ts stores `attachment-<i>` for a nameless MIME part. It is
    // non-empty, so a naive "prefer the stored name" reproduces exactly the
    // extensionless 0-based name this feature removes.
    expect(buildMediaFilename('attachment-0', 0, XLSX)).toBe('attachment-1.xlsx');
    expect(buildMediaFilename('attachment-12', 3, MP4)).toBe('attachment-4.mp4');
  });
});

describe('buildMediaFilename - splitting and sanitizing', () => {
  it('splits at the LAST dot and keeps interior dots in the stem', () => {
    expect(buildMediaFilename('data.tar.csv', 0, OPAQUE)).toBe('data.tar.csv');
    expect(buildMediaFilename('data.tar.csv', 0, MP4)).toBe('data.tar.mp4');
  });

  it('treats a leading-dot-only name as having no stem', () => {
    expect(buildMediaFilename('.env', 0, MP4)).toBe('attachment-1.mp4');
  });

  it('never emits a double dot from a trailing-dot name', () => {
    expect(buildMediaFilename('report.', 0, MP4)).toBe('report.mp4');
    expect(buildMediaFilename('report...', 0, MP4)).toBe('report.mp4');
  });

  it('strips path separators, traversal and control characters', () => {
    expect(buildMediaFilename('../../etc/passwd', 0, MP4)).toBe('etcpasswd.mp4');
    expect(buildMediaFilename('a\r\nb', 0, MP4)).toBe('a b.mp4');
    expect(buildMediaFilename('he said "hi"', 0, MP4)).toBe('he said hi.mp4');
  });

  it('caps the STEM, not the emitted name, so the extension survives', () => {
    // Capping the whole name would truncate .xlsx to .xls and change the file
    // type the OS sees.
    const long = 'a'.repeat(120);
    const out = buildMediaFilename(`${long}.xlsx`, 0, XLSX);
    expect(out).toBe(`${'a'.repeat(100)}.xlsx`);
    expect(out.endsWith('.xlsx')).toBe(true);
  });

  it('replaces non-ASCII rather than dropping it', () => {
    // Dropping empties a wholly non-ASCII stem and yields filename=".xlsx".
    expect(buildMediaFilename('bud\u00e9get', 0, XLSX)).toBe('bud_get.xlsx');
    expect(buildMediaFilename('\u4f60\u597d', 0, XLSX)).toBe('attachment-1.xlsx');
  });
});

describe('contentDispositionHeader', () => {
  it('emits a plain ASCII filename parameter', () => {
    expect(contentDispositionHeader('attachment', 'budget.xlsx')).toBe(
      'attachment; filename="budget.xlsx"',
    );
  });

  it('supports the inline kind', () => {
    expect(contentDispositionHeader('inline', 'photo.jpg')).toBe(
      'inline; filename="photo.jpg"',
    );
  });

  it('cannot be injected into via a quote or CRLF', () => {
    // buildMediaFilename has already removed these; this is defence in depth
    // at the point the header string is actually assembled.
    const header = contentDispositionHeader('attachment', 'a"b\r\nX-Evil: 1');
    expect(header).not.toContain('\r');
    expect(header).not.toContain('\n');
    expect(header.match(/"/g)).toHaveLength(2);
  });
});
```

NOTE ON `filename*`: the spec allows an RFC 5987 parameter alongside the ASCII
one. This plan deliberately does NOT implement it. `buildMediaFilename`
transliterates non-ASCII to `_`, which is a complete and safe answer on its
own, and there is no RFC 5987 implementation in the repo to copy - so adding
one is new surface with its own encoding-bug risk for a cosmetic gain on a
population (non-ASCII inbound email attachment names) that has never been
reported. Flag this to the reviewer as a deliberate spec deviation.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npx vitest run test/mediaFilename.test.ts`
Expected: FAIL - cannot resolve `../src/lib/mediaFilename.js`.

- [ ] **Step 3: Implement**

Create `app/src/lib/mediaFilename.ts`:

```ts
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
 * Split a stored filename at the LAST dot: everything before is the stem,
 * the dot and everything after is the extension. Interior dots stay in the
 * stem (`data.tar.csv` -> `data.tar` + `.csv`). A name whose only dot is
 * leading (`.env`) is all extension and has an EMPTY stem.
 */
function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * Order matters. Every verb REMOVES the matched characters - none of them
 * rejects the whole name. The cap runs LAST so it can never re-expose a
 * sequence an earlier rule removed.
 */
function sanitizeStem(raw: string): string {
  let s = raw;
  s = s.replace(/[\r\n\0"\\]/g, '');
  s = s.replace(/[/\\]/g, '');
  s = s.replace(/\.\./g, '');
  // Replace, never drop: dropping empties a wholly non-ASCII stem, and an
  // empty ASCII stem would emit filename=".xlsx".
  s = s.replace(/[^\x20-\x7e]/g, '_');
  s = s.replace(/\s+/g, ' ').trim();
  // Makes "the stem never ends in a dot" TRUE rather than assumed - without
  // it `report.` yields `report..bin`.
  s = s.replace(/\.+$/, '');
  return s.slice(0, MAX_STEM);
}

/**
 * The filename for attachment `index` (ZERO-based, as the URL carries it) of a
 * message, given its resolved type. The emitted name is one-based to match the
 * "Attachment N" the dashboard shows for the same attachment.
 */
export function buildMediaFilename(
  storedFilename: string | undefined,
  index: number,
  resolved: ResolvedMediaType,
): string {
  const stored = typeof storedFilename === 'string' ? splitName(storedFilename) : undefined;
  const rawStem = stored ? sanitizeStem(stored.stem) : '';
  const usable = rawStem.length > 0 && !SYNTHESIZED.test(rawStem);
  const stem = usable ? rawStem : `attachment-${index + 1}`;

  // Inline and declarable: the type is known, so the extension is ours.
  // Opaque: the type is unrecoverable, so a stored extension we RECOGNISE is
  // better information than `.bin` - a membership test against our closed set,
  // never a passthrough.
  let ext = resolved.ext;
  if (resolved.tier === 'opaque' && stored !== undefined && isAcceptedExtension(stored.ext)) {
    ext = stored.ext.toLowerCase();
  }
  return `${stem}${ext}`;
}

/** Assemble the header value. Defence in depth: strips anything a future
 *  caller might pass that buildMediaFilename would already have removed. */
export function contentDispositionHeader(
  kind: 'inline' | 'attachment',
  filename: string,
): string {
  const safe = filename.replace(/[\r\n\0"\\]/g, '');
  return `${kind}; filename="${safe}"`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && npx vitest run test/mediaFilename.test.ts`
Expected: PASS. If `'../../etc/passwd'` does not produce `etcpasswd.mp4`, work
out which rule fired in which order before changing anything - the ORDER in
`sanitizeStem` is deliberate.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/mediaFilename.ts app/test/mediaFilename.test.ts
git commit
```

Message: `feat(media): pure download-filename builder with an owned extension`

---

### Task 3: The serve route

**Files:**
- Modify: `app/src/routes/api.ts:2283-2298` (the media-serve header block) and
  its import at `:23`
- Test: `app/test/mmsMedia.test.ts`, `app/test/apiRoutes.test.ts`

**Interfaces:**
- Consumes: `resolveMediaTier` (Task 1), `buildMediaFilename` +
  `contentDispositionHeader` (Task 2).
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Add to `app/test/mmsMedia.test.ts`, following the file's existing harness
setup for a mirrored attachment (reuse whatever helper the neighbouring tests
use to seed a message + a stored object; do not invent a new one):

```ts
it('serves a declarable type truthfully, as a download, with a real extension', async () => {
  // The reported bug: a relay member's video downloaded as an untyped,
  // extensionless blob the OS could not open.
  const res = await getMedia({ storedContentType: 'video/mp4' });
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe('video/mp4');
  expect(res.headers['content-disposition']).toBe('attachment; filename="attachment-1.mp4"');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
});

it('still forces an unknown type to an opaque download', async () => {
  const res = await getMedia({ storedContentType: 'application/x-made-up' });
  expect(res.headers['content-type']).toBe('application/octet-stream');
  expect(res.headers['content-disposition']).toBe('attachment; filename="attachment-1.bin"');
});

it('still refuses to render a script-capable stored type', async () => {
  // The stored-XSS guard. A legacy object written before the write-side
  // normalizer existed can still carry text/html at rest.
  const res = await getMedia({ storedContentType: 'text/html' });
  expect(res.headers['content-type']).toBe('application/octet-stream');
  expect(res.headers['content-disposition']).toMatch(/^attachment/);
});

it('names an inline attachment without forcing a download', async () => {
  const res = await getMedia({ storedContentType: 'image/png' });
  expect(res.headers['content-type']).toBe('image/png');
  expect(res.headers['content-disposition']).toBe('inline; filename="attachment-1.png"');
});

it('prefers a stored filename stem but never its extension', async () => {
  const res = await getMedia({ storedContentType: 'video/mp4', filename: 'invoice.exe' });
  expect(res.headers['content-disposition']).toBe('attachment; filename="invoice.mp4"');
});

it('keeps a recognised stored extension when the type is unrecoverable', async () => {
  // Historical inbound email: octet-stream at rest, real name still present.
  const res = await getMedia({
    storedContentType: 'application/octet-stream',
    filename: 'budget.xlsx',
  });
  expect(res.headers['content-disposition']).toBe('attachment; filename="budget.xlsx"');
});

it('serves an OUTBOUND email attachment on the declarable tier', async () => {
  // Not the reported bug, but the same route: outbound email attachments are
  // already stored as their real type, so they change tier the moment this
  // lands. Spec section 8.6.
  const res = await getMedia({
    storedContentType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename: 'Q3.xlsx',
  });
  expect(res.headers['content-type']).toBe(
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  expect(res.headers['content-disposition']).toBe('attachment; filename="Q3.xlsx"');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd app && npx vitest run test/mmsMedia.test.ts`
Expected: FAIL - the declarable case returns `application/octet-stream`.

- [ ] **Step 3: Implement**

In `app/src/routes/api.ts`, change the import at `:23` - ADD the new symbols
and DROP `normalizeStoredMediaType`, which this file imports and never uses (a
pre-existing unused import; you are editing this line anyway):

```ts
import { isTwilioDeliverableType, resolveMediaTier } from '../lib/mediaTypes.js';
import { buildMediaFilename, contentDispositionHeader } from '../lib/mediaFilename.js';
```

`isInlineMediaType` also leaves this import if nothing else in the file uses it
- check with a grep before removing, and leave it if another call site does.

REPLACE the header block at `:2283-2298`:

```ts
    // The stored Content-Type is the MMS sender's, so it is untrusted content
    // on an authenticated transport. resolveMediaTier is the ONE place that
    // decides what we do with it:
    //   inline      - allowlisted raster images + PDF, rendered same-origin
    //   declarable  - not script-capable, so served TRUTHFULLY, but always as
    //                 a download (attachment) - never rendered
    //   opaque      - anything else, including every script-capable type and
    //                 anything unrecognised: octet-stream + .bin
    // It runs on the OBJECT's own type, not the message record's: objects
    // mirrored before the 2026-06-18 normalize fix can still carry text/html
    // at rest, and that population is why this gate exists at all.
    // Belt-and-braces regardless of tier: nosniff + a restrictive CSP.
    const resolved = resolveMediaTier(object.contentType);
    const filename = buildMediaFilename(attachments[idx]?.filename, idx, resolved);
    res.setHeader('Content-Type', resolved.canonical);
    res.setHeader(
      'Content-Disposition',
      contentDispositionHeader(resolved.tier === 'inline' ? 'inline' : 'attachment', filename),
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
```

Update the `log.info` a few lines below to log `tier: resolved.tier` instead of
`inline`. Do NOT log the filename - it is PII.

- [ ] **Step 4: Run to verify they pass**

Run: `cd app && npx vitest run test/mmsMedia.test.ts`
Expected: PASS except the three pre-existing assertions in Step 5.

- [ ] **Step 5: Update the three assertions the inline tier deliberately moves**

`app/test/mmsMedia.test.ts:229`, `app/test/apiRoutes.test.ts:648` and `:661`
assert `content-disposition` is UNDEFINED on the inline path. The inline tier
now sends `inline; filename=...`, which does not change rendering (`inline` is
the default when no disposition is sent) and exists so an operator saving an
image gets a real name. Change each from absent to:

```ts
expect(res.headers['content-disposition']).toMatch(/^inline; filename="/);
```

Run: `cd app && npx vitest run test/mmsMedia.test.ts test/apiRoutes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/routes/api.ts app/test/mmsMedia.test.ts app/test/apiRoutes.test.ts
git commit
```

Message: `fix(media): serve inbound media with its true type and a real filename`

---

### Task 4: Both dashboard galleries

**Files:**
- Modify: `dashboard/src/routes/contact/media.ts`
- Modify: `dashboard/src/routes/contact/Timeline.tsx:614-617,640,658`
- Modify: `dashboard/src/routes/contact/MediaGallery.tsx:36`
- Test: `dashboard/src/routes/contact/Timeline.test.tsx`,
  `dashboard/src/routes/contact/media.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-3 (the dashboard cannot import from `app/`).
- Produces, all from `media.ts`:
  - `isInlineRenderable(contentType: string): boolean`
  - `mediaKindWord(contentType: string): string | undefined`

- [ ] **Step 1: Write the failing tests**

Add to `dashboard/src/routes/contact/media.test.ts`:

```ts
describe('isInlineRenderable', () => {
  it('is true for exactly the four raster types the server renders inline', () => {
    for (const t of ['image/jpeg', 'image/png', 'image/gif', 'image/webp']) {
      expect(isInlineRenderable(t)).toBe(true);
    }
  });

  it('is FALSE for image types the browser cannot decode', () => {
    // The regression this whole helper exists to prevent: startsWith('image/')
    // renders a broken <img> for HEIC once the server stores it truthfully.
    expect(isInlineRenderable('image/heic')).toBe(false);
    expect(isInlineRenderable('image/tiff')).toBe(false);
  });

  it('is false for PDF, which is a file link here even though the server serves it inline', () => {
    expect(isInlineRenderable('application/pdf')).toBe(false);
  });

  it('matches on the essence so a parameterized type is not misread', () => {
    expect(isInlineRenderable('image/png; charset=x')).toBe(true);
  });
});

describe('mediaKindWord', () => {
  it('names the kind for declarable types', () => {
    expect(mediaKindWord('video/mp4')).toBe('Video');
    expect(mediaKindWord('audio/mpeg')).toBe('Audio');
    expect(mediaKindWord('image/heic')).toBe('Image');
    expect(mediaKindWord('text/vcard')).toBe('Contact card');
    expect(mediaKindWord('text/csv')).toBe('Document');
  });

  it('returns undefined for the opaque tier - there is no kind word for it', () => {
    // Labelling octet-stream "Document" would break the existing fallback
    // assertions and tell the operator something we do not know.
    expect(mediaKindWord('application/octet-stream')).toBeUndefined();
    expect(mediaKindWord('application/x-made-up')).toBeUndefined();
  });

  it('does NOT use a media-type prefix test', () => {
    // A prefix test collides on application/octet-stream against the OOXML
    // application/... types, and on text/vcard against text/plain.
    expect(mediaKindWord('application/octet-stream')).toBeUndefined();
    expect(
      mediaKindWord('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    ).toBe('Document');
  });
});
```

Add to `dashboard/src/routes/contact/Timeline.test.tsx`:

```ts
it('renders a HEIC attachment as a file link, not a broken image', () => {
  const mms = mmsWith([{ s3Key: 'k', contentType: 'image/heic' }]);
  renderTimeline({ items: [mms] });
  expect(screen.queryByRole('img', { name: /Attachment 1/i })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Attachment 1/i })).toBeInTheDocument();
});

it('labels a declarable attachment with its kind', () => {
  const mms = mmsWith([{ s3Key: 'k', contentType: 'video/mp4' }]);
  renderTimeline({ items: [mms] });
  expect(screen.getByRole('link', { name: /Video - Attachment 1/i })).toBeInTheDocument();
});

it('leaves an opaque attachment labelled bare', () => {
  const mms = mmsWith([{ s3Key: 'k', contentType: 'application/octet-stream' }]);
  renderTimeline({ items: [mms] });
  expect(screen.getByRole('link', { name: /^\W*Attachment 1$/i })).toBeInTheDocument();
});
```

`mmsWith` is a local helper you add beside the existing MMS test - copy the
`mms` object literal that the file's existing "Image -> inline img" test builds
and take the attachments array as a parameter.

- [ ] **Step 2: Run to verify they fail**

Run: `cd dashboard && npx vitest run src/routes/contact/media.test.ts src/routes/contact/Timeline.test.tsx`
Expected: FAIL - `isInlineRenderable is not a function`.

- [ ] **Step 3: Implement the shared helpers**

Append to `dashboard/src/routes/contact/media.ts`:

```ts
// --- Type tiers, MIRRORED from app/src/lib/mediaTypes.ts -------------------
// The dashboard cannot import from app/, so these are copies. THREE things are
// mirrored, not one, because the label rules below are tier-based:
//   1. the raster types the browser can decode inline,
//   2. which types are "declarable" (typed, but downloaded), and
//   3. a kind word per declarable type.
//
// A media-type PREFIX test is NOT a substitute for 2 and 3: it collides on
// application/octet-stream against the OOXML application/... types, and on
// text/vcard against text/plain. Source of truth: app/src/lib/mediaTypes.ts.

/** Everything before the first `;`, trimmed and lowercased. */
function essenceOf(contentType: string): string {
  return contentType.split(';')[0]!.trim().toLowerCase();
}

/** The raster types a browser renders in an <img>. NOT the server's inline
 *  allowlist, which also contains application/pdf - a PDF is a file link
 *  here. */
const INLINE_RENDERABLE_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

/** Declarable type -> the word we put in front of the positional fallback. */
const KIND_WORDS: ReadonlyMap<string, string> = new Map([
  ['video/mp4', 'Video'],
  ['video/quicktime', 'Video'],
  ['video/3gpp', 'Video'],
  ['video/3gpp2', 'Video'],
  ['video/webm', 'Video'],
  ['audio/mpeg', 'Audio'],
  ['audio/mp4', 'Audio'],
  ['audio/aac', 'Audio'],
  ['audio/ogg', 'Audio'],
  ['audio/amr', 'Audio'],
  ['audio/wav', 'Audio'],
  ['image/heic', 'Image'],
  ['image/heif', 'Image'],
  ['image/bmp', 'Image'],
  ['image/tiff', 'Image'],
  ['text/vcard', 'Contact card'],
  ['text/x-vcard', 'Contact card'],
  ['text/plain', 'Document'],
  ['text/csv', 'Document'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Document'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Document'],
]);

/** True when this attachment can be shown in an <img>. */
export function isInlineRenderable(contentType: string): boolean {
  return INLINE_RENDERABLE_TYPES.has(essenceOf(contentType));
}

/** The kind word for a declarable type; undefined on the opaque tier, where we
 *  genuinely do not know what the file is and must not pretend. */
export function mediaKindWord(contentType: string): string | undefined {
  return KIND_WORDS.get(essenceOf(contentType));
}
```

- [ ] **Step 4: Implement the two components**

`MediaGallery.tsx:36` - replace the predicate:

```tsx
          isInlineRenderable(m.contentType) ? (
```

and add `isInlineRenderable` to its existing `import ... from './media.js'`
(currently a type-only import of `CommsMediaItem` - make it a mixed import).

`Timeline.tsx:640` - replace `att.contentType.startsWith('image/')` with
`isInlineRenderable(att.contentType)`, and add `isInlineRenderable` +
`mediaKindWord` to the existing `./media.js` import at `:52`.

`Timeline.tsx:614-617` - `attachmentLabel` gains the content type so it can
name the kind. Replace the function and update its two call sites (`:652` and
`:667`) to pass `att.contentType`:

```tsx
/** The visible label for one attachment: the persisted original filename when
 *  present, else a positional fallback. The fallback names the KIND when we
 *  know it ("Video - Attachment 1"); PDF keeps its existing wording; and the
 *  opaque tier stays bare, because there is no honest kind word for
 *  application/octet-stream. */
function attachmentLabel(
  filename: string | undefined,
  contentType: string,
  isPdf: boolean,
  i: number,
): string {
  if (filename !== undefined && filename.trim().length > 0) return filename;
  if (isPdf) return `PDF attachment ${i + 1}`;
  const kind = mediaKindWord(contentType);
  return kind !== undefined ? `${kind} - Attachment ${i + 1}` : `Attachment ${i + 1}`;
}
```

The `<img>` call site passes `att.contentType` too but its `isPdf` stays
`false`; an image `alt` never gets a kind prefix because it is already known
to be an image, and `mediaKindWord` returns undefined for the four raster
types anyway.

- [ ] **Step 5: Run the dashboard suite**

Run: `cd dashboard && npx vitest run src/routes/contact/`
Expected: PASS, INCLUDING these four which must NOT have changed:
`Timeline.test.tsx:552` (image `alt`), `:555` (PDF file link),
`Timeline.email.test.tsx:88` and `:107` (both are `application/octet-stream`
with no filename - opaque tier, so bare). If one of those four fails, the kind
rule has been applied too widely - fix the rule, not the assertion.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/routes/contact/media.ts dashboard/src/routes/contact/Timeline.tsx dashboard/src/routes/contact/MediaGallery.tsx dashboard/src/routes/contact/media.test.ts dashboard/src/routes/contact/Timeline.test.tsx
git commit
```

Message: `fix(dashboard): branch both galleries on renderable types, not image/*`

---

### Task 5: Adapter methods for the backfill

**Files:**
- Modify: `app/src/adapters/messaging.ts` (interface + Twilio driver + console driver)
- Modify: `app/src/adapters/mediaStore.ts` (interface + implementation)
- Test: `app/test/mediaStore.test.ts`, and whichever messaging-adapter test file
  the repo already has (find it with `ls app/test | grep -i messaging`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MessagingAdapter.getMediaContentType(messageSid: string, mediaSid: string): Promise<string | undefined>`
  - `MediaStore.setContentType(key: string, contentType: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

For `MediaStore` (add to `app/test/mediaStore.test.ts`, using the file's
existing MinIO/localstack harness):

```ts
it('rewrites an object Content-Type in place and preserves the bytes', async () => {
  await store.put('media/c1/MM1/0', Readable.from(Buffer.from('hello')), 'application/octet-stream');
  await store.setContentType('media/c1/MM1/0', 'video/mp4');
  const head = await store.head('media/c1/MM1/0');
  expect(head?.contentType).toBe('video/mp4');
  const bytes = await store.getBytes('media/c1/MM1/0');
  expect(bytes?.toString()).toBe('hello');
});

it('is idempotent', async () => {
  await store.put('media/c1/MM1/1', Readable.from(Buffer.from('x')), 'application/octet-stream');
  await store.setContentType('media/c1/MM1/1', 'video/mp4');
  await store.setContentType('media/c1/MM1/1', 'video/mp4');
  expect((await store.head('media/c1/MM1/1'))?.contentType).toBe('video/mp4');
});
```

For the messaging adapter, assert the console driver returns `undefined` and
the Twilio driver maps a 404 to `undefined` rather than throwing, following
whatever mocking style that test file already uses for `getMediaStream`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd app && npx vitest run test/mediaStore.test.ts`
Expected: FAIL - `store.setContentType is not a function`.

- [ ] **Step 3: Implement `MediaStore.setContentType`**

Add to the `MediaStore` interface in `app/src/adapters/mediaStore.ts`:

```ts
  /**
   * Rewrite an existing object's Content-Type IN PLACE, preserving the bytes.
   * Implemented as a same-key CopyObject with MetadataDirective REPLACE - the
   * documented S3 case for a metadata-only change - so no bytes move through
   * this process. Idempotent. Needs s3:GetObject AND s3:PutObject.
   *
   * Used ONLY by the one-time content-type backfill
   * (scripts/backfill-media-content-types.ts). Nothing in the request path
   * calls this: the runtime writes the right type at put() time.
   */
  setContentType(key: string, contentType: string): Promise<void>;
```

And in the S3 implementation, alongside the existing `put`:

```ts
    async setContentType(key, contentType) {
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: key,
          CopySource: `${bucket}/${key}`,
          ContentType: contentType,
          MetadataDirective: 'REPLACE',
        }),
      );
    },
```

Import `CopyObjectCommand` from `@aws-sdk/client-s3` alongside the commands
already imported there.

- [ ] **Step 4: Implement `getMediaContentType`**

Add to the `MessagingAdapter` interface in `app/src/adapters/messaging.ts`,
beside `getMediaStream`:

```ts
  /**
   * The Content-Type Twilio holds for one inbound media resource - METADATA
   * ONLY, no bytes. Used by the one-time content-type backfill to recover a
   * type our own mirror discarded before the declarable tier existed.
   * Resolves undefined when Twilio no longer has the media (404), so an aged-
   * out attachment is a skip rather than a failure.
   */
  getMediaContentType(messageSid: string, mediaSid: string): Promise<string | undefined>;
```

Twilio driver:

```ts
  async getMediaContentType(messageSid: string, mediaSid: string): Promise<string | undefined> {
    try {
      const media = await this.client.messages(messageSid).media(mediaSid).fetch();
      return typeof media.contentType === 'string' ? media.contentType : undefined;
    } catch (err) {
      // 20404 / HTTP 404: the media is gone (retention, deletion). Not an
      // error for the backfill - it counts it and moves on.
      if ((err as { status?: number }).status === 404) return undefined;
      throw err;
    }
  }
```

Console driver:

```ts
  async getMediaContentType(): Promise<string | undefined> {
    this.log.info({}, 'console messaging driver: getMediaContentType is a no-op');
    return undefined;
  }
```

- [ ] **Step 5: Fix every exhaustive implementer**

Widening two interfaces breaks every object literal that implements them
exhaustively - one for `MediaStore` (`app/test/helpers/twilioWebhookHarness.ts`)
and several for `MessagingAdapter`.

Run: `npm run typecheck`

Work the error list top to bottom; each is a missing property on a test double.
Add the minimal stub - `async getMediaContentType() { return undefined; }` /
`async setContentType() {}` - unless that double's test needs a real answer.
Do NOT make the interface members optional to avoid this.

Run `npm run typecheck` again until clean.

- [ ] **Step 6: Commit**

```bash
git add app/src/adapters/messaging.ts app/src/adapters/mediaStore.ts app/test/
git commit
```

Message: `feat(adapters): media content-type read + in-place S3 type rewrite`

---

### Task 6: The backfill script

**Files:**
- Create: `app/scripts/backfill-media-content-types.ts`
- Create: `app/test/backfillMediaContentTypes.test.ts`
- Modify: `package.json` (root scripts block - add
  `"backfill:media-content-types": "tsx app/scripts/backfill-media-content-types.ts"`,
  matching how `backfill:media-pointers` is declared)

**Interfaces:**
- Consumes: `resolveMediaTier` / `normalizeStoredMediaType` (Task 1),
  `getMediaContentType` + `setContentType` (Task 5), `inboundMediaKey`
  (`app/src/services/mediaMirror.ts`).
- Produces: `backfillMediaContentTypes(opts): Promise<BackfillResult>` (exported
  for the test; the CLI wrapper calls it).

- [ ] **Step 1: Write the failing tests**

Create `app/test/backfillMediaContentTypes.test.ts`. Inject fakes for the doc
client, the messaging adapter, the media store and the messages repo - the
function must take all four so the test needs no AWS and no Twilio.

Start with these shared fixtures and harness so no test below is elided:

```ts
import { describe, expect, it, vi } from 'vitest';
import { backfillMediaContentTypes } from '../scripts/backfill-media-content-types.js';

const URL0 = 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME_ZERO';
const URL1 = 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME_ONE';

/** An inbound MMS row with `n` octet-stream attachments, keys index 0..n-1. */
function inboundRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversationId: 'c1',
    tsMsgId: '2026-08-01T00:00:00.000Z#MM1',
    provider_sid: 'MM1',
    direction: 'inbound',
    mediaUrls: [URL0, URL1],
    media_attachments: [{ s3Key: 'media/c1/MM1/0', contentType: 'application/octet-stream' }],
    ...overrides,
  };
}

const twoAttachmentRow = inboundRow({
  media_attachments: [
    { s3Key: 'media/c1/MM1/0', contentType: 'application/octet-stream' },
    { s3Key: 'media/c1/MM1/1', contentType: 'application/octet-stream' },
  ],
});

/** Runs the backfill over `rows` with recording fakes. `calls` records the
 *  ORDER of the three writes, which is the whole point of several tests. */
async function run(opts: {
  rows: Record<string, unknown>[];
  /** What Twilio answers. `null` means "Twilio no longer has it" (404). */
  contentType?: string | null;
  dryRun?: boolean;
  annotateFails?: boolean;
}) {
  const calls: string[] = [];
  const setContentType = vi.fn(async (key: string) => {
    calls.push(`s3:${key}`);
  });
  const putMediaPointers = vi.fn(async (conversationId: string) => {
    calls.push(`pointers:${conversationId}`);
  });
  const annotateMessage = vi.fn(async (conversationId: string) => {
    calls.push(`annotate:${conversationId}`);
    if (opts.annotateFails) throw new Error('boom');
  });
  const getMediaContentType = vi
    .fn()
    .mockResolvedValue(opts.contentType === null ? undefined : (opts.contentType ?? 'video/mp4'));
  const doc = { send: vi.fn().mockResolvedValue({ Items: opts.rows }) };

  const result = await backfillMediaContentTypes({
    doc: doc as never,
    adapter: { getMediaContentType } as never,
    mediaStore: { setContentType } as never,
    messagesRepo: { putMediaPointers, annotateMessage } as never,
    ...(opts.dryRun === true && { dryRun: true }),
  });
  return { result, calls, setContentType, putMediaPointers, annotateMessage, getMediaContentType };
}
```

Then the cases:

```ts
describe('backfillMediaContentTypes', () => {
  it('derives the media index from the S3 KEY, not the array position', async () => {
    // media_attachments is a compacted successes-only list that the deferred
    // mirror job appends to, so position 0 can carry index 1. Reading
    // mediaUrls[position] would stamp the WRONG type on the WRONG object, and
    // nothing downstream could detect it.
    const row = inboundRow({
      media_attachments: [
        { s3Key: 'media/c1/MM1/1', contentType: 'application/octet-stream' },
      ],
    });
    const { getMediaContentType } = await run({ rows: [row] });
    expect(getMediaContentType).toHaveBeenCalledWith('MM1', 'ME_ONE');
  });

  it('writes S3, then pointers, then the row - the predicate-clearing write LAST', async () => {
    // annotateMessage swallows pointer failures, so a row-first order can
    // clear the re-scan predicate and leave the gallery permanently wrong.
    const { calls } = await run({ rows: [inboundRow()] });
    expect(calls).toEqual(['s3:media/c1/MM1/0', 'pointers:c1', 'annotate:c1']);
  });

  it('leaves everything repairable when the row write fails', async () => {
    const first = await run({ rows: [inboundRow()], annotateFails: true });
    expect(first.result.written).toBe(0);
    // The row still says octet-stream, so a clean re-run completes it.
    const second = await run({ rows: [inboundRow()] });
    expect(second.result.written).toBe(1);
  });

  it('writes the row ONCE for a two-attachment message', async () => {
    const { result, annotateMessage, setContentType } = await run({ rows: [twoAttachmentRow] });
    expect(result.written).toBe(2);
    expect(setContentType).toHaveBeenCalledTimes(2);
    expect(annotateMessage).toHaveBeenCalledTimes(1);
  });

  it('never writes a type the runtime would refuse', async () => {
    const { result, setContentType } = await run({
      rows: [inboundRow()],
      contentType: 'text/html',
    });
    expect(result.skippedStillOpaque).toBe(1);
    expect(setContentType).not.toHaveBeenCalled();
  });

  it('skips an unparseable s3 key rather than guessing an index', async () => {
    const row = inboundRow({
      media_attachments: [{ s3Key: 'uploads/abc', contentType: 'application/octet-stream' }],
    });
    const { result, getMediaContentType } = await run({ rows: [row] });
    expect(result.skippedUnparseableKey).toBe(1);
    expect(getMediaContentType).not.toHaveBeenCalled();
  });

  it('skips an attachment whose index is past the stored mediaUrls', async () => {
    const row = inboundRow({
      mediaUrls: [URL0],
      media_attachments: [{ s3Key: 'media/c1/MM1/5', contentType: 'application/octet-stream' }],
    });
    expect((await run({ rows: [row] })).result.skippedNoUrl).toBe(1);
  });

  it('skips an attachment whose media Twilio no longer has', async () => {
    const { result, setContentType } = await run({ rows: [inboundRow()], contentType: null });
    expect(result.skippedTwilio404).toBe(1);
    expect(setContentType).not.toHaveBeenCalled();
  });

  it('counts an inbound EMAIL row separately and never queries Twilio for it', async () => {
    // Inbound + media_attachments + octet-stream, but no Twilio media behind
    // it. Without its own bucket it inflates the histogram the ops decision
    // reads.
    const row = inboundRow({ mediaUrls: undefined });
    const { result, getMediaContentType } = await run({ rows: [row] });
    expect(result.skippedEmailRow).toBe(1);
    expect(getMediaContentType).not.toHaveBeenCalled();
  });

  it('counts a legacy media_s3_keys row and leaves it alone', async () => {
    const row = inboundRow({ media_attachments: undefined, media_s3_keys: ['media/c1/MM1/0'] });
    const { result, setContentType } = await run({ rows: [row] });
    expect(result.skippedLegacyRow).toBe(1);
    expect(setContentType).not.toHaveBeenCalled();
  });

  it('ignores outbound rows, which are already correct', async () => {
    const row = inboundRow({ direction: 'outbound' });
    expect((await run({ rows: [row] })).result.eligible).toBe(0);
  });

  it('writes nothing on a dry run but still reports the histogram', async () => {
    const { result, setContentType, annotateMessage } = await run({
      rows: [inboundRow()],
      dryRun: true,
    });
    expect(result.recovered['video/mp4']).toBe(1);
    expect(setContentType).not.toHaveBeenCalled();
    expect(annotateMessage).not.toHaveBeenCalled();
    // A dry run performs no WRITES but it DOES read the live Twilio account.
    expect(result.vendorCalls).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd app && npx vitest run test/backfillMediaContentTypes.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement**

Create `app/scripts/backfill-media-content-types.ts`. Structure, in order:

1. Module docblock: what it repairs, why the write order is what it is, that
   `--dry-run` still READS Twilio, and that it is human-run per the RUNBOOK.
2. `export interface BackfillResult` with every counter the spec's reporting
   list names: `rowsScanned`, `eligible`, `recovered: Record<string, number>`,
   `skippedUnparseableKey`, `skippedNoUrl`, `skippedTwilio404`,
   `skippedStillOpaque`, `skippedEmailRow`, `skippedLegacyRow`, `written`,
   `vendorCalls`.
3. `parseMediaIndexFromKey(s3Key: string): number | undefined` - matches
   `^media/[^/]+/[^/]+/(\d+)$` and returns the group as a number. Anything else
   is undefined; NEVER guess.
4. `parseMediaSid(url: string): string | undefined` - matches
   `/Media/(ME[0-9a-f]+)` case-insensitively.
5. The paged `ScanCommand` loop, filtering
   `attribute_exists(media_attachments) OR attribute_exists(media_s3_keys)`
   exactly as `backfill-media-pointers.ts` does, then applying the
   per-attachment predicate IN CODE (a FilterExpression cannot test a list
   element).
6. Per row: skip + count legacy rows (`media_s3_keys` with no
   `media_attachments`), non-inbound rows, and rows with no `mediaUrls`
   (inbound EMAIL - count as `skippedEmailRow`).
7. Per attachment: parse the index, parse the MediaSid, call
   `getMediaContentType` (increment `vendorCalls`), normalize, skip if still
   opaque, else `setContentType` and stage the corrected attachment.
8. Per row, ONLY if at least one attachment changed and not `dryRun`:
   `putMediaPointers(conversationId, tsMsgId, merged)` and THEN
   `annotateMessage(conversationId, tsMsgId, { mediaAttachments: merged })`.
9. Bounded concurrency of 4 over attachments within a page, with a retry on a
   Twilio 429 (sleep 1s, 2s, 4s, then give up and count the attachment as
   `skippedTwilio404`). Keep it simple: a small `for` loop with a counter is
   fine - do not add a dependency.
10. CLI wrapper copying `backfill-media-pointers.ts`'s `invokedDirectly` shape,
    PLUS the account guard, which that script does not have:

```ts
import { assertHousingChoiceAccount, hcCredentials, HC_PROFILE, HC_REGION } from '../../scripts/lib/hcAws.mjs';
// ...
const identity = await assertHousingChoiceAccount();
logger.info({ profile: HC_PROFILE, account: identity.Account }, 'account guard OK');
```

The default AWS credential chain resolves to the WRONG account in this
environment - the guard is mandatory, not defensive.

Write the counters into one `logger.info` at the end. Log IDs and counts only:
never a filename, a media URL or a phone number.

- [ ] **Step 4: Run to verify they pass**

Run: `cd app && npx vitest run test/backfillMediaContentTypes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/scripts/backfill-media-content-types.ts app/test/backfillMediaContentTypes.test.ts package.json
git commit
```

Message: `feat(scripts): backfill inbound media content types from Twilio`

---

### Task 7: fake-twilio fixture and the e2e

**Files:**
- Create: a canned `.vcf` asset under `fake-twilio/web/` (see Step 1)
- Modify: `fake-twilio/src/engine/signer.ts:27` (`inferMediaContentType`)
- Modify: the canned-asset registry and its pinning test under `fake-twilio/web/`
- Create: `e2e/tests/dashboard-next/inbound-media-type.spec.ts`

**Interfaces:**
- Consumes: the served headers from Task 3, the labels from Task 4.
- Produces: nothing.

DELIBERATE DEVIATION FROM THE SPEC, FLAG IT IN REVIEW: the spec names a
"few-KB .mp4". Use a `.vcf` (`text/vcard`) instead. A vCard is plain ASCII
text, so the fixture can be created and reviewed as source rather than as an
opaque binary blob committed to the repo, and it exercises the identical
declarable tier. If a reviewer wants a video specifically, that is a second
asset, not a different design.

- [ ] **Step 1: Find the whole canned-asset surface before editing anything**

Run: `grep -rn "canned" fake-twilio/ --include=*.ts --include=*.tsx -l`

There are at least three places: the asset files, an index/registry that names
and labels them, and a test that pins the registry's contents. Read all three
before writing. Do NOT assume `signer.ts` is the whole change.

- [ ] **Step 2: Add the asset and its type mapping**

Create the vCard asset (ASCII, a few lines):

```
BEGIN:VCARD
VERSION:3.0
FN:Test Landlord
TEL;TYPE=CELL:+15555550100
END:VCARD
```

In `fake-twilio/src/engine/signer.ts`, add to `inferMediaContentType` before
the final return:

```ts
  if (path.endsWith('.vcf')) return 'text/vcard';
```

Register the asset in the canned registry with a label, and update the pinning
test's expected list.

- [ ] **Step 3: Write the e2e spec**

Create `e2e/tests/dashboard-next/inbound-media-type.spec.ts`. Use the
accessibility-first selectors in `e2e/support/selectors.md` and follow the
existing `outbound-mms.spec.ts` for how a spec drives the fake into sending an
inbound MMS. Assert BOTH halves:

```ts
// 1. the dashboard renders it as a file link with its kind, not an <img>
await expect(
  timeline.getByRole('link', { name: /Contact card - Attachment 1/i }),
).toBeVisible();

// 2. the served response is typed and named
const res = await page.request.get(mediaHref);
expect(res.headers()['content-type']).toBe('text/vcard');
expect(res.headers()['content-disposition']).toMatch(/^attachment; filename=".*\.vcf"$/);
```

- [ ] **Step 4: Run the e2e for this spec only**

Run from the e2e workspace, never from the repo root:
`cd e2e && npx playwright test tests/dashboard-next/inbound-media-type.spec.ts`

Docker must be running. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add fake-twilio/ e2e/tests/dashboard-next/inbound-media-type.spec.ts
git commit
```

Message: `test(e2e): inbound declarable media is typed, named and file-linked`

---

### Task 8: Docs

**Files:**
- Modify: `RUNBOOK.md`
- Modify: `docs/issues/media-serve-stored-xss.md`

- [ ] **Step 1: Add the RUNBOOK procedure**

Add a section for `backfill:media-content-types` covering, in this order:

- WHAT it repairs and that it is one-time and idempotent.
- THE HARD ORDERING: deploy the application FIRST, then run the backfill.
  Running it against an environment still serving the old dashboard bundle
  makes every repaired HEIC render as a broken image until the deploy lands.
- Per environment: deploy -> `--dry-run` -> read the histogram -> apply ->
  verify one repaired attachment in that environment's dashboard. Dev fully
  through before prod is started.
- Operator requirements: Twilio API credentials for the TARGET account, and
  `s3:GetObject` + `s3:PutObject` on that environment's media bucket
  (`CopyObject` needs both). The `assertHousingChoiceAccount` guard runs first.
- That `--dry-run` performs no writes but DOES read the live Twilio account
  once per candidate attachment.
- That the media bucket is versioned with no lifecycle rule, so each repair
  retains the old object version - recoverable, at the cost of a full extra
  copy per repaired object.

- [ ] **Step 2: Amend the stored-XSS issue**

`docs/issues/media-serve-stored-xss.md:30-32` records that
`...; charset=...` parameter forms cannot bypass the allowlist, describing
exact-string matching as part of the resolved fix. That is no longer how it
works. Add a dated amendment - do not rewrite the history:

```markdown
**Amendment (2026-08-26, media content-type fidelity).** The allowlist now
matches on the media-type ESSENCE rather than the exact string, so the
parameterized forms of ALLOWLISTED types are admitted (`image/png; charset=x`
reaches the inline tier). The guarantee is unchanged and now rests on the
CANONICAL OUTPUT instead of the matching: `resolveMediaTier` returns the
allowlist's own constant, so a caller-supplied parameterized string never
reaches a response header. Non-allowlisted types are unaffected -
`text/html; charset=x` has essence `text/html` and still fails the gate. See
docs/superpowers/specs/2026-08-26-media-content-type-fidelity-design.md 5.1.
```

- [ ] **Step 3: Commit**

```bash
git add RUNBOOK.md docs/issues/media-serve-stored-xss.md
git commit
```

Message: `docs: backfill runbook + amend the stored-XSS parameter claim`

---

## Final gates

From the worktree, BARE, never piped, on a quiet tree:

1. `npm run typecheck`
2. `npm test` (needs `npm run db:start`; if red on DynamoDB suites, re-run under
   a clean key per AGENTS.md before blaming the branch)
3. `npm run smoke`
4. `npm run e2e`
5. `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`

Gate 5 attributes by BASELINE COMPARISON, not line number: run the same command
on the same paths at the merge base and diff. Note that `api.ts` carries
pre-existing lint errors; dropping the unused `normalizeStoredMediaType` import
in Task 3 removes one of them, which is fine.

Sync `main` into the branch ONCE, at the final pre-handback step.

## Post-merge obligations

- `backfill:media-content-types` must be run by a human, dev then prod, AFTER
  each deploy. Nothing else is owed - no terraform, no secrets, no SSM.
