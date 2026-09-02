---
id: provider-status-unenumerated-defaults
title: Provider-status branches whose unenumerated default is non-terminal ("keep waiting")
type: bug
severity: med
status: open
area: app
created: 2026-09-01
refs: app/src/adapters/messaging.ts:545, app/src/adapters/messaging.ts:675, app/src/routes/webhooks/voice.ts:216, app/src/routes/webhooks/voice.ts:1631, app/src/routes/webhooks/twilio.ts:2359, app/src/routes/webhooks/twilio.ts:2470, app/src/services/groupRail.ts:290, app/src/services/groupRail.ts:493, app/src/services/groupRail.ts:544
---

**Problem.** Three places branch on a status string a provider gave us and send
every value they do not enumerate down a NON-TERMINAL arm: "not finished yet,
keep waiting" or "nothing to change here". That is the exact shape of the
2026-08-16 prod incident, whose voice half `a755c6f8` fixed: Twilio returned a
transcript status of `error`, the code enumerated `failed` but not `error`, the
unknown value fell into the keep-waiting arm, and a 1-second voicemail sat on
"Transcribing..." forever with nothing to page anybody.

None of these three is a live bug today: no value Twilio currently emits reaches
any of the defaults below. The exposure is LATENT and it is a class, not an
accident - a vendor adding one enum value turns each of them into a silent
stall.

Found by the bounded `app/src` sweep that spec Sec 9 of
`feat/retry-counter-durable` required. 52 sites were enumerated; the full table,
the per-site disposition and the methodology are in
`docs/superpowers/reviews/2026-08-31-retry-counter-durable/provider-status-sweep.md`.
Everything else in that table is SAFE (terminal default, or a closed TypeScript
union the compiler makes exhaustive), a deliberate loud drop, or backstopped by
a cap or a staleness alarm. This issue is the residue.

## 1. `mapTwilioStatus` - the root of the class

`app/src/adapters/messaging.ts:533-549`, default at `:545-547`:

```
    default:
      // accepted | scheduled | queued | sending | anything new Twilio adds.
      return 'queued';
```

`queued` is our most non-terminal `DeliveryStatus`. The comment says out loud
that the arm is meant to absorb "anything new Twilio adds", so a future
TERMINAL `MessageStatus` is silently reported as still-in-flight at every
caller. This is the ROOT site: the two fenced webhook call sites inherit it, and
so does every consumer of a send result.

Callers, all inheriting the default:

- `app/src/routes/webhooks/twilio.ts:2359` and `:2470` - the two highest-traffic
  status-callback paths. FENCED on this branch (M4/M12/T-PUSH own that file);
  audited, never edited. A new terminal `MessageStatus` arriving here is mapped
  to `queued`, the forward-only guard then refuses the write as a regression,
  and the receipt disappears as an INFO line.
- `app/src/adapters/messaging.ts:675` - the SEND result, which reaches
  `app/src/jobs/relayFanOut.ts:1007` and
  `app/src/services/relayAnnouncements.ts:308`. Both read
  `result.status === 'queued' ? 'queued' : 'sent'`, so the polarity inverts
  there: an unknown status is mapped to `queued` and then recorded as `sent`.
  Self-correcting via the forward-only DLR, but a create that actually failed is
  briefly shown as sent.

The in-repo counter-example is `app/src/services/groupReceipts.ts:12-22`, which
refuses to use `mapTwilioStatus` for Conversations receipts for precisely this
reason and states it in a comment: a total mapper with a `queued` default
"SILENTLY MISCLASSIFIES ... A wrong delivery state that leaves no trace is worse
than a loud drop". That file WARNs and counts unmapped values instead. It is the
shape a fix should copy.

## 2. Unmodeled `CallStatus` / `DialCallStatus` is acked and changes nothing

`app/src/routes/webhooks/voice.ts:216-236` (`mapCallStatus`, `default: return
undefined`) feeding `:1630-1637`:

```
    if (mapped === undefined) {
      // A status we don't model (e.g. 'queued'/'initiated') - ack so Twilio
      // stops, but make no change.
```

Twilio gets its 200 and stops resending. The call row keeps whatever
non-terminal status it had (`ringing` / `in-progress`) and no later callback is
coming, because the one that would have finished the call is the one that was
just discarded. This is the same family as the 2026-08-16 incident, one channel
over, and it is the closest structural match still unpatched: a row stuck
mid-flight, an INFO line nobody reads, no alarm.

The INFO log is the only trace. There is no cap, no reconcile job and no
staleness sweep on this path - unlike the transcript path, where
`RECONCILE_MAX_ATTEMPTS` (`app/src/jobs/voiceTranscript.ts:31`) is what makes the
non-terminal default safe.

## 3. `isDeadRailState` defaults an unknown Conversations state to "alive"

`app/src/services/groupRail.ts:290-293`:

```
function isDeadRailState(state: string | undefined): boolean {
  const value = state ?? 'active';
  return value === 'closed' || value === 'failed';
}
```

The port types the field as a raw vendor string
(`app/src/adapters/groupConversations.ts:36-43`, documented as
`initializing | active | inactive | closed`), so any value outside those two
literals - a future Twilio state included - reads as a rail that still works.

This site is IN-REGION for `feat/retry-counter-durable` and spec Sec 9 says
in-region findings are fixed, not filed. It is filed anyway, deliberately: the
analysis showed no fix that a sweep is allowed to make. The per-consumer
verdict, in full, is in the sweep record; the short version is that the
predicate has TWO consumers whose failure directions are OPPOSITE and whose
agreement is load-bearing:

- **Adopt-keep (`:493`).** An unknown state means the adoptee is KEPT. That
  default is CORRECT. The action it gates is `port.removeConversation` - a
  DELETE of a live Twilio resource - and the code's own justification for
  deleting (`:483-486`: "safe precisely because the resource is CLOSED ... We
  are reclaiming a name, not discarding data") does not survive a state we do
  not understand. Defaulting unknown to dead here would destroy rails on a
  vendor enum addition.
- **Post-create finalize (`:544`).** An unknown state means the rail is
  FINALIZED and stored, and every later staff send posts into a Conversation
  that may carry no traffic - a silent no-delivery, which is the exposed
  polarity and what `:535-536` warns about. But flipping only this consumer
  reinstates a closed defect: an adopted rail in an unknown state would pass
  `:493` undeleted, fail at `:544`, record `rail_failed`, and `groupSend`'s
  `healRail` would clear the sid, call back in, adopt the same Conversation and
  fail again - forever. That is the permanent-refusal loop fix wave 4's H1
  removed, described in the code at `:466-474`.

So the two consumers cannot take the same default and cannot safely take
different ones without redesigning the adopt/heal interaction. That is a
mission-sized change, not a sweep.

## What a fix must preserve

- **`mapTwilioStatus` is total and load-bearing.** It is called from a fenced
  file on the hottest path in the app. Do not make it throw or return
  `undefined` without auditing every caller: `groupReceipts`'s ruling shape
  (an explicit table plus an `undefined` "unmapped" ruling that is WARNed and
  counted) is the proven alternative, and it needed a parked-receipt design to
  go with it. A cheaper first step that changes no behavior: WARN once per
  distinct unmapped value at the default arm, so the next vendor addition is
  visible the day it arrives instead of years later.
- **The voice ack must stay a 200.** Twilio must not be made to retry; the
  incident is about the ROW, not the response. The fix is to give the
  non-terminal outcome a bound - a reconcile enqueue or a staleness sweep, as
  the transcript path already has - not to change the TwiML.
- **`isDeadRailState`'s two consumers must be decided TOGETHER**, and any change
  must keep both invariants that already hold: a dead adoptee is deleted before
  the state check (so `:544` can only see a freshly created rail), and no path
  can reach `recordRailFailure` on a rail nothing will ever delete. A per-call-
  site predicate that breaks either one re-opens the closed-rail loop.
- Nothing here should turn a silent stall into a LOUD stall. `rail_failed` and a
  dropped receipt are also terminal-for-the-user; the goal is that an
  unrecognised provider value produces a signal, not that it produces a refusal.

## Lineage

- `a755c6f8` ("fix(jobs,voice): wire the worker's job queue and stop a dead VI
  transcript hanging on 'Transcribing...'") is the incident patch and the
  reference shape. Its surviving form is
  `app/src/services/voiceTranscripts.ts:116-120` and `:198-213`: a terminal
  failure SET that includes the undocumented `error`, plus a non-terminal
  default that is safe only because `RECONCILE_MAX_ATTEMPTS` stamps it failed.
- [retry-counter-in-envelope-makes-caps-unreachable](./retry-counter-in-envelope-makes-caps-unreachable.md)
  asked for this sweep in its "Also worth auditing (not yet done)" paragraph. It
  proposed grepping for a `!== 'success'` fallthrough; that literal returns
  **zero hits in all of `app/src`** (verified twice, at `8c8b7100` and at the
  sweep), and so does the bare string `'success'`. Spec Sec 9 re-based the sweep
  on the POLARITY of the unenumerated default instead, which is what found these
  three. That paragraph can now be marked done and pointed here.
- [throw-for-redelivery-defeated-by-job-marker](./throw-for-redelivery-defeated-by-job-marker.md)
  is the other in-region exposure the same sweep confirmed. It is the D12
  exception spec Sec 9 named in advance: filed, not fixed, on this branch. Its
  two false comments were corrected as part of the sweep.
