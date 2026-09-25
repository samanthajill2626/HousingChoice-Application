---
id: broadcast-skip-code-drift-guard
title: Broadcast skip-reason codes are bare strings in three places with no compile-time drift guard
type: debt
severity: low
status: open
area: app/broadcasts
created: 2026-09-25
refs: app/src/jobs/broadcastFanOut.ts:396, app/src/repos/broadcastsRepo.ts:204, dashboard/src/routes/contact/deliveryStatus.ts:948
---

**Problem.** A skipped broadcast recipient's reason travels as a plain `string`
`errorCode` written in the fan-out (`opted_out`, `unreachable`, `contact_deleted`,
`no_consent` as literals, `app/src/jobs/broadcastFanOut.ts`), bucketed by the
`isNoConsentCode` / `isOptedOutCode` predicates (`app/src/repos/broadcastsRepo.ts`),
and rendered by the `SHARE_SKIP_REASONS` map plus the send wrapper's refusal codes
(`dashboard/src/routes/contact/deliveryStatus.ts`). Nothing ties the three lists
together at compile time. A rename in one place silently files opt-outs under
`skipped_other` and renders `Not sent (<code>)`. Found by the share-skip-fix
whole-branch review (adversarial NOTE 5, conformance NOTE 6). The three lists DO
agree today (verified); this is a guard against future drift, not a live bug.

Also noted: a few send-wrapper refusal codes reachable on this path
(`conversation_not_found`, and the relay/group-text codes) have no
`SHARE_SKIP_REASONS` entry and fall to the honest `Not sent (<code>)` fallback -
acceptable per spec D7's fallback row, but a union would make a missing entry a
compile error.

**Suggested fix.** A `BroadcastSkipCode` union in `broadcastsRepo.ts` used by every
`recordRecipient({ status: 'skipped' })` call and by the bucket predicates, and a
dashboard mirror typed `Record<ShareSkipCode, string>` so a missing entry fails
the build (the pattern `BroadcastStats` already uses across the two workspaces).

**Timing.** Do this AFTER `feat/send-outcome-reconcile` and `feat/retry-send-window`
land: both ADD codes to these exact sites (SOR's `send_unconfirmed`, RSW's retry
codes), so introducing the union earlier would collide with their merges.

**Addendum (planner adversarial review, 2026-09-25, finding 5).** The drift has
a second face: `isOptedOutCode(undefined)` is true by design, because a skipped
slot written BEFORE 2026-09-25 carries no reason and was an opt-out or an
unreachable number. A NEW skip path that forgets its `errorCode` therefore does
not surface as `Not sent (<code>)`; it is silently counted under
`skipped_opted_out` and rendered "Opted out or number unreachable" - a
TCPA-flavored statement about a tenant who never opted out. Slots carry no
timestamp, so the rule cannot tell a legacy slot from a forgotten code. When
this guard is built, either backfill the legacy slots to an explicit legacy code
(so `undefined` can become an error bucket) or add a test that every
`status: 'skipped'` write in `app/src/jobs/broadcastFanOut.ts` carries a code.
