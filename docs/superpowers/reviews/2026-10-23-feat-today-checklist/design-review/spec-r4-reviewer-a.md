# Spec review r4 - reviewer A (adversarial): the 7.5 backfill

Scope: section 7.5 of the spec at 28d33501 (diffed against 4353c68c). Repo
read-only; nothing run. The decision to backfill is Cameron's; this reviews how
7.5 specifies it.

Summary: the 14-day window argument is correct. The read can be much cheaper
than the last-heard-from shape. Two filters cannot work as written (calls, and
the per-member slot state); both would stamp contacts nobody reached. The rest
are LOW precision fixes.

---

## B1. MEDIUM - The call filter counts every call the navigator never accepted, where the contact was never dialed

7.5: calls count when `type` 'call' and `direction` outbound, "except calls
refused before the target was dialed (the canceled refusal stamp the
whisper-gate writes)".

The most common not-dialed case writes no `canceled`:

- `originateCall` appends the row with `callStatus: 'ringing'` as soon as the
  NAVIGATOR's cell rings (`app/src/services/originateCall.ts:153-189`).
- A never-accepted originate (cell unanswered, whisper timeout) "emits no
  <Dial>" and nothing closes the row (`originateCall.ts:191-198`). It stays
  `ringing` for good, and the dashboard derives "No team answer" from its age
  (`dashboard/src/routes/contact/presentCallState.ts:143-149`).
- `canceled` is written only by the refusals - the outbound-bridge one
  (`voice.ts:1415`) and the two whisper-gate ones (`voice.ts:1586`, `:1640`). It is also not refusal-only in general, since in-progress ->
  canceled is legal (`voice.ts:1404-1409`).

So the filter as written stamps exactly the navigator-leg-only attempts that
W6 was moved off originate to exclude (7.2: "not when only the staff member's
own cell has rung"). Use the positive marker instead: the outbound accept
branch writes `answeredAt` at press-1, just before the <Dial>
(`voice.ts:1672-1678`; stored as `answered_at`, `messagesRepo.ts:1169, 2676`).
Count an outbound call row only when `answered_at` is present, or when it has a
`call_outcome` (that write is best-effort). Do not filter on "not canceled".

## B2. MEDIUM - Per-member slot STATUS is not a "sent" marker; the right marker differs for relay and group rows

7.5 stamps team-post members "using the per-member slot state ... so a member
with no sent leg is skipped".

- Relay: "a relay success may leave the slot `queued`"
  (`app/src/jobs/relayFanOut.ts:47-49`), so status cannot tell a sent leg from
  an unsent one. A sent leg records `sid` and `sentAt` on its slot
  (`relayFanOut.ts:31-33`; slot fields `messagesRepo.ts:161-171`). Count a
  relay member when the slot has a `sid` (or `sentAt`). Slot keys are
  `relayMemberKey`, the contactId when known (`messagesRepo.ts:196-200`).
- Group text: `queued` is the steady state of an ordinary post ("It is
  `queued` for an ordinary send", `services/groupSend.ts:638-641`). A
  suppressed member is seeded `{ status: 'undelivered', errorCode: SUPPRESSED }`
  with `transportAggregationState: 'excluded'` (`groupSend.ts:625-630`,
  `services/groupDelivery.ts:59-61`). A status filter would therefore skip most
  real recipients and could not tell suppressed from carrier-undelivered. Use
  `transportAggregationState !== 'excluded'`.
- Group slots are keyed by PHONE (`groupMemberKey` = `phone#<E164>`,
  `services/groupMembers.ts:42-44`, used at `groupSend.ts:609`), not by contact.
  The script must resolve each slot phone to a contact (findByPhone, memoized,
  as the last-heard-from script does). It must not use the thread's CURRENT
  roster, which can differ from the roster at send time.

## B3. LOW - Imported Quo rows pass the relay/group and call filters; mark them out explicitly

The 1:1 filter requires `author` 'teammate', and imported rows carry
`author: 'staff'` (`app/src/lib/import/apply.ts`, the message and call
builders ~472-519), so they are excluded there. But the relay/group category
keys only on `relay_sender_key` 'team', which the importer also writes for
group outbound rows (`apply.ts:95-104, 132`). And the call category keys only
on type and direction. The no-stamp table's "Quo rows are older than the
backfill window anyway" is a date assumption (UNVERIFIED for any future
`import:apply` run). Every imported row carries `imported_from`
(`apply.ts`, `imported_from: IMPORT_SOURCE`). Require `imported_from` absent
and `author` 'teammate' in EVERY category.

## B4. LOW - The 1:1 category must restrict `type`, and "not a failed email" is the wrong email test

- As written, the one-to-one category (outbound, 'teammate', `automated` not
  true, no `broadcast_id`, no retry fields) also matches call rows: they are
  author 'teammate' and carry no `automated` (`originateCall.ts:171-189`). That
  would bypass B1. Restrict the category to `type` sms / mms / email.
- Email is persisted `queued` BEFORE SES is called (`sendEmailMessage.ts:393-410`).
  A row whose SES step never completed is neither sent nor failed, so "not a
  failed email" counts it. Live W3 stamps only once SES accepts. Require the
  accepted status the post-SES update writes (the plan names the value).

## B5. LOW - Staff-edited relay intros are written as system rows, so the 'system' skip drops W7

The intro row is `author: 'system'`, `relay_sender_key: 'system'` whatever its
body (`services/relayAnnouncements.ts:229-241`, `SYSTEM_SENDER_KEY = 'system'`
at :47). Live W7 stamps an intro whose body is the staff-edited `intro_body`.
The backfill skips it. It can be recovered: the earliest system row in a relay
thread whose `body` equals the conversation's `intro_body`
(`repos/conversationsRepo.ts:238`). Either do that, or name the gap in the dry
run's approximation count, as 7.5 does for Send now.

## B6. LOW - Reuse the script's skeleton, not its read: query the 14-day window by sort key

The last-heard-from script reads each thread's whole history through a
FilterExpression (`app/scripts/backfill-last-heard-from.ts:206-223`). Group
threads read to exhaustion, and the read is paid on every row. The messages
sort key is `${providerTs}#${providerSid}` (`repos/messagesRepo.ts:203-205`),
so a key condition `conversationId = :c AND tsMsgId >= :floor` reads only the
window. Floor it a day early and re-check each row with `normalizeInstant`, so
a stored instant without milliseconds or in an odd format cannot fall off the
edge.

Keep the full conversations Scan, and do NOT prefilter threads on
`last_activity_at`: outbound calls and queued relay posts deliberately do not
touch it (`originateCall.ts:192-198`, `routes/api.ts:1971-1978`). For a 1:1
thread, newest-first with an early stop at the first qualifying row is still
valid. A relay/group thread needs every row in the window, per member.

## B7. LOW - "Before or after the deploy is equally safe" is true of the writes, not of coverage

The forward-only writer makes any run order safe to WRITE. But a run before
the deploy leaves every staff send between that run and the deploy stamped by
nothing, because neither the script nor the not-yet-deployed live writers see
it. The "Who runs it" bullet already says after the deploy; drop the "before
or after" sentence so nobody runs it early.

## B8. LOW - Send now: there is no row marker, but an approximate join exists

Send-now rows are `automated: false`, `author` 'teammate', with no
`broadcast_id` (`jobs/tourReminders.ts:1998-2004`,
`jobs/placementNudges.ts:854-860`). Nothing on the message row tells them from
a W1 send, and the reminder/nudge records store `sentAt` but no SID
(`repos/tourRemindersRepo.ts:130`, `repos/placementNudgesRepo.ts:70`). The plan
can exclude rows whose instant falls within seconds of a sent reminder/nudge
on that tenant's thread, or keep 7.5's counted approximation. Either is
acceptable; name the choice.

---

## The 14-day window argument (charge 2): correct

Quiet shares compares the stamp only with a candidate share's `sentAt`. Every
candidate at any evaluation time after the run has `sentAt >= runTime - 14d`
(FOLLOW_UP_LOOKBACK_MS; `isWaiting`, `lib/listingSendOutcome.ts:150-153`), so
a row older than `runTime - 14d` can never be the later instant that matters.
The live writers cover everything after the deploy. The only coverage gap is
B7.

## What changes the build

B1 and B2 change what the script stamps. B3-B8 are precision fixes the plan
can absorb.
