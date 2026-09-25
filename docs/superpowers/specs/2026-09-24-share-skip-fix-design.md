# Share skips, "Already sent", and the one-to-one share message - design (Branch A)

Date: 2026-09-24 (cut to Branch A on 2026-09-25). Branch: `feat/share-skip-fix`.
Source: Sam's improvements list (2026-09-24) items #5 and #4, under Amendment
No. 2 (support). Diagnosis record:
`docs/superpowers/reviews/2026-09-24-share-skip-fix/diagnosis.md`. Review
history (four adversarial rounds on the pre-split spec, v1-v5, and the split
decision): `docs/superpowers/reviews/2026-09-24-share-skip-fix/`.

**Branch split.** The pre-split spec (v5, commit `3a6a1a06`) also redesigned
how a property counts as sent to a tenant across retries, the listing-send
ledger, the property activity count and the share labels. That rule shares its
object with two other branches at their spec gates - `feat/retry-send-window`
(RSW) and `feat/send-outcome-reconcile` (SOR) - so it moved to a follow-on,
Branch B: `docs/superpowers/specs/2026-09-25-share-sent-outcome-design.md`,
planned after RSW and SOR merge, on SOR's attempt record. This document is
Branch A: everything Sam reported, built on nothing the other branches change.
Agreed sequencing (all three agents, 2026-09-25): A, then RSW, then SOR, then
the `retrySend` adoption and B. Record:
`docs/superpowers/reviews/2026-09-24-share-skip-fix/branch-split.md`.

This is a TOP-LEVEL spec: it fixes behavior, rules, invariants and the surfaces
they reach. Mechanics belong to the implementation plan.

Vocabulary. GLOSSARY: staff-facing copy says "property", tenant-facing says
"home", code says `unit`; the Matching item is a "send" or "property send".
Shorthand used in THIS DOCUMENT ONLY (never UI, RUNBOOK or issue copy): a
"share" is a broadcast; a "one-to-one share" is a broadcast with exactly one
seeded recipient started from that tenant's file; a "blast" is a filter-audience
broadcast. "The switch" is the per-conversation `ai_mode` field
(`auto` | `manual`).

---

## 1. Problem

What Sam sees:

- #5: a one-to-one share often ends "Skipped", on every retry, for particular
  tenants, although the property is available, the tenant is Searching and consent
  is recorded. Typed messages to the same tenants go through. Afterwards the
  recipient review marks the tenant "Already sent", so Sam pastes the flyer link by
  hand.
- #4: mid-conversation she wants the share to be just the address and the link.

What happens today (each claim verified in the code by two reviewers; the
diagnosis confirmed the first four in production for the tenant Sam named):

1. The broadcast send job sends every recipient through the one-to-one send
   wrapper marked AUTOMATED, even when a staff member clicked Send.
2. The send wrapper refuses an automated send when the conversation's switch is
   `manual` (reason `manual_mode`). A person's send skips that check and is never
   counted by the circuit breaker. Every send still passes the kill switch, the
   opt-out gate and the deleted-contact gate; a person's send also passes the
   just-in-time consent gate. The deleted-contact and consent gates check
   whichever contact the phone lookup returns first. STOP and carrier
   suppression are per number by design; staff "Do Not Contact" sets only the
   contact's flag.
3. The Quo import writes the switch `manual` on any conversation row that has no
   value yet (new rows, and existing rows that lack the field). Nothing turns a
   switch back on: there is no UI or API, and apart from that import write, only
   the breaker writes the field after creation (to `manual`, with a
   `mode_changed` audit event, reason `breaker_trip`).
4. The same refusal silently stops every other automated one-to-one text for those
   contacts: tour reminders (one-to-one route), the missed-call auto-text, the
   public sign-up welcome and the 30003 automatic retry. (Placement nudges are
   held for manual sending today and go out as a person's send, so the switch
   never stops one; corrected 2026-09-25 from the plan research.)
5. The fan-out records a refusal on the recipient slot as `skipped` with the
   refusal code, but a skip for opt-out or unreachable at its own first fence
   records NO code. Derived stats count every skipped slot except `no_consent`
   as `skipped_opted_out`. The results page shows only "Skipped".
6. A finished share is marked `sent` unless every recipient FAILED; an all-skipped
   share reads "Sent".
7. "Already sent" is the union of recipient keys of every sending/sent share of
   that property, whatever happened to each recipient: skipped and failed both
   count. A share whose lifecycle status is `failed` is excluded.
8. Every share - one tenant or fifty - starts from the same default message:
   greeting with first name, bedrooms, address, rent, flyer link.

The architecture doc (section 6, "AI Conversation Layer") defines the switch as an
AI control: `auto` = the assistant replies itself; `manual` = the assistant stays
silent and suggests replies, Manual being the intended AI default. The same doc
designed the breaker to flip a conversation to Manual. What it never said is that
system texts - reminders, nudges, the welcome, retries, staff shares - should
read the switch; the build made them. Cameron decided (2026-09-24) to fix the harm
now and defer the redesign to Work Package 2, filed as
`docs/issues/ai-mode-switch-gates-all-automation.md` with his rule verbatim.

## 2. Goals and non-goals

Goals:

- G1. A share a staff member creates reaches the tenant regardless of the switch.
  (Until WP2, an automatic retry of that share is still an automated send and
  honors the switch; after D2 that only matters for a breaker-stopped
  conversation.)
- G2. Every one-to-one conversation not currently stopped by the breaker has the
  switch on, so reminders, missed-call texts, welcome texts and retries work
  again for imported contacts; the import no longer creates switched-off
  one-to-one conversations.
- G3. A tenant whose share was skipped is never marked "Already sent" for it.
- G4. Every skipped or failed recipient shows its real reason; counts stop
  filing other skips under opt-outs; a share in which every recipient was
  skipped never reads "Sent".
- G5. A one-to-one share defaults to the full address and the flyer link.
- G6. A breaker trip has a documented, scripted way back.

Non-goals (do not build; each is filed or owned elsewhere):

- Branch B (`2026-09-25-share-sent-outcome-design.md`): how a FAILED recipient
  counts across retries, the listing-send ledger ("Properties sent" / "Sent to
  tenants") following that rule, the post-deploy repair, the property activity
  count, share labels derived from recipients, the tenant-timeline milestone
  after a failed delivery.
- RSW: every 30003 wording and retry promise, the retry window, the manual
  Retry guard. This branch leaves the existing 30003 copy untouched.
- SOR: send-failure classification, the attempt record, the reconcile job.
- The switch redesign (WP2 issue above); any UI or API for the switch; the
  breaker's cap or behavior; which failures retry.
- The switch value on relay_group and group_text threads (stays `manual`; inert).
- Which tenants a blast targets (Sam's #6, awaiting her answers).
- Re-filing shares under the list's status tabs.

## 3. Decisions

### D1. Census (read-only operator script)

Reports, counts only, no names, phones or message bodies:

- All conversation rows by type and switch state (claim/pointer items excluded;
  rows with no type reported as their own group).
- Switched-off conversations by cause: imported (import stamp), breaker trip (a
  `mode_changed` audit event with reason `breaker_trip`), group thread
  (relay_group/group_text, off by design), other.
- Breaker-tripped conversations listed individually (conversation id, type, trip
  time) for Cameron's review.
- Not-yet-sent tour-reminder rungs that would take the one-to-one route (the
  census replays the reminder job's own target resolution: not a discontinued
  kind, not a group-routed tour, not a tour already started) whose conversation
  is switched off: these start sending once D2 runs. Pending placement nudges
  are reported separately as held manual-only, unaffected by D2.
- Import-created one-to-one conversations whose one-conversation-per-phone claim
  record points at a DIFFERENT conversation (a missing claim is the normal state
  for an imported row; only a mismatch matters) - for the D10 issue.

### D2. Fix script: switch every one-to-one conversation on

- Dry run is the default and writes nothing; applying requires an explicit flag.
- Population: conversation rows whose switch is `manual` and whose type is
  neither relay_group nor group_text - the codebase's own definition of
  one-to-one, which includes legacy rows with no type. Never a group thread.
- Bulk mode excludes conversations with a breaker trip on record unless an
  explicit flag includes them; Cameron reviews the D1 list first.
- Single-conversation mode switches one named conversation on (the breaker resume
  path); it refuses a group thread or an unknown id.
- Every write is conditional on the row still being a one-to-one conversation with
  the switch off, so a re-run or a concurrent change is safe.
- Every switch it turns on gets a `mode_changed` audit event (manual to auto) whose
  reason distinguishes a bulk enable from a single resume.
- Output: counts by type (and, for single mode, the one id).
- Target safety: follows the GUARDED ops-script precedents (`import-apply.ts`,
  `rail-verify.ts`): explicit table prefix, the resolved target logged before
  the first read, and, when the endpoint is not DynamoDB Local, the account is
  asserted as 938565869261 on the `housingchoice` profile and the DynamoDB
  client is built from those same credentials - never the default chain, which
  on the operator's machine belongs to another account. The account check is
  injectable so a test can prove the refusal. D1 follows the same shape.
- Only Cameron runs it against dev or prod (or gives an explicit go per run).

### D3. Import default

The import creates NEW one-to-one conversations with the switch `auto`. Group
rows keep `manual`. A re-run never changes an existing conversation's switch
(D2 handles existing rows).

### D4. Staff-created shares are a person's sends

- Who created the share is decided ONCE, at creation. The dashboard's draft
  route can only be called by an authenticated staff session (the session
  middleware verifies the user still exists, through a 60-second cache), so
  that route records on the share that it is a person's share. The recorded creator id stays as
  attribution.
- The send job reads that record. Present: every recipient is sent as a person's
  send; the switch and the breaker do not apply. Absent - a draft created before
  this change, or by any path other than the dashboard route, including a future
  engine - the share is automated, exactly as today. Unrecognized means automated
  (the safe direction). Nothing is looked up on the send path, so there is no
  read-failure case, and a draft whose creator has since left the team keeps its
  record.
- The creator decides, not the person who presses Send: an engine-created draft a
  person reviews and sends stays automated, because the engine composed it.
- Kill switch, opt-out, deleted contact and consent still refuse, for staff shares
  and blasts alike, judged as I8 says. A refusal stays a `skipped` recipient with
  its reason (D7).
- WP3's engine-sent shares must be created by their own path, never the dashboard
  route, so they stay automated: item 8 of the WP2 issue (D10).

### D5. "Already sent" stops counting skipped recipients (interim rule)

- The recipient review's "Already sent" flag for a property comes from the
  recipients of that property's earlier sending/sent shares whose slot is
  `queued`, `sent`, `delivered` or `failed`. A `skipped` recipient never counts:
  no text was attempted for them.
- `failed` keeps counting, as today, on purpose: a text that failed after it was
  sent may have been delivered by a retry the share never hears about, and
  un-flagging such a tenant would re-propose them. A recipient that failed
  BEFORE any send (no contact or phone, a ladder close) has no text and no
  retry, but telling the two apart is Branch B's attempts rule; until then every
  failed recipient stays flagged, and staff can tick them by hand.
- Everything else about the review list is unchanged, with one fix: the flag is
  a review-time hint, never a send-time block; tenants the filter proposed start
  unchecked when flagged; a seeded row (the one-to-one tenant, or a hand-picked
  tenant) starts checked; and "Select all" skips flagged rows EXCEPT seeded
  ones, which it leaves checked - today it unchecks them too, which on a
  one-to-one share unchecks the only row and blocks Send.
- Because the rule reads stored outcomes, it corrects history the moment it
  ships (the tenant Sam named has four skipped shares and is flagged today).

### D6. "Not sent" for a share that texted nobody (interim rule)

- A finished share in which every recipient was `skipped` reads "Not sent"
  instead of "Sent" on its results page and in the share list. Every other share
  keeps today's label. Presentation only: the stored lifecycle status and the
  list's status tabs are unchanged, so such a share stays under the "Sent" tab
  with a "Not sent" label (accepted; re-filing history is a production rewrite).
- Branch B widens this to labels derived from every recipient's outcome.

### D7. Real reasons and honest counts

- Every skipped or failed recipient carries a recorded reason when one exists.
  The first-fence skips that record none today get distinct reasons for opted
  out and unreachable. A carrier failure that arrives without an error code stays
  code-less.
- The results page shows each reason in plain words. Wording lives with the
  dashboard's existing staff-facing reason wording, not the message catalog, and
  is chosen PER SURFACE where a code already carries group-thread wording: a
  share recipient's row never shows a whole-group sentence, and the group
  aggregate wording is untouched.

  | Reason | Shown as |
  |---|---|
  | switch off (`manual_mode`; history and future engine shares) | Automatic texts were off for this conversation |
  | opted out (either opt-out code; STOP, Do Not Contact, import or carrier suppression alike) | Opted out of texts |
  | unreachable | Number can't receive texts |
  | no consent (either consent code) | No texting consent recorded |
  | deleted contact | Contact was deleted |
  | no contact record, or no phone | No contact or phone on file |
  | breaker | Stopped by the automatic-text safety limit |
  | kill switch | Texting is turned off |
  | rate-limit cap / could not schedule | the existing wording for those two codes |
  | carrier failure with a code | the existing carrier-code wording (30003's is RSW's and is not touched here), else "Delivery failed (error N)" |
  | failed with no code | Delivery failed |
  | a skip recorded before this change with no reason | Opted out or number unreachable |
  | any other code | Not sent (code) |

- Counts (wire and log only; no new chip): the derived stat buckets stop filing
  other skips under opted-out - "opted out" holds opt-outs and reason-less legacy
  skips, "no consent" holds both consent codes, every other skip goes to ONE
  other-skipped bucket; the results page's Skipped chip sums every skip bucket,
  so its total is unchanged; the finalize log line reports every skip.

### D8. One-to-one share default message (#4)

- In one-recipient mode the composer pre-fills exactly: the property's full
  one-line address (street, city, state, ZIP - the same format the server renders),
  one space, the flyer link. No name, greeting, bedrooms or rent. This matches
  Sam's screenshot.
- Blasts keep today's default. Switching a one-to-one share to filters keeps
  today's reset-to-blast-default behavior.
- No new words are introduced, so nothing is added to the message catalog.

### D9. RUNBOOK: "a conversation tripped the breaker"

How to see why - one trip fires no alarm (the error alarms need five errors in
five minutes or three consecutive periods), so the section gives the ways a trip
is found: a Logs Insights search for `circuit breaker TRIPPED` in the app log
group, Settings -> System status -> Recent errors, the D1 breaker list, and a
read-only Query of the conversation's audit partition (`conversations#<id>` in
`hc-<env>-audit_events`, via the `housingchoice` profile) for the `mode_changed`
event and the `message_sent` events with `automated: true` that preceded it (no
UI or API shows a conversation's audit trail). Then how to switch it back on
with D2's single-conversation mode once the cause is understood. Also: how to
run D1 and D2 against dev and prod, and the import-window rule from section 6.

### D10. Issues filed or amended by this branch

- `ai-mode-switch-gates-all-automation` (WP2; filed with this spec) carries item
  8: engine-created property sends use their own creation path, never the
  dashboard route (D4).
- Import-created conversations lack the one-conversation-per-phone claim record;
  a missing claim is their normal state and is harmless until a claim points at
  a different conversation than the phone's open row (low risk; D1 sizes the
  mismatches).
- The tenant timeline's "Property sent" milestone still reads sent after a later
  delivery failure (Branch B's rule decides it; filed so it is tracked
  meanwhile).

## 4. Invariants

- I1. Kill switch, opt-out, deleted contact and consent refuse every share,
  whoever created it.
- I2. A share not created through the dashboard's draft route is automated
  (switch and breaker apply).
- I3. A `skipped` recipient is never "Already sent", and a share in which every
  recipient was skipped never reads "Sent".
- I4. The "Already sent" flag is a review-time hint, never a send-time block,
  and a seeded row stays checked - through "Select all" too.
- I5. Nothing in this branch turns a switch OFF; only the existing breaker does.
- I6. D2 only ever turns switches on, only on one-to-one conversations, and audits
  every change.
- I7. Production is written only by the Cameron-run D2 script on his explicit go;
  no infrastructure, index or dependency changes.
- I8. For the fan-out's own sends, consent and deletion are judged on the
  recipient contact the share resolved, never on another contact that shares the
  phone; opt-out stays as today (either contact's flag refuses). The automatic
  retry and a staff Retry keep today's gates.

## 5. Surfaces (writers and readers the plan must cover)

- The switch. Writers: phone/email conversation creation (auto, unchanged); the
  import (D3); relay group creation and group-text creation/conversion (manual,
  unchanged); the breaker (manual, unchanged); D2 (new); seed fixtures - the lean
  world gains one switched-off tenant conversation for the e2e checks (RSW's
  one-to-one e2e must not use it), every other seed world is unchanged. Readers:
  the send wrapper; the scheduled-send suppression previews (tour reminders
  panel, contact timeline scheduled cards) - no change; after D2 they report the
  new state.
- Person's-share record. Writer: the dashboard draft route (D4); seed fixtures
  (seeded shares a test sends as staff must carry it); never the engine.
  Readers: the send job; the share list (attribution unchanged).
- Recipient reason and stats. Writers: the fan-out's first-fence skips (D7), and
  the PERSISTED stat counters the fan-out bumps (its refusal branch bumps
  `skipped_opted_out` today; other skips move to the new bucket in the
  persisted counters as well as the derived stats). Readers: results rows and
  chips, share list stats, derived stats, the finalize log line (which reads
  the persisted counters today), "already sent" (D5), the labels (D6).
- One-to-one default text: the composer's one-recipient mode and the message
  editor's placeholder in that mode.

## 6. Sequencing and rollout

1. Slice 1 - D1, D2, D3, D9, with hermetic tests - is reviewed on its own and
   handed to Cameron before the rest is done. He runs D1, then D2 dry run, then D2
   apply, each on his go. Running it before the rest ships is safe: it only turns
   switches on, and one-to-one shares work for switched-on conversations today.
   Import-window rule: between D2 apply and the merge, no Quo import runs from
   `main` (it would create switched-off rows again); if one must, re-run D2
   afterwards (idempotent).
2. D4-D8 and the D10 filings follow in the same worktree; one whole-branch review
   at the end.
3. Concurrent branches (agreed order A, RSW, SOR, then B): this branch needs
   nothing from them. Merge points for whoever lands second: the derived stats
   buckets and the StatChips balance rule (SOR adds an `unconfirmed` bucket);
   the dashboard internal-code reason map and `deliveryReason`'s options and
   check order (SOR and RSW add codes; RSW adds `retryScheduled`); the
   results-row reason gate (SOR shows a reason for `send_unconfirmed`); the
   fan-out's send call, first-fence skips and finalize log line (SOR
   restructures the recipient unit and rebuilds finalize); `sendMessage.ts`
   (this branch's I8 gates, SOR's typed errors, RSW's lineage inputs); the seed
   files' broadcast fixtures. One semantic point for SOR: its adoption writes
   the message and audit rows a share's send would have made, so it must read
   this branch's person's-share record to stamp `automated` correctly.

## 7. Testing and acceptance

- Hermetic tests for every decision. For D2: the dry run writes nothing; apply
  switches on only one-to-one `manual` rows (typeless rows included, group rows
  never); breaker-tripped rows are skipped unless included; single mode refuses
  group threads; a re-run changes nothing; every change is audited; a real-AWS
  run on the wrong account refuses.
- End to end (Playwright harness): a staff one-to-one share to a tenant whose
  conversation is switched off is delivered; a tenant whose earlier share was
  skipped is not "Already sent" on the next share of the property, while one
  whose text went out (or failed - the interim rule, pinned as such) is; skipped
  rows show their reasons; an all-skipped share reads "Not sent"; the
  one-to-one default text. The lean seed world needs a switched-off one-to-one
  tenant conversation - a deliberate, reviewed change to that world.
- All five completion gates from AGENTS.md.
- Handback reports: the D1 numbers, the diagnosed cause (done), what D2 changed or
  would change, and every issue filed or amended.

## 8. Risks and accepted tradeoffs

- D2 releases pending one-to-one tour-reminder rungs for previously switched-off
  conversations. Intended; D1 counts them before Cameron applies.
- A breaker trip that lands while the bulk run is in progress may be switched back
  on by that run; the breaker re-trips on the next capped minute. Bounded, accepted.
- After D2, `auto` does not mean "the AI may reply" (WP2 must not read it so).
- Staff shares are no longer breaker-metered. A share sends one text per recipient
  contact (two contacts on one phone can put two texts in one conversation -
  pre-existing), so the breaker could only matter for more than ten shares to one
  tenant within a minute; the per-user share rate limit still applies.
- Interim D5: a tenant whose text failed stays "Already sent" for that property
  until Branch B, even if they never received it. Safe direction; staff can tick
  them by hand.

## 9. For Cameron at the spec gate

- The interim D5 and D6 rules (skipped never counts; failed still counts; "Not
  sent" only for an all-skipped share) - the smallest change that fixes what Sam
  reported without touching the other branches' object.
- D4 records "person's share" at creation instead of resolving the creator on
  the send path (your suggestion was the creator id; this keys off the same
  identity, one step earlier, and avoids a lookup that could fail mid-send).
- The plain-word reason copy in D7.

## Appendix A. Where these live today (orientation, not instructions)

- Send job: `app/src/jobs/broadcastFanOut.ts`. Send wrapper and breaker:
  `app/src/services/sendMessage.ts`. Suppression preview:
  `app/src/services/scheduledSendSuppression.ts`.
- Share routes (draft, preview/"already sent", send, results):
  `app/src/routes/broadcasts.ts`; storage and derived stats:
  `app/src/repos/broadcastsRepo.ts`.
- Import: `app/src/lib/import/apply.ts`. Conversation creation and the switch:
  `app/src/repos/conversationsRepo.ts`; the one-to-one bucket definition in
  `app/src/lib/unreadFeed.ts`. Session user check: `app/src/middleware/auth.ts`.
- Composer and review: `dashboard/src/routes/broadcasts/` (`BroadcastComposer.tsx`,
  `resolveTemplate.ts`, `RecipientPreview.tsx`, `BroadcastResults.tsx`,
  `broadcastFormat.ts`, `StatChips.tsx`); reason wording:
  `dashboard/src/routes/contact/deliveryStatus.ts`.
- Ops-script precedents: `app/scripts/` - dry-run/conditional-write shape from
  `retire-paused-tour-reminders.ts`; the account guard plus
  credentials-from-profile shape from `import-apply.ts` and `rail-verify.ts`
  (`scripts/lib/hcAws.mjs`); local-endpoint detection from `db-create.ts`.
