# Wave 2 - media-content-type-fidelity

Base for this wave: `b31281a1`. Two commits, both on
`feat/media-content-type-fidelity` in `W:\tmp\media-content-type-fidelity`.

| # | Commit | Covers |
|---|--------|--------|
| 1 | `272930c0` | items 1-5 (M1 semantics, MEDIA_S3_ENDPOINT, adapter 404, partial report, run-target log) |
| 2 | `e3a97e77` | items 6-11 (NF1, NF2, NF3/NF4 RUNBOOK, P3, new issue) |

All eleven adjudicated items shipped. Nothing was interpreted away; the two
places where I extended slightly beyond the letter are flagged **BEYOND THE
LETTER** below.

---

## 1. M1 semantics refinement - foreign-account skip + end-of-run backstop

**Counter.** `skippedForeignAccount`
(`app/scripts/backfill-media-content-types.ts:156-163`), with the adjudicated
semantics comment: the stored media URL belongs to a different Twilio account
than the configured one (e.g. a Quo-era import), counted and left alone, no
vendor call.

**The skip.** `:501-524` replaces the throw. A mismatch increments the counter,
records `firstForeignAccountSid` for the backstop message, and `continue`s. The
comment names the reshaped purpose: dev and prod share ONE Twilio account, so a
mismatch can never mean "wrong environment"; it means a row imported from
another platform, which is permanent, which is exactly why a first-mismatch
abort would wedge every future run.

**The backstop.** `:606-629`, after the paging loop, inside the wrapper's try so
it also produces a PARTIAL report. Fires only when
`expectedAccountSid !== undefined && nativeAccountCandidates === 0 &&
result.skippedForeignAccount > 0` - i.e. at least one candidate carried a
parseable account SID and EVERY one of them mismatched. A mixed population
cannot reach it. `nativeAccountCandidates` and `firstForeignAccountSid` are
declared at `scanAndRepair` scope (`:311-317`), so they accumulate ACROSS pages
rather than resetting per page. Message says WRONG CREDENTIALS (not WRONG
ENVIRONMENT, which is now false) and names both SIDs.

**Documented cost, stated in the comment:** a candidate whose URL carries no
`/Accounts/<x>/` segment at all is neither native nor foreign, so such rows may
already have been repaired when the backstop fires. Harmless - those repairs are
exactly what a re-run would redo.

**Tests** (`app/test/backfillMediaContentTypes.test.ts`, describe renamed to
`foreign accounts vs wrong credentials`):
- `:274` `SKIPS a foreign-account row and still repairs the native ones
  alongside it` - two rows, one foreign (`ACquo`), one native. Asserts
  `skippedForeignAccount === 1`, `getMediaContentType` called exactly ONCE and
  with the NATIVE row's SIDs (so the foreign attachment cost no vendor call),
  `written === 1`, and `annotateMessage` called once for `c1` only. No throw.
- `:306` `REJECTS when every account-bearing URL names another account` -
  asserts the message names both SIDs and matches `/WRONG CREDENTIALS/`.
- `:321` `runs normally when the media URL names the configured account` - kept,
  plus a new `skippedForeignAccount === 0` assertion.

Docblocks updated to match: the module header's wrong-account paragraph
(`:57-76`), the `expectedAccountSid` opt (`:191-198`), and `main`'s call-site
comment (`:783-786`).

## 2. MEDIA_S3_ENDPOINT refusal

`messagingMisconfiguration` gains a third refusal (`:699-701`), same shape as the
`TWILIO_API_BASE_URL` one and using the same `!== undefined` test - correct for
the identical reason: `config.ts:1309` maps `''` to `undefined`, so the repo's
"every var uncommented" env convention cannot false-refuse.

Rationale in the function docblock (`:668-680`): `buildS3Client`
(`adapters/mediaStore.ts:374-397`) honours the endpoint whenever `NODE_ENV` is
not `production` - which an operator `tsx` shell is not - and spreads the
explicit credentials LAST, so the CopyObject would repair a LOCAL MinIO object
while the pointer and row writes hit the real DynamoDB, clearing the re-scan
predicate with the real object untouched. Silent and permanent, because the row
no longer says octet-stream.

**Test:** `:406` `REFUSES when MEDIA_S3_ENDPOINT is set`, placed directly beside
the `apiBaseUrl` case.

## 3. Adapter 404 string-tolerance

`app/src/adapters/messaging.ts:959-961`:

```ts
const e = err as { status?: number; code?: number | string };
const code = e.code === undefined ? undefined : Number(e.code);
if (e.status === 404 || code === 20404) return undefined;
```

Deliberately the SAME expression the branch's own `fetchMediaType` already uses
for 20429, so the two siblings now read identically. The comment cites
`groupConversations.ts:322-329`.

**Test:** `app/test/messaging.test.ts:1069` `treats a STRING error code as the
same 404, with no status to fall back on` - throws
`{ status: undefined, code: '20404' }` and expects `undefined`, not a rethrow.
Non-vacuous: reverting to `e.code === 20404` makes it reject.

## 4. Partial report on failure

Chose the function-level split over a CLI catch, because `main`'s catch cannot
see counters that live inside the function. `backfillMediaContentTypes` is now a
thin wrapper (`:290-321`) that owns the `BackfillResult`, calls the extracted
`scanAndRepair(opts, result)` (`:323-...`), and on a throw logs
`{ ...result }` at ERROR labelled `PARTIAL result: the run ABORTED...` before
rethrowing. **Zero re-indentation** - the loop body kept its exact indentation by
moving to a sibling function rather than into a nested block, so the diff shows
only the real change.

Covers every propagated error: the S3 permission failure the RUNBOOK's IAM
bullet is about, a vendor error out of `drain`, a scan failure, and the new
backstop. Per-row write failures are still caught per row and unaffected. The
log is counts and IDs only, matching the success report's PII rule; the error
itself is left to `main().catch`, which already logs it.

Observed working in the suite run: the all-foreign test emits the PARTIAL line
with `skippedForeignAccount: 1`.

## 5. Run-target log line

`:763-782`. Logs `dryRun`, `table` (resolved), `mediaBucket`, `appEnv`, and
`twilioAccountSidPrefix: config.twilioAccountSid?.slice(0, 6)`. Message:
`starting. CHECK THIS LINE names the environment you intend.` IDs and counts
only; no full SID, no secret. `config.appEnv` is a required `string` on
`AppConfig` (`config.ts:39`, derived by `resolveAppEnv` from `TABLE_PREFIX`), so
no optional handling is needed.

## 6. NF1 - the e2e can now tell a file link from a broken `<img>`

`e2e/tests/dashboard-next/inbound-media-type.spec.ts:80`
`await expect(link.locator('img')).toHaveCount(0);`, immediately after the
visibility assertion, with a comment explaining that both `AttachmentGallery`
branches render an `<a>` with the same accessible name and that widening
`INLINE_RENDERABLE_TYPES` to include `text/vcard` reddens only this line.

## 7. NF2 - the e2e now proves a real round trip

Same file, `:106` `expect(await res.text()).toContain('BEGIN:VCARD');` after the
two header assertions. Verified the fixture actually starts with that string
(`fake-twilio/web/public/canned/contact-card.vcf:1`). Comment records the
mechanism: the fake's SPA fallback does not reserve `/canned`, and the mirror
types from `MediaContentType0` rather than the fetched response, so a missing
asset would pass both header assertions on HTML bytes.

## 8. NF3 - the operator env list is now complete and honest

**Config anchors verified myself against the live tree**, not inherited:
`config.ts:623-641` lists SIX required keys (the five previously documented plus
`TWILIO_CONVERSATIONS_SERVICE_SID` at `:640`, required since the default
Conversations service was deleted 2026-08-15), throwing at `:642-647`; and
`config.ts:658-666` requires `TWILIO_EVENTS_WEBHOOK_SECRET` unless
`isMockTwilio`, whose sole trigger is `twilioApiBaseUrl` being set - which this
script now refuses, so the secret is unconditionally mandatory here.

- `HOW_TO_FIX` (`:709-710`) now names all six keys plus the events secret, plus
  `MEDIA_BUCKET`/`TABLE_PREFIX`, and states that both `TWILIO_API_BASE_URL` and
  `MEDIA_S3_ENDPOINT` must be UNSET. A preceding comment explains why the shell
  needs keys the script never reads: `loadConfig()` validates the WHOLE app
  config.
- `RUNBOOK.md:279` carries the same list with the same explanation.
- The docblock anchor that stopped one line short (`:648-655`) now cites
  `config.ts:623-647` and `:658-666` and names both extra requirements.

## 9. NF4 - the false account claim corrected and reframed

`RUNBOOK.md:281` replaces "Dev and prod are different accounts" with: one Twilio
account serves both (they differ by Messaging Service), so the credentials
cannot identify the environment - `TABLE_PREFIX` and `MEDIA_BUCKET` are the only
things that can. It then states what the account check DOES do, in its new
two-outcome form.

`RUNBOOK.md:270`, inside step 2, is the operator instruction: the script has no
confirmation pause, so read `table`/`mediaBucket`/`appEnv` off the **dry run's**
start-of-run line and confirm all three name the intended environment before
running the apply.

**BEYOND THE LETTER (two small additions):** step 2 also states that the dry run
exercises NEITHER write half, and the profile bullet (`:283`) tells the operator
to read the new PARTIAL line on an IAM failure. Both are one clause each and both
exist because items 4 and 5 changed what the operator sees; leaving the RUNBOOK
silent about a new log line is the defect this wave is about.

## 10. P3 - the relay issue now names both outcomes

`docs/issues/relay-forwards-undeliverable-media.md`:

- The closing section is rewritten as an explicit TWO-outcome list. Outcome 1
  ("the leg still fails") now says NOT to ground it in
  `TWILIO_DELIVERABLE_MMS_TYPES` and explains why: it is our self-imposed
  send-side rule for media we ORIGINATE, `relayFanOut` never consults it, and it
  is narrower than what Twilio accepts. Outcome 2 is the one the rewrite missed:
  the leg SUCCEEDS, relayed inbound media starts reaching other group members,
  and that collides with the privacy parking in
  `docs/issues/mms-forward-received-media.md` - read, and now cross-referenced
  in the body and added to `refs:`.
- **BEYOND THE LETTER:** I also softened the Problem section's "Only
  jpeg/png/gif can actually be carried as MMS", which was the same wrong
  grounding stated as fact. Leaving it would have made the issue contradict its
  own new closing section.

`RUNBOOK.md:274` adds step 6, the deploy observation: DEV ONLY, before the prod
sequence, send a non-image MMS into a relay group and read the forwarded leg's
status and error code; if it SUCCEEDS, stop and raise it before the prod deploy.

## 11. New issue - timeline-filename-bidi-display

`docs/issues/timeline-filename-bidi-display.md`, copied from `_TEMPLATE.md`.
`type: security`, `severity: low`, `status: open`, `area: dashboard`,
`created: 2026-08-26`, ASCII-only. States the three-hop path
(`inboundEmail.ts:681-686` persists verbatim -> `types.ts:2116` surfaces raw ->
`Timeline.tsx:610-625` renders as link text), the spoof walk, that it is
PRE-EXISTING and not widened by this branch (inbound MMS attachments carry no
filename - `messagesRepo.ts:808-814`), that wave 1 hardened the served
`Content-Disposition` so the two surfaces now DISAGREE, and that the display
label is the remaining surface. Two suggested fixes.

`npm run issues` regenerated: **258 open** (257 before, +1 mine). The one
reported warning is `perf-selfqa-route-contract-drift.md: unknown severity
"medium"` - a pre-existing unrelated file, not this issue. `INDEX.md` confirmed
gitignored (`.gitignore:62`) and NOT committed.

---

## Verification

All bare, none piped.

| Command | Result |
|---|---|
| `cd app && npx vitest run test/backfillMediaContentTypes.test.ts test/messaging.test.ts` | 2 files, **75 passed**, exit 0 (26 + 49) |
| `npm run typecheck` (all five workspaces) | exit 0 |
| `npx eslint` on all 5 touched `.ts` files | **0 errors**, 1 warning |
| ASCII scan of every added diff line + the new file | clean (node scan; `grep -P` is unusable in this locale) |

The single eslint warning is `app/test/messaging.test.ts:447 Unused
eslint-disable directive` - **PRE-EXISTING**, proven by baseline comparison
(stashed my change, re-ran on the same path at `b31281a1`, identical single
warning at the identical line). My edit to that file is at `:1069`.

Not run, per instruction: `npm run e2e` (the orchestrator runs the full
battery). Also not run this wave: `npm test` in full, `npm run smoke`.

**Blast radius for the gates I did not run:**
- `smoke`: the only `app/src` change is a two-line logic edit inside an existing
  method in `adapters/messaging.ts`. No new import edge anywhere, and
  `app/scripts` is outside the `dist` build by design.
- `npm test` full: the behavioural source change is `getMediaContentType`'s 404
  compare (strictly WIDER - nothing that returned `undefined` before now
  throws), plus the backfill script, whose only test file I ran. Every existing
  consumer of `getMediaContentType` is the backfill.
- `e2e`: two ADDED assertions in one spec; no app behavior changed on that path.

## Surprises

None that blocked. Three worth the next reader's attention:

1. **The partial report needed a function split, not a try/catch.** Wrapping the
   paging loop in place would have re-indented ~130 lines and buried the real
   change. Extracting `scanAndRepair(opts, result)` as a sibling function keeps
   the body's indentation byte-identical, so the diff shows only the semantics.
   The public signature is unchanged.
2. **`messagingMisconfiguration` is now slightly misnamed** - it guards the S3
   redirect too. I did not rename it: it is the exported, unit-tested, pre-scan
   refusal and the adjudication said "same shape as the TWILIO_API_BASE_URL
   refusal". The docblock now says it covers both redirect seams.
3. **The backstop fires AFTER the page loop, so it can follow writes** for rows
   whose media URL has no `/Accounts/<x>/` segment. This is inherent to
   not-aborting-on-first-mismatch and is documented at the throw. Those repairs
   are idempotent and re-runnable, so the residual is cosmetic.
