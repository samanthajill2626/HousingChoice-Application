# Spec-conformance review - media-content-type-fidelity

Reviewer: read-only spec-conformance pass (no edits, no suites run).
Worktree: `W:\tmp\media-content-type-fidelity`
Branch: `feat/media-content-type-fidelity` @8842bdfb, base `main` @3c2962a4.
Live-tree state at review: `git status` CLEAN; `main` is still at 3c2962a4
(`git rev-list --count 8842bdfb..main` = 0), so no main-sync drift exists yet.
Spec: `docs/superpowers/specs/2026-08-26-media-content-type-fidelity-design.md`
Plan: `docs/superpowers/plans/2026-08-26-media-content-type-fidelity.md`

**Verdict: the work map CONFORMS.** 8 of 8 tasks conform; one sub-item of T1's
spec clause (5.2) is PARTIAL by an in-plan choice. Five findings, all NIT - four
documentation/anchor defects and one ASCII-rule slip. Nothing must-fix, nothing
plausible-severity. All eight deviations from spec/plan prose are either
adjudicated in the plan or justified by a recorded plan-vs-tree correction; none
is unexplained.

---

## Work map

### T1 `app/src/lib/mediaTypes.ts` - CONFORMS

- `DECLARABLE_MEDIA_TYPES` at `app/src/lib/mediaTypes.ts:59-81` - all 21 members
  spec 5 names, no more: the five video, six audio, four non-renderable image,
  two vCard and four document types. Every permanently-excluded type
  (`text/html`, `application/xhtml+xml`, `image/svg+xml`, `text/xml`,
  `application/xml`, `application/javascript`) is absent and named as excluded in
  the docblock at `:55-57`.
- Emission map `MEDIA_TYPE_EXTENSIONS` at `:93-120`. I checked it by hand against
  both allowlists: all 5 inline + all 21 declarable types have an entry, and
  every emitted extension is a member of the accepted set (so the `?? '.bin'`
  fallback at `:180` is unreachable for an allowlisted type). Guardrail tests
  pin both directions at `app/test/mediaTypes.test.ts:105-120`.
- `ACCEPTED_EXTENSIONS` at `:130-135` is byte-for-byte spec 6.3's exhaustive
  list (29 entries, same order), and is NOT derived from the emission map -
  `.jpeg`, `.tif`, `.m4v`, `.oga` appear here and nowhere in the map.
- `resolveMediaTier` at `:170-181`: essence matching
  (`raw.split(';')[0]!.trim().toLowerCase()`), inline-then-declarable order,
  canonical output. Opaque is minted fresh per call (`opaque()` at `:149-151`),
  so no caller can mutate a shared constant.
- `normalizeStoredMediaType` rewired at `:201-203`
  (`return resolveMediaTier(raw).canonical;`), name and signature unchanged.
- `isInlineMediaType` UNTOUCHED - `git diff 3c2962a4..8842bdfb -- app/src/lib/mediaTypes.ts`
  removes exactly six lines, all of them the old `normalizeStoredMediaType`
  docblock + body. `INLINE_MEDIA_TYPES` (`:31-34`) and `isInlineMediaType`
  (`:37-39`, still `INLINE_MEDIA_TYPES.has(type.trim().toLowerCase())` - exact
  match) are unchanged.
- Both widened callers covered: `app/test/mediaMirror.test.ts:164-196` (video/mp4
  stored truthfully, text/html still collapses) and
  `app/test/inboundEmail.test.ts:993-1026` (docx real type, text/html still
  octet-stream).

### T2 `app/src/lib/mediaFilename.ts` - CONFORMS

- Sanitize-then-split order is real, not asserted: `buildMediaFilenameParts`
  calls `sanitizeName` at `:101` and only then `splitName` at `:102`
  (`app/src/lib/mediaFilename.ts`). `sanitizeName` (`:40-52`) removes CR/LF/TAB/NUL
  to a SPACE, then quotes/backslash, then `/`, then Windows-reserved `[<>:|?*]`,
  then `..`, then collapses whitespace.
- Extension always from our own sets: `extFor` (`:135-143`) returns
  `resolved.ext` unless the tier is opaque AND `isAcceptedExtension(stored.ext)` -
  a membership test, never a passthrough.
- Stem rules: `isUnusableStem` (`:70-72`) treats empty, all-underscore/space and
  `^attachment-\d+$` as absent; the synthesized stem is one-based
  (`` `attachment-${index + 1}${ext}` ``, `:122`).
- Cap bounds the STEM: `:108` `trimEnd(trimEnd(stored?.stem ?? '').slice(0, MAX_STEM))`
  with `MAX_STEM = 100` (`:17`) - trailing dots/space stripped BEFORE and AGAIN
  AFTER the cap, exactly as spec 6.3 requires and pinned at
  `app/test/mediaFilename.test.ts:98-105` (cap) and `:107-113` (re-strip).
- RFC 5987: `rfc5987` (`:80-89`) percent-encodes and then escapes the five
  characters `encodeURIComponent` leaves bare (`/['()*!]/g`); the `try/catch`
  returns `undefined` on a lone surrogate and `contentDispositionHeader`
  (`:162-172`) degrades to the ASCII form (`:168-170`).
- Header injection impossible: the ASCII parameter is re-stripped of
  `[\r\n\0"\\]` at `:166` at the point of assembly; `filename*` is
  percent-encoded end to end. Pinned at `app/test/mediaFilename.test.ts:197-204`.

### T3 `app/src/routes/api.ts` media serve - CONFORMS

- Three tiers from ONE resolver on the OBJECT's type:
  `app/src/routes/api.ts:2296` `const resolved = resolveMediaTier(object.contentType);`
- `:2298` `res.setHeader('Content-Type', resolved.canonical);`
- `:2299-2302` disposition:
  `contentDispositionHeader(resolved.tier === 'inline' ? 'inline' : 'attachment', filename)` -
  inline gets `inline; filename=`, declarable and opaque get `attachment`.
- `:2303-2304` nosniff + `default-src 'none'; sandbox`, unconditional on every
  tier. `:2305-2307` Content-Length preserved; `:2309` Cache-Control preserved.
- `:2310` log carries `tier: resolved.tier` (was `inline`) and no filename.
- Unused import dropped: `:23` is now
  `import { isTwilioDeliverableType, resolveMediaTier } from '../lib/mediaTypes.js';` -
  `normalizeStoredMediaType` gone, `isInlineMediaType` gone (grep confirms no
  other use of either in that file).
- `app/src/routes/unitMediaServe.ts` and `app/test/unitMediaServe.test.ts` are
  absent from the branch diff entirely; `unitMediaServe.test.ts:77` still asserts
  `content-disposition` is `toBeUndefined()`.
- Route tests: `app/test/apiRoutes.test.ts:712-808` cover declarable, unknown,
  script-capable-on-the-object, inline naming, stem-not-extension, opaque
  `.xlsx`, outbound-email xlsx, and `filename*`.

### T4 dashboard - CONFORMS

- Both galleries branch on the mirrored set:
  `dashboard/src/routes/contact/Timeline.tsx:648` `if (isInlineRenderable(att.contentType))`
  and `dashboard/src/routes/contact/MediaGallery.tsx:36` `isInlineRenderable(m.contentType) ? (`.
  Neither keeps a `startsWith('image/')` predicate.
- Three mirrored helpers in `dashboard/src/routes/contact/media.ts`:
  `isInlineRenderable` (`:97`), `mediaKindWord` (`:103`), `isDeclarableMediaType`
  (`:110`), over `INLINE_RENDERABLE_TYPES` (`:64-69`) and `KIND_WORDS` (`:72-94`).
  The mirror comment at `:45-54` names `app/src/lib/mediaTypes.ts` as the source
  of truth and rules out the prefix test. `KIND_WORDS` mirrors all 21 declarable
  types exactly (hand-checked against `mediaTypes.ts:59-81`).
- Label rules at `Timeline.tsx:615-625`: filename wins first (`:621`), PDF keeps
  `PDF attachment N` (`:622`), declarable gains `<Kind> - Attachment N` (`:624`),
  opaque stays bare. The `<img>` alt passes `att.contentType` with `isPdf=false`
  (`:659`) and `mediaKindWord` returns undefined for the four raster types, so
  the alt text is unchanged by construction.
- The five pins hold and are UNMODIFIED: `Timeline.test.tsx:552` (img alt) and
  `:555` (PDF link) are outside the diff hunk (the new cases start at `:560`);
  `Timeline.email.test.tsx` is not in the branch diff at all - `:87`
  (`lease agreement.pdf`), `:88` (`Attachment 2`) and `:107` (`Attachment 1`) all
  stand. Sixth pin `dashboard/src/routes/contact/files.test.tsx:328`
  (`getByRole('img', { name: /Attachment/i })` on an `image/png` item) is
  untouched and still inline-renderable.

### T5 adapters - CONFORMS

- `MessagingAdapter.getMediaContentType` declared NON-optional at
  `app/src/adapters/messaging.ts:136`; Twilio driver at `:938-955` - callable-view
  guard (`typeof (this.client as { messages?: unknown }).messages !== 'function'`
  returns undefined), narrow `MessageMediaResource` view declared at `:504-508`,
  `if (e.status === 404 || e.code === 20404) return undefined;` at `:953` then
  `throw err;`. Console driver `:1088-1091` logs and returns undefined.
- `MediaStore.setContentType` declared NON-optional at
  `app/src/adapters/mediaStore.ts:153`; implementation `:274-292` is a same-key
  `CopyObjectCommand` with `CopySource: \`${this.bucket}/${key}\`` and
  `MetadataDirective: 'REPLACE'`.
- `CreateMediaStoreDeps.credentials` at `:335`, forwarded at `:360`
  (`createMediaStore`) and `:416` (`createInboundMailRawStore`), applied LAST in
  `buildS3Client` at `:395` so an explicit credential survives the local-endpoint
  spread.
- Every exhaustive implementer stubbed, and exactly the six the worklist's C3
  enumerated: `app/test/helpers/twilioWebhookHarness.ts` (both interfaces),
  `poolNumbers.test.ts`, `relayWarm.test.ts`, `scheduledSendSuppression.test.ts`,
  `sendMessage.test.ts`, `tourReminders.test.ts`. The cast/`Partial<>` sites the
  worklist marked immune are untouched.

### T6 `app/scripts/backfill-media-content-types.ts` - CONFORMS

- Index from the s3Key, never array position: `parseMediaIndexFromKey`
  (`:153-157`, `/^media\/[^/]+\/[^/]+\/(\d+)$/`) used at `:369`; MediaSid regex
  `/\/Media\/(ME[0-9a-fA-F]{32})/` at `:164`.
- Candidate predicate: inbound (`:345`), stored `mediaUrls` present (`:347-351`),
  attachment still `application/octet-stream` (`:366`).
- Write order S3 -> pointers -> row, row LAST, inside try/catch that logs and
  continues: `:291` (S3, inside the dry-run guard), `:410` `putMediaPointers`,
  `:411-413` `annotateMessage`, `:414` `written += repaired`, `:415-427` catch +
  continue. Pinned by `app/test/backfillMediaContentTypes.test.ts:103-116`.
- `merged` preserves order/positions via `row.attachments.map(...)` at `:405-408` -
  no filter, no reorder, no append.
- One row write per message: the per-row loop at `:396` runs after `drain`;
  test at `:118-123` asserts `annotateMessage` once for two attachments.
- Dry run: `:291` guards `setContentType`, `:399` `if (dryRun) continue;` skips
  both row writes, staging + histogram still happen at `:292-293`, and
  `vendorCalls` increments at `:236` before every Twilio read including dry runs.
- Throttle: `fetchMediaType` (`:233-261`) is string-tolerant
  (`const code = e.code === undefined ? undefined : Number(e.code); const throttled = e.status === 429 || code === 20429;`),
  sleeps `[1000, 2000, 4000]` (`:77`), then returns `throttled` -> `skippedThrottled`
  (`:266-268`). `if (!throttled) throw err;` (`:255`) propagates everything else.
- All eleven counters present with per-counter semantics comments (`:79-124`).
- CLI guard: `messagingMisconfiguration` (`:461-469`) requires
  `config.messagingDriver === 'twilio'` FIRST, then the three credential fields;
  it runs at `:486-495`, BEFORE the account guard and any scan, logs the cause +
  `HOW_TO_FIX`, and sets `process.exitCode = 1`.
- Account guard binds the clients actually written through: `:503` assert, `:509`
  `hcCredentials()`, `:510-515` doc client with the matching marshall options,
  `:516` `createMediaStore({ config, credentials })`, `:523`
  `createMessagesRepo({ doc })`. Nothing ambient.
- Imports (`:48-66`) contain no `@aws-sdk/client-s3` and no `twilio`.

### T7 fake-twilio + e2e - CONFORMS (with the adjudicated .vcf deviation)

- `fake-twilio/web/public/canned/contact-card.vcf` (5 ASCII lines, under
  `public/` not `src/assets`).
- Registry: `fake-twilio/web/src/assets/canned/index.ts:40`, APPENDED so
  `cannedAssets[0]` still addresses the picker.
- Pinning test updated: `fake-twilio/web/src/assets/canned/index.test.ts:10-15`
  (`'contact-card': 'vcf'`) and `:29-35` (`isImageAsset` false).
- Signer: `fake-twilio/src/engine/signer.ts:42` `if (path.endsWith('.vcf')) return 'text/vcard';`
- e2e `e2e/tests/dashboard-next/inbound-media-type.spec.ts`: 1:1 thread
  (`sendAsParty` with no `to`, `:53-57`), label assertion `:70-73`
  (`/Contact card - Attachment 1/`), served-response assertions `:85`
  (`content-type` === `text/vcard`) and `:88`
  (`/^attachment; filename=".*\.vcf"$/`). Helper signatures verified against
  `e2e/fixtures/fakeTwilio.ts:166-184`, `e2e/support/urls.ts:20,23`,
  `e2e/support/today.ts:43`, and the region name against
  `dashboard/src/routes/contact/Timeline.tsx:1981`.

### T8 docs - CONFORMS

- `RUNBOOK.md:262-282`: deploy-first ordering (step 1, with the broken-`<img>`
  reason), dry-run-first sequence (steps 2-5, dev fully through before prod),
  operator env INCLUDING `MESSAGING_DRIVER=twilio` first with the console-driver
  green-exit rationale, `s3:GetObject` + `s3:PutObject` for CopyObject, the
  vendor-read note on `--dry-run`, and the versioned-no-lifecycle bucket note.
  Invocation is `npx tsx app/scripts/backfill-media-content-types.ts --dry-run`,
  which matches reality (no `backfill:*` npm script exists in either
  `package.json`).
- `docs/issues/media-serve-stored-xss.md:50-88`: one dated amendment covering the
  parameter-matching claim, the "everything else is octet-stream" claim, the
  `isInlineMediaType`-gate claim, PLUS a fourth the plan did not name (the
  write-side "collapsing anything off the allowlist" bullet). Historical
  Resolution body is not rewritten - the only pre-existing line changed is the
  frontmatter `refs:` (worklist C6), and `:82-88` lists current anchors. I
  verified each new anchor against the live tree: `api.ts:2284-2304` (serve
  block), `services/mediaMirror.ts:104`, `messagesRepo.ts:1001`
  (`mediaAttachmentsOf`), `app.ts:118` (nosniff), `api.ts:2168` (call recording).
  All correct.

---

## Spec-wide constraints

- **Spec 5.2 trap (outbound upload gate still refuses `video/mp4`): PARTIAL.**
  The pin is at the PREDICATE level -
  `app/test/mediaTypes.test.ts:162-174`, `describe('isInlineMediaType is NOT widened (outbound upload gate)')`,
  asserting `isInlineMediaType('video/mp4') === false`,
  `isInlineMediaType('text/vcard') === false` and
  `isInlineMediaType('image/png; charset=x') === false`. There is no ROUTE-level
  test driving `POST /api/media/presign` with `video/mp4`: the existing route
  test `app/test/mmsMediaRoutes.test.ts:33-37` uses `image/svg+xml`. Risk is
  nil - `app/src/routes/mmsMedia.ts:78` still reads
  `if (!isInlineMediaType(contentType))` and neither that file nor the predicate
  was touched - and the plan (Task 1 Step 1) specified exactly this test, so this
  is adjudicated-in-plan, not drift. See finding N5.
- **Spec 7.4 (tier decision reads the OBJECT's type): CONFORMS.**
  `app/src/routes/api.ts:2296` passes `object.contentType`. The message record is
  read only for `attachments[idx]?.filename` (`:2297`) and the S3 key (`:2268`).
  `app/test/apiRoutes.test.ts:737-751` pins it adversarially: record
  `application/octet-stream`, object `text/html`, response octet-stream +
  attachment.
- **Spec 8.6 (outbound email attachments serve declarable): CONFORMS.**
  `app/test/apiRoutes.test.ts:781-793`,
  `it('serves an OUTBOUND email attachment on the declarable tier')` - xlsx type
  in, `content-type` xlsx and `attachment; filename="Q3.xlsx"` out.
- **Spec 9 (existing assertions that MUST change): CONFORMS EXACTLY.** Three
  flipped, all to `toMatch(/^inline; filename="/)`:
  `app/test/apiRoutes.test.ts:648`, `:661`, `app/test/mmsMedia.test.ts:229`.
  `app/test/unitMediaServe.test.ts:77` still `toBeUndefined()` and that file is
  not in the branch diff. No dashboard label assertion moved (see T4).
- **ASCII rule: one slip, finding N3.** I scanned every added (`+`) line in the
  whole branch diff excluding `docs/superpowers/`: 2403 added lines, exactly ONE
  carries a non-ASCII byte. The vCard asset is pure ASCII, and every non-ASCII
  test fixture is built with `String.fromCharCode`
  (`app/test/mediaFilename.test.ts:17`, `:123`, `:134`, `:144`;
  `app/test/apiRoutes.test.ts:797`).
- **Commit discipline: CONFORMS.** All 19 commits in `3c2962a4..8842bdfb` carry
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` (verified
  by `git log --format='%b'` over the range - 19/19).

---

## Findings

All five are NIT. None blocks merge; N1 and N4 are the two I would actually fix.

### N1 (nit) - the write-side call site still documents the OLD rule

`app/src/services/mediaMirror.ts:100-103`:

```
    // Normalize the SENDER-supplied type before storing: keep it only if it is
    // an allowlisted inline type, else octet-stream - so a dangerous type
    // (text/html, image/svg+xml) never enters S3 metadata (stored-XSS guard;
    // defense-in-depth with the serve-time allowlist).
    const contentType = normalizeStoredMediaType(target.contentType);
```

"keep it only if it is an allowlisted inline type, else octet-stream" is exactly
the behavior this feature removed. This is the primary write-side site, the one
the branch's own amendment (`docs/issues/media-serve-stored-xss.md:78-80`) now
names as the canonical anchor, so a reader who follows the amendment lands on a
comment that contradicts it. The function's own docblock
(`app/src/lib/mediaTypes.ts:188-200`) is correct and says WIDENED.

### N2 (nit) - `mediaTypes.ts` file header still describes two tiers

`app/src/lib/mediaTypes.ts:1-14`, specifically `:4-6`:

```
// MediaContentType{i} is attacker-controlled, so anything off this list is
// treated as an opaque download — never rendered same-origin (stored-XSS guard).
```

After this change, a type off `INLINE_MEDIA_TYPES` but on
`DECLARABLE_MEDIA_TYPES` is a TRUTHFULLY TYPED download, not an opaque one. The
sentence is still right about safety and wrong about mechanism. Same class as
N1; the new docblocks below it (`:49-58`, `:153-169`) are correct. (These are
pre-existing lines, so the em dashes in them are not an ASCII violation.)

### N3 (nit) - one added line is non-ASCII

`fake-twilio/web/src/assets/canned/index.ts:3`:

```
// public/ dir (public/canned/) — deliberately NOT imported through Vite. Vite inlines any
```

The em dash (U+2014) is pre-existing text, but the comment was REFLOWED by this
branch, so the diff records this as an added line
(`git diff 3c2962a4..8842bdfb`, hunk on that file). The repo rule is "on a
pre-existing non-ASCII file, only ADDED lines must be ASCII", and this is the
only added line in the entire branch that carries a non-ASCII byte. Rewrapping
the two lines without moving the dash, or replacing it with `-`, closes it.

### N4 (nit) - the branch's own new issue doc has anchors the branch then invalidated

`docs/issues/relay-forwards-undeliverable-media.md` (created @ce536a30) cites
`app/src/lib/mediaTypes.ts:65-74` in its frontmatter `refs:` and
`app/src/lib/mediaTypes.ts:65-69` twice in the body, both for
`TWILIO_DELIVERABLE_MMS_TYPES`. Those were correct at the base commit
(`git show 3c2962a4:app/src/lib/mediaTypes.ts` has that set at `:65-69`), but
Task 1 (@c8821708) inserted ~145 lines above it, so in the branch's own final
tree `TWILIO_DELIVERABLE_MMS_TYPES` is at `app/src/lib/mediaTypes.ts:210-214`
and lines 65-74 are now inside `DECLARABLE_MEDIA_TYPES` (`audio/mpeg` ...
`image/heic`). A reader following the ref lands on the wrong allowlist - the
one that says these types are safe to declare, in a doc arguing they are not
deliverable. This is the exact drift worklist C6 fixed for the other issue file;
the same pass should have caught this one. (`api.ts:2251` in the same refs line
drifted by one to `:2252` - immaterial.)

### N5 (nit) - spec 5.2's upload-gate pin is predicate-level only

Detailed above under Spec-wide constraints. `app/test/mediaTypes.test.ts:162-174`
pins the predicate; no test drives the presign route with `video/mp4`
(`app/test/mmsMediaRoutes.test.ts:33-37` uses `image/svg+xml`). Adjudicated in
the plan, zero live risk, recorded only so the next reader does not read the
describe title as proof the ROUTE was exercised.

---

## Deviations from spec or plan, classified

| # | Deviation | Class | Evidence |
|---|---|---|---|
| D1 | e2e fixture is a `.vcf` (`text/vcard`), not the spec's "few-KB .mp4" | adjudicated-in-plan | Plan Task 7 header ("DELIBERATE DEVIATION FROM THE SPEC, FLAG IT IN REVIEW"); restated in @dc3ed0e5's body. Same declarable tier, reviewable as source. |
| D2 | No npm script, though spec 6.6 names `backfill:media-content-types` | adjudicated-in-plan | Plan Task 6 "NO npm SCRIPT"; `RUNBOOK.md:265` documents `npx tsx ...`; grep confirms no `backfill:*` script in any package.json. |
| D3 | CLI guard requires `messagingDriver === 'twilio'`, not the plan's "twilio* fields present" | justified-by-tree (worklist C1) | `.superpowers/sdd/worklist.md:10-25`. I re-verified the underlying claim independently: `app/src/lib/config.ts:618` defaults the driver to `console` outside production even with credentials set, and `app/src/adapters/messaging.ts:1208-1212` selects on `config.messagingDriver === 'console'` (`:1211`). The plan's predicate would have passed a console-driver shell. Shipped form is at `app/scripts/backfill-media-content-types.ts:461-469`. |
| D4 | `media-serve-stored-xss.md` frontmatter `refs:` rewritten (a historical line) | justified-by-tree (worklist C6) | `.superpowers/sdd/worklist.md:68-75`; body Resolution text untouched; `:82-88` explains and lists current anchors, all of which I verified. |
| D5 | `sanitizeName` additionally strips Windows-reserved `[<>:|?*]` (spec 6.3 lists five steps, not this) | adjudicated-in-plan | The plan's Task 2 Step 3 code block contains this exact line with its rationale; shipped verbatim at `app/src/lib/mediaFilename.ts:45-48`. |
| D6 | `createInboundMailRawStore` also forwards `credentials` (plan named only `createMediaStore`) | justified-by-code, harmless | `app/src/adapters/mediaStore.ts:412-416` - both factories share `CreateMediaStoreDeps`, so NOT forwarding would silently drop a supplied credential on the second call site. No caller passes it today. |
| D7 | The stored-XSS amendment covers a FOURTH contradicted claim the plan did not name | beyond-plan improvement | `docs/issues/media-serve-stored-xss.md:71-81`; explained in @8842bdfb's body. Strictly better than the plan's three. |
| D8 | RFC 5987 `filename*` implemented (an earlier plan draft deviated from spec 6.3 and dropped it) | reverted to spec | Plan lines 704-708 record the reversal; shipped at `app/src/lib/mediaFilename.ts:80-89,162-172`. |

No unexplained deviations.

---

## Observations (not findings)

- `isDeclarableMediaType` (`dashboard/src/routes/contact/media.ts:110`) is
  exported and tested but has no component call site. That is deliberate: spec
  6.4 item 2 requires the declarable SET be mirrored, and plan Task 4 explains
  why it is not redundant with `mediaKindWord`. Flagging only so a future
  dead-export sweep does not delete it.
- The backfill counts `skippedLegacyRow` BEFORE the inbound filter
  (`app/scripts/backfill-media-content-types.ts:336-341`), so an OUTBOUND legacy
  row is counted too. The in-code comment states the reasoning ("this names an
  UNREPAIRABLE STORAGE SHAPE ... not a rejected candidate") and the plan's step-6
  ordering lists legacy first, so this matches the plan. Worth knowing when
  reading a dry-run histogram.
- Recorded gate state in `.superpowers/sdd/` (context, not my verification):
  G1 typecheck EXIT 0; G2 `npm test` EXIT 1 on one environmental
  `performanceSeed.integration` timeout with a clean-key re-run at
  `gate2-cleankey.log` showing 6049 passed / 0 failed EXIT 0; G3 smoke EXIT 0;
  G4 e2e EXIT 0, 255 passed including the new spec; G5 lint EXIT 1 with exactly
  two problems, both baseline-proven pre-existing
  (`Timeline.tsx:1229` error vs base `:1221`; `messaging.test.ts:447` warning vs
  base `:446` - both simple line shifts from this branch's own insertions).
