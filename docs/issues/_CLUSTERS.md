# Issue clusters - a fix-the-highs work plan

Hand-maintained triage companion to the generated `INDEX.md`. The underscore
prefix keeps `npm run issues` from treating it as an issue file.

**Built 2026-08-21** against 283 open issues, at main `95d3d156`.

**Merge pass, same day.** Seven issue files were deleted outright and their
content folded into the issue they duplicated - not closed as `resolved`, deleted,
because a duplicate is not a fixed problem and leaving one as a closed record
invites re-filing:

| deleted | absorbed into |
|---|---|
| `markread-fanout-depends-on-stale-participant-gsi` | [mark-read-fanout-stale-gsi-skip](./mark-read-fanout-stale-gsi-skip.md) |
| `npm-test-red-on-main-dynamodb-local-contention` | [npm-test-dynamodb-local-contention](./npm-test-dynamodb-local-contention.md) (renamed - main FLAKES, it is not deterministically red) |
| `group-cross-check-integration-nondeterminism` | same |
| `db-update-gsis-integration-flake-under-load` | same |
| `seed-profile-integration-timeout-flake` | same |
| `matching-entry-points-picker-click-flake` | [matching-entry-points-property-first-e2e-flake](./matching-entry-points-property-first-e2e-flake.md) |
| `e2e-lane-probe-bind-toctou` | [e2e-lane-allocation-cross-worktree-race](./e2e-lane-allocation-cross-worktree-race.md) |

Plus [ported-number-not-on-a2p-campaign](./ported-number-not-on-a2p-campaign.md)
closed as genuinely resolved. Net: 283 -> 276 open, 9 open highs.

**Deliberately NOT merged:** the five `relay-duplicate-*` issues share one file
and one feature but describe five different defects with five different remedies
and five recorded design decisions. Same for the three `load-older-*` issues.
Sharing a file is not being a duplicate.

## What this is for

Every one of the 10 open `high` issues is anchored in exactly one cluster below.
Each cluster is a set of issues that touch the SAME files, functions, or product
seam, so the med/low items ride along on a mission that was going to open those
files anyway. Items are listed high-first; `(also Cn)` marks an issue that
legitimately belongs to two clusters.

Re-derive membership after any batch of closes - this file is a snapshot, not a
generated artifact.

---

## C1 - Inbox unread read path: stale-GSI correctness + read amplification

**Highs:** [unread-badge-request-round-trip-cost](./unread-badge-request-round-trip-cost.md),
[mark-read-fanout-stale-gsi-skip](./mark-read-fanout-stale-gsi-skip.md)

**Shared surface:** `app/src/lib/unreadFeed.ts` (`collectUnreadRows`),
`app/src/routes/inbox.ts`, `app/src/routes/contacts.ts`,
`app/src/repos/conversationsRepo.ts`, `app/src/repos/contactsRepo.ts`.

> Restated 2026-08-21 after commit `95d3d156` landed on main mid-triage. It split
> the old `contacts-batchget-amplified-reads` high: the unread-collector half
> became the new high above, and the mechanical BatchGet sweep dropped to `med`.
> The reason matters for planning - **BatchGetItem cannot read a GSI**, so
> `findByPhones` was never buildable. The collector needs a design decision
> (denormalize `contactId` onto the conversation item) rather than a sweep.

> **Re-adjudicated 2026-08-25 against main `@88ac7b36`** - twelve independent
> read-only agents, one per issue, each briefed without the planner's priors.
> Result: **6 still-valid, 6 remedy-wrong, 0 already-fixed.** Nothing self-healed;
> every defect still reproduces. What decayed is the REMEDIES - half the
> "Suggested fix" sections were wrong, no-ops, or aimed at a path that does not
> behave the way the issue says. Reports:
> `W:\tmp\handbacks\c1-readjudication-2026-08-25\`.
>
> Two claims below were DISPROVEN and are corrected in this section:
> the badge and the page-fill loop are DIFFERENT endpoints (`countUnreadRows`
> makes exactly ONE collect, and its `maxRows` already equals the internal page
> size), so the fill loop was never "contributor 2" of the badge and sequencing
> it first would have measured no badge improvement; and the badge's blocking
> premise - that no `contactId` exists on the conversation item - is false.
> `participants[].contactId` is written by `contactCapture` before the row is
> ever indexed, `today.ts` already reads it off this same walk, and
> `contacts.getManyByIds` shipped 2026-08-21.

The two highs are NOT the same walk. The badge is a read amplification on the
`byUnread` walk - one contact resolved per index item SCANNED, unbounded to
2000. The mark-read fan-out is a WRITE path that trusts a lagging
`byParticipantPhone` image. They share a cluster because they share the unread
state, not a code path.

**Re-sliced 2026-08-25.** The four issues marked `[gen]` below are not four
independent riders. They are one tangle in the collect generator's exit and
flag semantics in `app/src/lib/unreadFeed.ts` - `capped`, `scanExhausted`,
`truncated`, and the missing `consumedAll`. Three agents independently proposed
edits to the same few lines, and two found a neighbour's remedy was a no-op or
unreachable precisely because of that coupling. Build them as ONE slice with a
single coherent flag contract.

| sev | issue | why it rides along |
|---|---|---|
| high | [unread-badge-request-round-trip-cost](./unread-badge-request-round-trip-cost.md) | anchor - one serial `findByPhone` per index item scanned; fix is the `contactId` read-through |
| med | [mark-read-fanout-stale-gsi-skip](./mark-read-fanout-stale-gsi-skip.md) | anchor - conditional write; `high -> med`, the skip is not permanent (five later events re-drive it) |
| med | [unread-fill-loop-query-amplification](./unread-fill-loop-query-amplification.md) | `[gen]` - page path only, NOT the badge; both filed remedies disproven |
| low | [unread-budget-truncation-has-no-forward-path](./unread-budget-truncation-has-no-forward-path.md) | `[gen]` - `med -> low`; the exits are already mutually exclusive |
| med | [inbox-truncated-flag-two-meanings](./inbox-truncated-flag-two-meanings.md) | `[gen]` - four producers, one boolean, exactly one consumer mis-served |
| ~~med~~ | ~~[unread-index-integration-coverage-requires-local-dynamo](./unread-index-integration-coverage-requires-local-dynamo.md)~~ | **RESOLVED 2026-08-21** by the `globalSetup` throw - this row was stale when C1 was scoped. C1 is TWELVE open issues, not thirteen |
| low | [unread-load-more-empty-on-exact-multiple](./unread-load-more-empty-on-exact-multiple.md) | `[gen]` - filed remedy is a literal no-op; needs 3 coordinated edits |
| low | [seen-set-max-equals-max-inbox-limit](./seen-set-max-equals-max-inbox-limit.md) | filed symptom is INVERTED and never reproduced; retitled to the real invariant |
| low | [unread-deleted-contact-probed-twice-per-page](./unread-deleted-contact-probed-twice-per-page.md) | extra probes in the collector (also C8); carrier must be keyed by `conversationId` |
| low | [inbox-parselimit-empty-one-row](./inbox-parselimit-empty-one-row.md) | same route's limit parsing; the `aiRuns` line it says to copy has since changed |
| medium | [inbox-filter-tabs-full-walk](./inbox-filter-tabs-full-walk.md) | `low -> medium` - the last unbounded read on the route; rides the badge's `contactId` fix |
| low | [inbox-group-truncation-notice-not-reset](./inbox-group-truncation-notice-not-reset.md) | dashboard side of the truncation notice; All/Groups tabs only |
| low | [inbox-imported-call-outcome-normalization](./inbox-imported-call-outcome-normalization.md) | THREE renderers, not two; one crosses a package boundary, group threads bypass `deriveLatest` |

**Spin-off, DONE** - `feat/contacts-batchget` shipped and merged (`65179d73`,
2026-08-21); the branch and its worktree are retired.
[contacts-batchget-amplified-reads](./contacts-batchget-amplified-reads.md) is
resolved: all six mechanical surfaces are batched.
[broadcast-results-enrichment-read-cost](./broadcast-results-enrichment-read-cost.md)
(low) stays open - same function, but the caching half of the remedy.

Three further surfaces were found while batching the first six (`c0e60882`) and
were triaged rather than swept: `today.ts` `getContact` spun out to
[today-contact-hydration-fan-out](./today-contact-hydration-fan-out.md) (it is
NOT mechanical), `rosterResolution.ts` `nameOf` is a drive-by to fold into the
next change touching that file, and the `api.ts` unread-counts-by-contact rail
remains unswept. The shape lesson survives the branch: two of those three need
WHOLE items (`today.ts` does a soft-delete check; `api.ts` reads `phone_ref` /
`email_ref`, which a display projection does not carry) while
`rosterResolution.ts` is display-only - so the repo wants BOTH `getManyByIds`
and `getDisplaysByIds`, not one of them.

---

## C2 - Retry loops and terminal state: nothing may hang forever

**High:** [retry-counter-in-envelope-makes-caps-unreachable](./retry-counter-in-envelope-makes-caps-unreachable.md)

**Shared surface:** `app/src/jobs/*` (`broadcastFanOut.ts`, `relayFanOut.ts`,
`retrySend.ts`, `groupRail.ts`), plus every claim/release pair in the repos.

One invariant unifies the whole cluster: *if the mechanism that advances state
fails permanently, does this path still reach a terminal state?* The high is the
enqueue-counter case; the rest are stranded claims, unbounded holds, and rows that
never leave their in-flight status. Same review lens, same test shape.

| sev | issue | why it rides along |
|---|---|---|
| high | [retry-counter-in-envelope-makes-caps-unreachable](./retry-counter-in-envelope-makes-caps-unreachable.md) | anchor - move attempt counts into the durable record |
| med | [extraction-stranded-claim-no-reaper](./extraction-stranded-claim-no-reaper.md) | claimed row with no re-arm path |
| med | [extraction-driver-call-unbounded](./extraction-driver-call-unbounded.md) | holds the same claim ~30 min |
| med | [recording-claim-redelivery-loss-window](./recording-claim-redelivery-loss-window.md) | claim -> fetch -> release window under redelivery |
| med | [relay-provisioning-sentinel-leak](./relay-provisioning-sentinel-leak.md) | crashed provision leaks the sentinel pointer |
| med | [placement-relay-no-atomic-claim](./placement-relay-no-atomic-claim.md) | same non-atomic claim shape |
| med | [voice-caller-abandon-no-dial-summary](./voice-caller-abandon-no-dial-summary.md) | call row stays `ringing` with no terminal write |
| med | [messaging-delivery-alarms](./messaging-delivery-alarms.md) | the detection half - a loop that never terminates pages nobody |
| low | [email-outbound-stuck-queued-on-crash](./email-outbound-stuck-queued-on-crash.md) | stranded `queued` on crash |
| low | [paused-reminder-rows-grow-listdue-without-bound](./paused-reminder-rows-grow-listdue-without-bound.md) | rows that never leave the due batch |
| low | [relay-warm-ladder-dedup-window](./relay-warm-ladder-dedup-window.md) | un-deduped window past SQS visibility timeout |
| low | [push-broadcast-no-send-timeout-or-concurrency-bound](./push-broadcast-no-send-timeout-or-concurrency-bound.md) | unbounded in-flight fan-out |
| low | [rail-binding-propagation-retry](./rail-binding-propagation-retry.md) | retry ladder in the same job family |
| low | [extraction-claimedat-stamped-from-poll-clock](./extraction-claimedat-stamped-from-poll-clock.md) | the field a reaper would need to be correct |

**Also flagged inside the high, not yet filed:** the sweep for other
`!== 'success'` provider-status fallthroughs. Worth a file if it is not done as
part of this cluster.

---

## C3 - Log hygiene: vendor errors, PII, and alarm noise

**High:** [twilio-sdk-error-logs-leak-credentials](./twilio-sdk-error-logs-leak-credentials.md)

**Shared surface:** `app/src/lib/logger.ts`, `app/src/lib/errors.ts`,
`app/src/adapters/messaging.ts`, every `log.*({ err })` call site.

The high asks for a repo-wide sweep plus a `summarizeVendorError` helper and a
lint/guard test. The moment that sweep runs, it passes every other bad logging
call site in this list.

| sev | issue | why it rides along |
|---|---|---|
| high | [twilio-sdk-error-logs-leak-credentials](./twilio-sdk-error-logs-leak-credentials.md) | anchor - sanitized vendor-error summary + enforcement rule |
| med | [telemetry-phone-in-url-pii](./telemetry-phone-in-url-pii.md) | **PROD GATE** before prod OTLP; same redaction seam |
| low | [relay-intro-dlr-unknown-sid-noise](./relay-intro-dlr-unknown-sid-noise.md) | error-level noise from a known-benign case |
| low | [relay-direct-sends-unknown-sid-callbacks](./relay-direct-sends-unknown-sid-callbacks.md) | same unknown-SID error class |
| low | [push-users-scan-failure-logs-error-per-message](./push-users-scan-failure-logs-error-per-message.md) | one ERROR per message, no backoff |
| low | [push-failure-status-not-surfaced](./push-failure-status-not-surfaced.md) | vendor failure detail dropped instead of summarized |
| low | [voice-push-pii-masking-outdated](./voice-push-pii-masking-outdated.md) | PII posture alignment |
| low | [abandoned-journal-pii-until-next-contact-read](./abandoned-journal-pii-until-next-contact-read.md) | PII retention decision, same review |
| low | [ai-runs-throttled-batchget-renders-expired](./ai-runs-throttled-batchget-renders-expired.md) | a vendor throttle rendered as a domain outcome |

**Adjacent but a separate mission** (AWS blast radius, not logging):
[one-off-scripts-missing-account-guard](./one-off-scripts-missing-account-guard.md) (med) +
[aws-cli-identity-can-diverge-from-account-guard](./aws-cli-identity-can-diverge-from-account-guard.md) (low).

---

## C4 - Native group texting: inbound detection, outbound send, group identity

**Highs:** [inbound-group-mms-detection](./inbound-group-mms-detection.md),
[regular-group-texting-for-imported-groups](./regular-group-texting-for-imported-groups.md)

**Shared surface:** `app/src/routes/webhooks/twilio.ts` (the group block and the
closed-group intercept), `app/src/repos/conversationsRepo.ts`,
`app/src/lib/import/apply.ts`.

Detection must land first (Cameron's ruling); outbound is a full brainstorm ->
spec -> plan feature. Everything below is the same webhook routing decision or
the same group-identity key.

| sev | issue | why it rides along |
|---|---|---|
| high | [inbound-group-mms-detection](./inbound-group-mms-detection.md) | anchor - land FIRST; needs the empirical Twilio payload check |
| high | [regular-group-texting-for-imported-groups](./regular-group-texting-for-imported-groups.md) | anchor - outbound half, full feature pipeline |
| med | [group-mms-including-pool-numbers](./group-mms-including-pool-numbers.md) | the exact routing precedence detection changes |
| med | [group-identity-pool-number-mutability](./group-identity-pool-number-mutability.md) | participant-set identity is the key detection mints |
| med | [tripwire-extraction-scope](./tripwire-extraction-scope.md) | the missing-envelope heuristic real detection would retire |
| med | [import-group-thread-retraction](./import-group-thread-retraction.md) | the 132 imported threads this feature must migrate |
| med | [group-outbound-media](./group-outbound-media.md) | the v1 outbound limitation to lift in the same pass |
| med | [group-text-tour-placement-attachment](./group-text-tour-placement-attachment.md) | attaches the new thread shape to tours/placements |
| low | [group-identity-fingerprint-worker-and-pool-coverage](./group-identity-fingerprint-worker-and-pool-coverage.md) | same identity fingerprint |
| low | [group-roster-contact-id-can-dangle](./group-roster-contact-id-can-dangle.md) | the roster the new shape carries (also C8) |
| low | [closed-intercept-skips-contact-capture](./closed-intercept-skips-contact-capture.md) | `handleClosedGroupInbound`, same function detection edits |
| low | [group-text-conversion-unwindowed-log-assert](./group-text-conversion-unwindowed-log-assert.md) | the spec that covers this seam |

---

## C5 - Relay roster mutation: notify, announce, and roster truth

**High:** [relay-roster-change-notification-texts](./relay-roster-change-notification-texts.md) (GO-LIVE gate)

**Shared surface:** `app/src/routes/relayGroups.ts`, `app/src/services/relayMembers.ts`,
`app/src/jobs/relayFanOut.ts`, `app/src/messages/catalog.ts`.

The high adds sends on add/remove. Every issue in the core list is inside
`addMember` / `removeMember` / the announce path or the preview that fronts them.

**Core (do with the high):**

| sev | issue | why it rides along |
|---|---|---|
| high | [relay-roster-change-notification-texts](./relay-roster-change-notification-texts.md) | anchor - reuse the throttled `relay.intro` machinery, copy in the catalog |
| med | [relay-stale-participant-phone](./relay-stale-participant-phone.md) | the phone the new notify would send to |
| med | [relay-member-suppression-diverges-from-number-seam](./relay-member-suppression-diverges-from-number-seam.md) | who the notify must SKIP |
| med | [relay-groups-ignore-member-deletion](./relay-groups-ignore-member-deletion.md) | remove-path semantics the notify makes visible (also C8) |
| med | [standalone-relay-group-no-reachable-floor](./standalone-relay-group-no-reachable-floor.md) | same create/roster route |
| med | [relay-preview-lists-members-provisioning-drops](./relay-preview-lists-members-provisioning-drops.md) | preview must agree with what actually gets texted |
| med | [relay-group-routes-unbounded-members](./relay-group-routes-unbounded-members.md) | same routes, now with a per-member send cost |
| med | [standalone-relay-group-quiet-hours-deferral](./standalone-relay-group-quiet-hours-deferral.md) | when a roster-change send is allowed to go (also C7) |
| low | [relay-add-double-announce-race](./relay-add-double-announce-race.md) | the announce this high turns into a real text |
| low | [member-add-burn-first-residuals](./member-add-burn-first-residuals.md) | the add path's 409 residuals |
| low | [relay-preview-memberkey-collision-overcount](./relay-preview-memberkey-collision-overcount.md) | preview recipient count |
| low | [roster-plan-version-write-unguarded](./roster-plan-version-write-unguarded.md) | same conditional roster write |
| low | [relay-provisioning-stale-comments](./relay-provisioning-stale-comments.md) | comments in the files being edited |

**Sub-bundle - closed/reopen semantics** (one decision, then the code):
[relay-reopen-semantics](./relay-reopen-semantics.md) (med),
[inbound-reflags-closed-relay-group](./inbound-reflags-closed-relay-group.md) (med),
[relay-open-no-live-refresh](./relay-open-no-live-refresh.md) (med),
[relay-open-keyword-phantom-1to1](./relay-open-keyword-phantom-1to1.md) (low),
[relay-duplicate-via-reopen](./relay-duplicate-via-reopen.md) (low).

**Sub-bundle - duplicate detection** (one file, five issues, no high - cheap to
sweep together):
[relay-duplicate-detection-scan-cost](./relay-duplicate-detection-scan-cost.md),
[relay-duplicate-warning-stale-after-defer](./relay-duplicate-warning-stale-after-defer.md),
[relay-duplicate-across-contact-handsets](./relay-duplicate-across-contact-handsets.md),
[relay-duplicate-via-roster-removal](./relay-duplicate-via-roster-removal.md),
[relay-duplicate-detection-fake-partition-drift](./relay-duplicate-detection-fake-partition-drift.md).

**Sub-bundle - dashboard relay surface** (front end of the same feature):
[relay-group-no-dashboard-surface](./relay-group-no-dashboard-surface.md) (med),
[relay-confirm-dialog-overstates-tier3-send](./relay-confirm-dialog-overstates-tier3-send.md) (med),
[roster-confirm-dialog-unclosable-on-hung-confirm](./roster-confirm-dialog-unclosable-on-hung-confirm.md) (med),
[relay-group-view-stale-open-composer](./relay-group-view-stale-open-composer.md) (low),
[relay-group-composer-footer-copy](./relay-group-composer-footer-copy.md) (low),
[masked-relay-calls-invisible](./masked-relay-calls-invisible.md) (med).

---

## C6 - Test and E2E harness determinism

**High:** [e2e-lane-allocation-cross-worktree-race](./e2e-lane-allocation-cross-worktree-race.md)

**Shared surface:** `e2e/support/lane.mjs`, `scripts/e2e-session.mjs`, the shared
DynamoDB Local / MinIO containers.

The high's fix (an atomic, compare-before-delete lane lease with owner tokens) is
the same root cause as every "passes alone, fails in suite" item in the first
list. Doing it first makes the second list diagnosable instead of guesswork.

> **WAVE 1 IS DONE** - `fix/e2e-harness-determinism`, merged `987e39fd`
> (2026-08-21). Five issues closed; all three gates green; `npm run e2e` 251
> passed. Only `npm-test-dynamodb-local-contention` remains open from wave 1,
> and it is now the first step of the C11 campaign below.

**Wave 1 - infra contention (the actual root cause):**

| sev | issue | |
|---|---|---|
| high | [e2e-lane-allocation-cross-worktree-race](./e2e-lane-allocation-cross-worktree-race.md) | DONE |
| med | [npm-test-dynamodb-local-contention](./npm-test-dynamodb-local-contention.md) | **OPEN - C11 step 1** |
| med | [e2e-lane-tables-stale-schema](./e2e-lane-tables-stale-schema.md) | DONE |
| med | [broadcast-fanout-tests-blow-default-hooktimeout](./broadcast-fanout-tests-blow-default-hooktimeout.md) | DONE |
| low | [e2e-lane-cold-start-container-race](./e2e-lane-cold-start-container-race.md) | DONE |
| low | [e2e-session-lane-mismatch](./e2e-session-lane-mismatch.md) | DONE |

**Wave 2 - per-spec determinism (only after wave 1):**
[tour-reminders-panel-e2e-flake](./tour-reminders-panel-e2e-flake.md),
[today-heading-selector-ambiguity](./today-heading-selector-ambiguity.md),
[matching-entry-points-property-first-e2e-flake](./matching-entry-points-property-first-e2e-flake.md),
[inbox-row-appearance-e2e-flake](./inbox-row-appearance-e2e-flake.md),
[landlord-onboarding-e2e-suite-only-flake](./landlord-onboarding-e2e-suite-only-flake.md),
[tours-pm-exit-closed-chip-flake](./tours-pm-exit-closed-chip-flake.md),
[deleted-contact-resurfacing-e2e-401-flake](./deleted-contact-resurfacing-e2e-401-flake.md),
[roster-quiet-hours-e2e-timezone-skew](./roster-quiet-hours-e2e-timezone-skew.md),
[conversationdetail-members-mock-suite-flake](./conversationdetail-members-mock-suite-flake.md),
[tourdetail-composer-footer-suite-flake](./tourdetail-composer-footer-suite-flake.md),
[schedule-tour-form-test-flake](./schedule-tour-form-test-flake.md).

Two of these (`tour-reminders-panel-e2e-flake`,
`conversationdetail-members-mock-suite-flake`) are the AGENTS.md known flakes that
every mission currently has to re-run and report around. Closing them is a
recurring-cost win, not just a tidy-up.

**RETRACTED 2026-08-21.** An earlier version of this section claimed
`tour-reminders-panel-e2e-flake` was NOT a flake but a deterministic pre-08:00
failure, and that `AGENTS.md`'s "re-run once" rule could therefore never clear
it. **That was wrong.** The deterministic half was closed on 2026-08-05 by
`150fbfa4` ("full-ladder assertions book a 14:00-local tour - kills the
00:00-08:00 wall-clock flake"); the issue's TITLE still advertised it, and the
claim came from reading that title instead of the body directly beneath it.

The real remaining scope is a rare rung-visibility timing flake, last seen
2026-08-03. Re-running once IS the correct response, and `AGENTS.md` needs no
change. The issue title has been corrected and its severity dropped to `low`.

Worth keeping as a caution: a stale issue TITLE is load-bearing. Every triage
pass in this file reads titles first.

---

## C11 - Test-suite SOUNDNESS: the gate is green and proves less than it looks

**No high, and that is a mis-rating rather than a judgement** - nothing here
breaks a user flow, so nothing was rated high, but the cost is false confidence
in every other rating on this board.

**Shared surface:** `app/test/helpers/*` (the fakes), `dashboard/public/sw.js` vs
`dashboard/src/sw/*`, `app/vitest.config.ts`, the build/gate scripts.

C6 fixed an UNRELIABLE gate - red when nothing is wrong. This is an UNSOUND one -
**green when something is wrong.** Different cost, different urgency: a flake
wastes time, unsoundness spends confidence you did not know you had lost.

**One mechanism explains most of it.** Wherever a fake hand-mirrors real
semantics, the mirror is enforced only by whoever remembers it. Four of these are
literally that; the last two are the same shape one layer out - the toolchain
mirroring production, and the fake mirroring the service.

| sev | issue | the evidence, which is DEMONSTRATED not theorised |
|---|---|---|
| med | [update-call-status-fake-mirrors-real-so-a-broken-repo-is-invisible](./update-call-status-fake-mirrors-real-so-a-broken-repo-is-invisible.md) | Two mutation probes. Break the FAKE -> red. Break the **REAL repo** -> **green, exit 0.** The logic protects a live call from a redelivered webhook |
| med | [compiled-dist-boot-unverified](./compiled-dist-boot-unverified.md) | Gates run tsx/esbuild (bundler resolution); prod runs `node dist/` (stricter ESM). The email channel shipped a directory import: all suites green, dev deploy crash-looped, caught only by the deploy health check |
| med | [sw-mirror-test-pins-literals-not-behaviour](./sw-mirror-test-pins-literals-not-behaviour.md) | `mirror.test.ts` asserts `toContain('<literal>')` and never compares the files. A 1-char divergence lived from `26a01b9f` to 2026-08-20, through the entire life of the test written to prevent it. Found by READING |
| med | [unread-index-integration-coverage-requires-local-dynamo](./unread-index-integration-coverage-requires-local-dynamo.md) | The only suite proving real `byUnread` semantics self-skips with no Docker - and the fake modelled `LastEvaluatedKey` WRONGLY until 2026-08-16, so every call-count assertion was calibrated one round trip short of production |
| med | [group-text-conversion-unwindowed-log-assert](./group-text-conversion-unwindowed-log-assert.md) | Asserts zero error lines over an UNWINDOWED log tail - passes for reasons unrelated to the spec |
| low | [relay-duplicate-detection-fake-partition-drift](./relay-duplicate-detection-fake-partition-drift.md) | Fake filters `status`, real repo queries `relay_status`. Fake is strictly MORE permissive, and now drives user-visible confirm-dialog copy |
| low | [audit-fake-before-cursor-fidelity](./audit-fake-before-cursor-fidelity.md) | Fake treats `before` as a numeric seq; the real SK is a lexical ISO string |
| low | [sw-mirror-control-char-divergence](./sw-mirror-control-char-divergence.md) | The specific DEL-character instance of the row above |
| low | [e2e-documentelement-overflow-check-vacuous](./e2e-documentelement-overflow-check-vacuous.md) | Hand-rolled overflow checks are vacuous in this app shell - they cannot fail |

**The remedy shape is the same for all of them:** make the mirror CHECKED rather
than remembered - a real integration test, a file comparison instead of literal
pins, a loud or failing skip, a dist boot smoke.

---

## The C6+C11 campaign - sequence and why

Goal, in Cameron's words: the suite **runs properly even under resource
contention when multiple e2e runs happen at once.** That is the acceptance test,
and it is deliberately the LAST step rather than an assumption.

**Phase 1 - make contention survivable.** `npm-test-dynamodb-local-contention`:
suite A (`groupCrossCheck`) latency-robust assertions, suite B retry
`UpdateTable` on `InternalFailure`.
*First because everything downstream either adds integration tests or re-runs
them; doing it later means re-diagnosing every new red.* Suite A is the harder
half - it fails ALONE sometimes, so the cause is genuine timing assumptions
(spy-order and window predicates), not only the container.

**Phase 2 - make the gate honest about what it did NOT run.**
`unread-index-integration-coverage-requires-local-dynamo` (loud/failing skip, or
boot DynamoDB Local in the gate) and `compiled-dist-boot-unverified` (dist boot
smoke).
*Before phase 3, because there is no point adding integration tests to a gate
that can silently skip them. The dist smoke is independent of DynamoDB entirely
and closes a whole resolution class cheaply.*

**Phase 3 - close the fakes that lie.** `update-call-status-fake...`, the two
`sw-mirror-*`, `relay-duplicate-detection-fake-partition-drift`,
`audit-fake-before-cursor-fidelity`, `group-text-conversion-unwindowed-log-assert`,
`e2e-documentelement-overflow-check-vacuous`.
*After phase 1, because the remedy for the first two is MORE DynamoDB Local
integration tests - exactly what is flaking today. The issues flag this tension
themselves.*

**Phase 4 - per-spec determinism.** C6 wave 2, all eleven.
*Last, and deliberately RE-MEASURED first: several ("suite-only", "passes
alone") may simply stop reproducing once phase 1 lands, since they were filed as
contention symptoms. Measure which still fail before spending effort on each.*
Start with the two cheap certainties: `tour-reminders-panel-e2e-flake` (a
deterministic clock dependency, plus the `AGENTS.md` correction) and
`today-heading-selector-ambiguity` (a substring-match selector bug; the older duplicate slug was merged into it).

**Phase 5 - prove it.** Two concurrent full e2e suites from different worktrees,
both green, plus a `npm test` running against the same containers. That is the
stated goal and nothing before it demonstrates it.

---

## C7 - A2P, consent, and compliance copy

**High:** [a2p-compliance-hardening](./a2p-compliance-hardening.md) (in-progress)

**Shared surface:** `app/src/lib/smsCompliance.ts`, `app/src/messages/catalog.ts`,
`app/src/services/sendMessage.ts`, `app/src/routes/settings.ts`,
`dashboard/src/routes/public/IntakeForm.tsx`, `docs/a2p/campaign-resubmission.md`.

[`ported-number-not-on-a2p-campaign`](./ported-number-not-on-a2p-campaign.md) was
the second high here and is **CLOSED 2026-08-21** - Cameron confirmed the ported
number is on the campaign's Messaging Service. Its only tail is doc-only: naming
the number in `campaign-resubmission.md` item 9, which the anchor below owns.

| sev | issue | why it rides along |
|---|---|---|
| high | [a2p-compliance-hardening](./a2p-compliance-hardening.md) | anchor - P0/P1/P2 already scoped in the file |
| med | [sms-brand-diverges-from-registered-a2p-brand](./sms-brand-diverges-from-registered-a2p-brand.md) | same re-file decision |
| med | [call-recording-consent](./call-recording-consent.md) | the voice-side half of the same consent regime |
| med | [consent-copy-cross-stack-drift](./consent-copy-cross-stack-drift.md) | the copy the P0 work writes, hand-mirrored today |
| med | [automated-sms-length-guard](./automated-sms-length-guard.md) | catalog enforcement, same validation floor |
| med | [founder-message-template-updates-owed](./founder-message-template-updates-owed.md) | same templates the disclosure work edits |
| med | [quiet-hours-ungated-automated-paths](./quiet-hours-ungated-automated-paths.md) | TCPA calling-hours sibling of the consent gate |
| med | [number-suppression-change-emits-no-cross-thread-event](./number-suppression-change-emits-no-cross-thread-event.md) | the suppression list the whole regime rests on |
| med | [pool-audit-reimport-strands-business-number](./pool-audit-reimport-strands-business-number.md) | number inventory, same campaign item 9 |
| low | [sms-copy-non-gsm7-characters](./sms-copy-non-gsm7-characters.md) | remaining scope is the Settings-UI override advisory |
| low | [tourcopy-messageid-cast-unguarded](./tourcopy-messageid-cast-unguarded.md) | same catalog cast |
| low | [message-catalog-legacy-override-migration](./message-catalog-legacy-override-migration.md) | same override map |
| low | [quiet-hours-dst-gap-window-end-clamp](./quiet-hours-dst-gap-window-end-clamp.md) | same clamp (also C10) |
| low | [staff-unmute-vs-per-phone-optout](./staff-unmute-vs-per-phone-optout.md) | opt-out precedence decision |
| low | [dnc-registry-scrubbing](./dnc-registry-scrubbing.md) | voice-side deferred obligation |

---

## Clusters with no high, kept because they are cheap adjacency

These are not on the critical path, but each is one coherent category that
overlaps a cluster above. Fold the overlapping members in rather than opening the
same files twice.

**C8 - Soft-deleted contact handling** (overlaps C1, C4, C5). One rule -
"a soft-deleted contact is not a send/write target, but stays discoverable" -
applied consistently:
[deleted-contact-web-signup-silent](./deleted-contact-web-signup-silent.md) (med),
[outbound-voice-ignores-deleted-contacts](./outbound-voice-ignores-deleted-contacts.md) (med),
[scheduled-sends-to-deleted-contacts-silent-burn](./scheduled-sends-to-deleted-contacts-silent-burn.md) (med),
[soft-deleted-contact-still-extractable](./soft-deleted-contact-still-extractable.md) (med),
[relay-groups-ignore-member-deletion](./relay-groups-ignore-member-deletion.md) (med),
[unread-deleted-contact-probed-twice-per-page](./unread-deleted-contact-probed-twice-per-page.md) (low),
[group-roster-contact-id-can-dangle](./group-roster-contact-id-can-dangle.md) (low),
[stale-suggestions-survive-contact-retype](./stale-suggestions-survive-contact-retype.md) (low),
[deleted-contact-resurfacing-e2e-401-flake](./deleted-contact-resurfacing-e2e-401-flake.md) (low).

**C9 - Thread paging + SSE refetch in the dashboard.** The stateful half of thread
paging is copy-pasted across three hooks and has already drifted; every item below
is a symptom of that one duplication:
[thread-paging-stateful-half-duplicated](./thread-paging-stateful-half-duplicated.md) (med),
[thread-hooks-refetch-whole-page-per-event](./thread-hooks-refetch-whole-page-per-event.md) (med),
[thread-merge-leaves-a-hole-after-an-sse-gap](./thread-merge-leaves-a-hole-after-an-sse-gap.md) (med),
[relay-thread-unfiltered-sse-resorts-paged-history](./relay-thread-unfiltered-sse-resorts-paged-history.md) (med),
[contact-timeline-sse-refetch-unfiltered](./contact-timeline-sse-refetch-unfiltered.md) (med),
[older-page-can-remove-the-default-reply-target](./older-page-can-remove-the-default-reply-target.md) (med),
[prepend-anchor-misses-height-changes-with-no-render](./prepend-anchor-misses-height-changes-with-no-render.md) (med),
[load-older-control-loses-focus-and-announces-nothing](./load-older-control-loses-focus-and-announces-nothing.md) (med),
[load-older-control-unmount-jumps-the-reader](./load-older-control-unmount-jumps-the-reader.md) (low),
[timeline-load-older-remounts-and-collapses-reveals](./timeline-load-older-remounts-and-collapses-reveals.md) (low).

**C10 - Timezone truth** (overlaps C7's quiet hours). Org zone vs browser zone vs
property zone, decided once:
[tour-times-assume-org-timezone](./tour-times-assume-org-timezone.md) (med),
[tour-page-mixed-timezones](./tour-page-mixed-timezones.md) (low),
[quiet-hours-dst-gap-window-end-clamp](./quiet-hours-dst-gap-window-end-clamp.md) (low),
[roster-quiet-hours-e2e-timezone-skew](./roster-quiet-hours-e2e-timezone-skew.md) (low).

---

## Suggested order

1. ~~**C7 ops confirm**~~ - DONE 2026-08-21, `ported-number-not-on-a2p-campaign`
   closed.
2. **C6 wave 1** - the lane lease. It is the harness every other mission's gates
   run on; fixing it first makes every later run trustworthy.
3. **C1** - two highs, and the nav badge is the app's highest-frequency request.
   Inside it: fix `unread-fill-loop-query-amplification` first (cheap, no schema
   change, biggest single reduction), re-measure, THEN decide the contact-lookup
   half on fresh evidence.
4. **C3** - a live credential in CloudWatch, plus the telemetry PII prod gate.
5. **C2** - the "stuck forever" sweep. Same class as the prod voicemail incident.
6. **C4 detection half** - the group blind spot on the ported number.
7. **C5 core** - the go-live-gated roster notifications.
8. **C7 code** (P0/P1) and **C4 outbound half** - both full feature pipelines.

C8/C9/C10 fold into whichever of the above opens their files first.
