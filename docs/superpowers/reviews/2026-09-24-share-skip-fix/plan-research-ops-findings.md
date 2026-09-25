# Plan research (ops area) - findings against spec v7, D1 / D2 / D3 / D9

Date: 2026-09-25. Branch `feat/share-skip-fix` at `409540ac`. Scope: the census
(D1), the fix script (D2), the import default (D3) and the RUNBOOK section (D9)
of `docs/superpowers/specs/2026-09-24-share-skip-fix-design.md`.
Read-only pass; nothing was run against any environment. The verbatim excerpts
behind every citation are in `.superpowers/sdd/ops-reference.md` (gitignored
reference, kept separate from these findings).

Three findings change what the spec says. D3 holds as written. The last section
lists implementation traps that need no spec change.

## F1. D1: pending placement nudges will NOT start sending when D2 runs (the code contradicts the claim)

D1, fourth bullet: "Not-yet-sent scheduled texts (tour-reminder rungs, placement
nudges) whose recipient's one-to-one conversation is switched off: these start
sending once D2 runs."

- Placement nudges: no nudge sends automatically today, whatever the switch
  says. `MANUAL_ONLY_NUDGE_KINDS` holds all four `NudgeKind`s
  (`app/src/jobs/placementNudges.ts:123-128`; the union is
  `app/src/repos/placementNudgesRepo.ts:32-36`). The poll drops every one of
  them before any send and leaves the rows pending on purpose
  (`app/src/jobs/placementNudges.ts:331-337`). A nudge goes out only when a
  person clicks "Send now", and that path sends with `automated: false`
  (`app/src/jobs/placementNudges.ts:858-860`), so it never reads the switch
  (`app/src/services/sendMessage.ts:348-349`). D2 therefore releases zero
  nudges. A census line that counts pending nudges as "start sending once D2
  runs" would overstate what the apply releases. The same fact affects section
  1 claim 4 and G2 ("nudges ... work again"): the switch stops no nudge today.
  Suggested: have D1 report pending nudges separately as "held manual-only,
  unaffected by D2", or drop them.
- Tour-reminder rungs: the rungs that would really start sending are a
  narrower set than "recipient's one-to-one conversation is switched off":
  - `confirmation` is discontinued and never sends
    (`app/src/jobs/tourReminders.ts:312-314`, filtered at `:809-812`).
  - A tour that is not self_guided and has a usable group goes to the group
    route, which never reads the switch (`app/src/jobs/tourReminders.ts:1066-1069`).
  - The one-to-one route takes only the FIRST `tenant_1to1` or
    `unknown_1to1` row that `findByParticipantPhone` returns
    (`app/src/jobs/tourReminders.ts:1092-1093`). That is not D2's
    one-to-one definition (`isOneToOneBucket`,
    `app/src/lib/unreadFeed.ts:295-297`). If a phone has two one-to-one rows
    (the D10 import duplicate), the route uses whichever the index returns
    first.
  - The fire-time gate claim-skips any pre-tour rung whose tour has already
    started, so it never sends (`app/src/jobs/tourReminders.ts:1137`).

  So the census has to replay `resolveReminderTarget` on the same query
  result. A join on "one-to-one and manual" is not enough.

## F2. D9: one breaker trip pages nobody, and no UI or API shows the `mode_changed` event (surface missed)

D9: "How to see why (the alarm log line, the conversation's `mode_changed`
event, the automated sends that preceded it)".

- A trip writes exactly ONE ERROR line (`app/src/services/sendMessage.ts:361-364`).
  The code comment at `:359-360` calls it the line that "IS the alarm", but the
  alarms are built otherwise:
  - The burst alarm `hc-<env>-error-logs` needs at least 5 ErrorLogs in ONE
    5-minute period (`infra/modules/observability/main.tf:150-163`, default
    threshold `infra/modules/observability/variables.tf:16-20`).
  - `hc-<env>-error-logs-sustained` needs at least 1 in each of 3 consecutive
    periods (`infra/modules/observability/main.tf:186-202`).

  The resulting refusals are logged at WARN, not ERROR
  (`app/src/jobs/broadcastFanOut.ts:502`,
  `app/src/jobs/tourReminders.ts:1453-1456`,
  `app/src/jobs/missedCallAutoText.ts:245-250`). Once the row is `manual`, later
  automated sends get `ManualModeError` and write no ERROR line. So one trip
  fires neither alarm, and the new RUNBOOK section must not promise a page.

  Ways a trip can be found today:
  - a Logs Insights search for the msg `circuit breaker TRIPPED`, in the style
    of `RUNBOOK.md:2169-2217`;
  - Settings -> System status -> Recent errors (named at `RUNBOOK.md:2259`);
  - the D1 breaker list.
- No route reads a conversation's audit trail. The only
  `auditRepo.listByEntity` callers read `units#`, `placements#` or `tours#`
  (`app/src/routes/contactTimeline.ts:1301`,
  `app/src/routes/statusTransition.ts:232`, `app/src/routes/tours.ts:469`,
  `app/src/routes/units.ts:1253`). The single `mode_changed` writer is
  `app/src/services/sendMessage.ts:354`; its only reader is a test
  (`app/test/sendMessage.test.ts:744`). An operator can therefore read "the
  conversation's `mode_changed` event" only in two ways:
  - a direct Query on `hc-<env>-audit_events` with entityKey
    `conversations#<id>` and `--profile housingchoice`;
  - the D1 census.

  The section has to give that command. "The automated sends that preceded
  it" have two sources:
  - the `message_sent` events in the same partition, whose payload carries
    `automated` (`app/src/services/sendMessage.ts:433-437`);
  - the `outbound message sent` log lines, which carry `automated`
    (`app/src/services/sendMessage.ts:450-453`).

## F3. D2 target safety: the named precedents have no account guard, and the guard only protects a client built from its own profile (surface missed)

D2: "follows the repo's ops-script posture ... and, when pointed at real AWS,
refuses to run unless the account is 938565869261". Appendix A names
`retire-paused-tour-reminders.ts` and `measure-unread-contact-coverage.ts` as
the precedents. Neither has an account guard:
- the retire script uses `getDocumentClient()`
  (`app/scripts/retire-paused-tour-reminders.ts:177`). With `DYNAMODB_ENDPOINT`
  unset, that client resolves the SDK default credential chain
  (`app/src/lib/dynamo.ts:61-66`);
- the measure script builds a client on the default chain
  (`app/scripts/measure-unread-contact-coverage.ts:81-84`) and only advises
  `aws sts get-caller-identity` (`:24-26`).

`assertHousingChoiceAccount()` checks the NAMED `housingchoice` profile via STS,
not the default chain (`scripts/lib/hcAws.mjs:29-57`). On the operator machine
the default chain belongs to an unrelated account (`scripts/lib/hcAws.mjs:5-8`).
Asserting the account and then writing through `getDocumentClient()` therefore
checks an account the writes never touch. The repo has already recorded this
trap (`app/scripts/backfill-media-content-types.ts:776-781`).

Every guarded precedent runs the guard and then builds its client from
`hcCredentials()`:
- `app/scripts/import-apply.ts:248-256`;
- `app/scripts/rail-verify.ts:140-149`;
- `app/scripts/backfill-media-content-types.ts:782-794`.

D1 and D2 should follow that shape. "Pointed at real AWS" can be decided with
the existing `isLocalEndpoint` (`app/scripts/db-create.ts:22-29`).

No test exercises the guard today (grep of app/test finds none). D2's
acceptance test "a real-AWS run on the wrong account refuses" therefore needs an
injectable account resolver.

Two related points:
- `RUNBOOK.md:323` tells the operator that the retire sweep needs the
  `housingchoice` profile. The script reaches that profile only if the shell
  exports `AWS_PROFILE`. The new section should not copy that wording.
- `RUNBOOK.md:2655-2660` says the guard covers the bootstrap/plan/apply/drift/
  deploy scripts. The ambient-env backfills are not guarded.

## Implementation traps (no spec change needed)

- M1 (D1 breaker detection, D2 bulk exclusion):
  - `auditRepo.listByEntity` reads ONE Query page with no LastEvaluatedKey loop
    (`app/src/repos/auditRepo.ts:88-107`).
  - The `conversations#<id>` partition also holds one `message_sent` per send
    (`app/src/services/sendMessage.ts:433-437`) and other events
    (`app/src/routes/api.ts:1740`, `:1849`). An old trip can sit behind newer
    events.
  - audit_events has no event_type index (`app/src/lib/tables.ts:286-297`).
  - The trip payload has no `actor`, so it never lands on the byActor index
    (`app/src/services/sendMessage.ts:354-358`,
    `app/src/repos/auditRepo.ts:70-71`).

  Use a paged Query with a FilterExpression on `event_type`
  (`queryAll`, `app/src/lib/dynamoPaging.ts:29-61`), or one filtered Scan of
  audit_events. A trip whose audit append failed has no record at all:
  `setMode` and `append` are two separate writes
  (`app/src/services/sendMessage.ts:352-358`). Such a row falls into D1's
  "other" group, and D2 bulk would switch it on.
- M2 (D2 conditional write): `setMode` has no condition beyond
  `attribute_exists` (`app/src/repos/conversationsRepo.ts:1832-1843`), so D2
  cannot reuse it. The repo's own one-to-one write predicate is at
  `app/src/repos/conversationsRepo.ts:1736-1742` and `:1765-1767`.
- M3 (D1 groups): the pointer items `phone#`, `email#` and `token#` carry only
  a key and a ref (`app/src/repos/conversationsRepo.ts:506-528`). They have no
  `type`, so they pass the negative type test. They also have no `ai_mode`, so
  a D2 condition on `ai_mode = manual` excludes them. D1's "no type" group must
  exclude them by prefix. The prefix list is module-private
  (`app/src/lib/unreadFeed.ts:101-108`). Import one-to-one ids are bare UUIDv5
  strings (`app/src/lib/import/ids.ts:64-66`), so a `conv-` prefix does not
  identify a real row.
- M4 (D3): one binding, `:aiMode = 'manual'`, serves both paths
  (`app/src/lib/import/apply.ts:1107`). `if_not_exists`
  (`app/src/lib/import/apply.ts:1093`) already keeps an existing switch on a
  re-run. The group reduced retry keeps that clause
  (`app/test/importGroupGuards.test.ts:154`, pruning at
  `app/src/lib/import/apply.ts:1192-1200`). No test asserts the stored
  `ai_mode` of an imported one-to-one row
  (`app/test/importApply.integration.test.ts:241-249` checks only type and
  phone), so D3 needs a new assertion.
- M5 (D1 claim sizing): the import writes no `phone#` claim for a one-to-one
  row (`app/src/lib/import/apply.ts:385-402`, `:1160-1171`). Later inbound
  traffic adopts the import row through the GSI fast path without writing one
  (`app/src/repos/conversationsRepo.ts:1255-1264`). A missing claim is
  therefore the normal state for an imported row. The case that matters is a
  claim whose `ref_conversationId` points at a different row.
