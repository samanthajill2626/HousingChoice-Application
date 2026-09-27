# Plan research - dashboard renderers and API types: FINDINGS

Plan-phase research, 2026-09-26, worktree `W:\tmp\send-outcome-reconcile` at
a9f411f3 (RSW + share-skip-fix Branch A already merged). Read-only. Spec read:
revision 7. Scope: every renderer and wire type the new codes
(`send_unconfirmed`, `redrive_refused`, `sms_sending_disabled` on a relay leg),
the `unconfirmed` stats bucket and the slot `attemptedAt` touch.

This file holds FINDINGS only (what the spec gets wrong, what it omits, which
tests break, risks, and the reader sweep). The byte-exact copy, signatures,
types, fixture shapes and test idioms are the separate reference artifact
`.superpowers/sdd/plan-dashboard-reference.md` (gitignored, planner input).

## A. What the spec gets wrong

A1. **The "own arm in `shareRecipientReason`" rationale is a misread (Sec 2a
item 1, D22).** `shareRecipientReason` sends every non-`no_contact` failed code
to `deliveryReason` (`dashboard/src/routes/broadcasts/broadcastFormat.ts:156-158`),
and `deliveryReason` consults `INTERNAL_CODE_REASONS` first
(`dashboard/src/routes/contact/deliveryStatus.ts:1011-1012`). The "whole-group
sentence" exists only for `contact_opted_out` (`deliveryStatus.ts:928`). Once
D23 puts `send_unconfirmed` in `INTERNAL_CODE_REASONS`, the fall-through already
yields the D20 sentence; an own arm is redundant (harmless). The real trap is
the opposite: an own arm WITHOUT the internal-map entry leaves every relay
position printing `Delivery failed (error send_unconfirmed)`
(`deliveryStatus.ts:1040-1042`). The internal-map entry is the load-bearing
edit.

A2. **"It only ever appears on a CLOSED (`failed`) slot" (D20) is false on the
relay retry join, so D21's "K excludes `failed` slots carrying
`send_unconfirmed`" is wrong as worded.** The join's terminal step spreads the
ORIGINAL slot and overlays only the last rung's code
(`dashboard/src/routes/contact/relayRetryJoin.ts:422-429`), so a rung closed
`send_unconfirmed` lands on a root leg whose status is the original carrier
outcome - `undelivered` in the join's own UI fixtures
(`Timeline.delivery.test.tsx:846-848`), `failed` in others
(`relayRetryJoin.test.ts:23-31`). K is `failed || undelivered`
(`deliveryStatus.ts:459-460`) and would count it. The exclusion from K, the
inclusion in J and the row label must key on the CODE ALONE, exactly as the
`contact_opted_out` precedent does and documents (`deliveryStatus.ts:440-449`,
`:675-689`; the same "code alone" rule is restated at
`dashboard/src/api/types.ts:1757-1763`).

A3. **`isFailure: false` does not do what D20 says it does, and does something
D20 did not ask for.** No relay position offers a Retry: the only Retry button
is message-level (`Timeline.tsx:1423`) and keys on `msg.delivery_status`, which
stays `queued` on a relay source (`Timeline.tsx:1270-1273`). The broadcast
row's "open conversation to retry" hint keys on `row.status === 'failed'`
(`BroadcastResults.tsx:48`, `:63-67`), not on `isFailure`. What `isFailure:
false` DOES do on the relay surfaces is suppress the reason: the row and the
recital append a reason only on `isFailure` unless the presentation carries its
own (`Timeline.tsx:621-622`, `:1363-1365`). So `presentLegDelivery` must bake
the D20 reason into the presentation, as `Retrying` and `unconfirmed` already
do (`deliveryStatus.ts:726-764`), or the row reads a bare "Not confirmed". The
rollup's not-confirmed branch joins reasons from retry legs only
(`deliveryStatus.ts:567-570`), so the chip carries no D20 reason either unless
the plan adds `send_unconfirmed` legs to that list - a decision the spec leaves
open ("every render position keys on the code together"). The "no Retry" goal
on the broadcast row needs an explicit code check at `BroadcastResults.tsx:48`
/ `:63` (D22 names the link; the mechanism is not `isFailure`).

A4. **`unconfirmed` must NOT join `skippedTotal` (Sec 2a item 1 wording: "the
`skippedTotal` balance ... which the `unconfirmed` bucket joins"; D22 "the
StatChips balance rule (`skippedTotal` and the audience sum)").**
`skippedTotal` is also the "Not sent" test in `presentShareLabel`
(`broadcastFormat.ts:95-111`); folding `unconfirmed` into it would label a
share whose every recipient MAY have been texted "Not sent". It is its own
chip in the audience sum (`StatChips.tsx:28-36`, balance stated in the file
header `StatChips.tsx:1-16`), and `skippedTotal` stays three buckets.

A5. **Three of D22's "readers that change together" change by construction and
need no edit.** The SSE payload is typed as `BroadcastStats` on both sides
(`app/src/lib/events.ts:146-150`, `dashboard/src/api/types.ts:3065-3069`); all
three existing emitters and both routes derive stats with
`deriveBroadcastStats` (`app/src/jobs/broadcastFanOut.ts:167-173`,
`app/src/routes/webhooks/twilio.ts:3933-3937`, `:3978-3982`,
`app/src/routes/broadcasts.ts:293`, `:311`); the worker-to-app bridge passes
payloads opaquely (`app/src/routes/internal.ts:23-25`, `:71-84`) and the
dashboard parses without validation (`dashboard/src/api/EventStreamProvider.tsx:194-198`).
The edits are the two `BroadcastStats` types and `deriveBroadcastStats`
(`app/src/repos/broadcastsRepo.ts:254-306`); the obligation is that every NEW
emitter (verdict handlers, the rebuilt finalize) also derives - see C3.

A6. **The persisted `unconfirmed` counter (D22) is displayed nowhere.** When the
recipients map is non-empty every read path derives from the map
(`broadcastsRepo.ts:250-259`); persisted counters are read only by the
empty-map passthrough (`broadcastsRepo.ts:259`, drafts) and by TODAY's finalize
`allFailed = fresh.stats.failed >= total` (`broadcastFanOut.ts:747`). Bump it
for hygiene with the house idiom `{ unconfirmed: 1, queued: -1 }` (every close
does `{ <bucket>: 1, queued: -1 }`, `broadcastFanOut.ts:300`, `:385`, `:400`,
`:410`, `:491`, `:567`), but the rebuilt finalize (D16a) must decide from the
map / derived stats, not from persisted counters, or a stale persisted
`failed` decides the terminal status.

A7. **"The two seed files that build broadcast stats" are `matrix.ts` and
`performance.ts`; `lean.ts` and `cast.ts` build no broadcasts.** Matrix:
`app/src/lib/seed/matrix.ts:1202-1255` (untyped `Record<string, unknown>[]`,
so nothing forces a new field); performance: `app/src/lib/seed/performance.ts:989-1047`
(typed `BroadcastStats`, `satisfies BroadcastItem`). Neither seed has a
`failed` + `send_unconfirmed` slot, and every non-draft seed broadcast carries
a map, so its persisted stats are never displayed (only the matrix DRAFT's
empty-map stats are). Sec 8 item 15's "in both seeds" is therefore either a
display no-op (`unconfirmed: 0` in the literals) or requires adding a fixture
slot; the plan must say which. Lean (the e2e world) has no broadcast at all.

A8. **The D20 reason copy ends in a period; no reason entry does.** Every
`INTERNAL_CODE_REASONS` / `SHARE_SKIP_REASONS` entry is period-less
(`deliveryStatus.ts:927-981`). The recital appends "." after each row
(`Timeline.tsx:633-635`) and a `send_unconfirmed` leg has no `sentAt`, so
`row.when` is empty and the reason is last: "...whether this text went out.."
in the accessible name. The rollup joins reasons with "; "
(`deliveryStatus.ts:472`) giving ".;". Store it without the period.

A9. **RSW #7's "must both survive the merge" is already discharged.** RSW is
merged at a9f411f3 (`relayRetryJoin.ts:96-104`, `:422-424`); what remains is
keeping `relayRetryJoin.test.ts:217-237`, `Timeline.delivery.test.tsx:1056-1085`
and `relayWindowCloseMirror.test.ts` green beside the new `send_unconfirmed`
join test.

## B. What the spec omits that the plan must handle

B1. **`presentRecipientStatus` cannot produce "Not confirmed" today.** Its
signature is `(status, carrierSentAt?)` with no code
(`broadcastFormat.ts:126-142`), and `DeliveryBadge` passes only those two
(`DeliveryBadge.tsx:34`). The code must be threaded (third param, or the badge
decides). Lines `broadcastFormat.ts:136` and `:140` carry a non-ASCII U+2026
in `'Sending...'`; add the new arm on NEW lines and leave those two untouched
(the ASCII rule on touched lines would otherwise force a visible copy change
that `StatChips.test.tsx:108-112` and the 1:1 parity at `deliveryStatus.ts:52`
pin).

B2. **The broadcast row has three status-keyed treatments, the spec names
one.** Besides the retry hint (`BroadcastResults.tsx:63-67`), `failed` drives
the red row class (`BroadcastResults.tsx:73`, `:85`) and the failures-first
sort (`broadcastFormat.ts:206-210`, pinned `broadcastFormat.test.ts:51-64`).
Decide each for `send_unconfirmed`. The row stays a link to `/contacts/:id`
(`BroadcastResults.tsx:71-80`); only the hint text goes. If the plan edits the
hint condition, touch line 63 or 48, not line 66 (it carries U+2197 and is
the accessible name `BroadcastResults.test.tsx:149` resolves by regex).

B3. **The terminal pill for an all-unconfirmed share reads "Failed".** D16a
closes such a share `failed`; `presentShareLabel` maps that to "Failed"/danger
(`broadcastFormat.ts:95-103`), the list files it under the Failed tab
(`BroadcastsList.tsx:25`), and the results header renders `last_error`
verbatim as `role="alert"` (`BroadcastResults.tsx:141-145`; today's string
`'all recipients failed'`, `broadcastFanOut.ts:748`). A "Failed" share whose
rows say "Not confirmed" invites exactly the resend D20 exists to prevent, and
D16a's new `last_error` wording is staff-facing copy the spec does not state.
Spec-level decision owed; flag to the planner.

B4. **The `send_unconfirmed` J arm must be independent of the clock and of
`retryAware`, which changes two stated invariants.** The docblocks say that
with `nowMs` withheld the not-confirmed branches cannot be selected
(`deliveryStatus.ts:421-425`) and that with `retryAware` off the counts
collapse to the shipped two (`:451-456`). A code fact is neither: a
`send_unconfirmed` leg must count in J with no clock and with `retryAware`
off (the contact page does not render relay groups - `contactTimeline.ts:1242`
- but the relay view passes `retryAware: true` only via `isRelayLeg`,
`Timeline.tsx:1148`). The existing test `deliveryStatus.test.ts:613-628` keeps
passing (stale legs only), but the doc claims must be amended and a no-clock
`send_unconfirmed` case added. The native group-text product stays
byte-identical because it never carries the code.

B5. **D20a needs three type edits and one doc rewrite; the wire already
carries the field.** `attemptedAt` is absent from the dashboard
`RelayRecipientDelivery` (`dashboard/src/api/types.ts:1764-1773`), from the
presenter's `RelayDeliverySlot` (`deliveryStatus.ts:157-163`) and from the app
`RelayRecipientDelivery` (`app/src/repos/messagesRepo.ts:159-168`). Every wire
path passes the slot map whole: `useRelayThread.ts:125`,
`app/src/routes/contactTimeline.ts:453`, `GET /conversations/:id/messages`
returns rows as-is (`app/src/routes/api.ts:2182-2206`),
`buildTimelineFallback.ts:93`. The edit is the `queued` arm of
`stalenessClockMs` (`deliveryStatus.ts:239-240`) plus its S3 table
(`:196-206`) and the "byte-identical hold vs never-ran fan-out" rationale
(`:213-224`, which a claimed slot no longer shares). The `canEverGoStale` doc
says every ageing clock is the PROVIDER's (`:297-301`); `attemptedAt` is our
server clock - the futurity reasoning still holds, the sentence does not.
Precedence for a `queued` slot whose `sentAt` does not parse but whose
`attemptedAt` does is unstated (the existing no-clock test is
`deliveryStatus.test.ts:140-148`). Tests: a new S3 row in
`deliveryStatus.test.ts:101-285`, a new ARMING case in
`Timeline.ticker.test.tsx:300-328` (SILENT row 4 at `:331-343` must stay),
and a passthrough assertion in `useRelayThread.test.tsx:57-88`.

B6. **`withDecidingRung` does not treat `attemptedAt` as rung-owned.** It
strips and replaces seven named rung fields (`relayRetryJoin.ts:283-304`), so
the ORIGINAL's `attemptedAt` survives the `delivered-on-retry` and
`unconfirmed` overlays beside the rung's `status`. Inert today (the retry
states decide before staleness, `deliveryStatus.ts:725-765`; the ticker reads
raw slots, `Timeline.tsx:926-952`), but it contradicts the function's
"replacement, not fill-in" contract and the pinned
`relayRetryJoin.test.ts:403-431`. Add it to the stripped set, or record why not.

B7. **A broadcast slot's `attemptedAt` has no dashboard reader.** The results
route spreads the slot, so it crosses the wire (`app/src/routes/broadcasts.ts:238`,
`:244`, `:250-255`), but `toRecipientViews` is a fixed field list
(`broadcastFormat.ts:194-203`) and the broadcast surfaces have no staleness
rule. D8a's "so a stranded slot can age (D20a)" is relay-only: a stranded
broadcast recipient reads "Sending..." and sits in the Queued chip forever.
Consistent with Sec 1's residue; the spec's wording implies more.

B8. **`sms_sending_disabled` has no stated copy and four existing
spellings.** D23 adds it to `INTERNAL_CODE_REASONS` without a string; existing
copy: `'Texting is turned off'` (`deliveryStatus.ts:980`),
`'SMS sending is off'` (`dashboard/src/api/types.ts:1356`),
`'SMS sending is switched off, so nothing was sent.'` (`types.ts:1414`),
`'SMS sending is currently disabled.'` (`Timeline.tsx:106-107`). Adding the
internal entry changes `deliveryReason` for every caller; skipped broadcast
rows are unaffected (`broadcastFormat.ts:155` routes them through
`shareSkipReason` first). Reusing `'Texting is turned off'` keeps the share
badge and a relay leg reading alike.

B9. **No drift guard for the new codes or for `BroadcastStats`.** The
dashboard hand-copies code keys; the precedent guard is
`relayWindowCloseMirror.test.ts:1-40` (imports the app constant across
workspaces). `send_unconfirmed` and `redrive_refused` want the same (they have
no app constant yet - the app writes close codes as bare literals,
`broadcastFanOut.ts:361`, `relayFanOut.ts:1132`). `BroadcastStats` is mirrored
by comment only (`dashboard/src/api/types.ts:2906-2910`). The open issue
`broadcast-skip-code-drift-guard` says its union should land AFTER this branch.

B10. **`unconfirmed` must be OPTIONAL in both `BroadcastStats` types.**
Persisted rows written before the field lack it (the `skipped_other` /
`sending` precedent, `broadcastsRepo.ts:104-124`), and every dashboard stats
fixture omits it (`StatChips.test.tsx:12-23`, `broadcastFormat.test.ts:170-172`,
`BroadcastResults.test.tsx:39`, `BroadcastsList.test.tsx:34`,
`useBroadcastResults.test.tsx:36`). Read it with `?? 0` as `sending` is
(`StatChips.tsx:32`); add `unconfirmed: 0` to `zeroStats`
(`broadcastsRepo.ts:309-321`). `bumpStats` ADD creates a missing nested
counter (`broadcastsRepo.ts:760-801`; proven for `skipped_other` at
`broadcastsRepo.integration.test.ts:147-170`).

B11. **The finalize log line lists the derived buckets by name**
(`broadcastFanOut.ts:754-770`); add `unconfirmed`. Its test uses
`toMatchObject` (`broadcastFanOut.test.ts:368-379`) and will not fail if the
field is forgotten.

B12. **Positions the spec does not name, checked and needing no edit:** the
inbound-relay sr-only recital (`Timeline.tsx:1220-1231`) and the all-opted-out
message-chip recital (`:1205-1216`) both go through `recipientSummaryName`, so
they follow `presentLegDelivery`; the list row's "N/M delivered"
(`BroadcastsList.tsx:151`) is unaffected; the message-transport aggregate line
stays at the requested transport for a leg with no `actualTransport`
(`dashboard/src/lib/messageTransport.ts:79-109`), as it already does for any
failed leg; the ticker needs no clause (a `failed` leg is terminal,
`deliveryStatus.ts:241-245`; a `send_unconfirmed` rung is terminal,
`relayRetryJoin.ts:90-94`, `:185-189`).

## C. Risks

C1. **The composed rollup is the easiest place to double count.** K/J
disjointness is load-bearing (`deliveryStatus.ts:507-513`) and asserted
(`deliveryStatus.test.ts:168-172`, `:588-601`); a `send_unconfirmed` leg that
is excluded from K by status but included in J by code (or the reverse)
reads "1 failed, 1 not confirmed" for one member. Test the pair on BOTH
`failed` and `undelivered`, with and without a clock, with and without
`retryAware`.

C2. **Projecting vs mapping the rung close.** If the plan instead maps a
`send_unconfirmed` rung to the join's existing `retryState: 'unconfirmed'`,
the overlay takes the rung's `failed` status and the row reads
"Sent - not confirmed" (`deliveryStatus.ts:761`) - asserting a send that may
not have happened - with the original's 30003 as its reason. Projecting the
code through step 4 unchanged and keying the presenters on it is the path
that yields D20's "Not confirmed".

C3. **A new emitter that sends persisted stats regresses the chips.** Both
hooks REPLACE `stats` wholesale from the event (`useBroadcastResults.ts:128`,
`useBroadcastsList.ts:118`); persisted counters are cumulative on legacy rows
and would flash wrong values until the debounced refetch. Every reconcile-side
`broadcast.updated` must carry `deriveBroadcastStats(item)`.

C4. **Reconcile lengthens `sending`.** The results page polls every 2 s while
`sending` (`useBroadcastResults.ts:46`, `:155`); D13a's window (checks to ~4
minutes, then a possible re-drive) keeps a share `sending` for minutes, each
poll running the results enrich BatchGet (`broadcasts.ts:223-258`). Bounded,
but new.

C5. **The broadcast "Retry offer" for `enqueue_failed` after `never_sent`
(D13a) points at a thread with nothing to retry.** The hint links to the
tenant's 1:1 (`BroadcastResults.tsx:63-67`), but `sendMessage` never appended
a row for a never-sent recipient, so there is no failed bubble there. Already
true of `transient_cap` / `enqueue_failed` rows today; D13a relies on it.

C6. **Stage 1b forward risk.** The 1:1 Retry button keys only on the message's
status (`Timeline.tsx:1423`, via `:1028-1030`); if the `retrySend` adoption
ever writes `send_unconfirmed` onto a 1:1 MESSAGE row, the button offers the
double send. Not reachable on this branch (unresolved writes slots only).

## D. Tests that will break (assertion shapes to extend are in the reference)

- D23 `transient_cap` copy (exact strings): `deliveryStatus.test.ts:377`,
  `:781`, `:839`, `:876`, `:894`; `broadcastFormat.test.ts:153`;
  `StatChips.test.tsx:152`; `Timeline.delivery.test.tsx:388`, `:396-397`.
  `Timeline.delivery.test.tsx:423` is a NEGATIVE on the old phrase and passes
  vacuously after the change - update it to the new phrase.
- New chip: the exact order array `StatChips.test.tsx:75-86`.
- `deriveBroadcastStats` gaining a returned key: full-object `toEqual` at
  `app/test/deriveBroadcastStats.test.ts:43-53` and
  `app/test/broadcastApi.test.ts:1269-1279`.
- Bucket-sum invariants that will NOT fail but silently stop covering the new
  bucket: `deriveBroadcastStats.test.ts:93-123`,
  `broadcastFanOut.test.ts:1118-1128`, `broadcastApi.test.ts:386-396`.
- Nothing in e2e pins the changed copy; `e2e/tests/dashboard-next/broadcasts.spec.ts:269-276`
  reads chips by exact `<dt>` label, so a "Not confirmed" chip cannot collide.

## E. READER SWEEP (status / errorCode / sentAt of a slot, and BroadcastStats)

Dashboard - broadcast recipient slot:
- `dashboard/src/routes/broadcasts/broadcastFormat.ts:126-142` presentRecipientStatus - status, carrierSentAt (no code).
- `broadcastFormat.ts:151-161` shareRecipientReason - status, errorCode.
- `broadcastFormat.ts:182-211` toRecipientViews - copies status/carrierSentAt/errorCode/conversationId; sorts on status 'failed' (:206-210).
- `dashboard/src/routes/broadcasts/DeliveryBadge.tsx:33-42` - both helpers above.
- `dashboard/src/routes/broadcasts/BroadcastResults.tsx:48`, `:58-62`, `:63-67`, `:73`, `:85` - failed flag, badge props, retry hint, red row.

Dashboard - BroadcastStats:
- `broadcastFormat.ts:95-103` presentShareLabel; `:109-111` skippedTotal.
- `dashboard/src/routes/broadcasts/StatChips.tsx:27-52` the chip row.
- `dashboard/src/routes/broadcasts/BroadcastStatusPill.tsx:19-28` via presentShareLabel.
- `BroadcastResults.tsx:126`, `:138`, `:156` - audience label, pill, chips.
- `dashboard/src/routes/broadcasts/BroadcastsList.tsx:39`, `:144`, `:151` - audience label, pill, delivered/audience.
- `dashboard/src/routes/broadcasts/useBroadcastResults.ts:121-137` - SSE overlay replaces stats (:128).
- `dashboard/src/routes/broadcasts/useBroadcastsList.ts:114-124` - SSE patch replaces stats (:118).
- `dashboard/src/api/EventStreamProvider.tsx:194-198` - unvalidated passthrough.
- `dashboard/src/api/types.ts:2911-2929`, `:2962-2984`, `:3006-3022`, `:3065-3069` - the types.

Dashboard - relay slot:
- `dashboard/src/lib/messageTransport.ts:43-47`, `:49-57`, `:59-77`, `:79-109` - exclusion, entries, per-leg transport, aggregate.
- `dashboard/src/routes/contact/deliveryStatus.ts:228-255` stalenessClockMs; `:269-277` isStaleLeg; `:351-364` canEverGoStale.
- `deliveryStatus.ts:435-604` presentRelayDelivery; `:668-770` presentLegDelivery.
- `dashboard/src/routes/contact/relayRetryJoin.ts:145-175` index; `:185-189` terminal; `:204-208` rung clock; `:278-305` overlay; `:348-430` projection (code at :423-424).
- `dashboard/src/routes/contact/Timeline.tsx:522-526` row time; `:596-638` recital (code :622); `:907-954` ticker predicate (code :927, clocks :951); `:1073-1076` opted-out count; `:1113-1157` projection + rollup; `:1325-1398` rows (code :1365); `:2092-2107` retry-row visibility (rung status :2106).
- `Timeline.tsx:1028-1057` message-level chip (message fields, not a slot; renders an adopted broadcast row in the 1:1).
- `dashboard/src/routes/conversation/useRelayThread.ts:125`, `dashboard/src/routes/contact/buildTimelineFallback.ts:93` - whole-map passthrough.
- `dashboard/src/api/types.ts:1764-1773` RelayRecipientDelivery.

App routes:
- `app/src/routes/broadcasts.ts:223-258` enrichRecipients - spreads the slot verbatim.
- `app/src/routes/broadcasts.ts:280-298` results, `:301-315` list - deriveBroadcastStats at `:293`, `:311`.
- `app/src/routes/contactTimeline.ts:453` - relay map passthrough (relay and group threads skipped at `:1242`).
- `app/src/routes/api.ts:2182-2206` - messages returned as-is; `:2574-2575` SSE write passthrough.
- `app/src/routes/internal.ts:55-84` - bridge, opaque payload.
- `app/src/routes/webhooks/twilio.ts` (FENCED, read only): broadcast `:3840-3844` transition gate, `:3887-3901` slot match, `:3923-3941` carrierSentAt + emit, `:3950-3982` terminal + bump + emit; relay `:2787-2795` retry-claim slot check, `:3124` requested transport.

App non-route readers (context):
- `app/src/repos/broadcastsRepo.ts:254-306` deriveBroadcastStats; `:576-619` priorRecipientContactIds (non-skipped counts, so `send_unconfirmed` flags "Already sent" - the safe direction; mirrored in `app/test/helpers/twilioWebhookHarness.ts:3034-3042`).
- `app/src/jobs/broadcastFanOut.ts:146-150` isTerminal, `:295`, `:348`, `:374`, `:723-770` finalize (persisted `stats.failed` at `:747`).
- `app/src/jobs/relayFanOut.ts:1087`, `:1116`, `:1348`, `:1528-1562` - slot status reads in the fan-out.
- `app/src/services/groupSendStaleness.ts:166`, `app/src/services/groupReceipts.ts:343`, `:503` - native group text only; never see the new codes.
