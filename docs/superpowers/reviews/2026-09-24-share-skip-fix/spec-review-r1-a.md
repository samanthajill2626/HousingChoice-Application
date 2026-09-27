# Spec review r1 (reviewer A) - share-skip-fix design

Spec: `docs/superpowers/specs/2026-09-24-share-skip-fix-design.md` (v1, commit 2ae02544).
Method: every claim below was checked against the code in this worktree, read-only.
Scope: top-level spec review. Findings are limited to wrong claims about current
behavior, decisions that are wrong, missing, ambiguous or contradictory,
guarantees the mechanism cannot deliver, and surfaces the spec never names. No
implementation steps are proposed.

Severity key: BLOCKING = the build cannot proceed correctly; HIGH = ships a real
regression or cannot meet a stated acceptance criterion; MEDIUM = two reasonable
builders build different things, or an invariant is false as stated; LOW = worth a
sentence.

---

## F1. [HIGH] Retries deliver the property on a message the "counted" rule never sees; D5/D6 un-count pairs the tenant actually received

**What is wrong.** D5 defines "counted" purely from the share's recipient slot, and
D6 makes a delivery failure un-count the ledger pair. But the product has two
recovery paths that re-send a failed share text as a NEW message that carries no
broadcast id, so its outcome never reaches the slot or the ledger:

- The 30003 automatic retry. The status webhook rolls the first 30003 failure into
  the slot as `failed` (the `undelivered` callback maps to `failed`), then enqueues
  the retry. The retry sends a new message with no `broadcastId`; its later
  `delivered` callback finds no `broadcast_id` and rolls into nothing.
- The manual Retry button, which the share results page itself tells staff to use
  for a failed row ("open conversation to retry"). Same shape: new message, no
  broadcast id.

After this branch, a tenant whose first attempt failed 30003 and whose retry
delivered 60 seconds later would be: not "Already sent" (D5a), dropped from
"Properties sent" / "Sent to tenants" (D6), excluded from the property activity
count (D5c), and the share would read "Not sent" if they were the only recipient
(D7). Meanwhile the same results row reads "Failed - Phone unreachable - will
retry (error 30003)" (the spec keeps "the existing carrier-code wording"), the
conversation shows the delivered retry, and the tenant timeline still says
"Property sent". Today those surfaces happen to be right in this case: the ledger
row is never un-counted and the "already sent" union includes failed recipients.
So D6 turns a correct answer into a wrong one for a common failure class, and the
D6 repair pass would permanently un-count historical rows of exactly this kind.
Consequence for Sam: the property shows as not sent, she re-shares, the tenant gets
it twice.

A related over-claim: G1 says a staff share "reaches the tenant regardless of the
switch", but the 30003 retry of that staff share is still an automated send and is
refused for a switched-off (breaker-tripped, excluded-from-D2) conversation. The
non-goal defers "retries that follow the original sender", so G1 should not claim
the guarantee unconditionally.

**Evidence.**
- Retry job sends without a broadcast id and only annotates `retryOf`:
  `app/src/jobs/retrySend.ts:200-207`, `:226-229`.
- Manual Retry route, same: `app/src/routes/api.ts:1642-1652`.
- Only the original share send is stamped: `app/src/jobs/broadcastFanOut.ts:417-423`.
- Rollup only runs when the message carries `broadcast_id`:
  `app/src/routes/webhooks/twilio.ts:3312-3328`; 30003 enqueues the retry:
  `:3350-3369`; `undelivered` becomes a `failed` slot: `:3576-3581`, `:3653-3662`.
- The copy the spec keeps promises a retry: `dashboard/src/routes/contact/deliveryStatus.ts:778`
  ("Phone unreachable - will retry"), and `:850-851` ("a 1:1 30003 retry genuinely does send").
- Results page points staff at the manual retry: `dashboard/src/routes/broadcasts/BroadcastResults.tsx:63-67`.
- Today's union counts failed recipients of sent shares: `app/src/repos/broadcastsRepo.ts:536-538`;
  the ledger is never touched on failure (no writer outside the fan-out:
  `app/src/jobs/broadcastFanOut.ts:475-489`).
- Spec section 5 lists recipient-outcome writers as the send route, the fan-out and
  the delivery rollup only; neither retry path is named.

**What it implies.** The spec must decide how a retry relates to the share it
retried (does a retrying failure un-count at all; does a delivered retry re-count;
does the D6 repair skip retried pairs) before D5/D6/D7 can be built. As written, G3
and I3 cannot be delivered by the D5 mechanism.

---

## F2. [HIGH] D5(c) "must be right for shares already on record" names only the finalize writer; only an unstated read-time join can deliver it

**What is wrong.** The property activity entry stores `tenantCount` (the TOTAL
recipient count) in the audit payload at finalize, and BOTH readers render the
stored number. D5(c) requires the count to follow D5 and to be right for the four
shares already on record, but:

- Changing the finalize writer cannot fix history (the four existing rows keep
  `tenantCount: 1`), and I7 forbids any production write other than D2 and the D6
  repair, so there is no backfill.
- Even for new entries, a count written at finalize goes stale: D5 counts `sent`
  slots, and delivery callbacks that arrive after finalize turn them `failed`.
- The only mechanism that satisfies D5(c) is a read-time join from each
  `broadcast_sent` audit row to its broadcast item, on both the property Activity
  route and the landlord timeline interleave. The spec never says so, and section 5
  lists "Writer: fan-out finalize" as the surface. Each broadcast item carries the
  full recipients map (up to ~300KB), and the landlord interleave walks up to 25
  units per timeline page. D6 explicitly bans a per-row join for the ledger on cost
  grounds; D5(c) silently requires one elsewhere, on a class of read the repo
  already tracks as a cost problem (`docs/issues/broadcast-results-enrichment-read-cost.md`).
- D5's closing sentence, "computed from stored outcomes, so it corrects history as
  soon as it ships", is true for (a) only. (b) needs the post-deploy D6 repair
  pass, and (c) needs the join above.

Two reasonable builders diverge: one changes finalize (fails the explicit
acceptance on Sam's four shares and drifts after later failures); the other joins
at read time (meets it, at a cost the spec never accepted).

**Evidence.**
- Writer: `app/src/jobs/broadcastFanOut.ts:679-689` (`tenantCount: total`).
- Readers render the stored count: `app/src/routes/units.ts:183-213` (`:209`),
  `app/src/routes/contactTimeline.ts:670-678`, `dashboard/src/routes/listing/listingFormat.ts:130-135`.
- Post-finalize slot changes: `app/src/routes/webhooks/twilio.ts:3653-3679`.
- Item size: `app/src/repos/broadcastsRepo.ts:58-67`. Landlord walk bound:
  `app/src/routes/contactTimeline.ts:275-276`.
- Spec D5(c), D5 final paragraph, I7, section 5 "Property activity entry".

**What it implies.** The spec must pick the semantics (count at finalize vs live
count) and the mechanism that goes with it, and either accept the read cost or
drop the "right for shares already on record" requirement.

---

## F3. [MEDIUM] `queued` counts stranded slots, and the ledger (written only on acceptance) cannot follow D5 for `queued` as D6 requires

**What is wrong.** Two separate problems with making `queued` count:

1. Slots can sit `queued` forever with nothing waiting to send them:
   - Send-route enqueue failure: the share is marked `failed` with every slot still
     `queued` from markSending.
   - The unknown-error throw in the fan-out (known, deliberately unfixed): the
     current and all later recipients stay `queued` and the share is never finalized.
   Today the "already sent" union skips `failed` shares by lifecycle status. D5
   defines counting by slot status alone and names drafts as the only lifecycle
   exclusion ("A draft never counts"). A builder who follows D5 literally will count
   an enqueue-failed share's `queued` slots, so those tenants become permanently
   "Already sent" for a property nobody sent them. That is a regression. D5's own
   definition of `queued` ("waiting on our side, including a rate-limit retry wait")
   is not true of these slots.
2. D6 bullet 1 says a pair counts while any share of it is counted under D5,
   which includes `queued`. But the only ledger writer is the fan-out, after the
   carrier accepts; section 5 lists no queue-time writer. So during every in-flight
   window, and permanently for stranded slots, the review list says "Already sent"
   while "Properties sent" and "Sent to tenants" say nothing. G3 ("one rule ...
   every surface follows it") does not hold. A builder who honors D6 literally adds
   a ledger write in the send route, which then makes stranded slots show in
   "Properties sent" forever.

**Evidence.**
- markSending seeds `queued`: `app/src/routes/broadcasts.ts:742`; enqueue failure
  marks the share failed and leaves the slots: `:756-770`.
- Stranded-queued throw: `app/src/jobs/broadcastFanOut.ts:553-564`.
- Today's lifecycle filter: `app/src/repos/broadcastsRepo.ts:537`.
- Ledger written only after acceptance: `app/src/jobs/broadcastFanOut.ts:475-489`.
- The perf seed also writes draft shares WITH `queued` slots, so the draft exclusion
  is load-bearing: `app/src/lib/seed/performance.ts:989-993`, `:1017-1023`.
- Spec D5, D6 bullet 1, section 5 "Ledger. Writers".

**What it implies.** The spec must say whether `queued` counts only while the share
is live, and whether the ledger follows D5 for `queued` (a new writer) or counts
only from acceptance (in which case D6 bullet 1 and G3 need an explicit exception).

---

## F4. [MEDIUM] I4 and D5(a) collide with the existing "seeded rows are always pre-checked" rule, which governs the one-to-one flow

**What is wrong.** The review list pre-checks any SEEDED row even when it is already
sent. A one-to-one share is by definition one seeded row, and tenants added by hand
are persisted as seeds, so after any re-preview they come back seeded too. So:

- I4 ("a second share of a property never re-proposes a tenant whose text is still
  queued or on its way") is false today for the one-to-one flow, the flow at the
  heart of #5, and the spec neither keeps nor removes the seeded exception.
- D5(a) lists "the default-unchecked state ... including tenants added by hand".
  With the seeded exception in place, that holds only until the step is reloaded.
- If the builder removes the exception to satisfy I4, a one-to-one share of an
  already-sent property opens with its only row unchecked. The resolved-mode guard
  then blocks Send with "This message was written for {name}. Head back to edit the
  audience or message.", which is wrong advice: the fix is to tick the row.

Two reasonable builders build different things here, and both pass the stated tests.

**Evidence.**
- `dashboard/src/routes/broadcasts/RecipientPreview.tsx:76-80` (seeded rows pre-checked
  regardless of already-sent), `:198-220` (hand-adds persisted as seeds), `:122-124`
  and `:457-461` (resolved-mode guard and its copy).
- Seeded flag comes from the draft's seed list: `app/src/routes/broadcasts.ts:497-499`, `:548`.
- One-to-one mode is exactly one seed: `dashboard/src/routes/broadcasts/BroadcastComposer.tsx:63-66`, `:107`.

**What it implies.** The spec must decide whether an already-sent seeded row is
pre-checked, and scope I4 to match.

---

## F5. [MEDIUM] D4's safety rests on a WP3 requirement the spec says is recorded, but is not recorded anywhere, and D10 does not add it

**What is wrong.** D4 makes every share created by a staff user a person's send,
which bypasses the switch and the breaker. The protection against a future engine
doing the same is "WP3's engine-sent shares must be created under a non-user
identity ... (recorded in the WP2/WP3 issue text; nothing to build now)". The only
related issue, `ai-mode-switch-gates-all-automation` (already committed, ef383e2e),
has no such item: its seven WP2 deliverables never mention share creators, engine
identities or WP3. No WP3 issue exists. D10's filing list does not include adding
it. As written, no one on this branch is instructed to record it, and the
convention that decides whether engine shares are breaker-metered will exist only
in this spec.

Related ambiguity in the same rule: G1 says "a share a staff member STARTS". D4
keys on the draft's recorded creator, not on the person who clicks Send (the send
actor is only in the `broadcasts#` audit event, not on the item). An engine-created
draft that a person reviews and sends therefore stays automated. That may be
intended, but G1's wording does not say which of the two acts counts.

**Evidence.**
- `docs/issues/ai-mode-switch-gates-all-automation.md:51-64` (no creator/WP3 item);
  `grep WP3 docs/issues` finds nothing.
- Creator stamp: `app/src/routes/broadcasts.ts:369`, `:449`; the send actor is
  audit-only: `:584`, `:772-775`.
- Spec D4 bullet 4, D10, G1.

**What it implies.** Either D10 amends the issue (or files a WP3 one) with the
creator-identity rule, or D4 must not claim it is recorded.

---

## F6. [LOW] Duplicate-phone contacts break two D4 statements

**What is wrong.** Duplicate contacts on one phone are a documented, accepted state
(the import leaves them). `findByPhone` returns whichever the index yields first.

- After D4, share sends pass the wrapper's just-in-time consent gate, which checks
  the contact found BY PHONE, not the recipient the fan-out fenced by id. A
  recipient who has consent can now be refused `contact_no_consent` because a
  duplicate without consent was returned first. Typed sends already behave this
  way, but for shares this is a new refusal the spec does not list as one.
- Section 8: "A share sends at most one text per recipient conversation" is false
  for duplicates. Recipients are keyed by contactId, and two contacts with one
  phone resolve to the same conversation, so it gets two texts. The breaker
  conclusion still holds; the premise does not.

**Evidence.** `app/src/repos/contactsRepo.ts:1012-1016`, `:1025`;
`app/src/services/sendMessage.ts:307`, `:338-344`; `app/src/jobs/broadcastFanOut.ts:366`,
`:397`, `:410`; `app/src/routes/broadcasts.ts:268-277`, `:654-667`.

---

## F7. [LOW] D2's positive list of one-to-one types disagrees with the codebase's negative definition

**What is wrong.** D2 targets "tenant, landlord, partner, unknown-number". The repo
defines one-to-one NEGATIVELY: not relay_group and not group_text. A legacy row with
no `type` counts as one-to-one, and the send wrapper treats it as one: it passes the
channel guard and reads the switch. A manual, type-less row would be left off by D2
and stay suppressed, against G2. D1's census should report "no type" so Cameron can
see whether this matters.

**Evidence.** `app/src/repos/conversationsRepo.ts:83-91`, `:1737-1740`;
`app/src/services/sendMessage.ts:297-302`, `:348-349`.

---

## F8. [LOW] G2 and I3 are stated as absolutes that the spec's own design does not deliver

- G2, "Every one-to-one conversation has the switch on": D2's bulk mode excludes
  breaker-tripped rows by default, and the breaker keeps turning switches off after
  D2. In the hermetic perf world, every one-to-one conversation is seeded `manual`
  (the seed is listed as a writer but no target state is given).
- G3/I3, "no surface counts a skipped or failed send as sent": the tenant timeline's
  "Property sent" milestone is written at dispatch and is explicitly deferred (D10),
  so a failed delivery still reads "Property sent" on the same contact page where
  the "Properties sent" card (after D6) no longer lists it.

**Evidence.** Spec G2, D2 bullet 3, I3, section 2 last non-goal;
`app/src/lib/seed/performance.ts:822-832` (`ai_mode: 'manual'` at `:826`), `:836-845`;
`app/src/jobs/broadcastFanOut.ts:453-461`.

---

## F9. [LOW] D7 reason table: three mismatches with the code

- "Opted out (texted STOP)": `sms_opt_out` is also set by the staff Do-Not-Contact
  action, by the import, and by provider 21610 suppression, so "texted STOP" is
  often false (`app/src/routes/contacts.ts:1934-1963`, `app/src/lib/import/apply.ts:1029-1033`,
  `app/src/routes/webhooks/twilio.ts:3500`).
- `contact_opted_out` already has shared wording in "the dashboard's existing reason
  wording" meaning the GROUP aggregate ("Everyone here has opted out - nothing was
  sent"). Putting the new copy there changes group bubbles; leaving it gives
  broadcast rows the group sentence. The spec's placement rule does not settle
  which (`dashboard/src/routes/contact/deliveryStatus.ts:884-890`, `:913-914`).
- "Every skipped or failed recipient carries a recorded reason" cannot hold for a
  carrier failure callback with no ErrorCode, which the webhook documents as
  possible. The slot is written without a code (`app/src/routes/webhooks/twilio.ts:3330-3333`,
  `:3659`).

---

## F10. [LOW] "Not sent" is presentation-only, so Sam's case lands under the "Sent" tab, while an equivalent all-failed share reads "Failed"

An all-skipped share, or one whose every text failed after dispatch, keeps stored
status `sent`, so it appears under the "Sent" tab with a "Not sent" pill. A share
whose every recipient failed inside the fan-out is status `failed` and reads
"Failed" under the "Failed" tab. Two shares that reached nobody are labeled and
filed differently, and a staff member looking for what did not go out will not
find Sam's case under "Failed". The spec chose this deliberately ("the list's
status tabs are unchanged"), but it should say it accepts the split.

**Evidence.** `dashboard/src/routes/broadcasts/BroadcastsList.tsx:20-26`;
`app/src/jobs/broadcastFanOut.ts:690-693`; spec D7 last bullet.

---

## F11. [LOW] D6's "an earlier delivered share keeps it counted" leaves the pair's row describing the failed share

The ledger keeps one row per pair, carrying the LATEST share's `sentAt` and
`broadcastId`. When the latest share fails and an earlier delivered share keeps the
pair counted, the row still dates and links to the failed share. Readers order by
`sentAt`: the "Properties sent" order, and the tour-scheduling form's default
property, which takes the newest row. The spec does not say which share a counted
pair should describe.

**Evidence.** `app/src/repos/listingSendsRepo.ts:136-177`, `:192-201`;
`dashboard/src/routes/contact/ContactDetail.tsx:1158-1162`.

---

## Section 1 claims - verified

1. VERIFIED. The fan-out sends every recipient `automated: true` through the wrapper
   (`app/src/jobs/broadcastFanOut.ts:417-423`).
2. VERIFIED. Kill switch, opt-out and deleted apply to all sends; the consent gate
   applies to person sends only; the switch and breaker apply to automated sends only
   (`app/src/services/sendMessage.ts:286-289`, `:304-327`, `:338-344`, `:348-367`).
3. VERIFIED, with a nuance. The import writes `ai_mode = if_not_exists(..., 'manual')`
   for both 1:1 and group rows (`app/src/lib/import/apply.ts:1087-1107`). `setMode` has
   exactly one caller, the breaker (`sendMessage.ts:352-358`), and no UI or API writes
   the switch. Nuance: the import's `if_not_exists` also writes onto any EXISTING row
   that lacks `ai_mode` (the lean tenant conversation has none, `app/src/lib/seed/lean.ts:225-236`),
   so "after creation only the breaker writes it" is slightly too strong. D3 makes
   this harmless for 1:1 rows.
4. VERIFIED. Every `automated: true` caller: broadcast, tour reminder (1:1 route),
   placement nudge, missed-call, public welcome, 30003 retry (repo-wide grep; for example
   `app/src/jobs/tourReminders.ts:1440`, `app/src/routes/public.ts:300`, `app/src/jobs/retrySend.ts:205`).
5. VERIFIED (`broadcastFanOut.ts:381-390`, `:491-503`; `broadcastsRepo.ts:249-252`;
   `DeliveryBadge.tsx:30-31` shows a reason only on failure; `broadcastFormat.ts:98-100`).
6. VERIFIED (`broadcastFanOut.ts:690-693`).
7. VERIFIED (`broadcastsRepo.ts:524-550`). Precisely: shares whose lifecycle status is
   `failed` are excluded (see F3).
8. VERIFIED (`broadcastFanOut.ts:475-489`; no other production writer of `listing_sends`).
9. VERIFIED (`broadcastFanOut.ts:685`; `units.ts:209`; `contactTimeline.ts:670-678`;
   `listingFormat.ts:130-135`).
10. VERIFIED (`dashboard/src/routes/broadcasts/resolveTemplate.ts:24-25`, used by both
    prefill effects, `BroadcastComposer.tsx:186-214`).

Also checked and consistent: the switch readers named in section 5 (`routes/tourReminders.ts:1034`,
`routes/contactTimeline.ts:883`; the placement-nudge preview passes `aiMode: undefined` and
does not read the switch); relay and group sends never read the switch (`jobs/relayFanOut.ts:1389`
goes straight to the adapter); one AWS account holds both stacks, so D2's account check plus
the explicit table prefix is the right guard; the breaker cap (10/min) and the per-user share
limit (5/min) match section 8 (`app/src/lib/config.ts:991`, `:1030`).

Context note (not a finding): the architecture doc does define `ai_mode` as the AI
Auto/Manual control, but the same doc's echo-chamber section designs the breaker to
"flip the conversation to Manual" and its risk table says "Manual-by-default". So the
breaker coupling was designed, not a build deviation, and all-`auto` after D2 is the
opposite of that doc's intended AI default. The WP2 issue's item 7 covers the second
point. (Read from `documentation/HousingChoice_Architecture_and_Build_Plan.docx`, text extracted.)

## UNVERIFIED

- "This matches Sam's screenshot" (D8) and the wording of improvements-list items
  #4 and #5: neither is in the repo.
- The production facts in the diagnosis record (read, not re-run).
