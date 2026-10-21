# Flyer leads design - adversarial review R2 (reviewer B, continued)

Spec: `docs/superpowers/specs/2026-10-21-flyer-leads-design.md`, revision 2
(@bd73315c; diffed against rev 1 @880c5973). Inputs also read:
`adjudications.md`, `R1-reviewer-a.md`, `R1-reviewer-b.md`.
Read-only: nothing edited, staged, committed or run beyond reads and grep.
Line references are `path:line` in `W:\tmp\flyer-leads`. UNVERIFIED marks a
claim I could not prove from the code.

Order: new defects in the rev 2 mechanisms first, then contested
adjudications, then fixes that are correct but under-specified. Concessions
are at the end.

---

## 1. [HIGH] `findAllByPhone` drops soft-deleted holders, so D4's "only deleted holders" branch can never be reached: a deleted-only phone becomes "no holder", and the route CREATES a new contact and sends the welcome

**What is wrong.** D4 says the route "switches to `contacts.findAllByPhone`,
then" branches three ways: live holders, "**Only deleted holders**: the
deleted path", "**No holder**: a NEW contact is created". The repo contract
excludes deleted holders: "soft-deleted contacts EXCLUDED"
(`app/src/repos/contactsRepo.ts:746-755`), implemented by
`if (holder === undefined || isDeleted(holder) || ...) continue;`
(`contactsRepo.ts:1279`). The harness fake does the same
(`app/test/helpers/twilioWebhookHarness.ts:2225`). For a phone held only by
deleted contacts, `findAllByPhone` returns `[]`, exactly what it returns for an
unknown phone.

**Consequence if built as written.** For every deleted-only phone:
- a NEW `tenant` contact is created on that phone (today nothing is created,
  `public.ts:324-330`);
- the welcome is sent to a number staff deliberately deleted (today it is
  refused `contact_deleted`, `sendMessage.ts:537-540`);
- the phone now has two holders, one deleted. The thread
  `createOrGetByParticipantPhone` returns is the existing phone-claimed one,
  whose participants claim already names the deleted contact
  (`conversationsRepo.ts:1306-1331`; `setParticipantsIfAbsent` never relinks,
  `:1711-1740`). The inbox and the send gates then judge whichever holder
  `findByPhone` returns first (finding 2).

D4's own deleted path ("writes no conversation and sends nothing ... KEEPS the
`housing_fair_signup` audit event, with `deletedContact: true`") and the
section 5 test "Only deleted holders: ... the audit has `deletedContact: true`"
cannot pass. Rev 2 reached for `findAllByPhone` to fix arbitrary-holder
selection (M7) and in doing so removed the only read that could see a deleted
holder (M6).

**Implies.** The route needs a second read for the empty case (for example
`findByPhone`, which "deliberately ignores" deletion, `contactsRepo.ts:214`,
`twilio.ts:517`), or a repo variant that returns deleted holders flagged. The
spec must name it. It must also say which deleted holder the audit row's
entity `contacts#<id>` uses when there are several (`public.ts:420`).

---

## 2. [MEDIUM] The D4 holder ranking disagrees with every downstream reader, which all still use `findByPhone`: on a shared phone the pin and consent land on one contact, while the unread row and the send gate judge another

**What is wrong.** D4 records the sign-up on the live holder ranked "tenant,
then unknown, then partner, then landlord". D6.3 then bumps the phone's ONE
conversation. Every reader that turns that conversation back into a person
still uses the arbitrary first holder:
- the inbox pager: `resolveContact` -> `contacts.findByPhone(phone)`
  (`app/src/routes/inbox.ts:900-925`);
- the unread feed / badge / Unread page / Today: `deps.contacts.findByPhone`
  (`app/src/lib/unreadFeed.ts:534-546`);
- a staff reply's deleted and JIT-consent gates: `phoneContact` from
  `findByPhone` when no `recipient` is passed (`sendMessage.ts:493,511,537-557`).
  An ordinary 1:1 send passes none: only the broadcast fan-out and the Retry
  route do (`sendMessage.ts:371-388`, `app/src/routes/api.ts:1814-1823`).

So on a shared phone:
- **Live tenant + live partner** (the caseworker case D4 cites): the pin and
  the consent stamp land on the tenant. The unread inbox row may resolve to
  the partner and link to the partner's page (`InboxRow.tsx:44-55`). If the
  partner had no consent, staff's reply is still refused `contact_no_consent`,
  so D6.5's stated purpose ("Without this, the staff reply ... would be
  blocked") is not delivered.
- **Deleted tenant + live landlord** (the spec's own section 5 test, "recorded
  on the landlord"): when `findByPhone` returns the deleted tenant, the inbox
  hides the row unless the newest message is an inbound after deletion
  (`inbox.ts:1243-1247`, `unreadFeed.ts:548-593`). A sign-up writes no
  message, so the bump is INVISIBLE. Staff's reply from the thread is refused
  `contact_deleted` (`sendMessage.ts:537-540`). Goal 3 ("marked unread so staff
  see it in the inbox") fails in the very case the test names.

Reviewer A raised the pin-versus-inbox split in R1 (#7, third bullet). M7
adjudicated only the holder choice.

**Implies.** Either the spec states the shared-phone limits as accepted (pin
and unread can sit on different contacts; a deleted first holder hides the
bump), and the section 5 test asserts what actually happens rather than
"recorded on the landlord", or the bump and the consent stamp must follow the
holder `findByPhone` returns. A minimum fix: pass the chosen holder's id where
the reply path can carry it - out of scope here, so state it.

---

## 3. [MEDIUM] A `signed_up` row loses every roster action and is filed under "Waiting" on the property page: two readers the D8 list does not cover

**What is wrong.** D8 says `signed_up` "is never 'waiting'" and lists
`SendRosterRow` and `ListingDetail.tsx` as renderers, changing only the date
words and the chip. The roster's actions are all gated on the waiting
outcomes:
`const waiting = row.outcome === 'no_reply' || row.outcome === 'replied';`
(`dashboard/src/routes/contact/Card.tsx:348`). That gate controls Interested
(`:349`, `:370-380`), Request a tour (`:381-390`) and Not interested
(`:391-401`). A `signed_up` row - the hottest lead on the list - shows a chip
and NO buttons on the contact page and the property page. The server would
accept the click: the outcome route requires only a counted row
(`app/src/routes/units.ts:1553-1556`).

The property card groups rows with `groupSendRows`
(`dashboard/src/routes/listing/listingFormat.ts:338-354`). Anything that is not
interested, not_interested or missing goes to group 0, labelled "Waiting", when
eligible (`:349`). So a `signed_up` row is listed under **Waiting**, the word
D8 says it never is. `listingFormat.ts` is not in section 4.

D8's last bullet, "every other place that names an outcome treats `signed_up`
like an interest signal", is a slogan, not a rule: the two places above do the
opposite unless changed, and the spec does not say which group or which
actions a `signed_up` row gets.

**Implies.** Name the actions a `signed_up` row offers (presumably Interested
and Not interested, as for a waiting row) and the property-card group it falls
in, and add `listingFormat.ts` `groupSendRows` to the D8 reader list and the
tests.

---

## 4. [MEDIUM] D6.5 records a NEW web-form opt-in and D5 forbids the confirmation text: the repo's own A2P design pairs every new consent stamp with the welcome

**What is wrong.** D6.5 stamps `consent_method: 'web_form'`, `consent_at` and
`consent_version` on an existing contact that has none. D5 says such a contact
never gets the welcome. The welcome is the FILED opt-in message: identity and
opt-out (`public.ts:67-76`; `docs/superpowers/specs/2026-06-30-a2p-sms-compliance-design.md:111-117`).
The A2P design's rule for the one other path that stamps consent on an
existing contact is "stamp one (`inbound_text`) + send the welcome (keyword
opt-in is a documented affirmative opt-in)"
(`2026-06-30-a2p-sms-compliance-design.md:144-146`).

D5's rationale - landlords, caseworkers and long-time tenants got the welcome
mid-conversation - is about contacts who ALREADY consented: auto-captured
contacts carry `inbound_text` (`app/src/services/contactCapture.ts:90-92`). A
contact with NO `consent_method` has, by the system's own record, never opted
in. After rev 2, the first text this newly opted-in person receives is a staff
member's free-text reply, with no brand and no STOP line. Whether CTIA or the
campaign vetting requires the confirmation here is UNVERIFIED; that the repo's
design pairs a new stamp with the welcome is verified.

**Implies.** Make the welcome rule "sent when this request CREATED the contact
OR stamped its consent", or state at Cameron's gate that a stamped consent goes
out with no confirmation message. The two planner's calls (D5, D6.5) interact
and must be decided together.

---

## 5. [MEDIUM] First-sight keeps the R1 symptom for every already-sent pair: a person who signs up for a property they were texted stays "No reply yet" and lands on Follow up

**What is wrong.** D7 writes nothing when the pair already has a counted entry,
"whatever its outcome". D8's `signed_up` exists only when the flyer entry is the
LATEST counted entry. For the common forwarded-flyer case - the tenant got the
property by broadcast, never answered, and the caseworker forwards the same
flyer - the sign-up leaves the pair at `no_reply`. Twenty-four hours after the
send it is "waiting on a reply" (`listingSendOutcome.ts:116-131`), on the Follow
up tab and in the "<n> waiting" pill (`app/src/services/followUps.ts:168-196`).
Staff are asked to chase someone who just signed up for that exact home.

D8's own justification for `signed_up` never waiting ("The person reached out,
and the unread mark (D6) already puts it in front of staff") applies equally
here, but the mechanism cannot see it. First-sight fixed the R1 demotions
(Replied -> No reply, decline superseded) by giving up the R1 promotion. The
spec states the first half and not the second. A related residual: if the
cap (finding 9) skipped the pin, this pair carries no trace of the sign-up at
all except the audit row.

**Implies.** Either accept and state it ("a sign-up on an already-sent pair
changes nothing on the sent list; the pin is the only signal"), or give D8 a
reader-side signal that does not move `sentAt` or touch declines - for example
a flyer entry recorded as uncounted on a counted pair, read by the outcome
derivation only. That is a design call, not scope creep: it is the same
requirement M4 accepted.

---

## 6. [MEDIUM] "First sight only" cannot be enforced through `applyShareLedgerEntry` as named; a check outside its token loop races a concurrent broadcast

**What is wrong.** D7 says the flyer entry goes "through the ledger path every
share uses (`applyShareLedgerEntry` -> `putShareMemory`)", written only when the
pair has NO counted entry. `applyShareLedgerEntry` reads the row, applies
`mayReplace` to the ONE share key it was given, summarizes and writes on the
token (`app/src/services/shareLedger.ts:178-189`). It has no hook for "refuse
if any OTHER entry counts". A builder who checks `ledgerRowCounted` first and
then calls it has a check-then-write gap. A broadcast acceptance landing in
between (`jobs/broadcastFanOut.ts:1270`, `services/shareAttemptOutcome.ts:188`)
produces a pair with both entries counted. If the flyer's `countedAt` is later,
the pair reads `signed_up` with a broadcast also counted, and `sentAt` moves
past the broadcast: the exact state first-sight was introduced to prevent.

**Implies.** Specify the first-sight test INSIDE the conditional read-modify-
write: a predicate on the consistent read the token write is conditioned on,
returning `'refused'` exactly like `mayReplace`. Name it in section 4 under
`shareLedger.ts` (a new entry point or parameter), plus a test with an
interleaved broadcast write.

---

## 7. [LOW] For an `unknown` contact, the new flyer entry has no list to appear on: `UnknownFile` renders no Properties sent card

M13 extended D7 to `unknown` contacts, and Goal 4 says the property goes "on
their properties-sent list". The contact page renders a Properties sent card
only in `TenantFile` and `PartnerFile` (`ContactDetail.tsx:1247-1251,1297-1304`).
`UnknownFile` is passed no `listingsSent` (`ContactDetail.tsx:1272-1290`). The
entry shows on the property's Sent to card, and on the contact page only after
staff triage the contact to tenant or partner. Probably the right outcome (it
preserves the record for triage), but Goal 4 and the e2e line should say so.

---

## 8. [LOW] The consent stamp must be a conditional write

D6.5 says "only when absent" and "through `contactsRepo.update`", but gives no
guard. The decision reads the holder image from a GSI query plus non-consistent
owner reads (`contactsRepo.ts:1258-1283`), so a consent staff recorded a moment
earlier can be missing from it. An unguarded SET then overwrites a
`verbal_in_person` or `paper_form` consent with `web_form`. The repo already
supports the right write: `update(id, patch, { expect: { attr: 'consent_method',
value: null }, notDeleted: true })` (`contactsRepo.ts:712-734`; null means
absent at `:1618,1641`). Name it, and treat a lost guard as "already
consented", not as a failure.

---

## 9. [LOW] The per-contact cap suppresses the pin while D7 still writes the entry, so "the `signed_up` pin says which flyer" is false for a second flyer the same day

D6.1 skips steps 2 and 3 (pin, unread) when any `signed_up` exists in 24 hours.
D7's ledger write is not one of those steps (D6.4 lists it separately). A
tenant who signs up from flyers A and B an hour apart gets a pin for A only,
while B appears on the sent list as "Signed up from the flyer". D7 says "No
'Property sent' milestone is written for it. The `signed_up` pin says which
flyer" - not for B. The cap also lets an attacker's daily pin pre-empt the
genuine person's sign-up that day: no pin and no bump for the real lead. State
both as accepted, or exempt a pin whose `refId` is a shareable unit not pinned
in the window (still bounded by the number of shareable units).

---

## 10. [LOW] D8 asks five callers to compute "the latest counted entry is flyer" themselves, against "the ONE derivation"

D8: "Each caller computes 'latest counted entry is flyer' from the row's stored
`shares`." There are five callers (`broadcasts.ts:612`, `contacts.ts:1324`,
`units.ts:240,260`, `followUps.ts:168`). `listingSendOutcome.ts` exists so
"the units recipients read, the contact listings-sent read, the outcome route
and the follow-ups list can never disagree" (`listingSendOutcome.ts:1-12`). The
"latest counted entry" rule already lives in `summarize`
(`shareLedger.ts:112-120`). Pass `shares` into `deriveListingSendOutcome` (its
`row` input already takes the row), or export one helper beside `summarize`.
Five hand-rolled copies of a rule are the drift the module was written to
prevent.

---

## 11. [LOW] Touch-then-increment: say how the event gets the new count, and what is emitted when the increment fails

`touchLastActivity` returns the ALL_NEW image BEFORE the increment
(`conversationsRepo.ts:1626-1655`). `incrementUnread` returns only the new count
(`:1742-1758`). `toConversationUpdatedEvent` reads `item.unread_count`
(`app/src/lib/events.ts:89-99`). The builder must splice the count into the
touched image, which is fine but should be written down. If the increment
throws after a successful touch, D6.4 swallows it. Say whether the one event
still goes out with the old count, so open dashboards still re-sort the bumped
row (`useInbox` head-reads on any event, per R1-A).

---

## 12. [LOW] Small gaps in the rev 2 text

- D3.2: when the street line is absent, the h1 "reads that city line", and the
  "second, smaller line in the same link reads 'city, state zip'". As written,
  the city line appears twice. Say the second line is omitted in that
  fallback.
- D4 deleted path: with several deleted holders, which contact is the audit
  entity (`public.ts:420` keys `contacts#<id>`)? See finding 1.
- D6.4 says the sent-list write is best-effort, but not what a failed
  first-sight READ does (skip the write, presumably). One sentence.

---

## Contested adjudications

- **M6 (deleted path) and M7 (holder choice): not closed.** The two fixes
  cancel out. `findAllByPhone` cannot report "only deleted holders"
  (finding 1), and the ranking is not followed by the inbox, the unread feed or
  the send gates (finding 2). M7 adjudicated reviewer A's first two bullets and
  not the third (pin and inbox row on different contacts).
- **M4 (readers): partly closed.** "Every outcome reader is listed in section
  4" is not true: `listingFormat.ts` `groupSendRows` is missing, and the Card
  action gate is not addressed (finding 3). The fix also covers only unsent
  pairs (finding 5).
- **M10 (consent): partly closed.** The stamp goes on the ranked holder, while
  the JIT gate judges the `findByPhone` holder (finding 2). It also needs a
  guard (finding 8), and it reopens the welcome question (finding 4).
- **M2 (ledger shape): correct shape, unenforced rule.** First-sight needs to
  live inside the token loop (finding 6).
- **M13 (unknown gets the row): correct, but only half visible** (finding 7).
- **M1 (per-contact cap): closes the flood.** Its side effect on D7's "the pin
  says which flyer" is unstated (finding 9).

Checked and agreed: M3, M5, M8, M9, M11, M12, M14 (with finding 11's note), M15,
M16, M17, M18.

## Concessions

- My R1 #6 claim "the only re-typer is caseworker conversion" was wrong. The
  contacts PATCH propagates a retype to the contact's 1:1 conversations
  (`app/src/routes/contacts.ts:537-543,1658`). The rev 2 fix
  (`conversationTypeFor(contact)`) is still right, and its team-member answer
  (`unknown_1to1`) matches the inbound path (`twilio.ts:221-232`).
