# Planner verdict - feat/flyer-leads (2026-10-22, updated after FW-P3)

**MERGE-READY, UNMERGED (human gate).** Branch `feat/flyer-leads`
(W:\tmp\flyer-leads). Gated code tip d3bb2617; every later commit is
records and docs only. 0 commits behind main @0f6f29f9, so it merges as a
fast-forward. No infra, migration, backfill, dependency or env change.
Every decision for Cameron is resolved (below).

Scope: Sam's 2026-10-21 flyer trim, tracker #13 "Flyers and leads", and the
subzone match ignoring case and spacing. Spec rev 6 (approved 2026-10-21,
plus section 7 amendments), plan v3 (26 tasks), built AUTO 2026-10-21 20:20
to 2026-10-22 04:20 UTC with 0 recoveries; fix waves FW-P1 to FW-P3 after
the planner's review.

This file first said MERGE-READY @d717d160 (06:15 UTC). Cameron's answers
to its two decisions and to the opted-out question became FW-P2 and FW-P3.

## Gates (run by the planner, bare, from the worktree)

Final run on d3bb2617 (17:57-18:18 UTC; logs
`.superpowers/sdd/gates/planner-*`):

| Gate | Result |
|---|---|
| `npm run typecheck` | EXIT:0 |
| `npm test` | EXIT:0 - app 526 files, 11046 passed + 1 skipped; dashboard 265 / 5391; e2e workspace 22 / 508; fake-twilio 34 / 275; fake-twilio/web 13 / 111; no `[dynamoAdmin]` line |
| `npm run smoke` | EXIT:0 - "smoke-dist: OK - 1731 import specifier(s) across 301 emitted file(s) resolve under plain Node." |
| `npm run e2e` | EXIT:0 - "371 passed (17.8m)" |
| eslint on the branch's files | EXIT:1 - 3 errors (`react-hooks/set-state-in-effect`: Timeline.tsx:1625, FlyerPage.tsx:212 and :230), all present at the merge base 0f6f29f9; 0 new |

The planner's earlier runs (c860883b, 33e392aa, 8ce2d404) were green the
same way, and so were the build's six batteries; no e2e flake in any full
run. After d3bb2617 only records and docs changed (spec, GLOSSARY,
docs/issues); `npm run issues` EXIT:0.

## Review

- Build: six research readers (1 blocker fixed before the build), three
  code-review rounds, self-QA (one HIGH layout bug fixed: a long pin covered
  Send), four fix waves. Records under `code-review/`, `self-qa.md`.
- Planner review (`planner-review/`), two independent opus reviewers kept
  across rounds - spec-conformance and PLAN-BLIND adversarial:
  - P1: 2 MEDIUM, 4 LOW -> FW-P1 (Activity card label; best-effort audit).
  - P2: nothing at MEDIUM or above; terminal. Then Cameron's verdict
    decisions -> FW-P2 (legend; opted-out pin note).
  - P3: nothing at MEDIUM or above; the note's "text START" was wrong for a
    staff Do-Not-Contact -> Cameron's pick (a) -> FW-P3 (note by cause).
  - P4: 1 MEDIUM (conformance), 3 LOW (adversarial), all one finding: three
    writers of a real opt-out flag only the contact, so they get the
    Do-Not-Contact note. Cameron kept the words and filed it (below).
    Terminal; no code change.
  - Every ruling is in `planner-review/adjudications.md`.

## Spec items

| Spec | What | Status |
|---|---|---|
| D1 | Public flyer payload drops rent min/max, lease terms, accessibility, all of Pets, all of Deposit | DELIVERED (`toUnitFlyer`; projection tests) |
| D2 | Those fields tagged Staff only on property and landlord forms; the "Tenants see this" note only on On flyer fields; legend "Staff only - not on the public flyer." / "Staff only - never on a property flyer." | DELIVERED (tag tables, mirror drift test, TaggedField gate; legend per FW-P2) |
| D3 | Flyer: address heading linked to Maps, "Same-day tours available", bolder authority line, "Home for rent" fallback, sign-up copy and thank-you | DELIVERED (strings match character for character; screenshots at 1280 / 375 / 320) |
| D4 | One phone lookup; deleted holder -> audit only; existing contact never changed | DELIVERED |
| D5 | Welcome text for new contacts only | DELIVERED |
| D6 | Pin in the thread, unread mark, 24-hour check per contact per property, audit fields; opted-out note by cause (D6.2) | DELIVERED (residuals filed: overlapping same-second sign-ups; the Do-Not-Contact note's three opt-out causes) |
| D7 | Flyer sign-up puts the property on the sent list (tenant / unknown), never over a current decline; O1 closed | DELIVERED (one narrow race left, filed and in spec section 7) |
| D8 | `signed_up` outcome: "Signed up from the flyer <date>", chip, actions, never waits | DELIVERED ("Sent" words on an outranked row kept and filed) |
| D9 | Subzone match ignores case and spacing; SE1 != SE11 | DELIVERED |
| D10 | Whitespace trimmed before store and compare | DELIVERED (app-wide body trim; flyer trims area on display) |

## Conversation checklist (from the whole conversation)

| Raised | Request | Status | Evidence |
|---|---|---|---|
| 10-21 15:05 (Sam, relayed) | Rent min/max, lease terms, accessibility, pets, deposit off the flyer, but kept ("information I will want") | DELIVERED | Off the payload; still on the forms (Staff only) and the property page |
| 10-21 15:30 | Do all of #13 here | DELIVERED | D3, D6-D8 |
| 10-21 15:30 | Lease terms stay in the system, staff only (market rent later) | DELIVERED | Form tag Staff only; property page row |
| 10-21 15:30 | Accessibility off; application fee stays | DELIVERED | Flyer shows "No application fee" |
| 10-21 15:30 | Leave the `[Rent]` merge field alone | DELIVERED | Untouched; it stays in the Matching default too (Cameron 10-22 12:46) |
| 10-21 15:30 | No subzone dropdown; auto-fill is its own feature | DELIVERED | Not in this branch; prompt handed over 15:53 |
| 10-21 15:44 | Heading (a): the address, linked to the map | DELIVERED | Screenshot `qa-flyer-1280.png` |
| 10-21 15:44 | (2) "Same-day tours available" on every flyer | DELIVERED | Same |
| 10-21 15:44 | (3) Sign-up wording; Sam checks it after the build | DELIVERED; Sam's check OWED | Copy matches; relaying it to Sam is Cameron's |
| 10-21 15:44 | (4) Existing flyer contact: no welcome, note, unread, property on sent list; new contacts get the property too | DELIVERED | Self-QA, e2e `flyer-leads.spec.ts` |
| 10-21 15:44 | /join existing contact: same, minus the property | DELIVERED | Self-QA (landlord on /join: pin, unread, contact byte-identical) |
| 10-21 15:44 | Subzone ignores case and spacing; no fuzzy codes | DELIVERED | `similarUnits.ts` subzoneKey; tests incl. SE1 vs SE11 |
| 10-21 15:44 | Trim whitespace everywhere; save it as a preference | DELIVERED | Memory `trim-input-whitespace`; the app trims every JSON body (AR16) |
| 10-21 15:44 | Fuzzy matching of similar-properties free text waits for the new matching engine | NOT IN SCOPE (as agreed) | - |
| 10-21 15:52 | Subzone session as a top-level prompt, not a card | DELIVERED | 15:53 |
| 10-21 16:58 | O1: close it | DELIVERED | Decline writers stamp `shares_op`; a narrower race inside the decline click itself remains (filed) |
| 10-21 16:58 | The typed name in the note; never rename the contact | DELIVERED | Pin label; no write to an existing contact |
| 10-21 16:58 | One note and one bump per contact PER PROPERTY per 24 hours, but still track repeat sign-ups | DELIVERED (partly at the edge) | Two sign-ups landing in the same moment can both add a note (filed) |
| 10-21 16:58 | New sign-ups show unread in the inbox too | DELIVERED | Self-QA |
| 10-21 17:05 | Mark tracker #11 and #12 Done | DELIVERED (17:11, verified) | - |
| 10-22 12:46 | Rent in blast texts is fine; drop "never leaves the dashboard" from the legend | DELIVERED (FW-P2) | `FlyerTag.tsx` LEGEND; form tests and e2e pin the words |
| 10-22 12:46 | "Sent" words: leave as is and file | DELIVERED | `docs/issues/signed-up-row-sent-words.md` |
| 10-22 12:46 | An opted-out contact who signs up should opt back in somehow; is a START needed? | ANSWERED | Yes: Twilio lifts its block only on START, YES or UNSTOP, so the form cannot re-subscribe a number |
| 10-22 13:18 | Option B: a staff note on the pin; no thank-you line | DELIVERED (FW-P2) | Public page unchanged |
| 10-22 16:51 | (a) the Do-Not-Contact note | DELIVERED (FW-P3) | `public.ts` SIGNUP_OPT_OUT_NOTE; 11 new tests |
| 10-22 (P4) | B: keep the words, file the writer problem | DELIVERED | `docs/issues/opt-out-writers-skip-number-thread.md` |
| intent NOs | No stored field deleted or backfilled; no subzone dropdown; `[Rent]` field unchanged | DELIVERED | No scripts or migrations in the diff |

## Decisions (all resolved)

1. **Rent and the "Staff only" legend (OR-26).** Cameron 2026-10-22: rent
   stays in blast texts; the legend drops "never leaves the dashboard".
   Built in FW-P2.
2. **"Sent <date>" on an outranked flyer row (OR-26b).** Kept as built and
   filed (`signed-up-row-sent-words.md`).
3. **An opted-out contact who signs up again.** Cameron chose a staff note
   on the pin and no public line (FW-P2), worded by cause (FW-P3):
   - a 1:1 thread of the number carries the opt-out: " (this number opted
     out of texts - they need to text START from it to get texts again)";
   - only the contact's flag: " (marked Do-Not-Contact - texts stay off
     unless staff choose Allow SMS)".
4. **The Do-Not-Contact note's other causes (P4).** A 21610 receipt and an
   imported STOP also flag only the contact, so a real opt-out gets the
   Do-Not-Contact note. Cameron kept the words and filed the writer fix
   (`opt-out-writers-skip-number-thread.md`, severity med).

## Accepted consequences (none blocks the merge; issues filed)

- Two same-property sign-ups landing in the same moment can each add a pin
  and an unread bump (`public-signup-abuse-hardening.md`).
- A sign-up landing inside a staff "Not interested" click's own write can
  leave that decline superseded (`flyer-signup-decline-click-race.md`).
- An existing contact with no consent on file keeps none; an opted-out
  contact who signs up again stays opted out, and only staff see why, on
  the pin (`consent-capture-ignores-signup-web-form.md`).
- A real opt-out recorded by a 21610 receipt or the importer reads as a
  staff Do-Not-Contact on the pin; Allow SMS there is the wrong remedy, and
  for an imported STOP it lifts a legal one. The composer's older "Clear
  the opt-out" copy has the same gap
  (`opt-out-writers-skip-number-thread.md`).
- A new sign-up whose request fails after the contact is created is never
  welcomed on the retry (spec D5's consequence; recorded in the consent
  issue with the thread-first idea).
- Junk sign-ups with made-up phones now each leave an unread thread and can
  crowd Today's 100-thread unread block (filed with the abuse hardening).
- Sign-ups raise no push notification; a thread a sign-up creates has a
  blank inbox preview; Today lists a sign-up under Unreplied.

## Owed after the merge

- Nothing operational. Reload open dashboard tabs after the deploy.
- If this merges before the #11 + #12 deploy, both ship together and
  tenants never see the pets / deposit flyer rows.
- Sam reviews the sign-up copy (Cameron relays).
- Cleanup of `W:\tmp\flyer-leads` on Cameron's go.

## Merge command

First confirm main has not moved: `git -C "W:\AI Projects\Housing Choice\HC Application" rev-list --count feat/flyer-leads..main` must print 0.

```bash
git -C "W:\AI Projects\Housing Choice\HC Application" merge --ff-only feat/flyer-leads
```
