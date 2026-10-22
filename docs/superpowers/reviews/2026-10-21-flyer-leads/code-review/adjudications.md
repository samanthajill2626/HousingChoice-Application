# Code review adjudications - feat/flyer-leads

Orchestrator rulings on the build's code review. Reviews run against the
branch after the ONE main sync (merge 3ee55f93, main @0f6f29f9).

## Round 1 (2026-10-21, HEAD 3ee55f93)

Two parallel opus reviewers, dispatched while gate battery 1 ran (both were
read-only until its end marker existed; their throwaway probes ran after it
and were deleted):
- `R1-conformance.md` - spec-conformance (spec, plan, worklist, slice
  reports): 144 rows, 139 CONFORMS, 5 PARTIAL (LOW), 0 MISSING; findings
  6 LOW + 4 INFO.
- `R1-adversarial.md` - PLAN-BLIND by mandate (diff package + repo + the
  standing charter only; it opened nothing under docs/superpowers/):
  4 MEDIUM, 5 LOW, 8 PLAUSIBLE / INFO. Four proofs run against the harness.

Gate battery 1 on 3ee55f93 (logs under `.superpowers/sdd/gates/`): typecheck
EXIT:0; npm test EXIT:0 (Test Files app 526, dashboard 264, e2e 22,
fake-twilio 34, fake-twilio/web 13 - all passed; no `[dynamoAdmin]` line);
smoke EXIT:0; e2e EXIT:0 (371 passed, 15.8m); eslint EXIT:1 with 3 errors,
all baseline-matched at the merge base (Timeline.tsx x1, FlyerPage.tsx x2,
`react-hooks/set-state-in-effect`), 0 ours.

Rulings key: FIX = fix wave 1 (FW1) changes it; DOC = FW1 states it in a
comment / doc; FILE = a docs/issues entry (FW1 writes it); ACCEPT = a residual
the approved spec already accepts (cited); CAMERON = a decision for Cameron
before the merge, built as the spec says meanwhile.

| # | Finding | Sev (reviewer) | Ruling | Reason |
|---|---|---|---|---|
| A1 / C1 | The 24-hour pin / bump cap is read-then-write (`public.ts:612-647`): two OVERLAPPING same-source sign-ups each pin and each bump (adversarial proof A, conformance probe; sequential requests give one). | MEDIUM (A) / LOW (C) | DOC + FILE | No text, no data loss: the cost is a second pin and `unread_count` 2 on a thread that is unread anyway. A burst is bounded by the per-IP limiter on /public (`app.ts:188`). An exact fix needs a conditional claim per contact and source - a new mechanism, not a one-line change, and the spec's D6.1 names `hasEventSince` as the check. FW1 corrects every comment that says "at most once" (`public.ts` header and D6 docstrings, `activityEventsRepo.ts` AR12 docstring) and the GLOSSARY sentence (requests that do not overlap; a burst is bounded per IP), and files the hardening issue with proof A as its reproduction recipe. |
| A2 | The public sign-up is now an unauthenticated write path into existing records: (a) attacker-typed text in a staff-visible pin, name only trimmed (control / bidi characters kept), (b) bump / create threads, (c) rewrite the pair's sent state on every request, (d) multiplied by known unitIds and by A1. | MEDIUM (A) | ACCEPT + FILE | (a), (b) and the per-property multiplication are spec D6.1's stated, accepted residuals ("someone who knows a phone number can plant at most one pin a day per shareable property ... a typed name of their choosing, capped at 100 characters per part, and the endpoint's per-IP rate limit applies"); (c) is D6.1 "The cap governs the pin and the bump only. The flyer's sent-list entry (D7) is written on every sign-up it applies to" - what a real sign-up does, an impostor can do; it never clears a current decline. Nothing new reaches a tenant's phone. Hardening ideas (per-phone limit, stripping control and bidi characters from typed names, quoting the name in the pin) go in the same issue as A1; the pin copy is Cameron's accepted wording, so the build does not change it. |
| A3 | An existing contact with no recorded consent keeps none, so a staff reply hits the consent gate and blasts skip them, while the flyer says "We'll text you". | MEDIUM (A) | ACCEPT | Spec D4, decided and explained to Cameron at the gate (intent.md, gate A): no write to an existing contact, consent included; the A2P design pairs a consent stamp with the welcome, which D5 withholds; staff record consent through ConsentCaptureModal (its missing web-form choice is D4's stated residual). Named in the handback as a known consequence with the reviewer's follow-up idea (preselect / offer web_form in the modal). |
| A4 / C7 | The property legend "Staff only - never leaves the dashboard." is false for Rent, which the Matching blast default still texts as `[Rent]/mo`. | MEDIUM (A) / INFO (C) | CAMERON (OR-26) | Already the worklist's decide-before-merge item. Built per spec (D2 re-tags rent; the `[Rent]` field is out of scope); the GLOSSARY says rent still goes out through `[Rent]`. Options in the handback: reword the property legend line, or drop `[Rent]` from the blast default only. Changing staff copy Cameron has not seen is his call. |
| A5 / C2 | A sign-up landing between the outcome route's `at` stamp (`units.ts:1596`) and its `setDeclined` (`:1690`) leaves the new decline superseded at birth; the route answers `signed_up` (adversarial proof B). | LOW (A, C) | FILE | OR-13 residual (i). The window is the route's own read-to-write latency; the click visibly answers `signed_up` and a second click sticks. The real fix (condition `setDeclined` on the token the route read, re-stamp on loss) changes a merged route's race semantics against broadcasts too - its own change, not a fix-wave edit. Filed with proof B as the reproduction recipe. |
| A6 | The flyer veto ignores tours, so a decline a later tour superseded still refuses the entry; if the tour is later canceled the pair reads No reply yet. | LOW (A) | ACCEPT + DOC | Spec D7: "'Current' is exactly `effectiveDecline(row, undefined)` ... Tours are not consulted ... Residual: if that tour is later canceled, the pair reads by its old sentAt ('No reply yet') rather than signed_up." FW1 states it in the `applyFlyerShareEntry` docstring. |
| A7 | A flyer-created row stores `via: 'broadcast'`. | LOW (A) | ACCEPT + DOC | Spec D7: "`via` is untouched: it stays the first-write value, which nothing renders"; plan watch item "do not change putShareMemory". FW1 adds one docstring sentence. |
| A8 | A flyer entry makes a failed "Property sent" pin with no share id (or no entry) read "Property sent". | LOW (A) | ACCEPT | Spec D7 residual, pinned by `contactTimeline.test.ts`. (R2-s3 NOTE 5: only pre-branch pins or pins whose share has no entry read the pair.) |
| A9 | Comments that overclaim: "at most once" (A1); "the SAME contact" (Today attributes a thread by its participants link); `ledgerEntryCounts` "counts exactly these entries" (differs on a non-string countedAt). | LOW (A) | FIX (comment-only) | All three corrected in FW1. |
| C3 | `shareLedger.ts:6-7` header still says every lost write is healed by the repair. | LOW (C) | FIX (comment) | The flyer entry is not repaired. |
| C4 | `selectors.md` sign-up pin row omits the line2 form of the address (`formatAddress` joins line1 and line2 with a space). | LOW (C) | FIX (doc) | |
| C5 | The deleted-contact issue update names the wrong sentence of its "Net" paragraph; both touched issue files cite stale `public.ts` lines (pre-existing). | LOW (C) | FIX (doc) | Cheap; the files were touched on this branch. |
| C6 | `FlyerPage.tsx:164-166` comment and `FlyerPage.test.tsx:257` test title still say the edit form saves untrimmed values (false since AR16). | LOW (C) | FIX (comment + test title) | |
| C8 / OR-13 | The broadcasts.ts caller test cannot tell `signed_up` from `no_reply` (that caller reads only `not_interested`). | INFO | ACCEPT | Recorded in the S3 report; four callers carry a real `signed_up` pin. |
| C9 | The e2e existing-tenant case posts through the API, not the visitor form. | INFO | ACCEPT | Declared (OR-24, the live-inbox proof); the form submit is covered by the new-contact case and public-pages. |
| C10 | The OR-14 relay skip logs through the step-failed line at WARN. | INFO | ACCEPT | As OR-14 dictated (`reason: 'group_thread'` distinguishes it). |
| P1 | Pin floods vs the roster removal scan's 250-event cap. | PLAUSIBLE | FILE (same issue as A1) | Needs many IPs or unitIds; bounded per IP. |
| P2 | Exact-millisecond countedAt ties can pick different entries at write and read time. | PLAUSIBLE | ACCEPT | OR-13 residual (ii); cosmetic, the spec's whole-second class. |
| P3 | A re-submit inside the byPhone GSI lag after a NEW-contact create makes a duplicate contact and a second welcome. | PLAUSIBLE | ACCEPT (pre-existing) | Unchanged by this branch (the same lookup existed before). |
| P4 | Response latency distinguishes a deleted holder from a live one. | PLAUSIBLE | FILE (same issue as A1) | Existing-vs-new was already distinguishable (the welcome send); the deleted-vs-live split is new and low-value. |
| P5-P8 | Clock step-back of last_activity_at; phoneMarker enumerable (pre-existing); no push for a sign-up; Follow up Undo label (pinned, AR9 #1). | INFO | ACCEPT | P7 (no push) is mentioned in the handback as an observation. |

Fix wave 1 is comment, doc and issue work only - no behavior change, so no
gate can move except through a typo. Its diff gets the round 2 re-review
(fresh reviewer: what round 1 missed first, then the wave, then these
rulings).
