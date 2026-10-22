# Planner review adjudications - feat/flyer-leads

The planner's independent review of the build's handback (MERGE-READY
@692c44a4, records to 546be196), run on c860883b.

## Round P1 (2026-10-22)

Inputs:
- My own five-gate run on c860883b (bare, one log per gate under
  `.superpowers/sdd/gates/planner-*`): typecheck EXIT:0; npm test EXIT:0
  (app 526 files, 11024 passed + 1 skipped; dashboard 265 / 5391; e2e
  workspace 22 / 508; fake-twilio 34 / 275; fake-twilio/web 13 / 111; no
  `[dynamoAdmin]` line); smoke EXIT:0 (1730 specifiers, 301 files); e2e
  EXIT:0 (371 passed, 17.3m); eslint EXIT:1 with 3 errors, all present at
  the merge base 0f6f29f9 (Timeline.tsx x1, FlyerPage.tsx x2,
  `react-hooks/set-state-in-effect`), 0 new.
- `P1-conformance.md` (opus, spec + work map, blind to the plan and every
  review record): 71 items, 67 CONFORMS, 3 PARTIAL, 1 DEVIATES (harmless),
  0 MISSING; 2 LOW, 6 INFO.
- `P1-adversarial.md` (opus, PLAN-BLIND: diff + repo + charter): 2 MEDIUM,
  4 LOW, 4 INFO.

Rulings key: FIX = the fix wave changes code (RED first); DOC = a comment or
doc change; FILE = a docs/issues entry; ACCEPT = a residual the approved
spec or Cameron already accepts (cited); CAMERON = a decision for Cameron
before the merge.

| # | Finding | Sev | Ruling | Reason |
|---|---|---|---|---|
| A-M1 | Rent min / max read "Staff only - never leaves the dashboard." while the Matching blast default pre-fills `[Rent]/mo`. | MEDIUM | CAMERON (= OR-26) | Already the build's decide-before-merge item; a third reviewer found it independently. Cameron said on 2026-10-21 "leave the rent merge field alone. We can still add it if we need to" - the planner had described `[Rent]` as chosen "message by message", but it is in the blast DEFAULT text, so rent goes out unless staff delete it. Options at the verdict: (a) reword the legend line, (b) take `[Rent]` out of the default only. |
| A-M2 | Made-up-phone sign-ups now each leave an UNREAD open thread; Today keeps the newest 100 unread 1:1 threads (`today.ts:182`, `:752`), so one IP at 5/min crowds real unreplied threads off Today in ~20 min. | MEDIUM | FILE | New contacts are marked unread by Cameron's explicit call (2026-10-21 gate: "We definitely want that to happen"), so the mark stays. The same request already creates a contact and sends a paid welcome text to any number (an open abuse issue), which is the worse cost; the crowd-out is a new consequence of the same hole and belongs with its fix (the new-contacts ceiling the issue proposes, applied to the bump). Recorded in `public-signup-abuse-hardening.md` with the rate math and the PLAUSIBLE unbounded-read note. |
| A-L1 | A request that 500s after creating the contact but before the welcome is never welcomed on the retry (main re-welcomed on the flag). | LOW | ACCEPT + FILE | Spec D5, accepted at Cameron's gate: existing contacts never get the welcome, and a new contact whose welcome fails is not re-welcomed. A crash before the send is the same class. The candidate rule (welcome an existing contact with `consent_method: 'web_form'` and no `housing_fair_welcomed`) would also re-text a contact whose flag write failed after a successful welcome - a double text - so it is Cameron's call, not a fix-wave change. Filed with the consent / welcome pairing issue. |
| A-L2 | The property Activity card labels a nameless contact by its raw contactId (`units.ts:2268`), though the Sent to card and Follow up now use the formatted phone. | LOW | FIX | Unknown contacts reach the Sent to card only since this branch, so staff can now record outcomes on them; the third surface should follow AR13. One label rule (`recipientLabelOf`) for the Activity enrichment, RED first. |
| A-L3 | An existing contact who opted out (STOP) and signs up again keeps the opt-out; the thank-you copy says "We'll text you", and staff replies are refused. | LOW | FILE | Pre-existing (main refused that welcome too) and a compliance question - re-subscribing an opted-out number from a web form needs a rule (START) - not something to build in a fix wave. Added to `consent-capture-ignores-signup-web-form.md`. |
| A-L4 | A flyer entry turns a legacy "Property text failed" pin into "Property sent". | LOW | ACCEPT | Spec D7 residual, pinned by `contactTimeline.test.ts`. |
| A-I1 | The flyer veto is judged at write time, so a decline a later share temporarily superseded stays superseded. | INFO | ACCEPT | Spec D7: the refusal is `effectiveDecline(row, undefined)` on the read; nothing is re-judged later. |
| A-I2 | `FlyerPage.tsx:318` comment says the hidden suffix announces a new tab; the suffix is " - open in Google Maps". | INFO | DOC | Comment only; the accessible name is pinned by e2e selectors, so the words stay. |
| A-I3 | A sign-up reorders the tenant's Properties sent list, which sets the Schedule tour form's default property. | INFO | ACCEPT | The property they just signed up for becoming the default tour property is the sensible effect of the sent-list entry Cameron asked for. |
| A-I4 | "Same-day tours available" on every flyer whatever the property's tour arrangement. | INFO | ACCEPT | Cameron's call (2), 2026-10-21: "near the top of EVERY flyer". |
| C-F1 | An audit-write failure answers 500 after the pin, the bump and the flyer entry were written; the deleted path's audit is unguarded too. | LOW | FIX | Spec D6.4: failures never reach the public page. Guard both `housing_fair_signup` appends (log marker + step `audit`, no PII; the answer stays `{ ok: true }`), RED first. The thread step stays unguarded (pre-existing; guarding it changes the welcome path - see A-L1). |
| C-F2 | The decline-click race (a sign-up inside the outcome route's own stamp-to-write window supersedes the new decline) is filed but not in the spec's residual list. | LOW | DOC | Add it to spec section 7 with the issue link. |
| C-F3 | The D7 "Property text failed -> Property sent" residual is narrower in code than the spec says. | INFO | ACCEPT | The code is the better behavior. |
| C-F4 | An unknown contact's Signed up row offers Not interested only. | INFO | ACCEPT | Matches the waiting-row rule the spec points at (Interested needs a tenant). |
| C-F5 | Follow up can show a signed_up pair as waiting until a reload (an Undo that answers signed_up). | INFO | ACCEPT | Known and pinned by a test (plan AR9). |
| C-F6 | The unread mark skips a non-1:1 thread (relay pool number). | INFO | ACCEPT | Build ruling OR-14, RED-proven; a safety addition. |
| C-F7 | The deleted path records `existingContact: false`. | INFO | ACCEPT | Correct: existingContact means a LIVE holder; the deleted path carries `deletedContact: true`. |
| C-F8 | Additions beyond the spec (Follow up phone label, the pin CSS for every pin, `via: 'broadcast'` on a flyer-only row, id-only ledger log lines). | INFO | ACCEPT | Each recorded in the build's adjudications; none changes an approved decision. |

Decision changes this round: A-L2 and C-F1 change behavior (small, contained).
The fix wave is FW-P1 (below); the same two reviewers re-review its diff
with the re-review charge, and I re-run the gates on the final commit.

## FW-P1 - the fix list sent to the build orchestrator

1. **A-L2 (FIX)** `app/src/routes/units.ts` GET `/api/units/:unitId/activity`
   enrichment (~:2268): label each event's contact with the Sent to card's
   rule (`recipientLabelOf`: name, else `formatPhoneForDisplay(phone) ??
   phone`), so a nameless contact reads as its formatted phone. RED test
   first in the unit activity API test (a nameless contact with a phone ->
   formatted phone; no phone -> contactName absent, as today).
2. **C-F1 (FIX)** `app/src/routes/public.ts`: wrap BOTH `housing_fair_signup`
   audit appends (the deleted path ~:496 and the main path ~:718) so a throw
   is logged `{ marker, step: 'audit', err }` with `SIGNUP_STEP_FAILED` and
   the answer stays `{ ok: true }`. Update the header / step comments that
   enumerate the best-effort steps. RED test first: an audit repo whose
   append throws -> 200 `{ ok: true }`, the pin, the unread mark and the
   flyer entry still written, the step-failed line logged with no name or
   phone; the same for the deleted path.
3. **A-I2 (DOC)** `dashboard/src/routes/public/FlyerPage.tsx:318`: make the
   comment match the suffix it describes (" - open in Google Maps"). Comment
   only; the accessible name stays.
4. **A-M2 (FILE)** `docs/issues/public-signup-abuse-hardening.md`: add the
   Today crowd-out - each made-up-phone sign-up is a NEW contact (the
   24-hour check never runs), its thread is unread; Today keeps the newest
   100 unread 1:1 threads (`app/src/routes/today.ts:182`, break at `:752`);
   at the default per-IP limit (5 / 60 s) one IP fills the block in ~20
   minutes and real unreplied threads drop off Today (the inbox still lists
   them). Fix direction: the new-contacts ceiling the issue proposes, applied
   to the bump as well. Also the PLAUSIBLE note: the same junk grows the
   unpaginated Sent to card and Follow up reads.
5. **A-L1 + A-L3 (FILE)** `docs/issues/consent-capture-ignores-signup-web-form.md`:
   add (i) an existing contact who opted out (STOP) and signs up again keeps
   the opt-out while the thank-you says "We'll text you" - re-subscribing
   from a web form needs a compliance rule (START), a decision for Cameron;
   (ii) a request that fails after creating the contact but before the
   welcome is never welcomed on the retry (spec D5's consequence, widened to
   a crash before the send); the candidate rule (welcome an existing contact
   with `consent_method: 'web_form'` and no `housing_fair_welcomed`) and its
   double-text hazard when the flag write failed after a successful welcome.
6. **C-F2 (DOC)** spec `docs/superpowers/specs/2026-10-21-flyer-leads-design.md`
   section 7: append one residual bullet - "The decline-click race: a
   sign-up that lands inside the outcome route's own window between its
   'Not interested' stamp and its write leaves that new decline superseded
   at birth (the click answers Signed up; a second click sticks). Accepted
   in the build's code review; filed as
   docs/issues/flyer-signup-decline-click-race.md." ASCII only.

Gates after the wave: typecheck, the touched files' unit suites, then the
full battery on the final commit (the build's manual), no second main sync.
