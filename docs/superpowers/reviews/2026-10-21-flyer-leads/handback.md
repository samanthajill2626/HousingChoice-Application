# Handback - feat/flyer-leads (build orchestrator, AUTO)

## Update 2026-10-22 (2) - fix wave FW-P2 (Cameron's verdict decisions)

**MERGE-READY @ef2c2dd8 on feat/flyer-leads (W:\tmp\flyer-leads), 0 behind
main @0f6f29f9, UNMERGED (human gate).** Still NO infra or post-merge ops.
This supersedes 098eaa11 and 692c44a4 below; the gated commit includes the
planner's own commits since FW-P1 (33e392aa spec, dbcb88fc dashboard
comments, 3d916404 / d717d160 / 5e06423f records).

FW-P2 ran items 1-4 of `planner-review/adjudications.md` "FW-P2" and nothing
else (no second main sync; no review round of my own - your reviewers
re-review this diff). One fresh opus child; report
`planner-review/FW-P2-report.md`; I read the whole code diff.

| # | Item | Commit | Evidence |
|---|---|---|---|
| 1 | FlyerTag LEGEND: property "Staff only - not on the public flyer.", landlord "Staff only - never on a property flyer."; every pin of the old text updated (no "never leaves the dashboard" remains outside docs/superpowers/ and run state) | f53eacda | RED FlyerTag / ListingEditForm / UnitCreateForm 4 failed / 178 (the old line rendered), GREEN 182, EXIT:0; e2e property-requirements + flyer-leads 6 passed, EXIT:0 |
| 2 | Opted-out pin note: `isOptedOut(conversation.sms_opt_out, contact.sms_opt_out)` (no new read) -> all three pin forms end " (opted out of texts - they need to text START to get texts again)", a new contact on a flagged thread included; nothing else changes | 1ed6af53 | RED publicSignupLeads 5 failed / 58 (no note), GREEN publicSignupLeads + publicIntake 123, EXIT:0 |
| 3 | GLOSSARY pin entry + selectors.md pin row name the suffix; spec section 7 gets the two bullets (exact text) | 337fb87e | ASCII |
| 4 | New `docs/issues/signed-up-row-sent-words.md` (OR-26b, bug, low - names the roster row, the property Sent to card and Follow up); the consent issue's opted-out paragraph records the decision | 3bae6272 | `npm run issues` EXIT:0 |

Child-reported, verified: `optedOut` is computed just before the pin (same
inputs as "after the thread step"; the pin is its only user). FW-P2 shifted
`public.ts` lines, so four other issue files cite slightly stale lines
(deleted-contact, decline-click-race, abuse-hardening, welcome-cap) - outside
items 1-4, left as is; the report carries the old-to-new line map.

**Gates on ef2c2dd8 (battery 5, bare, logs `.superpowers/sdd/gates/*-5.*`):**

| Gate | Result |
|---|---|
| 1 `npm run typecheck` | EXIT:0 (0 `error TS`) |
| 2 `npm test` (no AWS_* exported) | EXIT:0 - app `Test Files 526 passed (526)`, `Tests 11035 passed \| 1 skipped (11036)`; dashboard `265`, `5391 passed`; e2e workspace `22`, `508 passed`; fake-twilio `34`, `275 passed`; fake-twilio/web `13`, `111 passed`; no `[dynamoAdmin]` line |
| 3 `npm run smoke` | EXIT:0 - "smoke-dist: OK - 1731 import specifier(s) across 301 emitted file(s) resolve under plain Node." |
| 4 `timeout 2700 npm run e2e` | EXIT:0 - "371 passed (18.4m)", no failed / flaky / skipped; TIME_WAIT 25 before |
| 5 `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` | EXIT:1 - 72 files, 3 errors, all baseline-matched at the merge base 0f6f29f9 (Timeline.tsx x1, FlyerPage.tsx x2, `react-hooks/set-state-in-effect`); 0 ours |

Branch now: 97 non-merge commits; code, tests and product docs (excluding
docs/superpowers records) 83 files, +6104 / -720. No stack is running; the
battery's leftover `session.pid` (1828, dead) was cleared with
`npm run e2e:stop`.

---

## Update 2026-10-22 - fix wave FW-P1 (planner review P1)

**MERGE-READY @098eaa11 on feat/flyer-leads (W:\tmp\flyer-leads), 0 behind
main @0f6f29f9, UNMERGED (human gate).** Still NO infra or post-merge ops.
This supersedes the gated commit 692c44a4 named below; everything after
098eaa11 is mission records.

FW-P1 ran the six items of `planner-review/adjudications.md` "FW-P1" and
nothing else (OR-26 / OR-26b untouched, no second main sync, no review round
of my own - the planner's reviewers re-review this diff). One fresh opus
child; report `planner-review/FW-P1-report.md`; I read the whole code diff.

| # | Item | Commit | Evidence |
|---|---|---|---|
| 1 | A-L2 FIX: the property Activity card's `contactName` uses the Sent to rule (`recipientLabelOf`: name, else formatted phone) | 6b632aef | RED `unitsApiActivity.test.ts` 1 failed / 19 passed (no contactName; expected "(404) 555-0142"), GREEN 20 + contactsBatchReads 10 + listingSendsApi 29, EXIT:0 |
| 2 | C-F1 FIX: both `housing_fair_signup` audit appends are best-effort (`{ marker, step: 'audit', err }` + SIGNUP_STEP_FAILED, answer `{ ok: true }`); thread step left unguarded; step comments updated | 0363dde2 | RED `publicSignupLeads.test.ts` 2 failed / 55 ("expected 500 to be 200", main and deleted path); the PII pin in publicIntake.test.ts RED against the old file, then GREEN 57 + 60, EXIT:0 |
| 3 | A-I2 DOC: `FlyerPage.tsx` heading comment names the suffix " - open in Google Maps" | 21b47d65 | comment only; FlyerPage.test.tsx 62 passed |
| 4 | A-M2 FILE: Today crowd-out by made-up phones (+ the unpaginated-reads note) in `public-signup-abuse-hardening.md` | 4a7796fb | `npm run issues` EXIT:0 |
| 5 | A-L1 + A-L3 FILE: the opted-out re-sign-up and the never-welcomed retry (with the candidate rule's double-text hazard) in `consent-capture-ignores-signup-web-form.md` | 4a7796fb | as above |
| 6 | C-F2 DOC: spec section 7 residual bullet for the decline-click race (the fix list's exact text) | 21b47d65 | ASCII |

Small deviations (child-reported, verified): `recipientLabelOf` now takes
`ContactDisplayItem` (what `getDisplaysByIds` returns; `RecipientDisplay`
callers unchanged); a one-paragraph comment at the thread step says it is
NOT best-effort and points at the consent issue.

**Gates on 098eaa11 (battery 4, bare, logs `.superpowers/sdd/gates/*-4.*`):**

| Gate | Result |
|---|---|
| 1 `npm run typecheck` | EXIT:0 (0 `error TS`) |
| 2 `npm test` (no AWS_* exported) | EXIT:0 - app `Test Files 526 passed (526)`, `Tests 11029 passed \| 1 skipped (11030)`; dashboard `265`, `5391 passed`; e2e workspace `22`, `508 passed`; fake-twilio `34`, `275 passed`; fake-twilio/web `13`, `111 passed`; no `[dynamoAdmin]` line |
| 3 `npm run smoke` | EXIT:0 - "smoke-dist: OK - 1730 import specifier(s) across 301 emitted file(s) resolve under plain Node." |
| 4 `timeout 2700 npm run e2e` | EXIT:0 - "371 passed (17.8m)", no failed / flaky / skipped; TIME_WAIT 25 before |
| 5 `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` | EXIT:1 - 70 files, 3 errors, all baseline-matched at the merge base 0f6f29f9 (Timeline.tsx x1, FlyerPage.tsx x2, `react-hooks/set-state-in-effect`); 0 ours |

Branch now: 86 non-merge commits; code, tests and product docs (excluding
docs/superpowers records) 80 files, +5864 / -711.

For the planner (not changed - outside the six items; your call):
- Spec line ~624 still says "The property Activity card is unchanged", which
  item 1 makes stale.
- Spec D6.4 ("every step after the contact is resolved or created is
  best-effort") now covers the audit, but the thread get-or-create step stays
  unguarded by the C-F1 ruling, and no residual bullet says so.
- Items 1 and 2 moved `units.ts` / `public.ts` lines by up to +8 / +29, so
  some older line citations in the issue files point a little early.
- The leftover `e2e/.artifacts/session.pid` from your gate run (pid 17520,
  dead) was cleared with `npm run e2e:stop` before battery 4 (the
  `e2e-session-stale-pid-reuse-killtree` hazard); battery 4's own leftover
  (48684, dead) was cleared the same way. No stack is running.

---

## Original handback (2026-10-22 00:20)

**MERGE-READY @692c44a4 on feat/flyer-leads (W:\tmp\flyer-leads), 0 behind
main @0f6f29f9, UNMERGED (human gate).** NO infra, migration, backfill,
dependency or env change; nothing is owed after the merge. If it merges
before the #11 + #12 deploy, both ship in one release (tenants never see the
pets / deposit flyer rows #12 added). Sam reviews the sign-up copy after the
build (spec section 6).

The gated commit 692c44a4 is the last commit that changes code or tests;
everything after it is mission records (this file and the self-QA addendum).

## Decide before the merge (Cameron) - built per the approved spec meanwhile

1. **OR-26 - the rent legend.** D2 tags Rent min / Rent max "Staff only"
   under the property forms' legend "Staff only - never leaves the
   dashboard." (`dashboard/src/routes/listing/FlyerTag.tsx:36`), but the
   Matching blast DEFAULT text still says "... is available for [Rent]/mo"
   (`dashboard/src/routes/broadcasts/resolveTemplate.ts:30-31`, pre-filled at
   `BroadcastComposer.tsx:447`). Two reviewers flagged it. Options: (a) reword
   the property legend line, e.g. "Staff only - not on the public flyer."
   (pins: FlyerTag.test.tsx, ListingEditForm.test.tsx, UnitCreateForm.test.tsx,
   e2e property-requirements.spec.ts); (b) drop `[Rent]` from the blast
   default only (the merge field stays available). Shipped: neither (the
   GLOSSARY says rent still reaches tenants through `[Rent]`).
2. **OR-26b - "Sent <date>" on a flyer-only pair that a decline, tour or
   reply outranks.** Spec D8 gives "Signed up from the flyer <date>" to the
   `signed_up` outcome only, so once the person replies (or staff mark them,
   or a tour lands) the roster row (`Card.tsx`) and the Follow up row
   (`FollowUpView.tsx:118-119`) read "Sent <sign-up date>" for a property the
   app may never have texted. Alternative: a wire flag from
   `latestCountedShareKey` that both renderers key their words on.

## Work map

| Item | Status |
|---|---|
| S1 - projection drops the ten keys; tags Staff only (D1, D2); subzone ignores case and spacing (D9) | SHIPPED (d44fe975, 533e4c9d; + OR-5 address.ts comment) |
| S2 - tag mirror, TaggedField note gate, form props, PublicFlyer, FlyerPage layout and sign-up copy (D2, D3) | SHIPPED (2d59cb55 .. 7faf3e88; + OR-6 the second verbatim copy of the app cases, OR-7 types.ts comments, OR-8/9) |
| S3 - shareLedgerKeys leaf, applyFlyerShareEntry + current-decline refusal, O1 decline writers stamp shares_op, signed_up through five callers, AR13 phone label | SHIPPED (da4c9ade .. 2c3bb0e7) |
| S4 - signed_up type + consistent hasEventSince, router deps + harness, the handler (existing / deleted / new, welcome for new only, pin, 24h per-source check, unread mark, flyer entry), audit fields | SHIPPED (614eab0f, 2f7fd187, ad6997ac, c26d6f76, 67e210bc; + OR-14 the unread mark skips a non-1:1 thread, OR-15, OR-16) |
| S5 - green signed_up pin, roster words / chip / action gate, groupSendRows, outcome switches | SHIPPED (2a1cf758, 88e674f9, fb1e4aad) |
| S6 - e2e repairs, new flyer-leads spec (mutation RED), selectors.md, GLOSSARY, issue note, ONE main sync, five gates | SHIPPED (93b02a36, 70a71482, d75a567a, 74e664cf; sync 3ee55f93 and the gates by the orchestrator, OR-25) |

Deviations (all recorded, none changes an approved decision):
- OR-14: the unread mark is applied to a 1:1 thread only - a sign-up typed
  with a relay group's POOL number resolved to the relay group and would have
  reopened / bumped it (R5 F1, RED-proven).
- QA-1 + R2 F1: milestone pins now WRAP inside the comms pane instead of
  widening it (the pane used to spill under the right column and cover Send
  at 1024-1440 px) - the whole label, the typed name included, stays visible.
  Applies to every milestone pin (pre-existing CSS defect the new pin made
  routine).
- R2 N1: Follow up labels a nameless contact by its formatted phone (AR13's
  rule) - unknown contacts reach Follow up since this branch.
- R2 N4: the flyer's area line wraps a long token.

## Gates on the final commit 692c44a4 (battery 3, bare, logs `.superpowers/sdd/gates/*-3.*`)

| Gate | Command | Result |
|---|---|---|
| 1 | `npm run typecheck` | EXIT:0 (0 `error TS`) |
| 2 | `npm test` (no AWS_* exported) | EXIT:0 - app `Test Files 526 passed (526)`, `Tests 11024 passed \| 1 skipped (11025)`; dashboard `265 passed (265)`, `5391 passed`; e2e workspace `22`, `508 passed`; fake-twilio `34`, `275 passed`; fake-twilio/web `13`, `111 passed`; no `[dynamoAdmin]` line |
| 3 | `npm run smoke` | EXIT:0 - "smoke-dist: OK - 1730 import specifier(s) across 301 emitted file(s) resolve under plain Node." |
| 4 | `timeout 2700 npm run e2e` | EXIT:0 - "371 passed (17.2m)", no failed / flaky / skipped line; TIME_WAIT 21 before the run |
| 5 | `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` | EXIT:1 - 69 files, 3 errors, ALL baseline-matched at the merge base (JSON-normalized comparison): `dashboard/src/routes/contact/Timeline.tsx` x1 and `dashboard/src/routes/public/FlyerPage.tsx` x2, `react-hooks/set-state-in-effect`; 0 ours |

Earlier batteries: battery 1 on 3ee55f93 (after the sync) and battery 2 on
fb3dfae0 (after FW2) were green the same way (e2e 371 passed, 15.8m / 16.5m).
No flake in any of the three full e2e runs.

## Commits and size

37 code / test / doc commits plus records, the one main merge 3ee55f93, and
78 non-merge commits in all on the branch (planner design records included).
Code, tests and product docs (excluding docs/superpowers records): 79 files,
+5606 / -703. Feature commits: see `git log --oneline --no-merges main..HEAD`.

## Review

- Phase 1: six read-only delta readers; worklist OR-1..OR-26
  (`build-research/worklist.md`) - 1 BLOCKER (the dashboard's second verbatim
  copy of the app tag cases, OR-6), 3 MAJOR (relay pool number, rent legend,
  Today) handled before the build.
- Round 1 (`code-review/R1-conformance.md`: 139/144 CONFORMS, 5 PARTIAL LOW;
  `R1-adversarial.md`, plan-blind: 4 MEDIUM, 5 LOW) -> FW1 (comments, docs,
  two issue files).
- Self-QA run 1 -> QA-1 HIGH (Send covered) -> FW-QA (a150db6b).
- Round 2 (`R2-review.md`, fresh): 2 MEDIUM (N1, F1) -> FW2 (pins wrap,
  Follow up label, area wrap, issue fixes, consent issue).
- Round 3 (`R3-review.md`, fresh, focused on FW2): 0 MEDIUM+, 4 LOW, 1 INFO
  -> FW3 (pin test hardening with three mutants RED, `.pill` overflow
  containment, em-based radius, issue text), verified by hand.
- Every ruling with its reason: `code-review/adjudications.md`.

Accepted residuals named for your eye (none blocks the merge):
- The 24-hour pin / bump cap is read-then-write: two OVERLAPPING same-source
  sign-ups each pin and bump (proven), so the spec's stated "at most one pin a
  day per property" bound (D6.1) holds for sequential requests only; a burst
  is bounded by the per-IP limiter. Filed: `docs/issues/public-signup-abuse-hardening.md`.
- A sign-up landing inside the outcome route's own window between its
  "Not interested" timestamp and its write leaves that decline superseded
  (the click answers Signed up; a second click sticks). Filed:
  `docs/issues/flyer-signup-decline-click-race.md`.
- An existing contact with no recorded consent keeps none (spec D4), so a
  staff reply hits the consent prompt and blasts skip them; the prompt has
  no web-form option. Filed as an improvement:
  `docs/issues/consent-capture-ignores-signup-web-form.md`.
- Spec-stated residuals confirmed in code: the flyer veto ignores tours (D7);
  a flyer-created row stores `via: 'broadcast'` (D7, nothing reads it); a
  pre-branch or entry-less "Property text failed" pin reads "Property sent"
  once a flyer entry counts the pair (D7).
- The unread touch can step `last_activity_at` back by under a second against
  a concurrent write (cosmetic); a sign-up inside the byPhone index lag after
  a soft-delete or restore takes the other path; sign-ups raise no push
  notification (the inbound path does).
- A sign-up shows on Today under Unreplied ("<name> - Unreplied"; an unknown
  contact under Needs you now), and a thread the sign-up creates has no
  message, so its inbox row is bold with a blank preview (documented in the
  GLOSSARY).

## Self-QA (orchestrator, hermetic lane, Playwright MCP + API) - `self-qa.md`

Measured, not eyeballed: the flyer at 1280 / 375 / 320 (heading link and
sr-only suffix, city line smaller, area line, highlight, the 18px/700
authority line, exact detail-row order, no removed row or value, no overflow);
/join unchanged; an existing tenant through the real visitor form while the
inbox was open (row unread LIVE in 782 ms, no reload, no text), Today, the
green pin and its link, the roster row words / chip / actions; a declined pair
stays Not interested; a same-property repeat inside 24 hours adds no pin or
bump; an unknown contact (labelled by its formatted phone on Sent to); a new
contact (welcome, then pin and unread); an existing landlord on /join (pin,
blank-preview unread row, contact byte-identical); the Edit property tags;
similar properties matching `se11` with `SE 11`; app log free of errors and
PII. QA-1 found and fixed (above). Screenshots:
`W:\tmp\flyer-leads\.playwright-mcp\qa-*.png`, `fw2-*.png`, `fw3-*.png`
(gitignored run state).

## Issues filed by this build

- `docs/issues/public-signup-abuse-hardening.md` (security, med)
- `docs/issues/flyer-signup-decline-click-race.md` (bug, low)
- `docs/issues/consent-capture-ignores-signup-web-form.md` (improvement, low)
- `docs/issues/e2e-session-stale-pid-reuse-killtree.md` (bug, med) - a
  pre-existing e2e harness hazard seen during FW3: the launcher's self-heal
  `killTree`s whatever process holds a stale `session.pid` (Windows reuses
  pids). Until it is fixed, run `npm run e2e:stop` before an e2e run in a
  worktree whose last run left a `session.pid`.

## Records

`docs/superpowers/reviews/2026-10-21-flyer-leads/`: build-research/
(R1-R6 findings, worklist), slices/ (S1-S6 reports), code-review/ (R1-R3,
adjudications, FW1 / FWQA / FW2 / FW3 reports), self-qa.md, S6-mutation-check.md,
this file.
