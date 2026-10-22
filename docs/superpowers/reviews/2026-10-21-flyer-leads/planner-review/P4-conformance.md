# P4 - spec conformance re-review, feat/flyer-leads (fix wave FW-P3)

Reviewer: the P1-P3 conformance reviewer, re-run on 647b5f3d (records head
d3bb2617). Scope:
- `git diff a49e250f..647b5f3d`: code 7aed3383, docs fbdc5f4d and citations
  7cc3f24f;
- a fresh sweep of the opt-out state those change;
- the coordinator's known gap: the 1:1 21610 arm and the imported STOP.

Inputs read: the spec, the code, the tests, the issue files, and the
"Round P3" and "FW-P3" sections of `planner-review/adjudications.md`. Not
read: the plan, FW-P3-report.md and the other reviewers' files.

I ran nothing: `planner.end` did not exist during this pass, and every
finding is proved by reading the code.

## Summary

Conformance table: 14 items.

| Verdict | Count |
|---|---|
| CONFORMS | 9 |
| PARTIAL | 1 |
| MISSING | 0 |
| DEVIATES | 4 |

Findings: 5.

| Severity | Count |
|---|---|
| BLOCKING | 0 |
| HIGH | 0 |
| MEDIUM | 1 (P4-F1) |
| LOW | 2 (P4-F2, P4-F3) |
| INFO | 2 (P4-F4, P4-F5) |

The FW-P3 mechanics are correct and well pinned:
- one thread rule, `isNumberThreadOptedOut`, is shared with
  readNumberSuppression;
- the number read runs once per pin-writing sign-up, never on a repeat, and
  falls back with a WARN on a throw;
- the cause precedence is number > contact > none;
- the note texts match the FW-P3 list on all three pin forms;
- nothing else changes.

The problem is the 'contact' bucket. It holds FOUR causes, not the two the
spec names:
- a staff Do-Not-Contact;
- a STOP from the contact's OTHER number;
- a 1:1 21610 receipt on the primary;
- an imported STOP.

Its words, " (marked Do-Not-Contact - texts stay off unless staff choose
Allow SMS)", are true only for the first. The worst case is the imported
STOP. It was read from the Quo (OpenPhone) export (`lib/import/threads.ts:249-259`),
so Twilio has no record of it, and the app flag is the person's only
protection. The note calls it a staff mark and names the override. The spec
section 7 bullet, the GLOSSARY and the consent issue then state the false
premise as fact.

Ownership: my P3-F1 option (a) named the 21610 caveat but missed the import
entirely; that is my miss.

## Conformance table

| # | Item | Verdict | Code file:line | Test file:line | Note |
|---|---|---|---|---|---|
| 1 | Cause = 'number' when the thread step's thread OR any 1:1 thread of the number carries `sms_opt_out`; else 'contact' on the contact flag; else none | CONFORMS | app/src/routes/public.ts:724-733 | app/test/publicSignupLeads.test.ts:1163,1177,1224,1240,1251 | |
| 2 | One shared thread rule (relay / group excluded), reused by readNumberSuppression | CONFORMS | app/src/services/numberSuppression.ts:123,141-143 | (readNumberSuppression's own suite, green on battery 6 per the handback) | |
| 3 | The number read: only when a pin will be written; best-effort (WARN step `opt_out_check`, the thread step's flag stands in, `{ ok: true }`) | CONFORMS | public.ts:724-732 | publicSignupLeads.test.ts:1263,1291 | |
| 4 | Note strings, all three forms | CONFORMS | public.ts:181-186,203-210 | publicSignupLeads.test.ts:1163 (it.each over the three forms) | "Allow SMS" is the prefix of the menu label "Allow SMS (clear opt-out)" (ContactActionsMenu.tsx:207); acceptable |
| 5 | Nothing else changes (mark, check, entry, welcome, answer, audit) | CONFORMS | public.ts:733-747 | publicSignupLeads.test.ts:1177 | |
| 6 | The 'contact' note's words are true for every cause that reaches it | DEVIATES | public.ts:184 (the words); twilio.ts:3982-3995 (21610: contact flag only); lib/import/apply.ts:1232-1236 (import: contact flag only, "set on every run") | publicSignupLeads.test.ts:1199-1222 pins "the contact's OTHER number opted out" -> "marked Do-Not-Contact" | P4-F1 |
| 7 | Spec section 7 D6.2 bullet | DEVIATES | spec :794-811 | - | P4-F2: "A STOP always writes the number's own thread flag" is false; two causes listed, not four; "Staff lift it" is stated universally |
| 8 | GLOSSARY signed_up entry | DEVIATES | documentation/GLOSSARY.md:669-680 | - | P4-F2: two causes; universal "staff lift it" |
| 9 | Consent issue: the "Decided" paragraph | DEVIATES | docs/issues/consent-capture-ignores-signup-web-form.md:89-108 | - | P4-F2: two causes |
| 10 | selectors.md pin row: both suffixes | CONFORMS | e2e/support/selectors.md:52 | - | |
| 11 | P3-F6: "formatted phone" -> "the phone as staff screens show it" (two places) | CONFORMS | spec :630, :774-777 | - | |
| 12 | P3-F6: D7 parenthesis | PARTIAL | spec :427-429 | - | P4-F5: still calls the race "one exception" to a sentence it is not an exception to |
| 13 | P3-F6: `via` cited at the code that writes it | CONFORMS | listingSendsRepo.ts:329,336 | - | P4-F5: the issue says `:328`, which is off by one (that line is `:now`) |
| 14 | Citations re-pointed (spot check: the click-race, deleted-contact and welcome-cap issues) | CONFORMS | public.ts:533,541,543,646,690,696,735,746,770 | - | every spot-checked digit matches HEAD |

## Findings

### P4-F1 - MEDIUM - the Do-Not-Contact note names a staff mark and its override for three causes that are opt-outs, one of them a legal STOP with no Twilio backstop

The FW-P3 note (public.ts:184) reads " (marked Do-Not-Contact - texts stay
off unless staff choose Allow SMS)". It fires whenever the contact flag is
set and no 1:1 thread of the number is flagged (public.ts:733). It reaches
four causes, and for three of them the words are false:

| Cause (writes contact flag only) | Who wrote it | Twilio blocks? | "marked Do-Not-Contact" | "unless staff choose Allow SMS" |
|---|---|---|---|---|
| Staff "Mark Do-Not-Contact" (contacts.ts:2253-2301) | staff | no | true | true |
| A STOP from the contact's OTHER number (primary STOP: contact flag + the primary's own thread flag, numberSuppression.ts:148-162; the sign-up comes from the secondary) | the person | the other number only | false - pinned as expected by publicSignupLeads.test.ts:1207-1221 | it "works" for this number, but it lifts the contact-wide flag a STOP set |
| A 1:1 21610 receipt on the primary (twilio.ts:3982-3995: `setFlag` on the contact, no thread flag) | Twilio, recording the person's STOP | YES | false | false: Allow SMS clears the flag, the next send fails 21610 and the arm re-flags; the real remedy is the STOP note's START |
| An imported STOP (apply.ts:1232-1236; detected from the Quo export, threads.ts:249-259) | the person, on the old platform | NO - Twilio never saw it | false | false: apply.ts calls it "a legal instruction, not a suggestion" and re-sets it "on every run", so Allow SMS both overrides a legal STOP and is undone by the next import:apply |

Failure scenario (imported STOP):
1. In the Quo history a tenant replied STOP.
2. import:apply sets `sms_opt_out` on the contact only.
3. A caseworker hands out a flyer, and someone types the tenant's number
   into the sign-up box. The form verifies nothing, so this may not be the
   tenant.
4. The pin reads "... as Ann Lee (marked Do-Not-Contact - texts stay off
   unless staff choose Allow SMS)".
5. Staff, reading this as a colleague's mark that the person has now
   reversed, choose Allow SMS. Texts go out to a number whose owner texted
   STOP, and no Twilio block stops them.
6. The next import:apply silently turns texts off again.

On the 21610 path the same click is harmless but wasted (a 21610, then a
re-flag).

Why MEDIUM and not HIGH: no text goes out without a deliberate staff
override. The composer's pre-existing refusal copy already invites the same
click for every opt-out (Timeline.tsx:97, P4-F3), so the override itself is
not new to the app. What is new is that this branch's copy states a false
cause, at the exact moment an unverified public submission arrives, and the
spec and docs certify that false cause (P4-F2).

Smallest correct change (copy only, keeps Cameron's "(a), the
Do-Not-Contact note"): drop the false "marked" and the bare invitation. Use
the vocabulary the contact page already uses for this flag ("On the
Do-Not-Contact list", Timeline.tsx:2809; "Do Not Contact", ContactDetail.tsx:1031):

    ' (on the Do-Not-Contact list - a staff mark or an opt-out; check the contact's history before choosing Allow SMS)'

That is one string at public.ts:184, plus the test constant
(publicSignupLeads.test.ts DNC_NOTE) and the selectors row. The STOP note
stays as built.

The more correct fix belongs to Cameron or a follow-up issue, not this
branch: make the two contact-only STOP writers also write the number's own
thread flag, so they reach the STOP note.
- Route the 1:1 21610 arm through `applyNumberSuppression`. The
  numberSuppression.ts header (lines 15-18) already lists the 21610
  receipts path as one of its callers; the 1:1 arm predates that binding.
- Have the import flag the imported number's 1:1 thread.

Both are compliance-path changes, too large for a fix wave at the end of
review.

### P4-F2 - LOW - the spec, the GLOSSARY and the consent issue state the false premise as fact

These claims are now false:
- **Spec section 7, D6.2 bullet (:802):** "A STOP always writes the number's
  own thread flag". The 1:1 21610 arm (twilio.ts:3982-3995) and the import
  (apply.ts:1232-1236) write the contact flag only. Only `applyNumberSuppression`
  (inbound keyword STOP, numberSuppression.ts:148-149) always writes the
  thread flag. The code comment at public.ts:170-180 says this correctly;
  the spec contradicts it.
- **Spec (:805-809), GLOSSARY (:675-678) and the consent issue (:100-104):**
  each lists the contact-only causes as "a staff Do-Not-Contact, or the
  contact's other number opted out". The 21610 and the imported STOP are
  missing.
- **"Staff lift it with 'Allow SMS (clear opt-out)'"** (spec :809, GLOSSARY
  :678) is stated for the whole bucket. It is false for a 21610 (Twilio
  still blocks) and for an import (the next run re-sets the flag, and
  lifting it overrides a legal STOP).

Coordinator's ruling question, answered: yes, the spec, the GLOSSARY and the
consent issue state something false about both cases, at LOW on their own.
They mislead the next engineer, but they change no behavior. They carry the
weight of P4-F1, because they are what a reviewer checks the copy against.

Smallest wording, one sentence each:
- **Spec bullet:** "An inbound STOP writes the number's own thread flag
  (applyNumberSuppression); a 1:1 21610 receipt (primary number only) and an
  imported STOP (Quo history) write only the contact flag, so they read as
  the Do-Not-Contact case."
- **Contact case, everywhere:** "only the contact's own flag: a staff
  Do-Not-Contact, a STOP from the contact's other number, a 1:1 21610 on the
  primary, or an imported STOP. Allow SMS is the remedy only for the staff
  mark."

### P4-F3 - LOW (pre-existing; all reviewers missed it) - the composer's opt-out refusal tells staff to "Clear the opt-out" for every cause, a dead end for a real STOP and an override of a legal one for an import

When a send is refused `contact_opted_out`, the composer says "This contact
is on the Do-Not-Contact list - texting is disabled. Clear the opt-out from
the ... menu to message them." (dashboard/src/routes/contact/Timeline.tsx:97).

The menu's "Allow SMS (clear opt-out)" clears only the CONTACT flag. The
route's comment says so: "Conversation-level denorm isn't propagated here;
the contact flag governs suppression" (contacts.ts:2253-2283). But
sendMessage refuses on EITHER flag (sendMessage.ts:512-515).

Two consequences:
- For a real primary-number STOP (both flags): after Allow SMS the composer
  note disappears (ContactCommsPane.tsx:148 reads the contact flag only).
  The next send is refused again on the thread flag, and the copy again says
  "Clear the opt-out from the menu", which now offers only "Mark
  Do-Not-Contact". A dead end, though a safe one, since Twilio blocks
  anyway.
- For an imported Quo STOP (contact flag only, no Twilio record): the advice
  lifts a legal STOP.

This predates the branch, and it is outside it. The branch's STOP note is
the first staff copy that gives the right remedy ("text START from it").
File it beside the issue P4-F1's follow-up would open: the refusal copy and
the Allow SMS route should tell a STOP from a staff mark the same way the
pin note now tries to.

### P4-F4 - INFO - the P3-F4 ruling's "narrowed by FW-P3's read" is not so

FW-P3's added read is `findByParticipantPhone` (conversationsRepo.ts:1336),
a `queryAll` on the same eventually consistent `byParticipantPhone` GSI
that the thread step's fast path reads. A GSI cannot be read strongly
consistent. The staleness P3-F4 described is therefore unchanged: a STOP
written a moment before a sign-up can still be missed by both reads. The
ACCEPT stands (cosmetic); only the "narrowed" reason is wrong.

### P4-F5 - INFO - three small leftovers

- Spec D7 (:427-429): "never undoes a decline that is already written (one
  exception: a sign-up inside the outcome route's own write window, section
  7)". In the race the decline is not yet written, so the sentence has no
  exception. "(see also the decline-click race, section 7)" would be exact.
- `signed-up-row-sent-words.md` cites `listingSendsRepo.ts:328` for the
  `:via` binding; it is at `:329` (`:328` is `:now`).
- `flyer-signup-decline-click-race.md` (its "What it takes" count): "five
  and a half [round trips] when it also pins and marks the thread" is now
  six and a half, because FW-P3 put the number read before the pin
  (public.ts:728). A longer sign-up path only narrows the race, so this is
  harmless; it is just stale.

## Contesting the adjudications

| Row | Ruling | My position |
|---|---|---|
| P3-F1 / A3-L1 | FIX; reason "A STOP or a 21610 always writes the NUMBER's thread flag" | Defended. The reason was false when it was written, and my P3-F1 said so: "the 1:1 21610 arm also writes only the contact flag while Twilio does block, so the cause test is a heuristic unless it reads the contact's latest ... audit". The arm is twilio.ts:3982-3995. The import, which I also missed, is apply.ts:1232-1236. The FIX built Cameron's pick faithfully on a false premise, hence P4-F1 / P4-F2. |
| P3-F2 / A3-L2 | FIX (wording) | Partly defended. The STOP note's "this number ... from it" now fixes shape A. Shape B (the other number STOPped) lands in the 'contact' bucket, whose "marked" is false for it; that is pinned as expected at publicSignupLeads.test.ts:1207-1221. The page header says "Do Not Contact" without "marked" (ContactDetail.tsx:1031), so the ruling's "as the contact page header already calls it" supports dropping "marked". |
| P3-F3 / A3-I1 | ACCEPT | Concede: the header shows the live state (ContactDetail.tsx:1031, ContactCommsPane.tsx:148). |
| P3-F4 | ACCEPT, "narrowed" | Concede the ACCEPT; contest only the "narrowed" reason (P4-F4). |
| P3-F5 | ACCEPT | Concede. |
| A3-I2 | ACCEPT | Not mine; no view. |
| P3-F6 | DOC | Mostly closed; one wording and one digit remain (P4-F5). |

## Are the fixes correct?

- **7aed3383 (code):** correct as specified.
  - Precedence and fallback are right, and the read is timing-neutral: it
    runs whatever the flags say.
  - The shared thread rule removes a copy.
  - The test matrix covers each cause the list named: the handler's thread,
    an older thread, contact only, both, neither, a throw, and a repeat.
  - The defect is the specification's bucket, not the code (P4-F1).
- **fbdc5f4d (docs):** accurate to the code except the three statements in
  P4-F2.
- **7cc3f24f (citations):** the spot check is clean.
