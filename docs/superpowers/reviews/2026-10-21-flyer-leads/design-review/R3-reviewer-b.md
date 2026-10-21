# Flyer leads design - adversarial review R3 (reviewer B, continued)

Spec: `docs/superpowers/specs/2026-10-21-flyer-leads-design.md`, revision 3
(@845d427a; diffed against rev 2 @bd73315c). Also read: the round 2 rulings
appended to `adjudications.md`.
Read-only: nothing edited, staged, committed or run beyond reads and grep.
Line references are `path:line` in `W:\tmp\flyer-leads`. UNVERIFIED marks a
claim I could not prove from the code.

Summary: rev 3's three reversals are sound in direction, and most R2 findings
are closed. The one material new defect is in the always-write rule: repeat
flyer writes are uncapped, so a staff decline can be undone indefinitely,
which contradicts the stated mitigation and the "harmless" claim.

---

## 1. [MEDIUM] Repeat flyer writes are uncapped, so "staff can decline again" does not hold: every later re-submit supersedes the decline staff recorded after seeing the sign-up

**Mechanism, checked.**
- A repeat flyer sign-up writes a newer attempt key on the same share key
  `flyer`. `mayReplace` accepts it: `compareAttemptKeys(next, existing) === 1`
  returns true for a counted-by-acceptance entry (`shareLedger.ts:77-90`).
- `summarize` then moves the pair's `sentAt` to the new sign-up
  (`shareLedger.ts:112-120`).
- `effectiveDecline` stops counting any decline older than `sentAt`
  (`listingSendOutcome.ts:47-58`).
- D6.1 exempts the ledger write from the 24-hour cap on purpose ("The cap
  governs the pin and the bump only").

So nothing bounds how often a pair's decline can be superseded.

**What rev 3 says about it.**
- D7: "Repeat flyer sign-ups for the same pair write a newer attempt key, so
  `sentAt` moves forward. That is harmless."
- Residual: someone who knows the phone can "resurface a declined pair as
  `signed_up` ... Staff can decline again; the per-IP rate limit applies."

Both are false together. Take the sequence: sign-up -> staff call -> tenant
says no -> staff mark Not interested (`units.ts:1671`). The next submit on
that flyer clears it again: genuine, an attacker at 5 per minute per IP
(`config.ts:1008`), or a caseworker re-forwarding the link. "Decline again"
is a loop the public side always wins. Each supersession puts the tenant back
in that property's Interested group and checks them by default in its next
blast (`broadcasts.ts:595-618`, `blastAudienceRules.ts:178-183`): a text about
a home they turned down. No timeline event records that the decline stopped
counting. Supersession is derived at read time, not written. And if the D6
cap skipped the pin, nothing in the thread explains it.

The decline is also not "newer interest in that home". Rev 3's own sign-up
copy reads "Sign up for home alerts. We'll text you about this home and
others that fit your voucher" (D3.8). A tenant who declined this home and
re-submits its forwarded flyer to get alerts about OTHER homes clears their
decline of THIS one.

**Implies.** Keep always-write for the first flyer entry. Choose one rule for
a repeat and state it, so a decline staff recorded AFTER a sign-up survives
the next one:
- (a) a repeat flyer entry is not written while the pair's decline is newer
  than its existing flyer entry; or
- (b) a repeat never moves `sentAt` (write it only when the existing flyer
  entry is older than the window, aligned with D6.1); or
- (c) state the loop as accepted.

Option (a) is a check inside the same consistent read the token write uses
(`shareLedger.ts:183-188`), so it does not reintroduce the R2-6 enforcement
problem. Add a test: decline after sign-up, then a second sign-up - the
decline holds.

---

## 2. [LOW] The "exactly as today" consent path makes staff attest a method they do not hold: the consent prompt has no web-form option

Rev 3 reverts the stamp (accepted, and now out of scope in section 3), and
says staff's first text "goes through the existing consent prompt
(`ConsentCaptureModal`) ... exactly as today", with the form's
`consentVersion` kept on the audit event as evidence.

The prompt can only record HUMAN methods: `client_inbound`, `verbal_phone`,
`verbal_in_person`, `paper_form`, `imported`
(`app/src/lib/smsCompliance.ts:75-87`; dashboard mirror
`dashboard/src/lib/consentCopy.ts:46-60`). `web_form` is not one of them. The
contact's actual basis - the web form the server just enforced
(`public.ts:127-131`) - cannot be selected. To text the lead the unread mark
surfaced, staff must pick a method that is not what happened, or not text.
The audit row holds the true evidence, but the contact record will hold a
different one.

The R2-4 ruling calls this "friction, not a dead end". It is a dead end for an
accurate record. No change to the decision is proposed (it is in section 3);
state this consequence at Cameron's gate.

---

## 3. [LOW] A dangling phone pointer that sorts first makes every sign-up mint a new contact and a welcome text, uncapped

`findByPhone` reads `Items[0]` only. A pointer whose owner is missing returns
`undefined` (`contactsRepo.ts:1301-1312`), even when a live holder sits at
`Items[1]`. Rev 3's "No holder" branch then creates a NEW contact and sends
the welcome. The next sign-up can hit the same dangling first item and do it
again. A fresh contact has no `signed_up` history, so the D6 cap never applies.
D5's "created by this request" rule means every request welcomes, so neither
guard stops the SMS spend.

This is pre-existing: today's route does the same. Its rarity is UNVERIFIED.
There is no contact hard-delete in `contactsRepo` - the only `DeleteCommand`s
remove pointer rows (`contactsRepo.ts:1147,1220`) - so a dangling pointer is a
crash or partial-write leftover. One sentence in D4's residual is enough. A
fix is out of scope.

---

## 4. [LOW] A lost flyer ledger write is logged as "the repair heals it", but the repair never sees flyer entries

`applyShareLedgerEntry` gives up after `MAX_REAPPLY` lost conditions with the
ERROR "the entry write lost its condition past the re-read bound - the repair
heals it" (`shareLedger.ts:189-194`). The repair rebuilds entries only from
broadcast recipient slots (`app/scripts/repair-share-outcomes.ts:16-18,55-67`;
`ledgerEntryForSlot`, `shareLedger.ts:155-170`). A flyer entry lost to
contention with a concurrent broadcast write on the same pair is simply gone.

D6.4 already makes it best-effort, and `sentRecorded: false` records it. Say
that the log line's promise does not cover flyer entries (or pass a distinct
message), so an operator does not run the repair expecting it back.

---

## 5. [LOW] The touch-failure branch is unstated

D6.3 now covers a failed increment (still emit the touched image). It does not
say what happens when `touchLastActivity` itself throws. The intent ("a
failure can never leave a closed thread flagged unread but invisible")
requires skipping the increment, and there is no image to emit. One sentence:
on a failed touch, no increment and no event.

---

## 6. [LOW] "The newest counted entry wins" compares instants from two clocks

A broadcast entry's `countedAt` is Twilio's `dateCreated`, which is whole
seconds (`app/src/adapters/messaging.ts:870`, via the attempt key's ISO,
`shareLedger.ts:49-55`). A flyer entry's is the app's millisecond clock. A
broadcast sent within the same second as a sign-up, or within normal NTP
skew, can order either way. The consequence is cosmetic (`signed_up` versus
`no_reply` for a pair touched twice in a second), so state it rather than fix
it.

---

## 7. [LOW] Two small overstatements in the new D8 renderer rules

- "Request a tour" can never appear on a `signed_up` row. The host passes
  `requestTourTo` ONLY for a partner (`Card.tsx:252-254`), and D7 writes flyer
  entries only for tenant and unknown contacts. The list should read
  "Interested (tenants) and Not interested".
- `groupSendRows` files `interested` rows ahead of the eligibility test
  (`listingFormat.ts:345-350`). Filing `signed_up` the same way puts an
  opted-out, unreachable, inactive or placed tenant's sign-up under
  "Interested", not "Not eligible", although the row cannot be texted
  (`isEligibleRecipient`, `listingSendOutcome.ts:95-109`). Decide which group
  wins and test it.

---

## Rulings: contested and conceded

- **R2-1 (deleted path): concede, closed.** `findByPhone` sees soft-deleted
  holders (`contactsRepo.ts:1287-1314`). The deleted path is reachable, and
  the audit entity is named. Its own sub-case is finding 3.
- **R2-2 (holder disagreement): concede, closed.** One read for every judge.
  The shared-phone residual is honestly stated, with the right citation
  (`contactsRepo.ts:1288`).
- **R2-3 (actions, grouping): closed,** with finding 7's two nits.
- **R2-4 (consent): accept the reversal; contest "friction, not a dead end"**
  (finding 2).
- **R2-5 (first-sight): closed, but the replacement introduces finding 1.**
- **R2-6 and R2-8 (moot): agree.**
- **R2-7, R2-9, R2-10, R2-12: agree.** R2-10's single helper plus `shares`
  into `deriveListingSendOutcome` is the right shape.
- **R2-11 (event splice): agree.** Splicing `unread_count` into the touched
  image matches `toConversationUpdatedEvent` (`events.ts:89-99`), and the
  failed-increment emit is stated. The remaining gap is finding 5.

Checked and found correct in rev 3:
- always-write on the existing `flyer` key always replaces a strictly older
  attempt (`shareLedger.ts:78-90`). An identical-millisecond repeat is
  refused as a no-op, which is fine.
- `summarize` mapping `flyer` like `individual` removes `broadcastId`
  (`shareLedger.ts:119`), and no dashboard reader uses the row's
  `broadcastId`.
- all five `deriveListingSendOutcome` callers are listed (`broadcasts.ts:612`,
  `contacts.ts:1324`, `units.ts:240,260`, `followUps.ts:168`), and every one
  reads full rows that carry `shares` (base table or a GSI projected ALL,
  `lib/tables.ts:14`).
- the outcome route accepts any counted row (`units.ts:1553-1556`), so the
  new `signed_up` actions work server-side.
