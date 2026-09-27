---
id: relay-fanout-closes-emit-nothing
title: The relay fan-out's own terminal closes emit no live update, so an open relay thread keeps showing a closed leg's old state until something else refetches it
type: bug
severity: low
status: open
area: app/messaging-relay
created: 2026-09-27
updated: 2026-09-27
refs: app/src/jobs/relayFanOut.ts:697, app/src/jobs/relayFanOut.ts:1196, app/src/jobs/relayFanOut.ts:1244, app/src/jobs/relayFanOut.ts:1683, app/src/jobs/relayFanOut.ts:2130, app/src/jobs/relayFanOut.ts:2214, dashboard/src/routes/conversation/useRelayThread.ts:464, app/src/jobs/relayRetryLeg.ts:574, app/src/jobs/sendReconcile.ts:668
---

**Problem.** `relayFanOut.ts` has no event bus: `RelayFanOutJobDeps`
(`app/src/jobs/relayFanOut.ts:697-740`) takes no `events`, and nothing in the
file emits. So none of the fan-out's own TERMINAL slot writes is announced.
Pre-existing: the opt-out suppression close (`:1857-1915`), the refusal close
(`:2130-2146`), the carrier-filtered 30007 close (`:2151-2167`) and the
cap-closes, `transient_cap` and `enqueue_failed` (`closeRelay`, `:1244-1293`).
`feat/send-outcome-reconcile` adds more of the same class: the provider
rejection close (`:2169-2192`, formerly a throw), a re-drive's second-unknown
close (`send_unconfirmed`, `:2214-2231`), the reconcile hand-off's
enqueue-failure close (`send_unconfirmed`, in `handOff`, `:1211-1224`) and the
re-drive refusal close (`redrive_refused`, `closeRedriveRefused`,
`:1683-1722`). The leg unit's closes are shared with the relay retry rung,
which announces its root after them (`app/src/jobs/relayRetryLeg.ts:1114`);
on the fan-out's own path nothing does. A SENT leg is announced later by the
status webhook's receipt emit; a terminal close gets no receipt, so nothing
ever announces it.

An open relay thread refetches only on server-sent events: `useRelayThread`
schedules a debounced refetch on `message.persisted`, `conversation.updated`
and `scheduled.updated`, and does not poll
(`dashboard/src/routes/conversation/useRelayThread.ts:464-501`). A leg the
fan-out closed keeps reading its previous state - "Sending...", or "Queued -
not confirmed" once its attempt clock passes 15 minutes - until some other
event on that thread, or a reload, shows the close and its reason ("Couldn't
confirm whether this text went out", "Sending gave up after repeated temporary
errors" and so on).

The two other relay writers do announce their closes, and are the model. The
relay retry rung emits `message.persisted` at its ROOT after every terminal
close it writes (`announceRootClose`, `app/src/jobs/relayRetryLeg.ts:574-581`,
with an injectable `events` dependency at `:168-174`). The `send.reconcile`
job emits after every relay slot move it makes (build ruling A1): a leg's
adoption and the job's own closes announce the source row in the status
webhook's shape (`announceLeg`, `app/src/jobs/sendReconcile.ts:668-680`,
called at `:643` and from `closeSlot`, `:825-834`), and every close or
adoption of a rung announces the rung's root (`afterClose`, `:856-873`).

Low: presentation only. The durable state is right, nothing double-sends, and
a reload shows the truth.

**Suggested fix.** Give the fan-out the rung's `events` dependency (the
singleton by default; in the worker process the event bridge forwards every
emit to the app's SSE clients) and emit `message.persisted` for the source
row after each terminal close the fan-out writes: the conversation, the source
`tsMsgId`, the source's direction and `deliveryStatus: 'failed'`, the shape
`announceLeg` uses. Not done on `feat/send-outcome-reconcile`, which adds
no new dependency to the fan-out (build ruling A8).

**Related.** [relay-staleness-alarm-assumed-not-built](./relay-staleness-alarm-assumed-not-built.md),
[fanout-close-path-robustness-residues](./fanout-close-path-robustness-residues.md),
[send-reconcile-job-residues](./send-reconcile-job-residues.md).
