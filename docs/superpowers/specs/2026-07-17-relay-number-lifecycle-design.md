# Relay number lifecycle: multiplexing, close flow, retirement (design)

Date: 2026-07-17
Status: Approved design, pre-implementation
Branch: feat/relay-number-lifecycle (worktree w:/tmp/relay-number-lifecycle, cut from main @e88d53d)

## 1. Problem and decisions

Today a relay (group-text) phone number serves exactly ONE group at a time:
inbound routing keys on the To number alone, closing a group clears its
pool_number and quarantines the number for 30 days, and reuse hands the same
number to strangers after the window. Three problems, confirmed in code:

- Pool pressure: every concurrent group needs its own number, and the 30-day
  quarantine inflates the pool further (~$1.15/mo per number, never released
  to Twilio).
- Reuse with the SAME person is possible after quarantine, which resurrects
  the old thread in their phone's SMS app and re-forms carrier STOP pairs.
- The close lifecycle barely exists: only placement->lost auto-closes (and
  releases); a tour that ends without converting leaks its number as
  assigned forever; a text to a closed group is silently swallowed.

Cameron's decisions (2026-07-17 design conversation):

D1. MULTIPLEXING with a PERMANENT BURN invariant. One number may host many
    groups - concurrently and sequentially - as long as no PERSON repeats:
    a (number, phone) pair, once used, is burned FOREVER. Assignment picks
    the first number with zero overlap between the new roster and the
    number's burn history. This is simultaneously the routing correctness
    condition, the no-thread-resurrection guarantee, and the STOP-pair
    hygiene rule.
D2. Inbound routing becomes (To, From): resolve the OPEN group on that
    number whose roster contains the sender (the invariant guarantees at
    most one). A sender matching only a CLOSED group's roster routes to
    their 1:1 thread with provenance (badge/note "via the closed group").
D3. Quarantine, release-on-close, and the assigned/available exclusivity
    all go away. Closing a group KEEPS its pool_number (interception
    depends on it). pool-number lifecycle states become: active | released.
D4. NOTHING auto-closes. Terminal events ASK: placement->lost, tour
    canceled / not-a-fit, and placement completed pop an inline "Also close
    the group text?" dialog for whoever recorded the outcome (any staff -
    the founder-decision policy is satisfied by practice, not role gates).
    Tour->placement conversion continues the group silently (unchanged).
D5. Groups left open past a terminal event get a recurring 28-DAY nag on
    the Today page: "Group text with <number> for <tenant/property> is
    still open - close it?" with Close / Keep-open (keep restarts 28
    days). 28 = exactly 4 weeks, so the nag always lands on the same
    weekday the deferral happened on (typically a workday) and always
    recurs within the month.
D6. Closing sends ONE final automated message to all participants (message
    catalog): the group is closed, and texting this number still reaches
    the team (true under D2 interception).
D7. RETIREMENT: a number is release-eligible when it has ZERO open groups
    AND its newest group closed >= 180 days ago (the interception grace
    window). Release deletes the number at Twilio (new adapter capability),
    keeps burn/audit records in our DB, and is gated behind an explicit
    config flag so prod ops controls when it is live. No burn-count
    threshold - the assignment algorithm already marginalizes crowded
    numbers naturally.

## 2. Data model

### 2.1 pool_numbers record (poolNumbersRepo)

- `lifecycle_state`: `active` | `released` (replaces
  available/assigned/quarantined). Migration maps available+assigned+
  quarantined -> active. `quarantine_until`, QUARANTINE_WINDOW_MS, and
  `reclaimExpired` are deleted.
- NEW `burned_phones`: a DynamoDB string set of E.164 phones ever rostered
  on this number. Size note: a group burns 2-3 phones; even 100 groups is
  ~5 KB - a set attribute is fine.
- NEW `last_group_closed_at`: ISO timestamp, updated on every group close
  for this number (monotonic max). Drives D7 eligibility together with a
  live open-group check.
- `assigned_conversation_id` is deleted (one-to-many now). The
  byLifecycleState GSI remains for assignment/retirement queries; whether
  its shape needs a change is an implementation detail for the plan.

### 2.2 Assignment = atomic burn (the race-safe claim)

`provisionForPlacement(roster)` becomes `provisionForGroup(rosterPhones)`:

1. Query `active` numbers (driver-matched via `provisioned_via`, as today).
2. For the first candidate whose `burned_phones` intersects the roster
   NOWHERE, perform a CONDITIONAL UpdateItem: ADD burned_phones {roster}
   with condition `NOT contains(burned_phones, :p)` for EVERY roster phone
   (and lifecycle_state = active). The burn IS the claim: two concurrent
   provisions with overlapping rosters cannot both succeed on the same
   number - the loser's condition fails and it moves to the next candidate.
3. No candidate -> buy a fresh number (same relayLiveProvisioning
   kill-switch and voice-capability checks as today), create its record
   with burned_phones = roster.

Roster note (verified 2026-07-17): members are caller-supplied
{contactId?, phone, name?} - tenant + landlord; staff operate from the
dashboard and have NO SMS leg, so the invariant does not burn staff cells.
CAVEAT recorded, not built: manually adding a staff cell to many groups
would burn numbers fast; an exemption list is a future follow-up if that
becomes a pattern.

### 2.3 Conversations

- `pool_number` is NEVER cleared. The byPoolNumber GSI therefore holds ALL
  of a number's groups (open + closed); every consumer of
  `getByPoolNumber` must handle multi-match (see 3.1). The
  single-open-match assumption (`items.find(open) ?? items[0]`) is deleted.
- `setRelayStatus('closed', ...)` no longer nulls pool_number; it also
  stamps `last_group_closed_at` on the pool record (best-effort, logged).
- NEW conversation field `close_nag_next_at` (ISO) on relay groups whose
  close-ask was declined/deferred - drives the Today nag (D5). Cleared on
  close; reset to now+28d on "Keep open".

## 3. Inbound routing (webhooks/twilio.ts)

### 3.1 Resolution order for an inbound SMS to a pool number

1. Fetch ALL conversations for To via byPoolNumber.
2. OPEN group whose roster contains From -> today's relay path (fan-out,
   DLR pointers, STOP handling - all unchanged). The invariant guarantees
   at most one such group; if data corruption ever yields two, pick the
   newest and log an error (never crash the webhook).
3. Else CLOSED group whose roster contains From (newest if several - a
   person can appear in several closed groups on one number over the
   years) -> deliver into the sender's 1:1 tenant/landlord thread
   (createOrGetByParticipantPhone, as the public intake does), persisting
   the message with NEW attributes `via_closed_group: <conversationId>`
   and the existing inbound shape. No fan-out to old group members, no
   auto-reply. The closed GROUP transcript no longer receives these
   messages at all (replaces today's receivedOnClosedThread append - the
   1:1 with provenance is strictly more useful and never pollutes group
   history).
4. Else (unknown sender) -> keep today's behavior for a non-member inbound.
5. The echo guards (our numbers, pool numbers) stay ahead of all of this.

### 3.2 Dashboard provenance

Timeline/conversation UI renders a badge/note on `via_closed_group`
messages: "Sent to the closed group chat for <tag/address>" (link to the
closed group). Exact placement mirrors existing timeline badge idioms.

## 4. Close lifecycle

### 4.1 Remove the auto-close

`closeRelayForLostPlacement` (statusTransition lost hook) is REMOVED.
Nothing closes a group without a human choice.

### 4.2 The inline ask (dashboard)

After these outcomes are recorded, if the entity has a linked OPEN relay
group, show a confirm dialog "Also close the group text with <names>?"
[Close group text] / [Keep it open]:
- placement -> lost
- placement -> its completed/terminal-success state (per STATUS-MODEL)
- tour -> canceled, and tour -> closed / "not a fit"
Close -> POST the existing close endpoint (4.4). Keep -> PATCH the group's
close_nag_next_at = now+28d. The dialog is non-blocking for the outcome
itself: the status change is already saved before the dialog answers
(never couple the transition to the dialog).

### 4.3 Today-page nag (D5)

A Today section lists open relay groups whose close_nag_next_at <= now:
"Group text with <number> for <tenant> / <property> - still open. Close
it?" [Close] / [Keep open] (keep -> +28d). Backend: a byRelayStatus-based
scan is fine at our scale (open groups only, filter on the timestamp);
plan decides the exact query shape.

### 4.4 Closing a group (route exists: PATCH /api/relay-groups/:id closed)

Order: send the final catalog message (D6) to every participant while the
group is still open (reuses the announcement leg machinery), THEN
setRelayStatus('closed') + stamp last_group_closed_at, audit, SSE. Send
failures degrade exactly like other announcements (logged, group still
closes). Composer hard-disable (existing) keeps keying on status==closed.
HARDENING (from research): sendRelayAnnouncement + any other gate that
infers closed-ness from pool_number absence must gate on status instead
(pool_number never clears now).

### 4.5 Final message copy (catalog key, e.g. relay.group_closed)

"This group chat is now closed. You can still text this number and a
Housing Choice team member will see your message and follow up."
(ASCII; exact copy lives in the message catalog like all automated copy;
operator-overridable like the welcome text if the catalog already supports
it - do not build new override machinery.)

## 5. Retirement (D7)

- Eligibility: lifecycle_state=active AND zero OPEN groups on the number
  (live byPoolNumber check) AND last_group_closed_at <= now - 180 days AND
  the number has hosted at least one group (never release a fresh unused
  number by accident of timestamps).
- Sweep runs lazily at the top of provisionForGroup (where reclaimExpired
  ran) and is ALSO exposed as `npm run` script for manual ops runs.
- Action per number: adapter.releasePhoneNumber (NEW adapter method:
  Twilio DELETE IncomingPhoneNumber; console driver: logged no-op parity),
  then lifecycle_state=released + released_at, audit entry. Burn history
  is retained forever (it is our record; DynamoDB cost is trivial).
- Config gate: RELAY_NUMBER_RELEASE_ENABLED (default OFF everywhere until
  ops turns it on; local/e2e may enable in the hermetic env to test). The
  sweep no-ops silently when off. A2P note for RUNBOOK: releasing a number
  must also drop it from the messaging service / campaign - the Twilio
  API path the adapter uses determines whether that is automatic; the plan
  verifies and the RUNBOOK documents the operator step if manual.

## 6. Existing data (NO migration - nothing is live)

Cameron 2026-07-17: no production data exists and dev has never turned on
group relays, so there is NO backfill/migration script. Instead:

- SEEDS are the source of truth for local/e2e data: any seed profile that
  creates relay groups / pool numbers must emit the NEW shape natively
  (burned_phones populated from rosters, lifecycle_state=active,
  last_group_closed_at where the seed closes a group). The mock-mode
  relay-group seeds (fake-phones) are in scope for this.
- Stray legacy rows in dev tables (old lifecycle states, quarantine
  fields) are handled by tolerance, not conversion: assignment simply
  ignores any record whose lifecycle_state is not `active`, and a normal
  reseed wipes local strays. No code path reads the old fields.

## 7. Non-goals

- No participant-level burn exemptions (staff-cell caveat recorded above).
- No change to relay VOICE behavior, STOP/opt-out semantics, RCS seams,
  fan-out mechanics, or 1:1 messaging.
- No burn-count caps or pool-size autoscaling policies.
- No UI for browsing burn history (audit/logs only).
- No retroactive final-close message to already-closed groups.

## 8. Testing

App (vitest): atomic-burn claim race (two concurrent provisions,
overlapping rosters, same candidate -> exactly one wins, loser moves on);
assignment skips overlapping numbers and buys fresh when none clean;
(To,From) resolution matrix (open-match / closed-match->1:1 with
via_closed_group / unknown / multi-closed picks newest); close no longer
clears pool_number; final message sent before close + close proceeds on
send failure; nag timestamp lifecycle; retirement eligibility incl. the
180d boundary, open-group veto, and the config gate; seeded relay groups
produce burn-consistent pool records (assert seed output shape).

E2e (playwright): close flow end-to-end - record "not a fit", inline ask,
Close -> dev-outbox shows the final message to both participants, composer
hard-disabled; late text from a closed participant (fake-phones) lands in
their 1:1 with the provenance badge and does NOT appear in the group or
any new group; a second group on the SAME number with disjoint
participants relays correctly both directions while the first is still
open (the multiplexing proof); Today nag card renders and Keep-open
defers it.

Gates: npm run typecheck + npm test + timeout 1500 e2e, bare, from the
worktree.

## 9. Post-merge obligations (known now)

- No new infra/tables (attribute-level changes only) unless the plan finds
  a GSI reshape is unavoidable - flag loudly if so.
- No data migration anywhere (section 6); a dev reseed after deploy is
  sufficient.
- RELAY_NUMBER_RELEASE_ENABLED stays OFF in deployed envs until Cameron
  turns it on (RUNBOOK entry + A2P/messaging-service note per section 5).
- Resolves docs/issues/group-threads-across-multiple-tours.md (the
  multi-tour numbering strategy IS this design); updates
  tour-outcome-close-not-backend-enforced.md (the close-ask flow subsumes
  part of it - the plan decides resolve vs narrow).
