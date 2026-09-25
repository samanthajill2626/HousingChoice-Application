# Share skips, "Already sent", and the one-to-one share message - design

Date: 2026-09-24. Branch: `feat/share-skip-fix`. Source: Sam's improvements list
(2026-09-24) items #5 and #4, under Amendment No. 2 (support). Diagnosis record:
`docs/superpowers/reviews/2026-09-24-share-skip-fix/diagnosis.md`. Review
history: `docs/superpowers/reviews/2026-09-24-share-skip-fix/`.

This is a TOP-LEVEL spec: it fixes behavior, rules, invariants and the surfaces
they reach. Mechanics (data shapes, function names, file-level tasks, test code)
belong to the implementation plan.

Vocabulary. GLOSSARY: staff-facing copy says "property", tenant-facing says
"home", code says `unit`; the Matching item is a "send" or "property send".
Shorthand used in THIS DOCUMENT ONLY (never UI, RUNBOOK or issue copy): a
"share" is a broadcast; a "one-to-one share" is a broadcast with exactly one
seeded recipient started from that tenant's file; a "blast" is a filter-audience
broadcast. "The switch" is the per-conversation `ai_mode` field
(`auto` | `manual`). "Counts" and "counted" are defined in D5. An "attempt" is
a text ACTUALLY SENT for a share recipient: the original, an automatic 30003
retry, or a staff Retry of the failed message (D5).

---

## 1. Problem

What Sam sees:

- #5: a one-to-one share often ends "Skipped", on every retry, for particular
  tenants, although the property is available, the tenant is Searching and consent
  is recorded. Typed messages to the same tenants go through. Afterwards the
  recipient review marks the tenant "Already sent", so Sam pastes the flyer link by
  hand.
- #4: mid-conversation she wants the share to be just the address and the link.

What happens today (each claim was verified in the code by two reviewers; the
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
   contacts: tour reminders (one-to-one route), placement nudges, the missed-call
   auto-text, the public sign-up welcome and the 30003 automatic retry.
5. The fan-out records a refusal on the recipient slot as `skipped` with the
   refusal code, but a skip for opt-out or unreachable at its own first fence
   records NO code. Derived stats count every skipped slot except `no_consent`
   as `skipped_opted_out`. The results page shows only "Skipped".
6. A finished share is marked `sent` unless every recipient FAILED; an all-skipped
   share reads "Sent". A share whose only recipient failed before finalize is
   stored `failed` with the alert "all recipients failed".
7. "Already sent" is the union of recipient keys of every sending/sent share of
   that property, whatever happened to each recipient. Skipped and failed count.
   A share whose lifecycle status is `failed` is excluded.
8. The listing-send ledger ("Properties sent" on a contact, "Sent to tenants" on a
   property) gets a row when the carrier accepts a unit-targeted share's text and
   is never updated when delivery later fails. One row per property-tenant pair,
   refreshed to the latest share's date and id.
9. When a unit-targeted share finishes, the property's audit trail records the
   TOTAL recipient count, rendered as "Sent to N tenants" on the property's
   Activity card and on the owning landlord's timeline. Skipped and failed count.
10. Every share - one tenant or fifty - starts from the same default message:
    greeting with first name, bedrooms, address, rent, flyer link.
11. A share text that fails 30003 is retried automatically (up to three times,
    60/120/240 s apart), and the results page sends staff to the conversation's
    Retry button for any failed row. Both retries send a NEW message that carries
    no share id, so the retry's outcome never reaches the recipient slot: the
    slot reads `failed` forever even when the retry delivered. A retry that is
    refused (by a gate or the switch), never scheduled, or errors out leaves no
    record at all; only exhaustion is derivable. A recipient's recorded outcome
    never leaves `failed` today (forward-only rule).

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
  switch on, so reminders, nudges, missed-call texts, welcome texts and retries
  work again for imported contacts; the import no longer creates switched-off
  one-to-one conversations.
- G3. One rule decides whether a property counts as sent to a tenant, and every
  surface that says so follows it (with the one stated lag in D6).
- G4. Every skipped or failed recipient shows its real reason; counts stop
  filing other skips under opt-outs.
- G5. A one-to-one share defaults to the full address and the flyer link.
- G6. A breaker trip has a documented, scripted way back.

Non-goals (do not build; each is filed or owned elsewhere):

- The switch redesign: AI-only meaning, a separate breaker stop, retries that
  follow the original sender, a visible per-conversation control, the engine in
  group threads (WP2 issue above).
- Any UI or API that turns the switch on or off.
- Any change to the breaker's cap or behavior, or to which failures retry and how
  often, or to the conversation timeline's Retry affordance and wording.
- The switch value on relay_group and group_text threads (stays `manual`; inert).
- Which tenants a blast targets (Sam's #6, awaiting her answers).
- The tenant timeline's "Property sent" milestone after a delivery fails (D10).
- Re-filing shares under the list's status tabs (D7).

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
- Not-yet-sent scheduled texts (tour-reminder rungs, placement nudges) whose
  recipient's one-to-one conversation is switched off: these start sending once D2
  runs.
- Listing-send ledger rows that D6 would un-count (no attempt of any share of the
  pair delivered, and the newest attempt of each failed) - sizes the D6 repair.
- Share recipients whose text failed before this branch and was delivered by a
  retry (message retry lineage) - the historical attempts the repair records
  against their shares (D6).
- Import-created one-to-one conversations missing the one-conversation-per-phone
  claim record (for the D10 issue).

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
- Target safety: follows the repo's ops-script posture (explicit table prefix, the
  resolved target logged before the first read) and, when pointed at real AWS,
  refuses to run unless the account is 938565869261.
- Only Cameron runs it against dev or prod (or gives an explicit go per run).

### D3. Import default

The import creates NEW one-to-one conversations with the switch `auto`. Group
rows keep `manual`. A re-run never changes an existing conversation's switch
(D2 handles existing rows).

### D4. Staff-created shares are a person's sends

- Who created the share is decided ONCE, at creation. The dashboard's draft
  route can only be called by an authenticated staff session (the session
  middleware has just verified that user exists), so that route records on the
  share that it is a person's share. The recorded creator id stays as
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
  and blasts alike, judged as I8 says.
- WP3's engine-sent shares must be created by their own path, never the dashboard
  route, so they stay automated: item 8 of the WP2 issue (D10).

### D5. One "counted as sent" rule

Attempts. Every text actually sent for a share recipient is an attempt recorded
against that share: the original, an automatic 30003 retry, or a staff Retry of
the failed message. A retry that never sends - refused by a gate or the switch,
never scheduled, or errored out - is not an attempt and changes nothing; the
recipient stays as their last attempt left them, which is the truth.

A recipient counts as sent when:

- any attempt for them was delivered; or
- their newest attempt is `queued` on our side (including a rate-limit retry
  wait) AND the share is still `sending` - the queued slots of a share whose
  send never started never count; or
- their newest attempt is `sent` (handed to the carrier, confirmed or not).

A recipient does not count when skipped, or when every attempt failed. A draft
never counts.

An attempt is attributed to the recipient whose text it retried, through the
attempt it retried - never by conversation, so two recipients of one share who
share a phone (duplicate contacts) stay distinct. The record follows the newest
attempt: when attempts overlap (a staff Retry pressed during an automatic
backoff), a delivery of the superseded attempt is not recorded. Accepted: rare,
and the same double-send case section 8 names. Known and accepted: a share whose
fan-out died on an unclassified error is never finalized (no route closes it;
I7), so its remaining `queued` slots count permanently - pre-existing, tracked
in `docs/issues/throw-for-redelivery-defeated-by-job-marker.md`.

What the share records per recipient is bounded: the newest attempt and whether
any attempt delivered - never a list of attempts - so the recipient cap's byte
budget grows by one small field.

Every surface that tells staff a property was sent to a tenant follows it:

- (a) The recipient review list: the "Already sent" tag and the default-unchecked
  state for tenants the audience filter proposed. A seeded row - the one-to-one
  tenant, or a tenant staff picked by hand, from the moment they are added - is a
  deliberate choice: it stays pre-checked and still shows the tag, and "Select
  all" leaves it checked. A tenant whose every attempt for the property failed,
  or who was skipped, is NOT already sent.
- (b) "Properties sent" on a contact and "Sent to tenants" on a property (via D6).
- (c) The property activity entry for a finished share: N counts only counted
  recipients; when N is 0 the entry says nothing was sent. The count is derived
  at render time from the share's stored outcomes, so it is right for shares
  already on record (the tenant Sam named has four) and after later attempts.
  Cost: one share read per activity entry, bounded by the number of shares of
  that property; the landlord timeline's property interleave inherits the same
  bound. Related read-cost tracking:
  `docs/issues/broadcast-results-enrichment-read-cost.md`.
- (d) The share's results row for the recipient shows the outcome that decides
  the count: delivered when any attempt delivered, else the newest attempt's
  outcome (a delivered retry reads delivered, not the original failure). A 30003
  failure with retries remaining keeps the existing "will retry" wording and the
  existing open-conversation-to-retry hint; one whose retries are exhausted
  (derivable from the failed message) says so instead. Known limitation,
  accepted: a retry the switch or a gate refuses is unrecorded, so that row
  keeps promising a retry - the same wording and affordance the conversation
  timeline shows today (WP2 owns retries). A `queued` slot of a share that is
  not `sending` presents as "Not sent".
- (e) A draft keeps "Draft". Any other share's label derives from its
  recipients, not its stored status, and has three values, first match wins:
  "Sending" while the share is `sending` and any recipient is still queued;
  "Sent" when any recipient counts; otherwise "Not sent" -
  including during a 30003 retry wait, when the recipient's row explains the
  coming retry. "Sent" holds even when the stored status is `failed` because a
  30003 landed before finalize and a retry later delivered. The results page's
  stored failure alert is suppressed only when the derived label is "Sent", so
  a share whose send never started keeps its "enqueue failed" explanation.

Because `queued` and `sent` count, a second share of the same property started
while the first is still going out flags those tenants as already sent.

### D6. The listing-send ledger follows the rule

- A property-tenant pair counts as sent while at least one share of that property
  to that tenant is counted (D5), judged from carrier acceptance onward: the
  ledger is written when the carrier accepts the text, so it lags D5's `queued`
  window by the send pacing (the one stated exception to G3/I3).
- A pair stops counting when no share of it counts any more: no attempt of any
  share delivered and the newest attempt of each share failed. A newly sent
  attempt (a retry) or a new share re-counts it.
- A counted pair describes its latest counted share (date and id). This date
  orders "Properties sent" and picks the tour form's default property.
- A failure reported before the ledger row is written must still un-count it: the
  order of the carrier callback and the ledger write must not matter.
- "Properties sent", "Sent to tenants" and any future matching read show only
  counted pairs, and stay a direct lookup (no per-row join), because Amendment
  No. 1's matching will read this at scale.
- Rows already on record that D6 would un-count are brought in line by a
  dry-run-first repair pass run on Cameron's go after deploy (D1 counts them
  first). The repair judges by attempts, walking message retry lineage for
  shares sent before this branch (whose retries carried no share id): a pair
  whose text was delivered on a retry stays counted, AND the repair records
  those historical attempts against their shares, so "Already sent", the
  activity count, the results row and the label agree with the ledger for
  history. The repair follows D2's write discipline: every write is conditional
  on the record being unchanged since its read, it never erases a recorded
  delivery or an attempt recorded after deploy, and an applied run re-reads
  rather than replaying a dry run's plan. A retry whose lineage was never
  written (a rare crash between send and annotate) is invisible to it - accepted.

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
  | carrier failure with a code | the existing carrier-code wording, else "Delivery failed (error N)" |
  | 30003 with retries remaining | Phone unreachable - will retry (existing) |
  | 30003 with retries exhausted | Phone unreachable - retries exhausted |
  | failed with no code | Delivery failed |
  | a skip recorded before this change with no reason | Opted out or number unreachable |
  | any other code | Not sent (code) |

- Counts (wire and log only; no new chip): the derived stat buckets stop filing
  other skips under opted-out - "opted out" holds opt-outs and reason-less legacy
  skips, "no consent" holds both consent codes, every other skip goes to ONE
  other-skipped bucket; the results page's Skipped chip sums every skip bucket,
  so its total is unchanged; the finalize log line reports every skip.
- Labels are presentation (D5(e)): the stored lifecycle status and the list's
  status tabs are unchanged, so an all-skipped share stays under the "Sent" tab
  reading "Not sent", a share whose every recipient failed inside the send job
  stays under "Failed", and a `failed`-stored share rescued by a retry reads
  "Sent" under "Failed". Accepted split: re-filing history is a production
  rewrite (I7), and a share's outcome keeps moving after finalize (retries, late
  callbacks), so no stored status could stay right.

### D8. One-to-one share default message (#4)

- In one-recipient mode the composer pre-fills exactly: the property's full
  one-line address (street, city, state, ZIP - the same format the server renders),
  one space, the flyer link. No name, greeting, bedrooms or rent. This matches
  Sam's screenshot.
- Blasts keep today's default. Switching a one-to-one share to filters keeps
  today's reset-to-blast-default behavior.
- No new words are introduced, so nothing is added to the message catalog.

### D9. RUNBOOK: "a conversation tripped the breaker"

How to see why (the alarm log line, the conversation's `mode_changed` event, the
automated sends that preceded it), and how to switch it back on with D2's
single-conversation mode once the cause is understood. Also: how to run D1 and D2
against dev and prod, and the import-window rule from section 6.

### D10. Issues filed or amended by this branch

- `ai-mode-switch-gates-all-automation` (WP2; filed with this spec) carries item
  8: engine-created property sends use their own creation path, never the
  dashboard route (D4).
- The tenant timeline's "Property sent" milestone still reads sent after a later
  delivery failure (the failed message bubble on the same timeline shows the
  truth; deferred).
- Import-created conversations lack the one-conversation-per-phone claim record
  (low risk; D1 sizes it).

## 4. Invariants

- I1. Kill switch, opt-out, deleted contact and consent refuse every share,
  whoever created it.
- I2. A share not created through the dashboard's draft route is automated
  (switch and breaker apply).
- I3. One definition of "counted as sent" (D5); no surface counts a skipped or
  all-attempts-failed send as sent, except the ledger's acceptance lag (D6) and
  the deferred tenant-timeline milestone (D10).
- I4. A second share of a property flags a tenant whose text is still queued, on
  its way or delivered as already sent, and leaves them unchecked when the filter
  proposed them. The flag is a review-time hint, never a send-time block, and a
  seeded row stays checked - through "Select all" too.
- I5. Nothing in this branch turns a switch OFF; only the existing breaker does.
- I6. D2 only ever turns switches on, only on one-to-one conversations, and audits
  every change.
- I7. Production is written only by Cameron-run operator scripts on his explicit
  go: D2 (conversations) and the post-deploy repair (the ledger, and historical
  shares' recorded attempts); no infrastructure, index or dependency changes.
- I8. For the fan-out's own sends, consent and deletion are judged on the
  recipient contact the share resolved, never on another contact that shares the
  phone; opt-out stays as today (either contact's flag refuses). A staff Retry of
  a share message is an ordinary staff send through the conversation, and the
  automatic retry is the existing retry job; both keep today's gates, and a
  refused one is not an attempt.
- I9. A recipient's recorded outcome leaves `failed` only through a newly sent
  attempt for that recipient - or, once, through the post-deploy repair
  recording an attempt sent before this branch, under D6's write rule - and a
  recorded delivery is never erased by a later attempt or by the repair. Within
  one attempt, delivery outcomes stay forward-only (the existing exactly-once
  rule for callbacks).

## 5. Surfaces (writers and readers the plan must cover)

- The switch. Writers: phone/email conversation creation (auto, unchanged); the
  import (D3); relay group creation and group-text creation/conversion (manual,
  unchanged); the breaker (manual, unchanged); D2 (new); seed fixtures - the lean
  world gains one switched-off tenant conversation for the e2e checks, every
  other seed world is unchanged (the performance world's manual one-to-ones are a
  load shape, not behavior under test). Readers: the send wrapper; the
  scheduled-send suppression previews (tour reminders panel, contact timeline
  scheduled cards). Readers need no change: after D2 they report the new state.
- Person's-share record. Writer: the dashboard draft route (D4); seed fixtures
  (seeded shares a test sends as staff must carry it); never the engine.
  Readers: the send job; the share list (attribution unchanged).
- Recipient outcome (attempts, status, reason). Writers: the send route (queued),
  the fan-out (sent/skipped/failed, transient deferrals, ladder closes), the
  delivery callback rollup (delivered/failed, carrier-sent marker, per attempt),
  and - new - the automatic 30003 retry and the staff Retry of a share message,
  which carry the share so their sent attempt is recorded (D5, I9), and the
  post-deploy repair for historical retries (D6). Readers:
  results rows, chips and the share label/alert (D5(d), (e)), share list stats
  and label, derived stats, "already sent" (D5a), the property activity count
  (D5c), finalize, the finalize log line, the ledger (D6).
- Ledger. Writers: the fan-out on acceptance, the delivery rollup and retry
  attempts (D6), the D6 repair, seed fixtures (seed rows with no share stay
  counted). Readers: "Properties sent" (and the tour form's default property),
  "Sent to tenants" (and their tour-chip join), future matching.
- Property activity entry. Writer: fan-out finalize. Readers: the property
  Activity card and the landlord timeline's property interleave (both derive the
  count, D5c).
- One-to-one default text: the composer's one-recipient mode and the message
  editor's placeholder in that mode.
- Dev seam (new): the one-to-one retry backoff (60/120/240 s) must be injectable
  for the hermetic harness, as the relay retry ladder's is, so the 30003
  scenario in section 7 runs in seconds.

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
3. After Cameron merges and deploys: the D6 repair pass, dry run first, on his
   go - immediately after the deploy and before the first blast, because until
   it runs a tenant who received a property on a pre-branch retry reads not sent
   and would be proposed again. D1's count says whether that gap holds anyone
   at all.

## 7. Testing and acceptance

- Hermetic tests for every decision. For D2: the dry run writes nothing; apply
  switches on only one-to-one `manual` rows (typeless rows included, group rows
  never); breaker-tripped rows are skipped unless included; single mode refuses
  group threads; a re-run changes nothing; every change is audited; a real-AWS
  run on the wrong account refuses.
- End to end (Playwright harness): a staff one-to-one share to a tenant whose
  conversation is switched off is delivered; a tenant whose earlier share was
  skipped or whose every attempt failed is not "Already sent" while one whose
  share is queued, sent or delivered is; a seeded already-sent row stays checked;
  a share text that fails 30003 and delivers on retry counts (review list,
  ledger, results row, share label) - asserted on D5 surfaces and the derived
  label, never on the stored lifecycle status, because finalize can race the
  30003 callback either way; skipped/failed rows show their reasons; an
  all-skipped share reads "Not sent"; the one-to-one default text; the property
  activity count; "Properties sent" drops a pair whose every attempt failed and
  keeps a pair an earlier share delivered. The lean seed world needs a
  switched-off one-to-one tenant conversation - a deliberate, reviewed change
  to that world.
- All five completion gates from AGENTS.md.
- Handback reports: the D1 numbers, the diagnosed cause (done), what D2 changed or
  would change, and every issue filed or amended.

## 8. Risks and accepted tradeoffs

- D2 releases pending automated texts for previously switched-off conversations.
  Intended; D1 counts them before Cameron applies.
- A breaker trip that lands while the bulk run is in progress may be switched back
  on by that run; the breaker re-trips on the next capped minute. Bounded, accepted.
- After D2, `auto` does not mean "the AI may reply" (WP2 must not read it so).
- Staff shares are no longer breaker-metered. A share sends one text per recipient
  contact (two contacts on one phone can put two texts in one conversation -
  pre-existing), so the breaker could only matter for more than ten shares to one
  tenant within a minute; the per-user share rate limit still applies.
- The ledger and the review list disagree for the pacing window of an in-flight
  blast (D6's stated lag). Accepted: minutes, and the review list is the surface
  staff decide from.
- During a retry's backoff (60-240 s per attempt, about seven minutes in all) a
  recipient whose text failed reads not sent everywhere, and a one-recipient
  share reads "Not sent" beside a row saying a retry is coming; a second share
  started in that window can text them twice. Accepted: the window is short, the results
  row says a retry is coming, and a retry that never sends leaves the truth in
  place. Pressing Retry on the conversation while an automatic retry is pending
  can also double-text; that is today's behavior for every one-to-one message
  and is out of scope.

## 9. For Cameron at the spec gate

- The retry rule (D5 attempts, I9) is load-bearing for D6 and is not optional;
  confirm it.
- Beyond the approved outline, included as consistency fixes: D5(c) (the property
  activity count, derived at read with the stated cost), D5(e) (labels derived
  from recipients, with the accepted tab split), and hand-picked tenants staying
  pre-checked (D5(a)). Confirm or cut each.
- D4 records "person's share" at creation instead of resolving the creator on
  the send path (your suggestion was the creator id; this keys off the same
  identity, one step earlier, and avoids a lookup that could fail mid-send).
- Deferred with an issue rather than built: the tenant timeline "Property sent"
  milestone after a failed delivery (D10).
- The plain-word reason copy in D7.

## Appendix A. Where these live today (orientation, not instructions)

- Send job: `app/src/jobs/broadcastFanOut.ts`. Send wrapper and breaker:
  `app/src/services/sendMessage.ts`. Suppression preview:
  `app/src/services/scheduledSendSuppression.ts`. Automatic retry:
  `app/src/jobs/retrySend.ts`; staff Retry: the conversation retry route in
  `app/src/routes/api.ts`. Number-scoped opt-out:
  `app/src/services/numberSuppression.ts`.
- Share routes (draft, preview/"already sent", send, results):
  `app/src/routes/broadcasts.ts`; storage and derived stats:
  `app/src/repos/broadcastsRepo.ts`; delivery rollup:
  `app/src/routes/webhooks/twilio.ts`.
- Ledger: `app/src/repos/listingSendsRepo.ts`, read by `app/src/routes/units.ts`
  and `app/src/routes/contacts.ts`; the tour form's default property in
  `dashboard/src/routes/contact/ContactDetail.tsx`.
- Property activity count: written in the send job's finalize; rendered by
  `dashboard/src/routes/listing/listingFormat.ts` and the landlord interleave in
  `app/src/routes/contactTimeline.ts`.
- Import: `app/src/lib/import/apply.ts`. Conversation creation and the switch:
  `app/src/repos/conversationsRepo.ts`; the one-to-one bucket definition in
  `app/src/lib/unreadFeed.ts`. Session user check: `app/src/middleware/auth.ts`.
- Composer and review: `dashboard/src/routes/broadcasts/` (`BroadcastComposer.tsx`,
  `resolveTemplate.ts`, `RecipientPreview.tsx`, `BroadcastResults.tsx`,
  `broadcastFormat.ts`, `StatChips.tsx`); reason wording:
  `dashboard/src/routes/contact/deliveryStatus.ts`.
- Ops-script precedents: `app/scripts/` (for example
  `retire-paused-tour-reminders.ts`, `measure-unread-contact-coverage.ts`).
- Retry-backoff seam precedent: the relay retry ladder
  (`docs/superpowers/specs/2026-09-02-relay-30003-retry-lineage-design.md`).
