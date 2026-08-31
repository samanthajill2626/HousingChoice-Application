# Spec-conformance review: media content-type fidelity

Branch `feat/media-content-type-fidelity` @e3a97e77, diff range `3c2962a4...e3a97e77`
(42 files). Spec: `docs/superpowers/specs/2026-08-26-media-content-type-fidelity-design.md`.

Method: every numbered decision and section of the spec walked to the code that
delivers it. No suites run, no servers started (a suite is live in this
worktree). Every citation below is a line I read.

## Verdict

The shipped code delivers the spec. Every load-bearing item the brief singled
out is CONFORM. The deviations found are all SUPERSETS of the spec (extra
hardening, extra counters, extra guards) or presentation choices with a reason
verifiable in the repo. One item is genuinely MISSING (the npm script) and its
absence is justified by repo precedent. Nothing found weakens the security
guarantee in section 7.

## Conformance table

| Spec item | Verdict | Evidence |
|---|---|---|
| D1 non-inline served truthfully + attachment + extension; inline set unchanged | CONFORM | `app/src/lib/mediaTypes.ts:37-40` (set unchanged), `app/src/routes/api.ts:2296-2302` |
| D2 backfill rewrites S3 object types, not just rows | CONFORM | `app/scripts/backfill-media-content-types.ts:405`, `app/src/adapters/mediaStore.ts:274-290` |
| D3 relay forwarding out of scope, filed | CONFORM | `docs/issues/relay-forwards-undeliverable-media.md` (new, commit ce536a30) |
| Non-goal: no new inline types | CONFORM | `app/src/lib/mediaTypes.ts:37-40` unchanged |
| Non-goal: no change to MMS upload allowlist / send path / unit photos / recordings | CONFORM | `app/src/routes/mmsMedia.ts:78` still `isInlineMediaType`; `units.ts:516,686`, `webhooks/voice.ts:1995` untouched by the diff |
| Non-goal: EMAIL_EXTENSIONS not consolidated, duplication noted in comment | CONFORM | `app/src/lib/mediaTypes.ts:94-98` |
| Non-goal: no legacy `media_s3_keys` promotion | CONFORM | backfill counts and skips: `backfill-media-content-types.ts:454` |
| Sec 5 tier table (3 tiers, canonical CT, disposition, filename) | CONFORM | `mediaTypes.ts:143-187`; `api.ts:2296-2302` |
| Sec 5 DECLARABLE set membership (exact list) | CONFORM | `mediaTypes.ts:65-87` - all 21 types, no additions |
| Sec 5 permanent exclusions (html/xhtml/svg/xml/js) | CONFORM | absent from both sets; pinned `app/test/mediaTypes.test.ts:80-96` |
| 5.1 ONE resolver, every tier decision through it | CONFORM | `mediaTypes.ts:176-187`; only callers `api.ts:2296` and `mediaTypes.ts:208` |
| 5.1 ESSENCE matching (before first `;`, trimmed, lowercased) | CONFORM | `mediaTypes.ts:178`; test `mediaTypes.test.ts:70-78` |
| 5.1 returns the CANONICAL set member, never the caller's raw string | CONFORM | `mediaTypes.ts:186` returns `essence`, which `Set.has` proved string-equal to the allowlist member; header takes `resolved.canonical` (`api.ts:2298`) |
| 5.1 separate `isAcceptedExtension` reverse lookup, NOT conflated | CONFORM | `mediaTypes.ts:136-141,190-192`; consumed only at `mediaFilename.ts:181` |
| 5.1 amend `media-serve-stored-xss.md` for the parameter-form claim | CONFORM | `docs/issues/media-serve-stored-xss.md` amendment block (4 bullets + current anchors) |
| 5.2 `isInlineMediaType` NOT widened in set OR semantics | CONFORM | `mediaTypes.ts:43-45` unchanged; tests `mediaTypes.test.ts:162-174` |
| 5.2 outbound upload gate still refuses `video/mp4`, test naming it | CONFORM | `routes/mmsMedia.ts:78`; route-level test `app/test/mmsMediaRoutes.test.ts:38-48` |
| 5.2 `normalizeStoredMediaType` re-expressed on the resolver | CONFORM | `mediaTypes.ts:207-209` |
| 6.1 both write-side callers change behavior (mirror + inbound email) | CONFORM | `services/mediaMirror.ts:109`, `services/inboundEmail.ts:677` (both inherit the widening; inboundEmail needed no edit) |
| 6.1 both covered by tests | CONFORM | `app/test/mediaMirror.test.ts` (+2 cases), `app/test/inboundEmail.test.ts` (+2 cases) |
| 6.2 three tiers applied on the serve route | CONFORM | `api.ts:2296-2302` |
| 6.2 tier decision runs on the S3 OBJECT's contentType, not the record's | CONFORM | `api.ts:2296` `resolveMediaTier(object.contentType)`; record used only for `filename` (`api.ts:2297`); guarded by test `apiRoutes.test.ts` "refuses to render a script-capable type stored on the OBJECT" |
| 6.2 nosniff + CSP on EVERY response | CONFORM | `api.ts:2303-2304` (unconditional) |
| 6.3 extension always from our own closed sets | CONFORM | `mediaFilename.ts:177-185`; only sources are `resolved.ext` and `isAcceptedExtension` |
| 6.3 two extension sets, different sizes, not derived from each other | CONFORM | `mediaTypes.ts:99-141`; guard test `mediaTypes.test.ts:105-142` |
| 6.3 stored filename contributes a STEM only (inline/declarable discard its ext) | CONFORM | `mediaFilename.ts:181-184`; test `apiRoutes.test.ts` `invoice.exe`+`video/mp4` -> `invoice.mp4` |
| 6.3 opaque-tier accepted-extension rule (rule 2) | CONFORM | `mediaFilename.ts:181`; tests `budget.xlsx` kept, `invoice.exe` -> `.bin`, `.jpeg` accepted |
| 6.3 split at LAST dot; leading-dot-only = empty stem | CONFORM | `mediaFilename.ts:79-84` |
| 6.3 `attachment-<i>` treated as absent | CONFORM | `mediaFilename.ts:20,94`; test `mediaFilename.test.ts:53` |
| 6.3 stem sanitization verbs (remove/replace, never reject whole name) | DEVIATES (superset) | `mediaFilename.ts:49-70` - CR/LF/TAB/NUL become a SPACE rather than being removed (documented at `:44-47`), and it additionally strips `<>:|?*`, Unicode BiDi controls, and treats Windows reserved device names as unusable (`:29,90-97`). All spec-required removals are present. |
| 6.3 sanitize order (trailing dots, then cap) | CONFORM (reordered, equivalent) | trailing dot/space strip + cap + re-strip at `mediaFilename.ts:146-147`; sanitize/split order inverted vs the spec's prose and the inversion is argued at `:38-48` (it is the safer order for `../../etc/passwd`) |
| 6.3 CAP BOUNDS THE STEM, not the emitted name | CONFORM | `mediaFilename.ts:17,147` (slice applied to stem only); test `mediaFilename.test.ts:98` |
| 6.3 non-ASCII: replace with `_`, never drop | CONFORM | `mediaFilename.ts:151`; test `:131` |
| 6.3 fall back to synthesized stem when ASCII stem empty/all underscores | CONFORM | `mediaFilename.ts:90-97,160-162` |
| 6.3 `filename*=UTF-8''<pct>` with the 5 extra RFC 5987 escapes | CONFORM | `mediaFilename.ts:119-128,204-214`; test `mediaFilename.test.ts:240` |
| 6.3 1-based synthesized stem | CONFORM | `mediaFilename.ts:161`; `attachment-1.mp4` in the route test |
| 6.4 BOTH galleries branch on renderable types | CONFORM | `dashboard/.../Timeline.tsx:648`, `dashboard/.../MediaGallery.tsx:36`, both via `isInlineRenderable` |
| 6.4 dashboard mirrors all THREE things (raster set, declarable set, kind words) | CONFORM | `dashboard/.../media.ts:66-119`; drift guard `mediaTypeMirror.test.ts` compares SETS against the app's own |
| 6.4 no prefix test substituted for (2)/(3) | CONFORM | `media.ts:105-119` are map/set lookups on the essence |
| 6.4 image `alt` unchanged (no kind prefix) | CONFORM | `Timeline.tsx:660` passes `isPdf=false`, but the alt path is only reached for raster types, which have no kind word (`media.ts:78-89` excludes jpeg/png/gif/webp) |
| 6.4 PDF file link keeps "PDF attachment N" | CONFORM | `Timeline.tsx:622` |
| 6.4 DECLARABLE file link gains the kind word | CONFORM | `Timeline.tsx:623-624`; test `Timeline.test.tsx` "labels a declarable attachment with its kind" |
| 6.4 OPAQUE file link stays BARE | CONFORM | `Timeline.tsx:624` (`kind === undefined` -> bare); test "leaves an opaque attachment labelled bare" |
| 6.4 the four protected assertions unchanged | CONFORM | `Timeline.email.test.tsx` is NOT in the diff at all; `Timeline.test.tsx` diff adds only after `:557`, leaving `:552`/`:555` untouched |
| 6.5 backfill rewrites pointer rows too | CONFORM | `backfill-media-content-types.ts:583` |
| 6.6 script exists | CONFORM | `app/scripts/backfill-media-content-types.ts` |
| 6.6 npm script `backfill:media-content-types` | MISSING (justified) | no `backfill` entry in root or `app/package.json`; no other backfill in `app/scripts/` has one either, and RUNBOOK step 2 uses `npx tsx`, matching `backfill-media-pointers.ts`. Reason stated at `backfill-media-content-types.ts:81-84` and in the RUNBOOK. |
| 6.6 scan-and-report shape, `--dry-run`, `lib/config.tableName` | CONFORM | `:331,431-441,713` |
| 6.6 `assertHousingChoiceAccount` / `hcCredentials` guard | CONFORM | `:741-754`; credentials INJECTED into every client, not merely asserted |
| 6.6 candidate predicate (inbound AND octet-stream AND has mediaUrls) | CONFORM | `:459,461,480` |
| 6.6 step 1 index from the s3Key, never array position | CONFORM | `:217-221,483`; test "derives the media index from the S3 KEY, not the array position" |
| 6.6 step 2 MediaSid from `mediaUrls[index]`, miss -> skip+count | CONFORM | `:227-229,488-500` |
| 6.6 step 3 metadata-only fetch, 404 -> skip+count | CONFORM | `:351-355,384-387`; adapter 404 handling `adapters/messaging.ts:938-963` |
| 6.6 step 4 normalize; still-opaque -> skip; setContentType INSIDE the dry-run guard | CONFORM | `:390-394` and `:405` (`if (!dryRun) await mediaStore.setContentType(...)`) |
| 6.6 step 5 ONCE PER MESSAGE | CONFORM | `:539-587` (per-row loop); test "writes the row ONCE for a two-attachment message" |
| 6.6 write order S3 -> pointers -> row, predicate-clearing write LAST | CONFORM | `:405` then `:583` then `:584`; test "writes S3, then pointers, then the row" and "leaves everything repairable when the row write fails" |
| 6.6 dry-run still reads Twilio, bounded concurrency + 429 backoff, reports vendor calls | CONFORM | `:113,117,347-375,414-428,177` |
| 6.6 idempotency semantics | CONFORM | `:480` (repaired attachment no longer selected); unrepairable rows re-queried every run, counted `:146,151` |
| 6.6 reporting counters (all 11 named) | CONFORM (superset) | `:119-178` - every spec counter present, plus `skippedThrottled` and `skippedForeignAccount` |
| 6.6 row write uses the scan-time snapshot | DEVIATES (safer) | `:555-586` re-reads the row and merges staged types onto the CURRENT list BY `s3Key`. Rationale at `:31-42`: `annotateMessage` SETs the list wholesale and `jobs/mediaMirror.ts` appends for ~3 min, so the spec's blind write could delete an appended attachment. Verifiable and strictly safer; covered by three tests (`:328-380`). |
| 6.7 `MessagingAdapter.getMediaContentType` (twilio + console drivers) | CONFORM | `adapters/messaging.ts:134,938-963,1096-1099` |
| 6.7 `MediaStore.setContentType` (same-key CopyObject, REPLACE) | CONFORM | `adapters/mediaStore.ts:144-153,274-290`; test `app/test/mediaStore.setContentType.test.ts` |
| 6.7 exhaustive implementers updated (4 messaging fakes + 1 store) | CONFORM | test-helper churn in `twilioWebhookHarness.ts`, `poolNumbers/relayWarm/tourReminders/sendMessage/scheduledSendSuppression` tests |
| T5 `createMediaStore` credentials passthrough | CONFORM | `mediaStore.ts:319-334,355-359,368-395` (spread LAST, honored on both branches; also forwarded by `createInboundMailRawStore`) |
| 6.8 fake-twilio canned non-image asset + registry + pinning test + static path | CONFORM | `fake-twilio/src/engine/signer.ts:38`, `web/public/canned/contact-card.vcf`, `web/src/assets/canned/index.ts:37`, `index.test.ts:10-36` |
| 7.1 write-side gate enumeration matches reality | CONFORM | Re-derived from every `mediaStore.put` / `createPresignedPost`: `mediaMirror.ts:115`, `inboundEmail.ts:679`, `mmsMedia.ts:83`(gate `:78`), `mmsMedia.ts:143`, `emailMedia.ts:82`(gates `:65,108`), `units.ts:543`(gate `:516`), `units.ts:766`(gate `:686`), `voice.ts:1995`, `seed/media.ts:128`, plus the NEW backfill `setContentType`. Exactly the spec's list; the branch adds exactly one writer, and `setContentType` has no other caller. |
| 7.2 declarable tier always `attachment` | CONFORM | `api.ts:2301` (`inline` only when `tier === 'inline'`) |
| 7.3 headers unchanged; `inline` disposition new | CONFORM | `api.ts:2301-2304`; existing assertions flipped absent -> `^inline; filename="` at `apiRoutes.test.ts:648,661` and `mmsMedia.test.ts:229` exactly as the spec authorised |
| 7.4 read side keeps reading the S3 OBJECT's type | CONFORM | `api.ts:2296` |
| 7.5 backfill writes only through the runtime allowlist | CONFORM | `backfill-media-content-types.ts:390` |
| 8.5 legacy + historical-email rows counted, not repaired | CONFORM | `:454,463`; extension rule 2 preserves `budget.xlsx` (`mediaFilename.ts:181`) |
| 8.6 outbound email attachments change tier, covered by a test | CONFORM | `apiRoutes.test.ts` "serves an OUTBOUND email attachment on the declarable tier" |
| Sec 9 unit coverage (resolver / normalize / regression guards / route per tier / filename unit) | CONFORM | `app/test/mediaTypes.test.ts` (all 6 spec bullets), `app/test/mediaFilename.test.ts` (26 cases incl. every named case), `app/test/apiRoutes.test.ts` (+8 cases) |
| Sec 9 backfill test list | CONFORM | `app/test/backfillMediaContentTypes.test.ts` - all named cases present (`:127,152,162,170,177,186,195,219,225,235,242,247`) |
| Sec 9 dashboard tests | CONFORM | `Timeline.test.tsx` (+3), `MediaGallery.test.tsx` (new), `media.test.ts`, `mediaTypeMirror.test.ts` |
| Sec 9 e2e: inbound `.mp4` into a RELAY thread | DEVIATES (reasoned) | `e2e/tests/dashboard-next/inbound-media-type.spec.ts` uses a `.vcf` into a 1:1 thread. Reason stated in the spec header at `:1-25`: the mirror is shared, and a relay thread would additionally drive the known-broken fan-out (D3). All three required response assertions are made (`text/vcard`, `attachment`, `.vcf`), plus a negative `<img>` assertion and a body check. |
| Sec 10 RUNBOOK entry, hard deploy-first ordering, per-env sequence, operator requirements | CONFORM (superset) | `RUNBOOK.md` new section: 6 numbered steps, IAM/`s3:PutObject`, all seven Twilio vars, `TWILIO_API_BASE_URL`/`MEDIA_S3_ENDPOINT` refusals, versioning cost. Adds a dev-only relay-leg observation step tied to `relay-forwards-undeliverable-media.md`. |
| Sec 11 reversibility / risks reflected in ops docs | CONFORM | RUNBOOK "Every repair leaves a spare copy behind" |
| Sec 12 relay issue FILED | CONFORM | `docs/issues/relay-forwards-undeliverable-media.md` |
| Sec 12 amend `media-serve-stored-xss.md` | CONFORM | see 5.1 row |
| Sec 12 `unitMediaServe.ts:65` noted, not fixed | CONFORM | not in the diff |
| Sec 12 drop the unused `normalizeStoredMediaType` import in `api.ts` | CONFORM | `api.ts:23-24` now imports `isTwilioDeliverableType, resolveMediaTier` only |

## Additions beyond the spec (all with in-repo justification)

1. `mediaFilename.ts` hardening: Windows reserved device names (`:29,90-97`),
   `<>:|?*` removal (`:57`), BiDi-control removal (`:66`), lone-high-surrogate
   handling at the cap (`:108-111`), and a `try/catch` around
   `encodeURIComponent` (`:119-128`). The BiDi one has a filed issue naming the
   residual dashboard-side half: `docs/issues/timeline-filename-bidi-display.md`.
2. Backfill: `skippedForeignAccount` + end-of-run wrong-credentials backstop
   (`:501-524,606-629`), `skippedThrottled` (`:151`), `messagingMisconfiguration`
   pre-scan guard (`:689-703`), PARTIAL report on abort (`:309-318`), and the
   re-read-then-merge row write (`:555-586`). Each closes a green-exit or
   data-loss path the spec did not enumerate.
3. `docs/issues/declarable-office-doc-types-double-click.md` - a new, filed,
   low-severity acceptance that `.csv`/`.docx`/`.xlsx` from an untrusted sender
   now land double-clickable. This is a real consequence of D1 + 6.3 that the
   spec did not name; filing it rather than silently shipping it is the right
   handling, and it does not contradict any spec decision.
4. `mediaTypeMirror.test.ts` - a cross-workspace drift guard the spec asked for
   only as a comment ("source of truth"). Turns the claim into a constraint.

## Items worth a human's attention

None is blocking. Listed most serious first.

1. **No npm script for the backfill (6.6, MISSING).** The spec named
   `backfill:media-content-types`; the branch ships `npx tsx` invocation only.
   Justified: no backfill in `app/scripts/` has an npm script, and the RUNBOOK
   entry documents the `npx tsx` form consistently with the media-pointer
   backfill above it. Cost: none beyond the spec text being stale.
2. **e2e proves the declarable tier with a vCard in a 1:1, not an `.mp4` in a
   relay thread (Sec 9, DEVIATES).** The shared mirror makes this equivalent for
   the tier decision, and the spec's own D3 argues against driving relay
   fan-out. What is NOT covered end to end is the relay path's own rendering;
   the RUNBOOK's dev-only step 6 converts that into a human observation instead.
3. **`isDeclarableMediaType` (`dashboard/.../media.ts:115`) is exported but has
   no production caller** - only `media.test.ts` uses it. Spec 6.4 asked the
   dashboard to mirror the declarable set; the kind-word map already serves
   that role, so the predicate is a thin alias. Harmless, mildly dead.
4. **`MediaGallery.tsx:56` still tests `m.contentType === 'application/pdf'`
   exactly** for its glyph, so a parameterized `application/pdf; x` gets the
   generic clip glyph while the rest of the branch is essence-matched. Purely
   cosmetic, one glyph, no security or naming consequence.
5. **The backfill's row write carries no optimistic-concurrency condition.** The
   re-read-then-merge shrinks the mirror-append race window but does not close
   it, which the code (`:31-42`) and the RUNBOOK both state plainly. Accepted
   deliberately; a quiet window remains the ops mitigation.
