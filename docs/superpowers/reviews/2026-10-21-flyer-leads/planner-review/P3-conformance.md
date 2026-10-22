# P3 - spec conformance re-review, feat/flyer-leads (fix wave FW-P2)

Reviewer: the P1 / P2 conformance reviewer, re-run on 8ce2d404. Scope:
- `git diff 33e392aa..8ce2d404`: the coordinator's dbcb88fc / 3d916404 and
  FW-P2's f53eacda (legend), 1ed6af53 (the opted-out pin note), 337fb87e
  (GLOSSARY, selectors, spec section 7) and 3bae6272 (issues);
- a fresh sweep of the state those change.

Inputs read: the spec at 8ce2d404, the code, the tests, the issue files and
the "Round P2", "Cameron's decisions at the verdict" and "FW-P2" sections of
`planner-review/adjudications.md`. Not read: the plan and every other review
record. Skipped as instructed: the stale public.ts line citations in four
docs/issues files (already queued).

I ran nothing: `planner.end` did not exist during this pass, and every
finding below is proved by reading the code.

## Summary

Conformance table: 16 items.

| Verdict | Count |
|---|---|
| CONFORMS | 12 |
| PARTIAL | 4 |
| MISSING | 0 |
| DEVIATES | 0 |

Findings: 6.

| Severity | Count |
|---|---|
| BLOCKING | 0 |
| HIGH | 0 |
| MEDIUM | 0 |
| LOW | 3 (P3-F1, P3-F2, P3-F3) |
| INFO | 3 (P3-F4, P3-F5, P3-F6) |

The FW-P2 code is mechanically correct, and its tests pin what the fix list
asked for:
- the note text is exact on all three pin forms;
- the note fires for the contact's flag, for the thread's flag, and for a
  NEW contact on a flagged thread;
- there is no note when neither flag is set;
- a repeat within 24 hours writes no second pin;
- the unread mark, the flyer entry, the audit payload and the welcome rule
  are unchanged.

On a single-number contact the inputs are exactly sendMessage's opt-out gate:
the thread's `sms_opt_out` plus the phone-matched contact's (public.ts:697
against sendMessage.ts:512-515). So the note fires exactly when a staff text
on that number would be refused. The legend is correct, and no reader of the
old phrase remains outside docs/superpowers/.

The three LOWs are about the note's WORDS, not its trigger:
- **P3-F1:** `sms_opt_out` is also the staff "Mark Do-Not-Contact" flag, and
  for that cause "they need to text START" is the wrong remedy. The
  decision's own premise ("Twilio's opt-out block lifts only on START") does
  not hold there.
- **P3-F2:** for a contact with two numbers, the note's number and the number
  the remedy has to come from can differ.
- **P3-F3:** the note is frozen into a stored label, but phrased as live
  state.

## Conformance table

| # | Item | Verdict | Code file:line | Test file:line | Note |
|---|---|---|---|---|---|
| 1 | FW-P2.1 property legend: "Staff only - not on the public flyer." | CONFORMS | dashboard/src/routes/listing/FlyerTag.tsx:39 | FlyerTag.test.tsx:37-41; ListingEditForm.test.tsx:339; UnitCreateForm.test.tsx:1061; e2e property-requirements.spec.ts:277 | |
| 2 | FW-P2.1 landlord legend: "Staff only - never on a property flyer." | CONFORMS | FlyerTag.tsx:42-45 | FlyerTag.test.tsx:48-52 | no e2e pin; contact-detail.spec.ts:161-166 pins only the On line, which is enough |
| 3 | No reader of "never leaves the dashboard" remains | CONFORMS | grep of app/, dashboard/, e2e/, documentation/: no hit (docs/issues/optional-call-outcome-... is an unrelated sentence) | - | the tag chips themselves ("Staff only" / "On flyer") are unchanged (FlyerTag.tsx:21-24) |
| 4 | FW-P2.2 note text, exact, on all three forms | CONFORMS | app/src/routes/public.ts:168,188-191 | app/test/publicSignupLeads.test.ts:1041 (it.each over flyer / a flyer / join) | ASCII |
| 5 | The note's rule is sendMessage's opt-out gate (thread flag OR phone-matched contact flag), with no new read | CONFORMS for a single-number contact | public.ts:697; sendMessage.ts:512-515; contactsRepo.ts:1307-1312 (the same pointer-aware findByPhone feeds both) | publicSignupLeads.test.ts:1041,1058,1121 | P3-F2 for two numbers |
| 6 | A NEW contact on a thread flagged before any contact held the number gets the note; its welcome is refused as before | CONFORMS | public.ts:627-653,697 | publicSignupLeads.test.ts:1098 | |
| 7 | A repeat within 24 hours: no second pin (so no second note) | CONFORMS | public.ts:671-712 | publicSignupLeads.test.ts:1058 (tail) | P3-F5 |
| 8 | Only the words change: unread mark, 24-hour check, flyer entry, welcome rule, answer; no audit field; no flag written | CONFORMS | public.ts:697-712 | publicSignupLeads.test.ts:1058,1098 | |
| 9 | The note's words are true for every cause of `sms_opt_out` | PARTIAL | public.ts:168; contacts.ts:2253-2301 (staff Do-Not-Contact sets the same flag) | - | P3-F1 |
| 10 | The note stays true after the pin is written | PARTIAL | public.ts:699-709 (the label is stored); routes/contactTimeline.ts:678-688 (served verbatim, no read-time re-wording) | - | P3-F3 |
| 11 | GLOSSARY: the signed_up entry names the suffix and the rule | CONFORMS | documentation/GLOSSARY.md:669-674 | - | inherits P3-F1's premise ("Twilio's opt-out block lifts only ...") |
| 12 | selectors.md: the sign-up pin row names the suffix as part of the exact name | CONFORMS | e2e/support/selectors.md:52 | - | |
| 13 | Spec section 7: the D2 legend bullet | CONFORMS | spec :787-791 | - | |
| 14 | Spec section 7: the D6.2 opted-out note bullet | PARTIAL | spec :792-798 | - | the rule and the text match the code; the stated premise misses the staff-flag cause (P3-F1) |
| 15 | The consent issue's "Decided" paragraph | PARTIAL | docs/issues/consent-capture-ignores-signup-web-form.md ("Decided (Cameron, 2026-10-22 ...") | - | the same premise gap (P3-F1); the cited symbols are right |
| 16 | New issue `signed-up-row-sent-words.md` says what the code does | CONFORMS | Card.tsx:351,371; FollowUpView.tsx:68,119; listingSendOutcome.ts:83-88; shareLedger.ts:136-137 | - | each cited line checked at HEAD |

## Findings

### P3-F1 - LOW (decision premise - for Cameron) - a staff "Do-Not-Contact" contact's sign-up pin tells staff the person must text START

Spec section 7, D6.2 opted-out note: "when the number is opted out (the send
path's rule: the thread's or the contact's sms_opt_out), the pin label ends
' (opted out of texts - they need to text START to get texts again)'. The form
cannot re-subscribe a number: Twilio's opt-out block lifts only when the
person texts START, YES or UNSTOP." The GLOSSARY (:669-674) and the consent
issue's "Decided" paragraph repeat the premise.

Code: `contact.sms_opt_out` has three writers:
- an inbound STOP, through `applyNumberSuppression` (numberSuppression.ts:148-178);
- a 1:1 21610 receipt (webhooks/twilio.ts:3982-3989);
- **staff**, through "Mark Do-Not-Contact": `POST /api/contacts/:id/opt-out`
  (contacts.ts:2253-2301) on the contact actions menu
  (ContactActionsMenu.tsx:207). Its own comment calls clearing it "a staff
  override (e.g. the contact re-consented by phone)", and the same menu
  offers "Allow SMS (clear opt-out)".

A staff DNC writes the contact flag only. Twilio holds no block for it. The
note's rule (public.ts:697) cannot tell the causes apart, and the note gives
every cause the STOP remedy.

Scenario: staff marked a tenant Do-Not-Contact after a phone call. Weeks
later the tenant fills the flyer's sign-up box, ticking the CTIA consent box.
The pin reads "Signed up from the flyer for 12 Oak St ... as Ann Lee (opted
out of texts - they need to text START to get texts again)".
- The remedy is wrong: nothing Twilio-side needs lifting. The person has just
  given web-form consent, the case the DNC route's comment names for a staff
  clear, and staff can clear the flag themselves ("Allow SMS").
- Staff are told the opposite, so they either wait for a START that the
  person, who does not remember any STOP (Cameron's own reason for rejecting
  the thank-you line), will never send, or they ask them to text a keyword
  for no reason.
- No wrong text goes out: the error is in the conservative direction.

The decision was taken on the premise that every opt-out is a Twilio-held
STOP. For the staff-flag subset, the answer to Cameron's question ("they
should opt back in somehow. Is that a thing that we can do?") is yes: staff
can.

Fix directions, for Cameron:
- (a) Word the note by cause. The thread flag is written ONLY by a real STOP
  (numberSuppression.ts:148-149 always writes it), so `conversation.sms_opt_out`
  means a STOP and the START words fit. A contact flag WITHOUT the thread
  flag is a staff DNC (or a 1:1 21610) and could read
  " (marked Do Not Contact - clear it on the contact to text them)".
- (b) A neutral note: " (texts to this number are blocked - opted out or
  Do Not Contact)".

Both are a copy change on the existing inputs: no new read, no new audit.
One caveat for (a): the 1:1 21610 arm also writes only the contact flag
while Twilio does block, so the cause test is a heuristic unless it reads the
contact's latest `sms_opt_out_recorded` / `contact_opt_out_changed` audit.

### P3-F2 - LOW - two-number contacts: the note speaks for the person, but suppression is per number

The note says the person is "opted out of texts" and that "they need to
text START". The rule mirrors sendMessage's gate. But the app's suppression
store is number-scoped (BE1, numberSuppression.ts:1-17): a primary number's
STOP writes the contact flag, and a secondary number's STOP writes only that
number's thread flag. A START clears only the scope it arrives on
(numberSuppression.ts:160-172).

Two reachable shapes:
- **A.** The tenant signs up with a SECONDARY number they once STOPped
  (that thread is flagged), while the primary is fine.
  - The note fires.
  - The contact page's default composer texts the PRIMARY: its thread
    comes from `primary.phone`, contacts.ts:2191-2198. That send is not
    refused.
  - So the pin says "opted out of texts" about a person staff can text
    right now.
- **B.** The primary was STOPped (contact flag set) and the tenant signs up
  with the SECONDARY (findByPhone hops to the owner, contactsRepo.ts:1307-1312).
  - The note fires. Correctly, by sendMessage's rule, which refuses the
    secondary too on the contact flag.
  - But a START texted from the secondary clears only the secondary's thread
    flag. The log line "contact flag NOT changed (number-scoped)" is at
    numberSuppression.ts:167.
  - So the remedy the note gives does not work: the START has to come from
    the primary number.

Severity LOW: it needs a multi-number contact with a STOP on one number. Fix
direction: the same cause-split as P3-F1, or name the number ("... text
START from <the number>"). Alternatively, accept and record it as a
residual beside the D6.2 bullet.

### P3-F3 - LOW - the note is frozen into a stored label but reads as current state

`signupPinLabel` writes the note into the `signed_up` event's label at
sign-up time (public.ts:701-709). The timeline serves milestone labels
verbatim (contactTimeline.ts:678-688). Only `listing_sent` pins are
re-worded at read time (`propertySentWords`).

Scenario: an opted-out tenant signs up, and the pin ends "... they need to
text START to get texts again". The next day they text START, which clears
both flags, so staff texts go through. The pin keeps the instruction in the
present tense for as long as the thread exists. Within the repeat window,
even a fresh sign-up writes no new pin to supersede it (P3-F5). A staff
member scrolling the thread sees "they need to text START" above messages
that were delivered.

This is the one case where the note "fires" when a staff text would NOT be
refused. Mitigations: the START message itself appears in the thread, and
the composer's Do-Not-Contact note is live state (ContactCommsPane.tsx:146-148).

Fix directions:
- word the note in the past tense: "(was opted out of texts at sign-up - they
  needed to text START)";
- or re-word `signed_up` pins at read time from the live flags, as
  `propertySentWords` does for `listing_sent` (contactTimeline.ts:1386-1410).

### P3-F4 - INFO - the thread flag may come from the GSI copy

`createOrGetByParticipantPhone`'s fast path returns the item from the
eventually consistent `byParticipantPhone` GSI (conversationsRepo.ts:1280-1289).
So the note's `conversation.sms_opt_out` can lag a STOP written a moment
earlier. sendMessage judges the conversation it reads by id. A STOP and a
sign-up within about a second of each other can therefore produce a pin
without the note while a staff text is refused. Cosmetic.

### P3-F5 - INFO - an opt-out after the first pin is never noted inside the 24-hour window

The note rides on the pin, and the repeat check skips the pin for the same
source within 24 hours (public.ts:671-686). If the person texts STOP after
signing up and then signs up again from the same flyer the same day, no pin
is written, so staff never see the note for the opted-out state. That is by
the cap's design; it is listed so the D6.2 bullet's "when the number is
opted out" is not read as "every sign-up".

### P3-F6 - INFO - three precision leftovers from the round-P2 doc fixes

- Spec section 4 (:628-630) and the D7 / AR13 Activity bullet (:774-776)
  still say "formatted phone". The AR13 bullet above them is now exact (a
  non-US number shows as stored). Both point at AR13, so this is harmless.
- D7's qualified sentence (:427-429) now reads "a public request never
  undoes a decline that is already written (one exception, a race inside
  the outcome route's own write: section 7)". In the race the decline is NOT
  yet written when the sign-up lands, so the race is not an exception to
  that sentence: the sentence is now true as written, and the parenthesis
  could say "(but see the decline-click race, section 7)".
- `signed-up-row-sent-words.md` cites `shareLedger.ts:271-274` for
  putShareMemory's first-write `via`. Those lines are the comment that
  mentions it; the write itself is `if_not_exists` in listingSendsRepo's
  `putShareMemory`.

## Contesting the adjudications

| Row | Ruling | My position |
|---|---|---|
| P2-F1 | DOC (re-pointed) | Concede; FW-P2 re-staled four files, already queued. |
| P2-F2 | DOC | Closed: the bullet now lists the create and scopes the retry consequence to the thread step (spec :777-786). |
| P2-F3 | DOC | Closed (spec :150-152). |
| P2-F4 | DOC | Closed for the AR13 bullet and both comments (types.ts:3395-3396, listingFormat.ts:225-226); two loose "formatted phone" mentions remain (P3-F6, harmless). |
| P2-F5 | DOC | Closed in substance; the "one exception" wording is slightly off (P3-F6). |
| C-F3 re-raised | DOC | Closed (spec :459-462). |
| A-L3 -> Cameron's option (b) | BUILD | Built as specified, with one point to contest: the decision's premise. "Twilio's opt-out block lifts only on START" is true of a STOP, but `sms_opt_out` is also the staff Do-Not-Contact flag (contacts.ts:2253-2301), and for that cause the form's consent COULD re-subscribe, or staff could. P3-F1 asks Cameron whether the note should split by cause. |
| OR-26 / A-M1 | Legend reworded | Concede; correct and complete (rows 1-3). |
| OR-26b / N1 | FILE | Concede; the new issue is accurate (row 16). |

## Are the fixes correct?

- **f53eacda (legend):**
  - Both lines match the FW-P2 text character for character, and every pin
    of the old text was updated.
  - The chips and the aria descriptions (the tag span text) are unchanged,
    so no accessible name moved.
  - Correct.
- **1ed6af53 (note):**
  - `optedOut` is computed once, after the thread step. It takes the thread
    image the handler already holds and the resolved contact (for a new
    contact, the created item, which never carries the flag). It feeds only
    the label.
  - The suffix is appended to every return of `signupPinLabel`, and the
    tests cover each form and each flag.
  - Correct as specified. The open questions are about the words
    (P3-F1 to P3-F3), not the mechanics.
- **337fb87e / 3bae6272 (docs):** accurate to the code, apart from the
  shared premise (P3-F1) and the trivia in P3-F6.
