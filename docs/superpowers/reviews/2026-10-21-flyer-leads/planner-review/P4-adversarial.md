# flyer-leads - planner review P4: plan-blind adversarial re-review of FW-P3

Reviewed: `feat/flyer-leads` at `d3bb2617`. Read:
- the code commit `7aed3383` (public.ts, numberSuppression.ts,
  relayAnnouncements.ts and the tests);
- the docs commits `fbdc5f4d` and `7cc3f24f`;
- every writer of `sms_opt_out` across app/ (file:line below).

The only files opened under `docs/superpowers/` were this output and
`planner-review/adjudications.md` (Round P3). No test, build or script was run
(`planner.end` was absent throughout), so every proof is a code path.

Counts:
- New: BLOCKING 0, HIGH 0, MEDIUM 0, LOW 3 (L1-L3), INFO 3 (I1-I3).
- Contested: none; Round P3's ACCEPTs are conceded (section 3).
- Fix: correct as specified. Its premise is not, and L1 is the cost.

---

## 1. Every writer of `sms_opt_out`, and which note each one produces

The note's rule (`app/src/routes/public.ts:726-733`):
- 'number' (the START note) when the thread step's thread or any 1:1 thread
  of the typed phone is flagged;
- else 'contact' (the Do-Not-Contact note) when the contact's own flag is
  set;
- else no note.

| # | Writer | What it writes | Note it yields | Right? |
|---|---|---|---|---|
| W1 | Inbound STOP / START on every path (1:1, closed-group AF-4, relay command, native group) -> `processInboundKeywords` -> `applyNumberSuppression` (`webhooks/twilio.ts:1100,1461,1782,2250,2715,1232`; `services/numberSuppression.ts:149-176`) | STOP: the number's OWN 1:1 thread flag always, plus the contact flag when it is the contact's primary number. START: clears that ONE thread and (primary) the contact flag | STOP -> 'number'. START -> none | Yes, except when the number has two 1:1 threads (L3). |
| W2 | Native-group 21610 receipt (`services/groupReceipts.ts:290-318`) | `readNumberSuppression` first; when that already says suppressed it RETURNS (`:300`) and writes nothing; else W1's writer | 'number' when it writes. 'contact' when a contact-only flag already existed (W3-W5) | No in the early-return case: a real Twilio block reads as Do-Not-Contact. |
| W3 | 1:1 21610 status arm (`webhooks/twilio.ts:3953-4001`) | Primary number: the CONTACT flag only (`:3984`), with an audit row carrying the conversationId (`:3985-3989`). Secondary number: NOTHING (`:3991-3994`) | Primary: 'contact'. Secondary: no note | No: Twilio holds a STOP in both cases. |
| W4 | Staff toggle `POST /api/contacts/:id/opt-out` (`routes/contacts.ts:2253-2301`; menu "Mark Do-Not-Contact" / "Allow SMS (clear opt-out)", `ContactActionsMenu.tsx:207`) | The contact flag only, set or cleared; never a thread flag (`contacts.ts:2257-2258`) | 'contact' | Yes - the case the note was written for. |
| W5 | Importer (`lib/import/apply.ts:1232-1236`, from `lib/import/threads.ts:249-259` bare-STOP phones) | The contact flag only, set "on every run and never cleared". The imported 1:1 thread (`upsertConversation`, `apply.ts:1287-1345`) carries no flag | 'contact' | No: a legacy STOP reads as a staff Do-Not-Contact. |
| W6 | Dev seed (`lib/seed/cast.ts:158`) | The contact flag only | 'contact' | Dev only. |

There is no other writer of either flag: `setSmsOptOut` is called only from
`numberSuppression.ts:160`, and contact `sms_opt_out` is set only at the
sites above (`emailEvents.ts:161` writes the email flags).

The coordinator's P3 premise ("a STOP or a 21610 always writes the number's
thread flag") holds for W1 and for W2's writing branch only. W3, W5 and W2's
early return leave a real STOP as contact-only. The public.ts comment
(`:175-178`) admits W3-primary and W5 and accepts them as 'contact'.

## 2. New findings

### L1 - LOW - Three real-STOP sources read "marked Do-Not-Contact - texts stay off unless staff choose Allow SMS"

What it costs, by source:
- **W3, primary-number 21610.** The flag is real and Twilio holds the block.
  - "Allow SMS" clears the contact flag. The thread has none, so every send
    gate opens: staff texts, tour reminders, placement nudges and the
    blast fan-out (which fences on the contact flag,
    `jobs/broadcastFanOut.ts:266`).
  - Twilio then refuses the next send with 21610, and W3 re-flags the
    contact. So nothing reaches the person, but every send in that window
    fails.
  - Staff believed they had re-enabled texts. The one remedy that works - the
    person texts START from that number - is the one the note no longer
    shows.
- **W3, secondary-number 21610.** Nothing is recorded, so the pin has no
  note, though Twilio blocks that number and every staff text to it fails.
  This gap is pre-existing in W3; the note simply cannot see it.
- **W5, imported legacy STOP.** The STOP was sent to the previous provider's
  number. PLAUSIBLE that Twilio holds no block (it does not inherit another
  provider's opt-out list).
  - "Allow SMS" then REALLY lifts a person's STOP, presented to staff as
    their own colleague's Do-Not-Contact.
  - The person has no `consent_method` (the importer stamps none for an
    opted-out person, `apply.ts:1237-1243`). So the next staff text opens the
    consent-capture modal, and staff attest a staff-held method for someone
    whose last recorded instruction was STOP.
  - The next `import:apply` silently re-sets the flag.
  - Reach today is small: the import comment counts "the single STOP in the
    real corpus" (`threads.ts:241`).
- **W2 early return.** A native-group 21610 for a contact that is already
  contact-flagged (W3, W4 or W5) writes no thread flag. The STOP Twilio now
  holds still reads as Do-Not-Contact, and Allow SMS behaves as in W3.

Can the Do-Not-Contact note steer staff into lifting a real STOP? Yes:
- W5 - lifted for real;
- W3 and W2 - lifted in the app only, so sends fail at Twilio and the
  contact re-flags.

Proof: the table above. `numberSuppression.ts:11-15` says the module "is the
one place the rule lives", but the 1:1 21610 branch still re-implements the
old contact-only rule (W3). That is why the note's premise fails.

Smallest correct change (root, no new read on the public path):
1. W3: route the 1:1 21610 arm through `applyNumberSuppression`, exactly as
   the group receipt does (`groupReceipts.ts:301-318`). The target is the
   conversation the arm already reads (`twilio.ts:3959`). A primary 21610
   then flags the thread and the contact, and a secondary one flags its own
   thread, so both read 'number'. About ten lines, RED first.
2. W5: in `upsertConversation`, SET `sms_opt_out = true` on the person's
   imported 1:1 thread when `person.optedOut`, so an imported STOP reads
   'number'. One clause.
3. Repair the existing rows. W3's audit (`sms_opt_out_recorded`, `source:
   'twilio_21610'`) carries the conversationId, so a one-off repair can flag
   exactly that thread. The import's handful can be fixed by hand. Running it
   is Cameron's call.

None of these touches public.ts. Once they land, the note is right as built.
They are outside this branch's files, so the realistic path is to FILE them
with this dependency stated and say so in GLOSSARY.

If the merge must not wait, the only in-branch fix that needs no read is
words true for every contact-only source. For example: " (texts are off for
this contact - a staff Do-Not-Contact or a recorded STOP; check its history
before choosing Allow SMS)". Cameron chose the current words, so this is his
call.

### L2 - LOW - The Do-Not-Contact note invites lifting a revocation on consent nobody confirmed

- A W4 Do-Not-Contact is often a VERBAL revocation ("stop texting me" on a
  call). Under the FCC's revoke-by-any-reasonable-means rule, that is as
  binding as a STOP.
- The sign-up behind the note may not be the person: anyone who knows the
  phone can submit the form, tick the box and type any name (filed in
  `public-signup-abuse-hardening.md`).
- Nothing confirms it either. An EXISTING contact gets no welcome (spec D5),
  and that welcome, with STOP / HELP, is the one confirmation step the web
  opt-in has.
- So the pin pairs an unverified opt-in with a pointer to the button that
  undoes the revocation.
- Proof: `public.ts:183-184` (the words), `contacts.ts:2253-2301` (W4), and
  D5's welcome rule (`public.ts:646`).
- Smallest fix: copy only, Cameron's call. For example "(marked
  Do-Not-Contact - confirm with them before choosing Allow SMS)". Or file it
  beside `consent-capture-ignores-signup-web-form.md`, whose suggested
  web-form consent stamp has the same unverified-submitter question.

### L3 - LOW - With two 1:1 threads on one number, a START leaves the other thread's flag, and the "any thread" rule then shows the START note to someone who already texted START

- Where: `applyNumberSuppression` writes ONE conversation, the one the
  keyword landed on (`numberSuppression.ts:160`). The new rule reads every
  1:1 thread of the number (`public.ts:728-729`, `isNumberThreadOptedOut`).
- Scenario: the number has a live, claimed thread A plus an imported thread
  B. `upsertConversation` writes its own conversationId with
  `participant_phone` and no phone claim (`apply.ts:1287-1345`), so an
  import run over a number that already had a live thread leaves two open
  1:1 threads. A STOP lands on A, and later a START lands on B (the fast
  path takes the first open thread in index order,
  `conversationsRepo.ts` createOrGetByParticipantPhone). B and the contact
  flag clear, A keeps its flag. The person is textable again on B, yet every
  later sign-up pin says "this number opted out ... text START from it".
  `readNumberSuppression` shares the rule, so the group roster chips are
  wrong the same way.
- The FW-P3 test "the flag only on an OLDER thread of the number -> the STOP
  note" pins the "an older thread's STOP counts" side and has no START case.
- Smallest fix: make the START (and STOP) write every 1:1 thread of the
  number in `applyNumberSuppression`. That is a per-number suppression fix;
  file it with L1.

### I1 - INFO - The rule's seed skips the type rule

`public.ts:726` seeds `numberOptedOut` from `conversation.sms_opt_out ===
true`, not `isNumberThreadOptedOut(conversation)`. A sign-up typed with a
relay pool number gets the relay group as its thread. A flag on it would read
as this number's STOP: the very misreading the exported rule exists to
prevent (`numberSuppression.ts:133-140`). Spec 4.4 forbids the flag on a
group, so this is unreachable today. The fix is one call.

### I2 - INFO - The new read's cost grows with history for a pool number

`findByParticipantPhone(phone)` is paged to exhaustion. For a typed pool
number it returns every relay group that ever used that pool (pools are
reused; `getAllByPoolNumber` exists for that), so that one request's latency
grows with history. The latency does not depend on the opt-out state - the
read runs on every pin-writing sign-up, pinned by the "runs once per sign-up
that writes a pin, whatever the flags" test - so there is no opt-out oracle.
It only reveals "this is one of our pool numbers", which every relay member
already knows. Everything else about the read is sound:
- failure: WARN with marker, step and error, no name or phone, the thread
  step's flag standing in, still `{ ok: true }`;
- consistency: index lag only, with the seed covering the thread the
  request just created.

### I3 - INFO - GLOSSARY and the consent issue list fewer contact-only causes than the code

Both say the contact-flag-only case is "a staff Do-Not-Contact, or the
contact's other number opted out". They omit the 1:1 21610 and import
writers (W3, W5) that the code comment names (`public.ts:175-178`). A reader
of either doc would trust the Do-Not-Contact note more than the code does.

## 3. Adjudications (Round P3)

- P3-F1 / A3-L1 (FIX): conceded. It led to this wave. Its stated reason is
  false for W2, W3 and W5, which is L1.
- P3-F2 / A3-L2 (FIX, wording): conceded. "this number ... from it" answers
  it. In the other-number case Allow SMS now does the right thing (texts to
  this number flow; the STOPped number's own thread flag still holds),
  although "marked Do-Not-Contact" names the wrong cause there.
- P3-F3 / A3-I1, P3-F4, P3-F5, A3-I2 (ACCEPT): conceded.

## 4. Is the fix correct?

- `isNumberThreadOptedOut` (`numberSuppression.ts:141-143`) is a pure
  extraction: `readNumberSuppression`'s behavior is unchanged
  (`numberSuppression.ts:122-123`), and the relayAnnouncements comment now
  points at the moved clause.
- The public.ts change matches the FW-P3 list:
  - the read runs only when a pin is written;
  - it is best-effort, with the fallback;
  - three causes give two notes;
  - the "Allow SMS" words match the menu label (`ContactActionsMenu.tsx:207`);
  - no audit, answer or log field changed, and the label is still never
    logged.
- The tests cover the handler-thread flag, an older-thread flag, the contact
  flag only (including the other-number case), both flags, neither flag, and
  the read throwing.
- Correct as specified. What it cannot be is correct for W2's early return,
  W3 and W5 (L1), or for a START that cleared only one of two threads (L3).
