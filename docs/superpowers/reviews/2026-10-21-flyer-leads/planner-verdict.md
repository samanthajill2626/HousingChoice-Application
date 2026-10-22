# Planner verdict - feat/flyer-leads (2026-10-22)

**MERGE-READY, UNMERGED (human gate).** Branch `feat/flyer-leads`
(W:\tmp\flyer-leads), tip 3d916404, 0 commits behind main @0f6f29f9, so it
merges as a fast-forward. No infra, migration, backfill, dependency or env
change. Two decisions for Cameron below; neither blocks the merge.

Scope: Sam's 2026-10-21 flyer trim, tracker #13 "Flyers and leads", and the
subzone match ignoring case and spacing. Spec rev 6 (approved 2026-10-21,
plus section 7 amendments), plan v3 (26 tasks), built AUTO 2026-10-21 20:20
to 2026-10-22 04:20 UTC with 0 recoveries.

## Gates (run by the planner, bare, from the worktree)

Final run on 33e392aa (code identical to the build's gated 098eaa11; logs
`.superpowers/sdd/gates/planner-*`):

| Gate | Result |
|---|---|
| `npm run typecheck` | EXIT:0 |
| `npm test` | EXIT:0 - app 526 files, 11029 passed + 1 skipped; dashboard 265 / 5391; e2e workspace 22 / 508; fake-twilio 34 / 275; fake-twilio/web 13 / 111; no `[dynamoAdmin]` line |
| `npm run smoke` | EXIT:0 - "smoke-dist: OK - 1730 import specifier(s) across 301 emitted file(s) resolve under plain Node." |
| `npm run e2e` | EXIT:0 - "371 passed (17.9m)" |
| eslint on the branch's files | EXIT:1 - 3 errors (`react-hooks/set-state-in-effect`: Timeline.tsx x1, FlyerPage.tsx x2), all present at the merge base 0f6f29f9 (linted from `git show`); 0 new |

The planner's first run on c860883b (before FW-P1) was green the same way
(e2e 371 passed, 17.3m). After 33e392aa only two dashboard COMMENTS changed
(dbcb88fc) plus records: dashboard `tsc --noEmit` EXIT:0, eslint on the two
files EXIT:0, `listingFormat.test.ts` 43 passed. The build's own four
batteries were green too; no e2e flake in any of the six full runs.

## Review

- Build: six research readers (1 blocker fixed before the build), three
  code-review rounds, self-QA (one HIGH layout bug fixed: a long pin covered
  Send), four fix waves. Records under `code-review/`, `self-qa.md`.
- Planner review (`planner-review/`): two independent opus reviewers -
  spec-conformance (71 items: 67 conform, 3 partial, 1 harmless deviation,
  0 missing) and PLAN-BLIND adversarial (2 MEDIUM, 4 LOW). Fix wave FW-P1:
  the property Activity card labels a nameless contact by phone; the sign-up
  audit write is best-effort on both paths. Round P2 (same reviewers,
  re-review charge): nothing at MEDIUM or above; terminal. Every ruling is
  in `planner-review/adjudications.md`.

## Spec items

| Spec | What | Status |
|---|---|---|
| D1 | Public flyer payload drops rent min/max, lease terms, accessibility, all of Pets, all of Deposit | DELIVERED (`toUnitFlyer`; projection tests) |
| D2 | Those fields tagged Staff only on property and landlord forms; the "Tenants see this" note only on On flyer fields | DELIVERED (tag tables, mirror drift test, TaggedField gate) |
| D3 | Flyer: address heading linked to Maps, "Same-day tours available", bolder authority line, "Home for rent" fallback, sign-up copy and thank-you | DELIVERED (strings match character for character; screenshots at 1280 / 375 / 320) |
| D4 | One phone lookup; deleted holder -> audit only; existing contact never changed | DELIVERED |
| D5 | Welcome text for new contacts only | DELIVERED |
| D6 | Pin in the thread, unread mark, 24-hour check per contact per property, audit fields | DELIVERED (one residual: overlapping same-second sign-ups, filed) |
| D7 | Flyer sign-up puts the property on the sent list (tenant / unknown), never over a current decline; O1 closed | DELIVERED (one narrow race left, filed and in spec section 7) |
| D8 | `signed_up` outcome: "Signed up from the flyer <date>", chip, actions, never waits | DELIVERED (see decision 2) |
| D9 | Subzone match ignores case and spacing; SE1 != SE11 | DELIVERED |
| D10 | Whitespace trimmed before store and compare | DELIVERED (app-wide body trim; flyer trims area on display) |

## Conversation checklist (from the whole conversation, 2026-10-21)

| Raised | Request | Status | Evidence |
|---|---|---|---|
| 15:05 (Sam, relayed) | Rent min/max, lease terms, accessibility, pets, deposit off the flyer, but kept ("information I will want") | DELIVERED | Off the payload; still on the forms (Staff only) and the property page (`ListingDetail.tsx:976-984`) |
| 15:30 | Do all of #13 here | DELIVERED | D3, D6-D8 |
| 15:30 | Lease terms stay in the system, staff only (market rent later) | DELIVERED | Form tag Staff only; property page row |
| 15:30 | Accessibility off; application fee stays | DELIVERED | Flyer shows "No application fee" |
| 15:30 | Leave the `[Rent]` merge field alone | DELIVERED, with a catch | Merge field files untouched; but `[Rent]` sits in the Matching DEFAULT text - decision 1 |
| 15:30 | No subzone dropdown; auto-fill is its own feature | DELIVERED | Not in this branch; prompt handed over 15:53 |
| 15:44 | Heading (a): the address, linked to the map | DELIVERED | Screenshot `qa-flyer-1280.png` |
| 15:44 | (2) "Same-day tours available" on every flyer | DELIVERED | Same |
| 15:44 | (3) Sign-up wording; Sam checks it after the build | DELIVERED; Sam's check OWED | Copy matches; relaying it to Sam is Cameron's |
| 15:44 | (4) Existing flyer contact: no welcome, note, unread, property on sent list; new contacts get the property too | DELIVERED | Self-QA (inbox row unread live, no text), e2e `flyer-leads.spec.ts` |
| 15:44 | /join existing contact: same, minus the property | DELIVERED | Self-QA (landlord on /join: pin, unread, contact byte-identical) |
| 15:44 | Subzone ignores case and spacing; no fuzzy codes | DELIVERED | `similarUnits.ts` subzoneKey; tests incl. SE1 vs SE11 |
| 15:44 | Trim whitespace everywhere; save it as a preference | DELIVERED | Memory `trim-input-whitespace`; the app trims every JSON body (AR16) |
| 15:44 | Fuzzy matching of similar-properties free text waits for the new matching engine | NOT IN SCOPE (as agreed) | - |
| 15:52 | Subzone session as a top-level prompt, not a card | DELIVERED | 15:53 |
| 16:58 | O1: close it | DELIVERED | Decline writers stamp `shares_op`; a narrower race inside the decline click itself remains (filed) |
| 16:58 | The typed name in the note; never rename the contact | DELIVERED | Pin label; no write to an existing contact |
| 16:58 | One note and one bump per contact PER PROPERTY per 24 hours, but still track repeat sign-ups | DELIVERED (partly at the edge) | Per-property check (/join and dead flyers share one slot); every sign-up audited, every flyer sign-up updates the sent list. Two sign-ups landing in the same moment can both add a note (filed) |
| 16:58 | New sign-ups show unread in the inbox too | DELIVERED | Self-QA: new contact gets the welcome, then the pin and the unread mark |
| 17:05 | Mark tracker #11 and #12 Done | DELIVERED (17:11, verified) | - |
| intent NOs | No stored field deleted or backfilled; no subzone dropdown; `[Rent]` field unchanged | DELIVERED | No scripts or migrations in the diff |

## Decisions for Cameron (built per the approved spec meanwhile)

1. **Rent and the "Staff only" legend (OR-26).** Rent min / max are now
   tagged "Staff only - never leaves the dashboard.", but the Matching blast's
   DEFAULT text pre-fills "is available for [Rent]/mo", so rent is texted
   unless staff delete it. On 2026-10-21 the planner described `[Rent]` as
   chosen "message by message"; it is in fact in the default. Options:
   - (a) take `[Rent]` out of the default text only - the merge field stays,
     staff add it when they want it ("we can still add it if we need to");
     RECOMMENDED, it matches Sam's reason for pulling rent;
   - (b) keep the default, and add a note under the two Rent fields ("Not on
     the flyer - Matching texts include it through [Rent]");
   - (c) leave as built.
2. **"Sent <date>" on an outranked flyer row (OR-26b).** A row whose latest
   entry is a flyer sign-up reads "Signed up from the flyer <date>" only
   while it is `signed_up`. Once the person texts in, or staff mark it, it
   reads "Sent <sign-up date>" on the contact's list and on Follow up, for a
   property that may never have been texted. Options: (a) keep and file it
   (RECOMMENDED - wording on an uncommon path, and the follow-up staff take
   is the right one); (b) put the latest entry's kind on the wire and key
   the words on it (a server + dashboard change, then the gates again).

Either change made now means a small fix wave and one more gate run before
the merge.

## Accepted consequences (none blocks the merge; issues filed)

- Two same-property sign-ups landing in the same moment can each add a pin
  and an unread bump (`public-signup-abuse-hardening.md`).
- A sign-up landing inside a staff "Not interested" click's own write can
  leave that decline superseded (`flyer-signup-decline-click-race.md`).
- An existing contact with no consent on file keeps none; an opted-out
  contact who signs up again stays opted out while the thank-you says
  "We'll text you" (`consent-capture-ignores-signup-web-form.md`).
- A new sign-up whose request fails after the contact is created is never
  welcomed on the retry (spec D5's consequence; a reviewer contests it and
  proposes creating the thread first - recorded in the consent issue).
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

```bash
git -C "W:\AI Projects\Housing Choice\HC Application" merge --ff-only feat/flyer-leads
```
