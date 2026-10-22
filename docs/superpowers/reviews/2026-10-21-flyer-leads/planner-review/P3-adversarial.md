# flyer-leads - planner review P3: plan-blind adversarial re-review of FW-P2

Reviewed: `feat/flyer-leads` at `8ce2d404`. The wave is
`git diff 33e392aa..8ce2d404 -- . ':!docs/superpowers'`. The only file opened
under `docs/superpowers/` was `planner-review/adjudications.md` (Round P2 and
Cameron's decisions). No test, build or script was run (`planner.end` was
absent throughout), so every proof is a code path. The stale docs/issues line
citations are skipped as instructed.

Counts:
- New this round: BLOCKING 0, HIGH 0, MEDIUM 0, LOW 2 (L1, L2), INFO 2 (I1,
  I2).
- Contested: none still worth contesting (section 2).
- Fixes: the legend fix is correct and complete. The opted-out note is correct
  for the cases its tests cover; L1 and L2 are the cases they do not cover.
- Leak check: clean (V3).

---

## 1. New findings (all on the opted-out note, which arrived cold)

### L1 - LOW - The note treats every `sms_opt_out` as a texted STOP, but staff set the same flag with "Do Not Contact", where "they need to text START" is the wrong instruction

- Where: the note `app/src/routes/public.ts:168`, chosen at `:697` from
  `isOptedOut(conversation.sms_opt_out, contact.sms_opt_out)`. The staff
  toggle `app/src/routes/contacts.ts:2253-2294` (`POST
  /api/contacts/:id/opt-out`) sets and clears the CONTACT flag only, and
  records the "Marked Do Not Contact" milestone. The dashboard calls the flag,
  whatever its source, "Do Not Contact" (header badge
  `dashboard/src/routes/contact/ContactDetail.tsx:1031`, toggle at `:713-717`).
- Scenario: staff mark a contact Do Not Contact (the person asked on a call to
  stop texting, or the number was misattributed). Weeks later the person signs
  up on a flyer, ticking the consent box. Their thread carries no flag (the
  toggle never writes it: "Conversation-level denorm isn't propagated here",
  `contacts.ts:2257-2258`); the contact does. So the pin reads "... (opted out
  of texts - they need to text START to get texts again)". Two things are
  wrong:
  1. The person never opted out by text. Twilio holds no block, so nothing
     requires START.
  2. The remedy that fits is staff clearing Do Not Contact from the contact's
     menu - the toggle the route's own comment names for exactly this ("a
     staff override (e.g. the contact re-consented by phone)"). The note
     instead tells staff to get a person they deliberately marked Do Not
     Contact to text START. A START from that person also silently undoes the
     DNC (the keyword path clears the primary number's contact flag,
     `numberSuppression.ts:160-162`, via `twilio.ts:1232`), with no staff
     decision involved.
- Two words for one state also appear on one page: the header says "Do Not
  Contact", the pin says "opted out of texts".
- The same mismatch reaches imported opt-outs (`lib/import/apply.ts:1232-1236`
  sets the flag from the legacy system's STOPs). There START does work, but
  Twilio may hold no block for this number.
- Proof: the code path above. The handler cannot tell the sources apart
  without a read (the FW-P2 brief required no new read), and the tests cover
  only a seeded flag.
- Smallest fix: words that are true for every source. For example " (texts
  are blocked: Do Not Contact is on - if they texted STOP, only their texting
  START lifts it)", which uses the dashboard's own word for the flag. Or test
  the conversation flag alone for the "text START" sentence (the keyword and
  21610 paths always write it, `numberSuppression.ts:149`) and show a
  plain "Do Not Contact is on" when only the contact flag is set.

### L2 - LOW - On a contact's attached (secondary) number, the "text START" instruction fails when followed from the number the person signed up with

- Where: the note judges the pointer owner's contact flag; so does the send
  gate, which reads `contacts.findByPhone(participantPhone)` and hops a phone
  pointer to its owner (`app/src/services/sendMessage.ts:493,512-514`;
  `contactsRepo.ts` findByPhone). The START that would lift it is
  number-scoped: a keyword on a SECONDARY number clears only that number's
  thread flag and leaves the contact flag alone (`numberSuppression.ts:96-101`
  scope, `:160-169`, called from `twilio.ts:1232`).
- Scenario: a tenant with two numbers texted STOP from their primary P, which
  set the contact flag and P's thread flag. Later they sign up on the flyer
  with their other number Q. The note appears (the owner's flag), and a staff
  text to Q is indeed refused, so the note is right that texts will not
  reach them. Staff then ask the person to text START, and the person texts it
  from Q, the phone in their hand and the one on the form. Q's thread flag
  clears (it was already false), the contact flag stays, and every text to Q
  is still refused. Only a START from P lifts it, and nothing tells staff or
  the person that.
- Proof: the code path above. The root is pre-existing - the 1:1 send gate
  applies the primary number's contact flag to every number of the contact,
  while numberSuppression documents that flag as the PRIMARY number's
  (`numberSuppression.ts:6-10`) - but before this wave nothing told staff to
  fix it with a START.
- Smallest fix: name the number in the remedy ("... text START from the
  number that opted out"), or show the note only when the signed-up number
  itself is suppressed (`readNumberSuppression`, which applies the per-number
  rule - but that is a read). Aligning the send gate with the per-number model
  is its own change; file it beside
  `consent-capture-ignores-signup-web-form.md`.

### I1 - INFO - The note is frozen into an immutable pin, and the 24-hour cap decides which state it records

- `signed_up` pins are written once and never re-worded. The 24-hour repeat
  check (`public.ts:675-686`) skips the pin for the next sign-up from the same
  source, so the note reflects the opt-out state at the FIRST sign-up of the
  window, in both directions:
  - a person who texts START after that pin (the keyword path records an
    audit row, not a timeline milestone, `numberSuppression.ts:149-176`) still
    has, as their latest pin, "they need to text START";
  - a person who STOPs after the first pin and signs up again within 24 hours
    gets no note at all.
- The header badge (`ContactDetail.tsx:1031`) shows the live state, so staff
  can check. If the words are changed for L1 anyway, a point-in-time phrasing
  ("texts were blocked at sign-up") costs nothing.

### I2 - INFO - "The send path's rule" is two of the gate's three operands

The new GLOSSARY entry, the issue text and the `public.ts:692-696` comment
call the note "the send path's rule: the thread's or the contact's
sms_opt_out". The gate also refuses on the named recipient's own flag
(`sendMessage.ts:514`, `heldRecipient`). On a legacy shared phone, a text
staff send from the OTHER holder's page can be refused while the pin (on the
findByPhone holder) has no note. Edge case; a wording note only.

## 2. Adjudications

- A-L1 (kept ACCEPT): conceded. It is recorded as the preferred fix direction
  in the consent issue and is before Cameron.
- A-M1 / OR-26 (decided: legend reworded, `[Rent]` stays): conceded. The fix
  matches the decision (V1).
- N1 / OR-26b (decided: keep, FILE): conceded.
  `docs/issues/signed-up-row-sent-words.md` states both shapes and the
  wire-flag fix accurately. Its claim that Follow up shows it for Replied rows
  only is right: Interested and Not interested never wait,
  `listingSendOutcome.ts` isWaiting.
- A-L3 (decided: the form cannot re-subscribe a STOP; staff get a note):
  conceded as a decision. Its build is reviewed in section 1: correct for a
  texted STOP, wrong for a staff DNC (L1) and for a secondary number (L2).

## 3. Are the fixes correct?

- V1, legend (`dashboard/src/routes/listing/FlyerTag.tsx:38-46`): correct and
  complete.
  - Tracked files contain no "never leaves the dashboard" outside
    `docs/superpowers/` (only gitignored `.superpowers/` artifacts).
  - The tests and the e2e spec are updated.
  - The landlord line "Staff only - never on a property flyer." is true: a
    landlord's Staff only value stays Staff only when copied to a property.
- V2, note (`public.ts:168`, `:179-192`, `:697`): correct on the paths its
  tests pin:
  - the contact flag, in all three label forms;
  - the thread flag with no contact flag (a STOP from a number before any
    contact held it);
  - a NEW contact on a flagged thread, whose welcome is still refused with
    `contact_opted_out`;
  - not opted out.
  Two further cases also hold:
  - Relay pool numbers cannot produce a false note: group threads carry no
    `sms_opt_out` (spec 4.4, `numberSuppression.ts:121-131`).
  - A STOP recorded on a CLOSED thread is still seen: `createOrGetByParticipantPhone`
    adopts the claimed thread when none is open, and the GSI projection is ALL
    (`infra/modules/dynamodb/main.tf:57`), so the fast path carries the flag.
  The only lag is the GSI's own, sub-second, on both the thread and the
  contact read. The untested cases are L1 and L2.
- V3, leaks: none.
  - The public answer is still the constant `{ ok: true }`.
  - The note adds no read, so there is no timing signal.
  - It lives only in the pin label, which `activityEventsRepo.record` never
    logs (it logs contactId, type and refs).
  - No audit field and no log field was added.
