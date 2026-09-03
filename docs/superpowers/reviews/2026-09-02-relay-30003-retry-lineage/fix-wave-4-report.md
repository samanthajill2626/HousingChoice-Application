# Fix wave 4 - the retry job announces its terminal closes

Branch `feat/relay-30003-retry-lineage`, base `eda374a5`. ONE finding from the
orchestrator's live self-QA.

## The finding (self-QA P1)

A D9 gate refusal wrote the retry row's slot and emitted no
`message.persisted`, so no client refetched: the dashboard kept reading
`delivered 1/2 - 1 retrying - Phone unreachable (error 30003)` until an
unrelated SSE arrived in some other conversation, then aged into
`not confirmed` at 15 minutes - never the refusal reason the job had already
stored. The same held for every JOB-side terminal close.

Spec D16 already decided this question at the other end of the ladder: the
SSE fires when the CLAIM lands, "a false terminal state, for at least 60
seconds, on the surface this feature exists to make truthful". Wave 4 extends
that rationale to the closes that happen inside the job.

## What changed

`app/src/jobs/relayRetryLeg.ts` (+1 import, +1 dep, +1 helper, 3 call sites):

- `:35` imports `appEvents, type EventBus`; `:115` adds `events?: EventBus` to
  `RelayRetryLegJobDeps`; `:315` / `:320` hold it lazily and default to the
  singleton (`events ??= appEvents`), and `:335` takes the narrowed local.
  This is `app/src/jobs/voiceTranscript.ts`'s pattern verbatim (`:96` dep,
  `:108` registrar local, `:167` / `:257` lazy default, `:151` emit) - the
  precedent named in the finding.
- `:439` `announceRootClose()` emits ONE `message.persisted` addressed to the
  ROOT: `conversationId` = the relay conversation, `tsMsgId` =
  `row.relay_retry_of`, `direction` = the retry row's own (the claim wrote it
  as a mirror of the original per D2, so it equals the root's transitively),
  `deliveryStatus: 'failed'` - the shape the webhook's relay emit passes on a
  failure (`app/src/routes/webhooks/twilio.ts:2899`).
- Call sites, all AFTER the durable write: `:466` in `refuseGate` (the four D9
  gate refusals), `:479` in `closeTerminally` (`transient_cap` and the job's
  own `enqueue_failed`), `:696` in the terminal-outcome fall-through
  (`refused` / `filtered` / `suppressed`). The third site cannot be folded into
  the helpers: on that path the extracted send unit wrote the slot and this job
  writes none of it.
- `:375` `const rowDirection = row.direction`, read where `row` is narrowed -
  the nested helpers cannot see that narrowing, the same reason the repo and
  adapter locals above it exist. Without it `tsc` reports
  `TS18048: 'row' is possibly 'undefined'`.
- NOT emitted on `sent` (the rung's own Twilio callbacks reach the webhook's
  emit; announcing `failed` for a leg in flight would be a lie), on a transient
  re-enqueue (nothing terminal happened), or on `skipped_terminal` (the slot
  was terminal before this job ran - whoever closed it announced then).

`registerHandlers.ts` was NOT touched: the emitter did not need to become
injectable through registration, since the `appEvents` default is correct in
both topologies and tests inject through `registerRelayRetryLegJobHandler`.

## The bus reaches the SSE (the STOP condition, checked first)

The finding's fix is only worth making if a job-side emit is not dead. It is
not: `app/src/worker.ts:45-47` calls `attachEventBridge(appEvents, ...)`, and
`app/src/lib/eventBridge.ts:42-45` subscribes one forwarding listener per
`APP_EVENT_NAMES` entry - `message.persisted` included by construction, since
`APP_EVENT_NAMES` is a `Record<AppEventName, true>` and adding an event without
listing it is a compile error (`events.ts:308-313`). The worker's emit
fire-and-forgets `POST /internal/events`, which re-emits on the app's bus for
its SSE clients.

## Tests - `app/test/relayRetryLeg.test.ts`

`:242` injects the harness bus (`events: world.events`), whose every emission
lands in `world.emitted`. `:275` `persistedEmits()` filters it to
`message.persisted`; `:278` `ROOT_CLOSE_EMIT` is the expected payload. Nothing
else on this path emits - neither `persistRelayRecipientResult` nor
`sendOneRelayLeg` takes a bus - so the count IS the job's own announcement
count, which is what lets a bare `toHaveLength(1)` pin "for the ROOT, and only
the ROOT": an emit addressed to the retry row would be a second entry.

| Assertion | Where |
| --- | --- |
| each of the 4 gate refusals emits exactly one, for the ROOT | `:371` (the `it.each` extension) |
| `transient_cap` emits one | `:873` |
| a `refused` outcome emits one | `:889` |
| `sent` emits NONE from the job | `:906` |
| a transient re-enqueue emits NONE | `:919` |
| `skipped_terminal` emits NONE | `:869` (added to the existing test) |

### Revert-proof - how each was verified

Two runs, both with the Edit tool, both restored afterwards (`grep REVERT-PROOF`
returns nothing; `announceRootClose` stands at 1 declaration + 3 call sites).

- **Positive assertions.** All three call sites removed at once
  (`.superpowers/sdd/revert-proof-abc.log`): `6 failed | 48 passed (54)`, and
  the six are exactly `refuses on closed group / removed member / changed
  number / opted out`, `announces the ROOT once when the transient pass budget
  is spent`, and `announces the ROOT once on a refused leg the extraction
  closed`. Each of the six exercises exactly one call site, so removing all
  three in one run still attributes cleanly: the four gate cases to `:466`,
  `transient_cap` to `:479`, `refused` to `:696`. The two NOTHING tests passed
  in this run, as they must.
- **Negative assertions.** A negative cannot be proven by deletion, so the
  change was INVERTED instead: `announceRootClose()` added to the `sent` branch
  and to the transient re-enqueue branch (`.superpowers/sdd/revert-proof-d.log`)
  gives `2 failed | 52 passed (54)` - exactly `announces NOTHING when the leg
  sent` and `announces NOTHING on a transient re-enqueue`. Both have teeth.

`enqueue_failed` has no test of its own. It shares `closeTerminally` with
`transient_cap`, so it is covered by construction rather than by assertion -
the same standing gap the self-QA already recorded under "What was NOT
exercised live" (it needs a failing queue). Named here so nobody re-derives it.

## Gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` (bare, worktree root) | exit 0 - `.superpowers/sdd/typecheck-fixwave4.log` |
| `npx vitest run test/relayRetryLeg.test.ts test/relayRetryClaim.webhook.test.ts test/relayFanOut.test.ts test/registerHandlers.test.ts` | exit 0, `4 passed (4)` / `167 passed (167)` - `.superpowers/sdd/vitest-fixwave4-final.log` |
| `npx eslint src/jobs/relayRetryLeg.ts test/relayRetryLeg.test.ts` | exit 0, no output |
| ASCII on added lines | 0 non-printable bytes, both files |
| e2e `--grep "relay leg"` | exit 0, `2 passed (46.2s)` - `.superpowers/sdd/e2e-fixwave4-run1.log` |

The e2e verdict is read from the LOG, not from the runner wrapper's exit code.
Both selected specs reported `ok`:
`relay-30003-retry.spec.ts:131` (a failed relay leg retries to delivered
without duplicating - chip, accessible name, row and send counts, 18.8s) and
`relay-open-stop.spec.ts:114` (open-path STOP suppresses relay legs; START
resumes them, 14.2s). Run from the e2e workspace, foreground, once. No
listener survived it: every lane-9 and lane-10 port is free and a fresh lane
probe reports `needsReap: false`.

`relayRetryLeg.test.ts` is 54 cases, up from 50: four new `it` blocks, plus
assertions added to four existing cases through the gate `it.each` and one to
the already-terminal test. The other three files are unchanged and their counts
are unmoved.

## Divergences

- **`registerHandlers.ts` untouched** (the prompt allowed it "only if the
  emitter must become injectable through registration"). It did not: the
  precedent's dep-plus-singleton-default pattern is enough, and adding a
  pass-through would have made the app process's registration site carry a
  value the worker already has.
- **One line outside the two named seams' obvious shape:** `:375`
  `const rowDirection`. It is inside `relayRetryLeg.ts` and forced by
  `TS18048`; no other file was touched.
- **The e2e lane is free-probed, not fixed.** The probe reported lane 9 before
  the run and lane 10 during and after it - the harness resolving an available
  lane at config load, not a misconfiguration. Both lanes' ports were confirmed
  free after the run, and neither spec is lane-sensitive.
- **A note the self-QA already carried, still open and NOT this wave's:** the
  conversation header keeps reading `Open` after an API close until a reload,
  because the close route emits no conversation-level SSE. Out of scope here.
