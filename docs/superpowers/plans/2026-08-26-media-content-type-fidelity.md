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
  strings, docs. `Timeline.tsx` already does this correctly - its paperclip and
  page glyphs are `String.fromCodePoint(0x1f4ce)` escapes (`:604-608`), so
  follow that pattern for any glyph you add. `MediaGallery.tsx:56` has LITERAL
  emoji; leave them exactly as they are (pre-existing, and only added lines must
  be ASCII) and do not add more.
- The TEST files in this plan need non-ASCII VALUES on purpose (fixtures that
  prove the non-ASCII filename path). BUILD them with `String.fromCharCode`,
  as the tasks below do and as `Timeline.tsx:604-608` already does for its
  glyphs - never paste an accented character into a source file.
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

describe('the emission map covers every allowlisted type', () => {
  it('never falls through to .bin for a type we claim to serve truthfully', () => {
    // GUARDRAIL: resolveMediaTier ends in `?? '.bin'`, so a type added to
    // either allowlist without an extension would be served truthfully AND
    // named .bin - silently, and only noticed by an operator.
    for (const type of [...INLINE_MEDIA_TYPES, ...DECLARABLE_MEDIA_TYPES]) {
      expect(resolveMediaTier(type).ext).not.toBe('.bin');
    }
  });

  it('emits only extensions the accepted set also recognises', () => {
    for (const type of [...INLINE_MEDIA_TYPES, ...DECLARABLE_MEDIA_TYPES]) {
      expect(isAcceptedExtension(resolveMediaTier(type).ext)).toBe(true);
    }
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

Add FOUR symbols to the file's existing import from `../src/lib/mediaTypes.js`:
`resolveMediaTier`, `isAcceptedExtension`, `DECLARABLE_MEDIA_TYPES` and
`INLINE_MEDIA_TYPES` - the last two are iterated by the emission-map guardrail
block above, which is easy to miss when scanning only the first two describes.

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

To `app/test/mediaMirror.test.ts`, using the file's OWN existing helpers -
`flakyAdapter(failures, err)` returns `{ calls, urls, adapter }` and
`storeSpy()` returns `{ puts, mediaStore }`, where `puts` is an array of
`{ key, contentType }` (`app/test/mediaMirror.test.ts:23-50`). Copy the call
shape from the first test in the `mirrorMediaSet` describe block:

```ts
it('stores a declarable sender type truthfully', async () => {
  // The reported bug: a relay member's video was stored as octet-stream and
  // its real type lost forever the moment the object landed in S3.
  const f = flakyAdapter(0, () => new Error('never'));
  const s = storeSpy();
  const out = await mirrorMediaSet(
    { adapter: f.adapter, mediaStore: s.mediaStore, logger: silent, sleep: async () => {} },
    {
      conversationId: 'conv-1',
      messageSid: 'MM9',
      targets: [{ index: 0, url: 'https://api.twilio.com/m/0', contentType: 'video/mp4' }],
      delaysMs: INLINE_MIRROR_DELAYS_MS,
    },
  );
  expect(out.attachments[0]?.attachment.contentType).toBe('video/mp4');
  expect(s.puts).toEqual([{ key: 'media/conv-1/MM9/0', contentType: 'video/mp4' }]);
});

it('still collapses a script-capable sender type at rest', async () => {
  const f = flakyAdapter(0, () => new Error('never'));
  const s = storeSpy();
  const out = await mirrorMediaSet(
    { adapter: f.adapter, mediaStore: s.mediaStore, logger: silent, sleep: async () => {} },
    {
      conversationId: 'conv-1',
      messageSid: 'MM10',
      targets: [{ index: 0, url: 'https://api.twilio.com/m/0', contentType: 'text/html' }],
      delaysMs: INLINE_MIRROR_DELAYS_MS,
    },
  );
  expect(out.attachments[0]?.attachment.contentType).toBe('application/octet-stream');
  expect(s.puts[0]?.contentType).toBe('application/octet-stream');
});
```

To `app/test/inboundEmail.test.ts`. The harness exists and the model is
`inboundEmail.test.ts:975-988`, which already asserts on
`w.appended[0].mediaAttachments` for a two-attachment email - one
`application/pdf`, one `application/x-weird` that collapses to
`application/octet-stream`. Copy that test's setup and assertion path and
change the second attachment:

```ts
it('stores an inbound docx attachment with its real type', async () => {
  // Same defect, different channel: an inbound .docx collapsed to
  // octet-stream exactly like an MMS video did. The x-weird case in the
  // sibling test above still collapses - the allowlist did not become a
  // passthrough.
  const docx =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  // ...same `w` / notice() setup as :975, with attachments:
  //   { filename: 'lease.docx', contentType: docx, base64: 'AAAA' }
  const m = w.appended[0]!;
  expect(m.mediaAttachments?.[0]).toMatchObject({ contentType: docx, filename: 'lease.docx' });
});
```

Also assert that an inbound `text/html` part is STILL stored as
`application/octet-stream` - the security half, and the one a widening change
is most likely to break.

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
  - `interface MediaFilename { ascii: string; utf8?: string | undefined }`
  - `buildMediaFilenameParts(storedFilename: string | undefined, index: number, resolved: ResolvedMediaType): MediaFilename`
  - `buildMediaFilename(...same args...): string` - convenience returning
    `.ascii`, used by the tests and by any caller that does not need the pair
  - `contentDispositionHeader(kind: 'inline' | 'attachment', name: MediaFilename): string`

`index` is the ZERO-BASED attachment index from the URL; the function emits a
one-based name.

- [ ] **Step 1: Write the failing tests**

Create `app/test/mediaFilename.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildMediaFilename,
  buildMediaFilenameParts,
  contentDispositionHeader,
} from '../src/lib/mediaFilename.js';
import { resolveMediaTier } from '../src/lib/mediaTypes.js';

// Non-ASCII fixtures are BUILT, never written as literals: the repo's
// ASCII-only rule covers test files, and a unicode escape in a markdown plan
// does not survive copy-paste reliably. String.fromCharCode is unambiguous at
// every layer - the same reason Timeline.tsx:604-608 builds its glyphs.
const E_ACUTE = String.fromCharCode(0xe9);
const NON_ASCII_STEM = `bud${E_ACUTE}get`;

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

describe('buildMediaFilename - sanitizing happens BEFORE splitting', () => {
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

  it('removes path separators and traversal BEFORE looking for the extension', () => {
    // ORDER IS LOAD-BEARING. Splitting first would find the dot at index 4 of
    // `../../etc/passwd` and hand `./etc/passwd` to the extension logic.
    expect(buildMediaFilename('../../etc/passwd', 0, MP4)).toBe('etcpasswd.mp4');
    expect(buildMediaFilename('C:\\Users\\x\\secret.txt', 0, MP4)).toBe('CUsersxsecret.mp4');
  });

  it('turns control characters into a space rather than deleting them', () => {
    // Deleting would silently join two words: `a\r\nb` must not become `ab`.
    expect(buildMediaFilename('a\r\nb', 0, MP4)).toBe('a b.mp4');
    expect(buildMediaFilename('a\tb', 0, MP4)).toBe('a b.mp4');
  });

  it('removes quotes and backslashes entirely', () => {
    expect(buildMediaFilename('he said "hi"', 0, MP4)).toBe('he said hi.mp4');
  });

  it('does not let a trailing space reach the emitted name', () => {
    expect(buildMediaFilename('report .txt', 0, MP4)).toBe('report.mp4');
  });

  it('caps the STEM, not the emitted name, so the extension survives', () => {
    // Capping the whole name would truncate .xlsx to .xls and change the file
    // type the OS sees.
    const long = 'a'.repeat(120);
    const out = buildMediaFilename(`${long}.xlsx`, 0, XLSX);
    expect(out).toBe(`${'a'.repeat(100)}.xlsx`);
    expect(out.endsWith('.xlsx')).toBe(true);
  });

  it('re-strips a trailing dot EXPOSED BY the cap', () => {
    // The stem is 110 chars with a dot at position 99, so the cap turns an
    // INTERIOR dot into a trailing one. Stripping only before the cap emits
    // `aaa...a..mp4`.
    const name = `${'a'.repeat(99)}.${'c'.repeat(10)}.txt`;
    expect(buildMediaFilename(name, 0, MP4)).toBe(`${'a'.repeat(99)}.mp4`);
  });

  it('replaces non-ASCII rather than dropping it', () => {
    // Dropping empties a wholly non-ASCII stem and yields filename=".xlsx".
    expect(buildMediaFilename(NON_ASCII_STEM, 0, XLSX)).toBe('bud_get.xlsx');
  });

  it('falls through when nothing usable survives sanitizing', () => {
    // An all-placeholder stem is not a name. Without this rule a wholly
    // non-ASCII filename downloads as `__.xlsx`.
    const allNonAscii = String.fromCharCode(0x4f60, 0x597d);
    expect(buildMediaFilename(allNonAscii, 0, XLSX)).toBe('attachment-1.xlsx');
    expect(buildMediaFilename('///', 0, MP4)).toBe('attachment-1.mp4');
    expect(buildMediaFilename('   ', 0, MP4)).toBe('attachment-1.mp4');
  });

  it('KEEPS the utf8 form even when the ASCII form fell through', () => {
    // The two decisions are independent. A wholly non-ASCII name has no usable
    // ASCII form, but `filename*` can still carry the operator's real name -
    // and that is the exact population filename* exists for, so collapsing the
    // two decisions would lose it precisely where it matters.
    const allNonAscii = String.fromCharCode(0x4f60, 0x597d);
    expect(buildMediaFilenameParts(allNonAscii, 0, XLSX)).toEqual({
      ascii: 'attachment-1.xlsx',
      utf8: `${allNonAscii}.xlsx`,
    });
  });

  it('omits filename* rather than throwing on an unpaired surrogate', () => {
    // encodeURIComponent throws URIError on a lone surrogate, and a stored
    // filename is untrusted data - this must not 500 the authed media route.
    const loneSurrogate = String.fromCharCode(0xd800);
    const parts = buildMediaFilenameParts(`x${loneSurrogate}y`, 0, MP4);
    expect(() => contentDispositionHeader('attachment', parts)).not.toThrow();
    expect(contentDispositionHeader('attachment', parts)).toBe(
      'attachment; filename="x_y.mp4"',
    );
  });
});

describe('buildMediaFilename - the RFC 5987 companion', () => {
  it('reports no utf8 form when the stem was already ASCII', () => {
    expect(buildMediaFilenameParts('budget.xlsx', 0, XLSX)).toEqual({
      ascii: 'budget.xlsx',
      utf8: undefined,
    });
  });

  it('reports both forms when the stem carried non-ASCII', () => {
    expect(buildMediaFilenameParts(NON_ASCII_STEM, 0, XLSX)).toEqual({
      ascii: 'bud_get.xlsx',
      utf8: `${NON_ASCII_STEM}.xlsx`,
    });
  });
});

describe('contentDispositionHeader', () => {
  it('emits a plain ASCII filename parameter', () => {
    expect(contentDispositionHeader('attachment', { ascii: 'budget.xlsx' })).toBe(
      'attachment; filename="budget.xlsx"',
    );
  });

  it('supports the inline kind', () => {
    expect(contentDispositionHeader('inline', { ascii: 'photo.jpg' })).toBe(
      'inline; filename="photo.jpg"',
    );
  });

  it('adds filename* only when a utf8 form differs', () => {
    expect(
      contentDispositionHeader('attachment', {
        ascii: 'bud_get.xlsx',
        utf8: `${NON_ASCII_STEM}.xlsx`,
      }),
    ).toBe("attachment; filename=\"bud_get.xlsx\"; filename*=UTF-8''bud%C3%A9get.xlsx");
  });

  it('percent-encodes the RFC 5987 characters encodeURIComponent leaves bare', () => {
    expect(
      contentDispositionHeader('attachment', { ascii: 'a_b.txt', utf8: "a'(b)*!.txt" }),
    ).toContain("filename*=UTF-8''a%27%28b%29%2A%21.txt");
  });

  it('cannot be injected into via a quote or CRLF', () => {
    // buildMediaFilename has already removed these; this is defence in depth
    // at the point the header string is actually assembled.
    const header = contentDispositionHeader('attachment', { ascii: 'a"b\r\nX-Evil: 1' });
    expect(header).not.toContain('\r');
    expect(header).not.toContain('\n');
    expect(header.match(/"/g)).toHaveLength(2);
  });
});
```

RFC 5987 IS IMPLEMENTED HERE, reversing an earlier draft of this plan that
dropped it. Spec 6.3 mandates it and spec 9 tests it, and the ASCII
transliteration alone leaves a non-ASCII name as `attachment-1.xlsx` for the
operator - correct and safe, but a real loss of information for a name we
actually hold. It is about eight lines over `encodeURIComponent`.

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

/** True when nothing a human would recognise as a name survived sanitizing:
 *  empty, only separators/underscores/spaces, or emailMime's placeholder. */
function isUnusableStem(stem: string): boolean {
  return stem.length === 0 || /^[_\s]+$/.test(stem) || SYNTHESIZED.test(stem);
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
  const stem = trimEnd(trimEnd(stored?.stem ?? '').slice(0, MAX_STEM));

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
  const utf8Usable = stem.length > 0 && !SYNTHESIZED.test(stem) && stem !== asciiStem;

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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && npx vitest run test/mediaFilename.test.ts`
Expected: PASS. If `'../../etc/passwd'` does not produce `etcpasswd.mp4`, work
out which rule fired in which order before changing anything - the ORDER inside
`sanitizeName`, and the fact that it runs BEFORE `splitName`, is the deliberate
part and the thing an earlier draft of this plan got wrong.

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
- Test: `app/test/apiRoutes.test.ts` (ALL new cases go here), and update three
  existing assertions in `app/test/mmsMedia.test.ts` + `app/test/apiRoutes.test.ts`

**Interfaces:**
- Consumes: `resolveMediaTier` (Task 1), `buildMediaFilenameParts` +
  `contentDispositionHeader` (Task 2).
- Produces: no new exports.

WHY apiRoutes.test.ts AND NOT mmsMedia.test.ts: `makeMediaApp`
(`app/test/apiRoutes.test.ts:600-632`) injects BOTH the message record and the
store's returned `contentType` directly, so a test can state the stored type
and a stored filename independently. `mmsMedia.test.ts` drives the webhook,
which NORMALIZES the type on the way in - so a "we still refuse text/html at
READ time" test written there would pass without ever exercising the read-side
gate, because the write side already collapsed it. That would be a test that
proves nothing while looking like it proves the security property.

- [ ] **Step 1: Write the failing tests**

Add to the `GET /api/messages/:providerSid/media/:idx` describe block in
`app/test/apiRoutes.test.ts`. `makeMediaApp` already takes the message record,
so a stored filename is expressed through `media_attachments`:

```ts
  function mediaMessage(attachment: Record<string, unknown>) {
    return {
      conversationId: 'c1',
      tsMsgId: '2026-08-01T00:00:00.000Z#MM1',
      provider_sid: 'MM1',
      media_attachments: [{ s3Key: 'media/c1/MM1/0', ...attachment }],
    };
  }

  it('serves a declarable type truthfully, as a download, with a real extension', async () => {
    // The reported bug: a relay member's video downloaded as an untyped,
    // extensionless blob the OS could not open.
    const { app } = makeMediaApp({
      message: mediaMessage({ contentType: 'video/mp4' }),
      object: { contentType: 'video/mp4' },
    });
    const res = await get(app, 'MM1', 0);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['content-disposition']).toBe('attachment; filename="attachment-1.mp4"');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  });

  it('still forces an unknown stored type to an opaque download', async () => {
    const { app } = makeMediaApp({
      message: mediaMessage({ contentType: 'application/x-made-up' }),
      object: { contentType: 'application/x-made-up' },
    });
    const res = await get(app, 'MM1', 0);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe('attachment; filename="attachment-1.bin"');
  });

  it('refuses to render a script-capable type stored on the OBJECT', async () => {
    // The stored-XSS guard, exercised where it actually lives. An object
    // mirrored before the write-side normalizer existed can still carry
    // text/html at rest, which is the population this gate is for - so the
    // OBJECT's type is text/html here even though no write path would produce
    // it today.
    const { app } = makeMediaApp({
      message: mediaMessage({ contentType: 'application/octet-stream' }),
      object: { contentType: 'text/html' },
    });
    const res = await get(app, 'MM1', 0);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
  });

  it('names an inline attachment without forcing a download', async () => {
    const { app } = makeMediaApp({
      message: mediaMessage({ contentType: 'image/png' }),
      object: { contentType: 'image/png' },
    });
    const res = await get(app, 'MM1', 0);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toBe('inline; filename="attachment-1.png"');
  });

  it('takes a stored filename stem but never its extension', async () => {
    const { app } = makeMediaApp({
      message: mediaMessage({ contentType: 'video/mp4', filename: 'invoice.exe' }),
      object: { contentType: 'video/mp4' },
    });
    const res = await get(app, 'MM1', 0);
    expect(res.headers['content-disposition']).toBe('attachment; filename="invoice.mp4"');
  });

  it('keeps a recognised stored extension when the type is unrecoverable', async () => {
    // Historical inbound email: octet-stream at rest, real name still present.
    const { app } = makeMediaApp({
      message: mediaMessage({ contentType: 'application/octet-stream', filename: 'budget.xlsx' }),
      object: { contentType: 'application/octet-stream' },
    });
    const res = await get(app, 'MM1', 0);
    expect(res.headers['content-disposition']).toBe('attachment; filename="budget.xlsx"');
  });

  it('serves an OUTBOUND email attachment on the declarable tier', async () => {
    // Not the reported bug, but the same route: outbound email attachments are
    // already stored as their real type, so they change tier the moment this
    // lands with no backfill at all. Spec section 8.6.
    const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const { app } = makeMediaApp({
      message: mediaMessage({ contentType: xlsx, filename: 'Q3.xlsx' }),
      object: { contentType: xlsx },
    });
    const res = await get(app, 'MM1', 0);
    expect(res.headers['content-type']).toBe(xlsx);
    expect(res.headers['content-disposition']).toBe('attachment; filename="Q3.xlsx"');
  });

  it('emits filename* for a non-ASCII stored name', async () => {
    // Built, not written as a literal - the ASCII-only source rule.
    const stored = `bud${String.fromCharCode(0xe9)}get.mov`;
    const { app } = makeMediaApp({
      message: mediaMessage({ contentType: 'video/mp4', filename: stored }),
      object: { contentType: 'video/mp4' },
    });
    const res = await get(app, 'MM1', 0);
    expect(res.headers['content-disposition']).toBe(
      "attachment; filename=\"bud_get.mp4\"; filename*=UTF-8''bud%C3%A9get.mp4",
    );
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd app && npx vitest run test/apiRoutes.test.ts`
Expected: FAIL - the declarable case returns `application/octet-stream`.

- [ ] **Step 3: Implement**

In `app/src/routes/api.ts`, change the import at `:23` - ADD the new symbols
and DROP `normalizeStoredMediaType`, which this file imports and never uses (a
pre-existing unused import; you are editing this line anyway):

```ts
import { isTwilioDeliverableType, resolveMediaTier } from '../lib/mediaTypes.js';
import { buildMediaFilenameParts, contentDispositionHeader } from '../lib/mediaFilename.js';
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
    const filename = buildMediaFilenameParts(attachments[idx]?.filename, idx, resolved);
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

Run: `cd app && npx vitest run test/apiRoutes.test.ts`
Expected: PASS except the pre-existing assertions in Step 5.

- [ ] **Step 5: Update the three assertions the inline tier deliberately moves**

Three existing assertions say `content-disposition` is UNDEFINED on the inline
path. FIND THEM BY CONTENT, NOT BY LINE NUMBER - Step 1 inserted roughly a
hundred lines into the same describe block in `apiRoutes.test.ts`, so the line
numbers recorded during planning are already stale:

```
grep -rn "content-disposition'\]).toBeUndefined" app/test
```

That returns one hit in `app/test/mmsMedia.test.ts` and two in
`app/test/apiRoutes.test.ts`. The inline tier now sends `inline; filename=...`,
which does not change rendering (`inline` is the default when no disposition is
sent) and exists so an operator saving an image gets a real name. Change each
from absent to:

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
- Create: `dashboard/src/routes/contact/MediaGallery.test.tsx` if no test file
  for that component exists (check first)

**Interfaces:**
- Consumes: nothing from Tasks 1-3 (the dashboard cannot import from `app/`).
- Produces, all from `media.ts`:
  - `isInlineRenderable(contentType: string): boolean`
  - `mediaKindWord(contentType: string): string | undefined`
  - `isDeclarableMediaType(contentType: string): boolean` - the third mirrored
    item spec 6.4 requires. It is NOT redundant with `mediaKindWord`: a caller
    asking "is this a known typed attachment" should not have to infer it from
    a label lookup returning a truthy string.

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

  it('isDeclarableMediaType agrees with it - one map, two views', () => {
    expect(isDeclarableMediaType('video/mp4')).toBe(true);
    expect(isDeclarableMediaType('image/jpeg')).toBe(false);
    expect(isDeclarableMediaType('application/octet-stream')).toBe(false);
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

/** True when the server will serve this type truthfully (declarable tier).
 *  Every declarable type has a kind word, so this shares the map - but callers
 *  asking a yes/no question get a yes/no answer rather than a label. */
export function isDeclarableMediaType(contentType: string): boolean {
  return KIND_WORDS.has(essenceOf(contentType));
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

- [ ] **Step 4b: Cover MediaGallery as a COMPONENT, not only through media.ts**

Spec 9 requires the HEIC/JPEG behavior proven in BOTH galleries. Task 4's
helper tests prove the predicate; they do not prove `MediaGallery` calls it.
Add (creating the file if there is none), following whatever render helper the
neighbouring `dashboard/src/routes/contact/*.test.tsx` files use:

```tsx
const AT = '2026-08-01T00:00:00.000Z';
const item = (contentType: string) => ({ key: 'a:0', src: '/x', contentType, at: AT });

it('renders a HEIC gallery item as a file tile, not an img', () => {
  render(<MediaGallery media={[item('image/heic')]} />);
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});

it('still renders a jpeg gallery item as an img', () => {
  render(<MediaGallery media={[item('image/jpeg')]} />);
  expect(screen.getByRole('img')).toBeInTheDocument();
});
```

- [ ] **Step 5: Run the dashboard suite**

Run: `cd dashboard && npx vitest run src/routes/contact/`
Expected: PASS, INCLUDING these four which must NOT have changed:
`Timeline.test.tsx:552` (image `alt`), `:555` (PDF file link),
`Timeline.email.test.tsx:88` and `:107` (both are `application/octet-stream`
with no filename - opaque tier, so bare). If one of those four fails, the kind
rule has been applied too widely - fix the rule, not the assertion.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/routes/contact/media.ts dashboard/src/routes/contact/Timeline.tsx dashboard/src/routes/contact/MediaGallery.tsx dashboard/src/routes/contact/media.test.ts dashboard/src/routes/contact/Timeline.test.tsx dashboard/src/routes/contact/MediaGallery.test.tsx
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

THERE IS NO MinIO ROUND-TRIP HARNESS. `app/test/mediaStore.test.ts` is
hermetic - it asserts factory gating and command SHAPES against a fake `send`
(see its header comment: "The real S3/MinIO streaming path is exercised in the
e2e harness"). Do not invent a live-bucket harness here; assert the command,
which is the part that can be wrong.

Create `app/test/mediaStore.setContentType.test.ts` - the repo already puts one
method per file here (`mediaStore.getBytes.test.ts`,
`mediaStore.deleteObject.test.ts`, `mediaStore.getStreamRange.test.ts`,
`mediaStore.presignPost.test.ts`), and `mediaStore.test.ts`'s own header scopes
it to factory gating. Copy the fake-`send` setup from one of those siblings.

THE CONSTRUCTOR IS POSITIONAL - `new S3MediaStore(bucket, client)`
(`app/src/adapters/mediaStore.ts:138-142`), NOT an options object:

```ts
it('issues a same-key CopyObject that REPLACES the metadata', async () => {
  const sent: unknown[] = [];
  const client = { async send(cmd: unknown) { sent.push(cmd); return {}; } };
  const store = new S3MediaStore('b', client as unknown as S3Client);
  await store.setContentType('media/c1/MM1/0', 'video/mp4');
  const input = (sent[0] as { input: Record<string, unknown> }).input;
  expect(input).toMatchObject({
    Bucket: 'b',
    Key: 'media/c1/MM1/0',
    CopySource: 'b/media/c1/MM1/0',
    ContentType: 'video/mp4',
    // Without REPLACE, S3 COPIES the old Content-Type and the call is a no-op
    // that looks like a success - the single most likely way to ship this
    // broken.
    MetadataDirective: 'REPLACE',
  });
});
```

For the messaging adapter, add a NEW describe block in
`app/test/messaging.test.ts`. Do NOT call the existing `makeDriver` - it takes
ZERO arguments and is scoped inside the
`TwilioMessagingDriver.getMediaStream` describe (`messaging.test.ts:293`), so
it cannot inject a client. Write a local builder that takes one, copying that
function's constructor argument list verbatim:

```ts
describe('TwilioMessagingDriver.getMediaContentType', () => {
  function driverWith(client: unknown) {
    return new TwilioMessagingDriver({
      accountSid: 'ACtest',
      apiKeySid: 'SKtest',
      apiKeySecret: 'secret',
      messagingServiceSid: 'MGtest',
      appEnv: 'local',
      client: client as never,
    });
  }

  /** The REAL SDK's `messages` is a function that also carries `.create`. */
  function callableClient(fetchImpl: () => Promise<unknown>) {
    return {
      messages: Object.assign((_sid: string) => ({ media: (_m: string) => ({ fetch: fetchImpl }) }), {
        create: vi.fn(),
      }),
    };
  }

  it('reads the content type off a callable messages resource', async () => {
    const d = driverWith(callableClient(async () => ({ contentType: 'video/mp4' })));
    expect(await d.getMediaContentType('MM1', 'ME1')).toBe('video/mp4');
  });

  it('returns undefined when Twilio no longer has the media', async () => {
    const d = driverWith(
      callableClient(async () => {
        throw Object.assign(new Error('gone'), { status: 404, code: 20404 });
      }),
    );
    expect(await d.getMediaContentType('MM1', 'ME1')).toBeUndefined();
  });

  it('rethrows anything that is not a 404', async () => {
    // A 429 must reach the backfill so it can count throttling separately
    // from retention loss.
    const d = driverWith(
      callableClient(async () => {
        throw Object.assign(new Error('slow down'), { status: 429 });
      }),
    );
    await expect(d.getMediaContentType('MM1', 'ME1')).rejects.toThrow('slow down');
  });

  it('degrades against a message-only fake rather than throwing', async () => {
    // Every existing fake supplies a plain object with only `create`. This
    // path must degrade, not crash, or one new interface member breaks
    // several unrelated suites.
    const d = driverWith({ messages: { create: vi.fn() } });
    expect(await d.getMediaContentType('MM1', 'ME1')).toBeUndefined();
  });
});
```

And that the console driver returns `undefined`.

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
  // A METHOD ON THE CLASS, beside `put`. `S3MediaStore` is a class holding
  // `private readonly bucket` and `private readonly client`
  // (`app/src/adapters/mediaStore.ts:138-142`), so this reads `this.*` and
  // annotates its parameters - a free `client` / `bucket` and untyped params
  // are three errors under `strict`.
  async setContentType(key: string, contentType: string): Promise<void> {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: key,
          // CopySource is a URL PATH, so a key containing characters that are
          // special in a path would need encoding. Every key this method is
          // called with is machine-minted (media/<uuid>/<SID>/<int>), so plain
          // interpolation is correct today - encode if that ever stops being
          // true.
          CopySource: `${this.bucket}/${key}`,
          ContentType: contentType,
          MetadataDirective: 'REPLACE',
        }),
      );
  }
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

Twilio driver. THE SEAM IS NOT CALLABLE, so `this.client.messages(sid)` does
NOT compile: `TwilioClientLike.messages` is declared as a plain object with
only `create` (`app/src/adapters/messaging.ts:390-399`), because every injected
fake supplies an object literal. The real SDK's `messages` IS callable - the
interface just models less than the real object.

Do NOT widen `messages` to a call signature: that breaks every message-only
fake in the repo for one new method. Assert the narrow callable view at the ONE
call site that needs it, and discriminate at runtime, which also makes the
degradation testable:

```ts
/**
 * The callable shape the REAL Twilio SDK exposes for per-message
 * sub-resources. TwilioClientLike models only what our fakes implement
 * (`messages.create`), so this narrower view is asserted here rather than
 * widening the seam - the same reason `calls` is optional on that interface.
 */
interface MessageMediaResource {
  messages(messageSid: string): {
    media(mediaSid: string): { fetch(): Promise<{ contentType?: string | null }> };
  };
}

  async getMediaContentType(messageSid: string, mediaSid: string): Promise<string | undefined> {
    // A message-only fake has a plain object here, not a function. Degrade
    // rather than crash: one new method must not break unrelated suites.
    if (typeof (this.client as { messages?: unknown }).messages !== 'function') return undefined;
    const client = this.client as unknown as MessageMediaResource;
    try {
      const media = await client.messages(messageSid).media(mediaSid).fetch();
      return typeof media.contentType === 'string' ? media.contentType : undefined;
    } catch (err) {
      // The media is gone (retention, deletion). Not an error for the
      // backfill - it counts it and moves on. Twilio surfaces this as HTTP 404
      // with code 20404; check BOTH, because the repo has already been bitten
      // by assuming one shape (see the note at
      // app/src/services/groupConversations.ts:708-716).
      const e = err as { status?: number; code?: number };
      if (e.status === 404 || e.code === 20404) return undefined;
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
# Explicit paths only - never `git add app/test/` or any other directory.
# List each file typecheck made you touch.
git add app/src/adapters/messaging.ts app/src/adapters/mediaStore.ts app/test/mediaStore.test.ts <each-touched-test-file>
git commit
```

Message: `feat(adapters): media content-type read + in-place S3 type rewrite`

---

### Task 6: The backfill script

**Files:**
- Create: `app/scripts/backfill-media-content-types.ts`
- Create: `app/test/backfillMediaContentTypes.test.ts`

NO npm SCRIPT. There is no `backfill:*` script in any package.json - the
RUNBOOK invokes every backfill as `npx tsx app/scripts/<name>.ts --dry-run`
(see `RUNBOOK.md:257,260`). Follow that; do not add one for this script alone.

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

// REAL-SHAPED SIDs: `ME` + 32 hex. An underscore-and-letters placeholder like
// `ME_ZERO` cannot match the parser's own regex and would redden most of this
// file while looking like a logic bug.
const ME0 = 'ME00000000000000000000000000000000';
const ME1 = 'ME11111111111111111111111111111111';
const URL0 = `https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/${ME0}`;
const URL1 = `https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/${ME1}`;

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
    expect(getMediaContentType).toHaveBeenCalledWith('MM1', ME1);
  });

  it('skips an attachment already carrying a real type', async () => {
    // The per-attachment predicate. Without it a re-run re-queries Twilio for
    // every attachment on a partially repaired row.
    const row = inboundRow({
      media_attachments: [{ s3Key: 'media/c1/MM1/0', contentType: 'video/mp4' }],
    });
    const { result, getMediaContentType } = await run({ rows: [row] });
    expect(result.eligible).toBe(0);
    expect(getMediaContentType).not.toHaveBeenCalled();
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
2. `export interface BackfillResult` with every counter, EACH WITH ITS
   SEMANTICS IN A COMMENT because an operator reads these to decide whether to
   apply:
   - `rowsScanned` - message rows returned by the scan, before any filtering
   - `eligible` - ATTACHMENTS that passed the full candidate predicate
   - `recovered: Record<string, number>` - canonical type -> count, the
     histogram
   - `written` - attachments whose repair COMMITTED, which means their
     message's row write succeeded. An attachment whose S3 copy landed but
     whose row write then failed is NOT counted: it is still octet-stream in
     the row, so the next run re-selects it.
   - `skippedUnparseableKey`, `skippedNoUrl`, `skippedTwilio404`,
     `skippedThrottled`, `skippedStillOpaque`, `skippedEmailRow`,
     `skippedLegacyRow`
   - `vendorCalls` - Twilio reads performed, INCLUDING on a dry run

   `skippedThrottled` is separate from `skippedTwilio404` on purpose:
   throttling is transient and means "run it again", retention loss is
   permanent and means "these are gone". Folding them together corrupts the
   one number the go/no-go decision turns on.
3. `parseMediaIndexFromKey(s3Key: string): number | undefined` - matches
   `^media/[^/]+/[^/]+/(\d+)$` and returns the group as a number. Anything else
   is undefined; NEVER guess.

   NOTE ON WHAT THAT INDEX IS: it is the position in the ROW'S STORED
   `mediaUrls` array, not Twilio's own `MediaUrl{i}` numbering.
   `parseInboundMediaUrls` (`app/src/routes/webhooks/twilio.ts:440-448`) skips
   absent/empty entries, so the two can differ - and it is the correct index to
   use precisely because the s3Key and the stored `mediaUrls` derive from the
   same compacted list.
4. `parseMediaSid(url: string): string | undefined` - matches
   `/\/Media\/(ME[0-9a-fA-F]{32})/`. A real Twilio SID is `ME` + 32 hex; a
   looser pattern silently accepts junk.
5. The paged `ScanCommand` loop, filtering
   `attribute_exists(media_attachments) OR attribute_exists(media_s3_keys)`
   exactly as `backfill-media-pointers.ts` does, then applying the
   per-attachment predicate IN CODE (a FilterExpression cannot test a list
   element).
6. Per row: skip + count legacy rows (`media_s3_keys` with no
   `media_attachments`), non-inbound rows, and rows with no `mediaUrls`
   (inbound EMAIL - count as `skippedEmailRow`).
7. Per attachment, skipping any whose stored `contentType` is NOT
   `application/octet-stream` (a partially repaired row must not re-query
   Twilio for the attachments already fixed): parse the index, parse the
   MediaSid, call `getMediaContentType` (increment `vendorCalls`), normalize,
   skip if still opaque, else - ONLY WHEN NOT `dryRun` - `setContentType` on
   that attachment's object, and stage the corrected attachment either way so
   the histogram is complete on a dry run.

   `setContentType` MUST be inside the `dryRun` guard. It is the one call in
   this script that mutates the production bucket, and a dry run that mutates
   anything makes the whole "dry run first" ops sequence a lie.
8. Per row, ONLY if at least one attachment changed and not `dryRun`:
   `putMediaPointers(conversationId, tsMsgId, merged)` and THEN
   `annotateMessage(conversationId, tsMsgId, { mediaAttachments: merged })`,
   inside a try/catch. On failure log the error, do NOT increment `written`
   for that row's attachments, and CONTINUE to the next row - one bad row must
   not abort a long ops run, and the row still says octet-stream so a re-run
   repairs it.

   `merged` IS THE SAME ARRAY IN THE SAME ORDER as the row's existing
   `media_attachments`, with only the `contentType` of repaired entries
   changed. Positional identity is load-bearing twice over: pointer sort keys
   are built from the array position (`mediaPointerSk`), and the dashboard
   addresses bytes as `/media/:idx` where `idx` IS that position. Build it with
   `attachments.map(...)` - never filter, never reorder, never append.
9. Bounded concurrency of 4 over the attachments of one page, with a retry on
   a Twilio 429. Implement it as a simple index-cursor worker pool - four async
   workers pulling from a shared array cursor. Do not add a dependency and do
   not use an unbounded `Promise.all` over the whole page.

   HOW A 429 IS DETECTED, because a counter with no detection is decoration:
   the adapter returns `undefined` ONLY for a 404 and RETHROWS everything else
   (Task 5), so the backfill wraps its `getMediaContentType` call in a
   try/catch and inspects the thrown error:
   `const s = (err as {status?: number; code?: number}); if (s.status === 429 || s.code === 20429)`.
   Sleep 1s, 2s, 4s; if the fourth attempt still throttles, count the
   attachment as `skippedThrottled` and continue. Any other thrown error
   propagates - an auth failure must stop the run, not be silently counted.

   TEST IT: a fake whose `getMediaContentType` throws `{status: 429}` twice
   then resolves must produce one repair and zero skips; one that always
   throttles must produce `skippedThrottled: 1` and no write. Inject the sleep
   so the test does not actually wait 7 seconds.

9b. MISCONFIGURATION GUARD, and it is not optional. `getMediaContentType`
   returns `undefined` for BOTH "Twilio no longer has this media" and "this
   client cannot read media at all" (the console driver, a message-only fake, a
   credential pointed at the wrong account). Those are indistinguishable at the
   call site, so a misconfigured ops run would report "every attachment aged
   out", write nothing, and EXIT GREEN - the worst possible outcome, because it
   looks like a completed repair.

   So: if `vendorCalls > 0` and the `recovered` histogram is empty, log an
   ERROR and exit non-zero with a message saying that every single lookup came
   back empty, that this is far more likely a driver or credential
   misconfiguration than genuine total retention loss, and that nothing was
   written. Applies on a dry run too - that is when it should be caught.
10. CLI wrapper copying `backfill-media-pointers.ts`'s `invokedDirectly` shape,
    PLUS the account guard - which that script does NOT have, so it is not the
    precedent for this part. `app/scripts/import-apply.ts:30-34,240-254` is:

```ts
import {
  assertHousingChoiceAccount,
  hcCredentials,
  HC_PROFILE,
  HC_REGION,
} from '../../scripts/lib/hcAws.mjs';

const identity = await assertHousingChoiceAccount();
logger.info({ profile: HC_PROFILE, account: identity.Account }, 'account guard OK');
```

THE GUARD MUST BIND TO THE CLIENTS THE SCRIPT ACTUALLY WRITES THROUGH. Calling
`assertHousingChoiceAccount()` and then building the doc client and media store
from `getDocumentClient()` / `createMediaStore()` proves an account the writes
never touch - the guard passes on the `housingchoice` profile while the writes
go wherever the DEFAULT chain points, which in this environment is a different
account. That is worse than no guard, because it reads as protection.

So construct all three explicitly and pass them in.

DOC CLIENT - copy `import-apply.ts:240-254` including its marshall options,
which that file explicitly flags as having to match `lib/dynamo.ts:83-89`.
Omitting them changes how `undefined` is written and is exactly the kind of
divergence a one-off ops script should not introduce:

```ts
const credentials = hcCredentials();
const doc = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: HC_REGION, credentials }),
  { marshallOptions: { removeUndefinedValues: true } },
);
```

MEDIA STORE - `createMediaStore` builds its own `S3Client` from the default
chain, so it needs a small ADAPTER-SIDE change rather than a script-side
workaround. Add an optional `credentials` passthrough to `createMediaStore` in
Task 5 (it is already editing that file) and forward it to the `S3Client` it
constructs. Do NOT reach for the store's `client` seam from the script: that
would put an `@aws-sdk/client-s3` import in `app/scripts`, which this plan's
Global Constraints and the repo's adapter rule both forbid. Keeping the SDK
inside the adapter is the whole point of the rule, and the passthrough is three
lines.

Write the counters into one `logger.info` at the end. Log IDs and counts only:
never a filename, a media URL or a phone number.

- [ ] **Step 4: Run to verify they pass**

Run: `cd app && npx vitest run test/backfillMediaContentTypes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/scripts/backfill-media-content-types.ts app/test/backfillMediaContentTypes.test.ts
git commit
```

Message: `feat(scripts): backfill inbound media content types from Twilio`

---

### Task 7: fake-twilio fixture and the e2e

**Files:**
- Create: `fake-twilio/web/public/canned/contact-card.vcf` - the SAME directory
  as the existing `kitchen.png`, `room.png` and `lease-doc.pdf`. It must be
  under `public/`: an asset under `src/assets` below Vite's inlining threshold
  is emitted as a `data:` URI rather than a fetchable URL, and a few-hundred-byte
  vCard is far below it.
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
test's expected list - it carries an id-to-EXTENSION map and asserts the
resulting URL pathnames, so a new asset must be added there or that test goes
red. Note that it knows nothing about content types: NOTHING pins that the
registry and `signer.ts`'s `inferMediaContentType` agree, so getting the
`.vcf` branch into the signer is on you, not on a guard.

- [ ] **Step 3: Write the e2e spec**

Create `e2e/tests/dashboard-next/inbound-media-type.spec.ts`. Use the
accessibility-first selectors in `e2e/support/selectors.md` and follow the
existing `outbound-mms.spec.ts` for how a spec drives the fake into sending an
inbound MMS.

TARGET A 1:1 THREAD, NOT A RELAY GROUP. The spec's own example was a relay
thread, but the mirror is shared by both paths (spec section 1), and a relay
thread also drives the fan-out, which is the KNOWN-BROKEN forwarding path filed
as `docs/issues/relay-forwards-undeliverable-media.md`. A 1:1 thread proves the
same thing without entangling this spec with a failure it does not own.

Assert BOTH halves. `mediaHref` comes off the rendered link, so the test
follows the same URL a human would click:

```ts
// `timeline` is whatever locator the neighbouring specs use to scope to the
// thread's message list - copy it from outbound-mms.spec.ts rather than
// inventing one.
// 1. the dashboard renders it as a file link with its kind, not an <img>
const link = timeline.getByRole('link', { name: /Contact card - Attachment 1/i });
await expect(link).toBeVisible();

// 2. the served response is typed and named. Same session cookie - the media
//    route is authed, so an unauthenticated request would 401.
const mediaHref = await link.getAttribute('href');
const res = await page.request.get(mediaHref!);
expect(res.status()).toBe(200);
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

Add a section for the media content-type backfill covering, in this order.
INVOKE IT AS `npx tsx app/scripts/backfill-media-content-types.ts --dry-run` -
there is no npm script and Task 6 deliberately does not add one, so naming a
`backfill:*` command here would document something that does not exist:

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

That issue's Resolution section makes THREE claims this change alters, not one.
Read the whole section before writing, and cover all of them:

1. `:30-32` - `...; charset=...` parameter forms cannot bypass the allowlist
   (exact-string matching). Now essence matching.
2. "everything else is forced to `application/octet-stream` +
   `Content-Disposition: attachment`" - no longer true; the declarable tier is
   served truthfully, still as an attachment.
3. it names `isInlineMediaType(object.contentType)` as the read-side gate - the
   route now calls `resolveMediaTier`.

Add ONE dated amendment covering all three - do not rewrite the history:

```markdown
**Amendment (2026-08-26, media content-type fidelity).** Three details of the
resolution above changed; the GUARANTEE did not.

- The read-side gate is now `resolveMediaTier` (`app/src/lib/mediaTypes.ts`),
  not `isInlineMediaType`, which keeps its own set and exact-match semantics
  for the outbound upload endpoint.
- Matching is on the media-type ESSENCE rather than the exact string, so the
  parameterized forms of ALLOWLISTED types are now admitted
  (`image/png; charset=x` reaches the inline tier). Safety rests on the
  CANONICAL OUTPUT instead of the matching: the resolver returns the
  allowlist's own constant, so a caller-supplied parameterized string never
  reaches a response header. Non-allowlisted types are unaffected -
  `text/html; charset=x` has essence `text/html` and still fails the gate.
- "Everything else is forced to octet-stream" is now two tiers: a DECLARABLE
  set of non-script-capable types (video, audio, HEIC, vCard, the OOXML
  documents) is served with its true Content-Type but ALWAYS as
  `Content-Disposition: attachment`, so it is downloaded and never rendered
  same-origin. Everything else, including every script-capable type and
  anything unrecognised, still gets octet-stream + attachment exactly as
  before.

See docs/superpowers/specs/2026-08-26-media-content-type-fidelity-design.md
sections 5.1 and 7.
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

- `npx tsx app/scripts/backfill-media-content-types.ts` must be run by a human, dev then prod, AFTER
  each deploy. Nothing else is owed - no terraform, no secrets, no SSM.
