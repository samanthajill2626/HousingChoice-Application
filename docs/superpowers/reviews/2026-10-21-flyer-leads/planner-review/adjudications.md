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

## Round P2 (2026-10-22, re-review of FW-P1 at 33e392aa) - TERMINAL

FW-P1 landed as 6b632aef, 0363dde2, 21b47d65, 4a7796fb (report 098eaa11;
`FW-P1-report.md`); the orchestrator's battery 4 on 098eaa11 was green.
I then amended the spec (33e392aa: section 4's Activity card line, three
section 7 bullets). The SAME two reviewers re-reviewed with the re-review
charge (`P2-conformance.md`, `P2-adversarial.md`). Both confirm A-L2, C-F1
and A-I2 correct; neither found anything at MEDIUM or above. No accepted
finding changes what gets built, so this round is TERMINAL: its precision
edits are folded in below and the review stops.

| # | Finding | Sev | Ruling | Reason |
|---|---|---|---|---|
| P2-F1 / N2 | ~30 `public.ts` / `units.ts` line citations in five docs/issues files point at pre-FW-P1 lines; two files mix numberings. | LOW | DOC | Re-pointed to the final code (a docs-only sweep; symbol names where a line was ambiguous). |
| P2-F2 | The D6.4 handback bullet omits `contacts.create` from the not-best-effort list and over-states who is never welcomed. | INFO | DOC | Bullet corrected: the create is listed; only a thread-step throw AFTER the create leaves a new contact unwelcomed. |
| P2-F3 | Spec D3 says the " - open in Google Maps" suffix is the new-tab disclosure; it is not (and the corrected code comment says so). | INFO | DOC | D3 now says the suffix names the destination and never said "new tab". |
| P2-F4 | AR13 wording: "formatted phone" (a non-US number shows as stored); no name and no phone still shows the id; Follow up unnamed; two dashboard comments (`listingFormat.ts:225`, `types.ts` UnitActivityEvent.contactName) still describe name-or-id. | INFO | DOC | Section 7 AR13 bullet made exact; the two comments corrected (comment-only). |
| P2-F5 | D7's "a public request can never undo a staff decision" is still absolute; the race bullet omits that the route still writes its timeline / Activity rows. | INFO | DOC | D7 sentence qualified with a pointer to the section 7 race bullet; the bullet names the rows. |
| C-F3 (re-raised) | The D7 "Property text failed" residual over-states the case. | INFO | DOC | D7 residual now says which pins read the pair (legacy / entry-less). |
| N3 | With the audit best-effort, a missing `housing_fair_signup` row no longer proves there was no sign-up (the authority backfill's exclusion; the consent issue's planned stamp). | INFO | DOC | Stated in the D6.4 handback bullet. The authority backfill already ran in dev and prod (2026-10-13), so nothing reads it live. |
| N1 = OR-26b | Only `signed_up` rows get their own words; a flyer-latest pair that a reply, tour or decline outranks reads "Sent <sign-up date>" on the roster and on Follow up (a Replied flyer-only pair is chased on Follow up as "Sent ..."). | LOW | CAMERON (= OR-26b) | Built per spec D8; the decision goes to Cameron with this sharper example and the wire-flag alternative. |
| A-L1 (contested) | The reviewer defends A-L1: a throw before the welcome is not the "failed welcome" class; a safer fix is to create the thread BEFORE the contact so a thread failure leaves no contact and the retry is a create. | LOW | ACCEPT (kept) | The window needs a DynamoDB fault between two writes; the reorder moves the new-contact path at the end of review and leaves an empty participant-less thread when the create then fails, which shows in the inbox. Recorded in the consent issue as the preferred fix direction; Cameron sees it in the verdict. |
| A-M1 refinement | Option (a) as worded would reword the shared legend for every Staff only field; the honest narrow version is a note on the two Rent fields only (`[Rent]` is the only merge field that reads a newly Staff only field). | MEDIUM | CAMERON (= OR-26) | Folded into the options put to Cameron. |

## Cameron's decisions at the verdict (2026-10-22)

Verbatim:

> "Rent going out in the blast texts is fine. I think what we need to do is
> say "staff only" because that's what's in the flyer. That's really what's
> talking about a flyer. We shouldn't use the phrase "never leaves the
> dashboard" because it does in the instance that you talk about with the
> property sharing, and we want to keep that as is. [...] So either we need
> to remove that specific phrase from rent, or we need to add something that
> says Matching texts include it for number two, that's fine. Let's leave it
> as is. And file an issue. For an opted-out contact who signs up again,
> they should opt back in somehow. Is that a thing that we can do?"

> (after the planner explained that Twilio's opt-out block lifts only when the
> person texts START, and offered (a) a thank-you line for everyone and (b) a
> staff note on the sign-up) "For A, I don't really like that because people
> aren't going to know if they texted stop before. They aren't really paying
> attention, and it just muddies the water. I think that option B is the only
> solution. Let's add that."

Rulings:
- OR-26 / A-M1: `[Rent]` stays in the Matching default. The Staff only legend
  line drops "never leaves the dashboard" (planner's pick of Cameron's two
  options: it removes the phrase everywhere, so Rent needs no note of its own).
- OR-26b / N1: keep as built; FILE.
- A-L3: an opted-out contact cannot be opted back in by the form (Twilio's
  Advanced Opt-Out block lifts only on START / YES / UNSTOP from the person).
  BUILD option (b): the sign-up pin tells staff. NO thank-you line (option (a)
  rejected by Cameron).

## FW-P2 - the fix list sent to the build orchestrator

1. **Legend (FIX, RED first).** `dashboard/src/routes/listing/FlyerTag.tsx`
   LEGEND: property Staff only line -> `Staff only - not on the public flyer.`;
   landlord Staff only line -> `Staff only - never on a property flyer.` The
   On flyer lines are unchanged. Update every pin of the old text:
   `FlyerTag.test.tsx`, `ListingEditForm.test.tsx`, `UnitCreateForm.test.tsx`,
   `e2e/tests/dashboard-next/property-requirements.spec.ts` (and any other
   hit of "never leaves the dashboard" outside docs/superpowers/).
2. **Opted-out note on the sign-up pin (FIX, RED first).**
   `app/src/routes/public.ts`: after the thread step, judge the number opted
   out with the SEND path's rule on what the handler already holds -
   `isOptedOut(conversation.sms_opt_out, contact.sms_opt_out)`
   (`app/src/services/scheduledSendSuppression.ts:33`) - no new read. When
   true, the `signed_up` pin label (all three forms: flyer with address,
   "from a flyer", join page) gets the suffix
   ` (opted out of texts - they need to text START to get texts again)`.
   It applies to a NEW contact too (a number that opted out before any
   contact held it: its thread carries the flag and the welcome is refused).
   Nothing else changes: the unread mark, the 24-hour check, the flyer entry,
   the welcome rule, the public answer. No new audit field. Tests in
   `app/test/publicSignupLeads.test.ts`: contact flag; thread flag; a new
   contact on a flagged thread; not opted out -> no suffix (the existing
   label tests stay green).
3. **Docs.** `documentation/GLOSSARY.md` (the signed_up pin entry, ~:666)
   and `e2e/support/selectors.md` (the sign-up pin row, ~:52): name the
   opted-out suffix. Spec `docs/superpowers/specs/2026-10-21-flyer-leads-design.md`
   section 7: append two bullets - "D2 legend (Cameron, 2026-10-22): the
   Staff only legend line reads 'Staff only - not on the public flyer.'
   (property forms) and 'Staff only - never on a property flyer.' (landlord
   form). The tags are about the flyer; rent still reaches tenants through
   the Matching [Rent] merge field, which stays." and "D6.2 opted-out note
   (Cameron, 2026-10-22): when the number is opted out (the send path's
   rule: the thread's or the contact's sms_opt_out), the pin label ends
   ' (opted out of texts - they need to text START to get texts again)'.
   The form cannot re-subscribe a number: Twilio's opt-out block lifts only
   when the person texts START, YES or UNSTOP. No thank-you line (Cameron
   rejected it: people do not remember texting STOP)." ASCII only.
4. **Issues.** New `docs/issues/signed-up-row-sent-words.md` from
   `docs/issues/_TEMPLATE.md` (bug or improvement, low): a pair whose latest
   counted entry is the flyer reads "Sent <sign-up date>" on the contact's
   Properties sent row (`Card.tsx`) and on Follow up (`FollowUpView.tsx`)
   once a reply, tour or decline outranks `signed_up`, for a property the app
   may never have texted; fix direction: the latest entry's key on the wire
   (`latestCountedShareKey`), the words keyed on it; Cameron 2026-10-22:
   keep as built, filed. And update `docs/issues/consent-capture-ignores-signup-web-form.md`'s
   opted-out paragraph: decided - the form cannot opt a number back in
   (Twilio), staff see the pin note (FW-P2), no thank-you line.
5. Run `npm run issues` (EXIT:0). Then the full five-gate battery on the
   final commit; no second main sync; no review round of your own (my two
   reviewers re-review this diff).

## Round P3 (2026-10-22, re-review of FW-P2 at 8ce2d404)

Planner gates on 8ce2d404 (logs `.superpowers/sdd/gates/planner-*`, round-2
logs archived as `r2-planner-*`): typecheck EXIT:0; npm test EXIT:0 (app
11035 passed + 1 skipped, dashboard 5391, e2e workspace 508, fake-twilio
275, fake-twilio/web 111; no `[dynamoAdmin]`); smoke EXIT:0 (1731
specifiers); e2e EXIT:0 (371 passed, 17.8m); eslint EXIT:1 with the same 3
merge-base errors, 0 new.

`P3-conformance.md` (16 items, 12 conform, 4 partial; 3 LOW, 3 INFO) and
`P3-adversarial.md` (2 LOW, 2 INFO): nothing at MEDIUM or above; the legend
is complete and correct; the note fires exactly on the send gate's flags.

| # | Finding | Sev | Ruling | Reason |
|---|---|---|---|---|
| P3-F1 / A3-L1 | `sms_opt_out` is also the staff "Mark Do-Not-Contact" flag (contact only, `contacts.ts:2253-2301`); for it, "they need to text START" is false (no Twilio block; staff lift it with Allow SMS) and a START would silently clear the staff DNC. | LOW | FIX (Cameron 2026-10-22: "Go with (a), the Do-Not-Contact note") | A STOP or a 21610 always writes the NUMBER's thread flag (`applyNumberSuppression`); a staff DNC writes only the contact flag. Word the note by cause. |
| P3-F2 / A3-L2 | Two numbers: a START from a secondary number never clears the contact flag; a STOPped secondary does not stop the primary. | LOW | FIX (wording) | The STOP note names "this number" and "from it"; a contact-flag-only case gets the Do-Not-Contact note, as the contact page header already calls it. |
| P3-F3 / A3-I1 | The note is frozen into the pin and reads as present tense after a later START; a repeat inside 24 hours adds no pin. | LOW | ACCEPT | A pin is a point-in-time record like every activity event; the contact page header shows the live state. |
| P3-F4 | The handler's thread can come from the eventually consistent index copy. | INFO | ACCEPT (narrowed by FW-P3's read of all the number's threads) | |
| P3-F5 | An opt-out after the day's first pin is not noted on a repeat. | INFO | ACCEPT | The 24-hour cap is Cameron's. |
| A3-I2 | The send gate's third check (the named recipient's own flag) is not mirrored. | INFO | ACCEPT | Matters only on a legacy shared phone. |
| P3-F6 | Spec leftovers: two loose "formatted phone" mentions (~:630, ~:774-776); D7's "one exception" parenthesis; the new issue cites a comment, not the code that writes `via`. | INFO | DOC | Folded into FW-P3. |

## FW-P3 - the fix list sent to the build orchestrator

1. **The opted-out note by cause (FIX, RED first)** in `app/src/routes/public.ts`:
   - `numberOptedOut` = the handler's thread has `sms_opt_out`, OR any of the
     phone's 1:1 threads does (`conversations.findByParticipantPhone(phone)`,
     excluding `relay_group` / `group_text` exactly as
     `numberSuppression.ts` readNumberSuppression does - reuse or export that
     thread rule rather than copy it). The read is best-effort: on a throw,
     log `{ marker, step: 'opt_out_check', err }` with SIGNUP_STEP_FAILED
     (WARN) and fall back to the handler's thread flag; the answer stays
     `{ ok: true }`. Read it only when a pin will be written (not on a
     repeat).
   - When `numberOptedOut`: the pin ends
     ` (this number opted out of texts - they need to text START from it to get texts again)`.
   - Else when `contact.sms_opt_out === true` (a staff Do-Not-Contact, or
     the contact's other number opted out): the pin ends
     ` (marked Do-Not-Contact - texts stay off unless staff choose Allow SMS)`.
     Use the staff menu's exact label for "Allow SMS"
     (`dashboard/src/routes/contact/ContactActionsMenu.tsx`); if it differs,
     use the real label and say so in the report.
   - Else no note. All three pin forms; new and existing contacts; nothing
     else changes (no audit field, no public change).
   - Tests (`app/test/publicSignupLeads.test.ts`, appended): handler-thread
     flag -> STOP note; flag only on an OLDER thread of the number -> STOP
     note; contact flag only -> Do-Not-Contact note; both -> STOP note;
     neither -> no note; the thread read throwing -> logged, falls back, 200.
2. **Docs.** GLOSSARY signed_up pin entry and `e2e/support/selectors.md` pin
   row: both suffixes. Spec section 7: replace the FW-P2 "D6.2 opted-out
   note" bullet's rule and words with the two cases (cite Cameron
   2026-10-22 for both), and fix P3-F6's leftovers (the two "formatted
   phone" mentions -> "the phone as staff screens show it"; D7's parenthesis
   -> "one exception: a sign-up inside the outcome route's own write window,
   section 7"). `docs/issues/consent-capture-ignores-signup-web-form.md`:
   the opted-out paragraph names both notes. `docs/issues/signed-up-row-sent-words.md`:
   cite the code that writes `via` (putShareMemory's first-write), not a
   comment.
3. **Citations.** Re-point every stale `public.ts` / `units.ts` line citation
   in docs/issues/ to the FINAL code (FW-P2 and FW-P3 both shift public.ts;
   the FW-P2 report has the FW-P2 map). Digits only.
4. `npm run issues`, then the full five-gate battery on the final commit
   (`npm run e2e:stop` first); no second main sync; no review round of your
   own.

## Round P4 (2026-10-22, re-review of FW-P3 at d3bb2617)

Planner gates on d3bb2617 (logs `.superpowers/sdd/gates/planner-*`, round-3
logs archived as `r3-planner-*`): results recorded below when the run ends.

`P4-conformance.md` (14 items: 9 conform, 1 partial, 4 deviate; 1 MEDIUM,
2 LOW, 2 INFO) and `P4-adversarial.md` (3 LOW, 3 INFO). The code mechanics
are correct (one shared thread rule, the read runs whatever the flags say,
a clean fallback); the finding is in the premise behind the words.

**The planner's error.** The P3-F1 ruling's reason read "A STOP or a 21610
always writes the NUMBER's thread flag (`applyNumberSuppression`)". That is
true only for an inbound STOP keyword (`webhooks/twilio.ts:1232`). Three
other writers set the contact flag alone, so a real opt-out reads as the
staff Do-Not-Contact case: the 1:1 21610 receipt on the primary number
(`webhooks/twilio.ts:3982-3995`; on a secondary number it writes nothing),
the native-group 21610 receipt when the contact flag is already set (it
returns early, `groupReceipts.ts:300`), and an imported legacy STOP
(`lib/import/apply.ts:1232-1236`, re-set on every import:apply). The build
reported the first and third (FW-P3-report.md); the reviewers confirmed them
and added the second. Verified in the code by the planner.

| # | Finding | Sev | Ruling | Reason |
|---|---|---|---|---|
| P4-F1 / A4-L1 | The Do-Not-Contact note (" (marked Do-Not-Contact - texts stay off unless staff choose Allow SMS)") is true only for a staff mark. It is false for a STOP from the contact's other number, a 21610 (Twilio still blocks, so Allow SMS only earns another 21610 and a re-flag), and an imported STOP, where Twilio holds no block and Allow SMS lifts a legal STOP on the strength of a public form anyone can submit. | MEDIUM / LOW | DECISION (Cameron) - the wording is his pick (a) | Recommend rewording the contact-only note so it is true for every cause and asks staff to confirm first. The real fix - make those writers flag the number's thread, so the START note shows - sits outside this branch: FILE. |
| A4-L2 | The note points staff at Allow SMS on consent nobody confirmed (existing contacts get no welcome text). | LOW | Folded into P4-F1's decision | The recommended words ask staff to confirm with the person first. |
| P4-F2 / A4-I3 | The spec section 7 bullet says "A STOP always writes the number's own thread flag"; the spec, GLOSSARY and the consent issue list two of the four contact-only causes and say staff lift every one with Allow SMS. | LOW | FIX (doc) | Whatever the words, the docs must name all four causes and drop the false premise. |
| P4-F3 | Pre-existing: the composer's opt-out refusal tells staff to "Clear the opt-out from the menu" for every cause (`dashboard/src/routes/contact/Timeline.tsx:97`) - a dead end for a Twilio-held STOP, an override of a legal one for an import. | LOW | FILE | Predates the branch; it belongs with the writer fix. |
| A4-L3 | A START clears only the thread it lands on (`numberSuppression.ts:160`), so with two 1:1 threads on one number (an import run's own thread beside a live one) the "any thread" rule keeps showing the START note after the person texted START. | LOW | ACCEPT + FILE | readNumberSuppression has the same stale read today; the pin is a point-in-time record (P3-F3). |
| A4-I1 | The note's seed reads `conversation.sms_opt_out` directly, not `isNumberThreadOptedOut(conversation)`. | INFO | FIX if a wave runs | Unreachable (spec 4.4 forbids the flag on a group thread); one call. |
| A4-I2 | The new read has no timing or enumeration signal; cost grows with history only for a pool number. | INFO | ACCEPT | |
| P4-F4 | P3-F4's "narrowed by FW-P3's read" is not so: the new read uses the same eventually consistent index. | INFO | ACCEPT; P3-F4's reason corrected here | |
| P4-F5 | Leftovers: D7's "one exception" wording; `signed-up-row-sent-words.md` cites `listingSendsRepo.ts:328` for `via` (it is `:329`); the click-race issue's round-trip count is one higher. | INFO | FIX (doc) | |

**Cameron's decision (2026-10-22, verbatim).** Asked to pick (a) reword the
Do-Not-Contact note so it is true for every cause, or (b) keep his wording
and file the problem: "Let's just do it: B. File the problem note code
change." Read as option (b): the note keeps its words, no code change on
this branch, and the code change (the writers) is filed.

Rulings settled by it:
- P4-F1 / A4-L1 / A4-L2: RESIDUAL, filed as
  `docs/issues/opt-out-writers-skip-number-thread.md` (the three writers,
  the repair of rows the old 21610 arm wrote, and the START gap).
- P4-F3: filed in the same issue (the composer refusal copy).
- A4-L3: filed in the same issue ("Also").
- A4-I1: ACCEPT (no wave runs; unreachable).
- P4-F2 and P4-F5: fixed by the planner, docs only - the spec section 7
  D6.2 bullet (the four contact-only causes, the true premise, the
  residual), D7's parenthesis, GLOSSARY, the consent issue,
  `signed-up-row-sent-words.md` (`:329`) and
  `flyer-signup-decline-click-race.md` (six and a half round trips).

This round changes no code: TERMINAL. No FW-P4.
