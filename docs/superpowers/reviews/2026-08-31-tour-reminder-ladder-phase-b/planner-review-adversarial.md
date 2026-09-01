# Planner review - ADVERSARIAL (diff + repo only, no spec/plan/handback)

Branch `feat/tour-reminder-ladder-phase-b`, base `main` @ec32170a.
Scope reviewed: `git diff main...HEAD -- app dashboard e2e RUNBOOK.md`, plus a
consumer sweep of `app/`, `dashboard/`, `e2e/`, `app/scripts/` and
`docs/issues/`. `docs/superpowers/` deliberately unread.

Every claim below cites `file:line` in the worktree as of the review. Nothing was
executed (a gate run is live); no test suite, server or e2e lane was started.

---

## 1. [HIGH] The tour/placement relay intro is written to the TENANT and broadcast verbatim to the landlord

**What is wrong.** `relay.intro_tour_today`, `relay.intro_tour` and
`relay.intro_placement` are second-person-singular copy addressed to the tenant:

- `app/src/messages/catalog.ts:355-358` - `"Hey {tenantFirstName}! Putting you in
  a group text with {propertyContactFirstName} to tour {where} at {time}. Looking
  forward to you seeing the property and meeting {propertyContactFirstName}!
  Please let us know when you're on the way."`

The intro job composes ONE body and hands it to `sendRelayAnnouncement` with no
per-recipient selector:

- `app/src/jobs/relayFanOut.ts:1013-1037` - `body = composeIntroBody(inputs,
  roster.map(...))`, then `sendRelayAnnouncement(..., { conversationId, body,
  kind: 'relay.intro' })`. No `bodyFor`.
- `app/src/services/relayAnnouncements.ts:253-284` - the loop sends `legBody =
  input.bodyFor?.(member) ?? body` to EVERY member of `conversation.participants`.

The default tour-group roster is `[tenant, unit's landlord]`
(`e2e/scenarios/steps.ts:1856` and its docblock). So the landlord/PM receives a
message that greets the tenant by first name, refers to the landlord in the third
person ("meeting Gloria!"), and asks the landlord to "let us know when you're on
the way" to the landlord's own property.

This is not inferred. The branch's own e2e spec PINS it:
`e2e/tests/relay-intro-variants.spec.ts:365-367` iterates `minted = [tenant.phone,
owner.phone]` and asserts `expectExactSentFromPool(req, phone, introBody, ...)` -
byte-EXACT equality of the tenant-addressed body against the owner's inbox. The
placement walk does the same at `:345-367`.

**What it implies.** The one thing that would fix it is already built and used one
handler down: `RelayAnnouncementInput.bodyFor`
(`app/src/services/relayAnnouncements.ts:140`), added by THIS diff for the
member_added split. The intro is the message with the strongest case for it - it
is the first contact a landlord ever gets on a masked number - and it is the one
place the seam was not applied. A landlord's first impression of the product is a
text that was obviously not meant for them, which is exactly the "unexpected text
to a landlord is more expensive than a missed one" cost the pause existed to
avoid.

Note also that the intro job holds `getOwner(conversation)`, `tenantId` and the
resolved `propertyContactFirstName` already, so the routing information for a
second variant is in hand at the point of composition.

---

## 2. [HIGH] Discontinued rungs are never retired by the runtime, so they re-list from `listDue` on every 30s tick FOREVER, and the only cleanup is a script documented as one-time

**What is wrong.** The poll filters discontinued kinds out of `dueRows` but leaves
the rows PENDING - no claim-skip:

- `app/src/jobs/tourReminders.ts:735-737` - `blocked = manualOnly.has(kind) ||
  DISCONTINUED_REMINDER_KINDS.has(kind)`; `dueRows = allDueRows.filter(r =>
  !blocked(r))`.
- `app/src/repos/tourRemindersRepo.ts:242-243` - `listDue`'s FilterExpression
  excludes only `sentAt` / `canceledAt` / `skippedAt`. A pending discontinued row
  therefore comes back on EVERY query, forever.
- `app/src/jobs/tourReminders.ts:739-756` - when `heldBack > 0` the poll runs two
  more full filter passes and emits an INFO line. Every pause-era `confirmation`
  row (dueAt = its arm instant, long past) satisfies this permanently.
- `app/src/worker.ts:349` + `app/src/lib/config.ts:609` - the poll runs on
  `WORKER_POLL_INTERVAL_MS`, default 30000. That is ~2,880 INFO lines per day, per
  environment, indefinitely.

The ONLY writer that can clear those rows is the ops script:
`app/src/repos/tourRemindersRepo.ts:84-88` ("Written by the one-time sweep script
ONLY - the runtime poll EXCLUDES discontinued kinds rather than claim-skipping
them") and `app/scripts/retire-paused-tour-reminders.ts:85-90`.

And the RUNBOOK explicitly downgrades running that script to optional:
`RUNBOOK.md:302` - "**SWEEP FIRST is the PREFERENCE, not a deadline**... a deploy
that lands before the sweep sends nothing wrong". True about SENDING. Silent about
the fact that skipping the sweep leaves a permanent per-tick backlog.

**What it implies.** Two things.

(a) This is a re-introduction, in a narrower form, of the pathology
`skippedAt` was added for -
`app/src/repos/tourRemindersRepo.ts:114-117` cites
`docs/issues/tour-reminder-unclaimed-skip-no-conversation.md`: "Without this stamp
a skipped row stayed in listDue FOREVER: re-listed and re-skipped every poll". The
stated reason for NOT claim-skipping here is to preserve "Send now" for PAUSED
rungs (`app/src/jobs/tourReminders.ts:728-734`) - but that reason does not apply
to a DISCONTINUED rung, whose Send now is refused anyway
(`app/src/jobs/tourReminders.ts:1638-1645`). The two causes were merged into one
`blocked` predicate and inherited a rule only one of them needs.

(b) The architecture is now permanently coupled to a script whose header says
"ONE-TIME" (`app/scripts/retire-paused-tour-reminders.ts:1-3`). Adding a second
kind to `DISCONTINUED_REMINDER_KINDS` later - which the diff's own docblocks
present as a supported operation
(`app/src/jobs/tourReminders.ts:142-171`) - leaves every pending rung of that kind
stuck in `listDue` with no cleanup path in the product. The script comment at
`:85-89` anticipates exactly this ("discontinuing a second kind would leave its
rows pending forever") and fixes only the kind LITERAL, not the one-time-ness.

---

## 3. [HIGH] `en_route` now has no quiet-hours floor at all, and both operator surfaces were changed to hide the warning that would have shown it

**What is wrong.** The exemption is applied at three places and there is no lower
bound anywhere:

- Arm time: `app/src/jobs/tourReminders.ts:417` - `dues.set(kind, kind ===
  'en_route' ? raw : clampOutOfQuietHours(raw, window))`.
- Fire time: `app/src/jobs/tourReminders.ts:1112` - `if (row.kind !== 'en_route'
  && isQuietTime(now, window))`.
- Force-send already bypassed quiet hours.

`computeDueAt` for `en_route` is `scheduledAt - 1h`
(`app/src/jobs/tourReminders.ts:150`), so the send time is whatever the operator
typed minus an hour. The comment states the consequence plainly
(`app/src/jobs/tourReminders.ts:410-411`): "There is no floor on the tour hour: a
04:00 tour really does text at 03:00".

What makes this worse than a founder trade-off is that the same diff removes the
only two places an operator would have been told:

- `app/src/routes/tourReminders.ts:642-655` - the tour panel passes
  `quietExempt = row.kind === 'en_route'`, so the rung never chips
  `Will wait - quiet hours`.
- `app/src/routes/contactTimeline.ts:1029-1037` - the contact timeline does the
  same.

And there is no arm-time warning for it. `armTourReminders` DOES warn when the
`day_before` anchor falls inside the org window
(`app/src/jobs/tourReminders.ts:429-440`) - a precedent for exactly this class of
"the panel's chips are about to look wrong, name the cause" log. Nothing
equivalent exists for an `en_route` whose raw dueAt is inside the window, even
though that is now the rung that will actually send there.

**What it implies.** An operator who mistypes a tour time (an AM/PM slip in a
`datetime-local` field is the canonical one) gets a real 03:00 SMS to a tenant, and
neither the tour panel, the contact timeline, nor any log line said anything was
unusual. Quiet hours were the last automated brake on operator data-entry error
for this rung, and the removal is total rather than bounded (e.g. "exempt only
within N hours of quiet-end"). Federal TCPA quiet hours (8pm-8am local) are the
reason the org setting exists at all; a permanent per-kind carve-out with no floor
is a compliance decision, and it currently rests on a code comment and a handback
item rather than on anything a reviewer of the running system could see.

---

## 4. [MEDIUM] The sweep script's header states the wrong default target, and its report cannot be attributed to an environment

**What is wrong.** `app/scripts/retire-paused-tour-reminders.ts:34` says:

> Targets DYNAMODB_ENDPOINT (default DynamoDB Local)

The default is the opposite. `app/src/lib/dynamo.ts:63` - `const endpoint =
opts.endpoint ?? config.dynamodbEndpoint`; `app/src/lib/config.ts:1281` -
`dynamodbEndpoint: env.DYNAMODB_ENDPOINT` (no default). `app/src/lib/dynamo.ts:3-8`
states the rule correctly: "When unset (AWS), the SDK's default chain resolves the
regional endpoint and the instance role credentials." So with no env set, the
script talks to the real AWS account of whatever credentials are ambient.

Separately, neither the success report nor the PARTIAL report logs the resolved
table name or the endpoint:

- `app/scripts/retire-paused-tour-reminders.ts:148-151` (PARTIAL) and `:303-309`
  (final) log `{...result, dryRun}` only. `result` is counters
  (`:94-108`) - `scanned`, `tourAlreadyPassed`, `kindRetired`, `skipped`,
  `skippedOnCondition`, `failed`, `toursRead`.
- `table` is computed at `:165` and never logged.

**What it implies.** The RUNBOOK procedure is "dev all the way through, then prod"
(`RUNBOOK.md:294`) and step 2 is "Read the report before applying"
(`RUNBOOK.md:296`). But a `scanned: 0` line is indistinguishable between "prod is
clean", "TABLE_PREFIX was still `hc-local-`", and "a stale `DYNAMODB_ENDPOINT` in
the shell pointed at localhost:8000". For a two-environment, run-it-twice data
mutation, the resolved target is the single most load-bearing field in the report
and it is absent - while the docblock actively tells the operator the unsafe
default is the safe one.

---

## 5. [MEDIUM] The member_added split leaves the group-side copy with no record anywhere

**What is wrong.** One row is persisted, and it carries the NEW MEMBER's body:

- `app/src/jobs/relayFanOut.ts:1103-1116` - `body: added !== undefined ?
  newMemberBody : groupBody`, plus `bodyFor` selecting `newMemberBody` for the
  joiner and `groupBody` for everyone else.
- `app/src/services/relayAnnouncements.ts:277-284` - the selector applies to the
  outbound LEG only; `body` is what `messagesRepo.append` stored (`:228`) and what
  `touchLastActivity` used for the inbox preview (`:235-239`).
- The per-member delivery slots (`:306-318`) are keyed to the persisted row, so
  each existing member's slot points at a body they did not receive.

So after an add, the dashboard thread shows "Hey, it's Sam. You're now connected
with ..." with N delivery chips, and N-1 of those recipients actually received
"Hey, adding Marcus to the group as the landlord." That second string is stored in
no message row, no slot and no log line.

**What it implies.** It is a named, dated exception to the 2026-07-14 "everything
sent into a relay group is visible in its thread" rule, and the docblock says so
(`app/src/services/relayAnnouncements.ts:119-140`). But the exception as
implemented is stronger than "one bubble instead of two": it makes the group-side
text unrecoverable. When a landlord asks what they were sent, or a delivery
complaint has to be reconciled, staff have no artefact. A cheaper shape that keeps
the ruling (one bubble, one chip) would persist the group body in a non-rendered
field on the same row, or log it once at INFO with the conversationId. Neither is
done.

---

## 6. [MEDIUM] The three new intro entries carry no sender identity at all, on a first contact from an unrecognised number, and the code says the question is unresolved

**What is wrong.** `app/src/messages/catalog.ts:337-342`:

> STOP is omitted here for the same logged A2P decision that removed it from
> `relay.intro` (changelog 1.2.1 #7). **Note these two carry NO sender identity at
> all - not even the "it's Sam" the naked intro opens with.** Engineering stated
> that exposure (see the 2026-08-20 note above); it goes to the founder as a
> question rather than being invented here, and until she rules her copy ships as
> written. TODO(founder-message-template-updates-owed).

Confirmed against the defaults: `relay.intro` opens `"Hey, it's Sam."`
(`:305`); `relay.intro_tour_today` / `relay.intro_tour` /
`relay.intro_placement` open `"Hey {tenantFirstName}!"` (`:355`, `:367`, `:386`)
and name only the property contact. The test pins the absence rather than
questioning it: `app/test/messages/catalog.test.ts:171-181` asserts
`not.toContain('Reply STOP')` and `not.toContain(SMS_BRAND_NAME)` for all four new
entries.

**What it implies.** A tenant's first message from a brand-new pool number now
says neither who is texting nor how to stop. The previous relay intro at least
said "it's Sam". The comment records the exposure as an OPEN founder question and
ships anyway - which is a defensible process choice for wording, but it means the
identification regression is landing in production with the only mitigation being
a TODO. `docs/issues/founder-message-template-updates-owed.md` (the issue that TODO
points at) was not updated by this branch, so the question is not queued anywhere
a reader would find it (see finding 7).

---

## 7. [MEDIUM] Issue-registry drift: three open issues still describe symbols and gaps this branch deleted or delivered

The branch touched `docs/issues/` (four files, per `git diff --stat main...HEAD --
docs/issues/`) but not these:

- `docs/issues/founder-message-template-updates-owed.md:31-35` - item 2 says
  `relay.intro` / `relay.member_added` "need tokens that don't exist yet", naming
  `{tenant first name}`, `{property address without city, state, zip}`,
  `{landlord first name}` "and a role tag - none of which `composeIntroBody` /
  `composeMemberAddedBody` thread today; each only receives a computed `{members}`
  (and `{joined}`) sentence." Every one of those tokens now exists
  (`app/src/messages/catalog.ts:360-364`, `:394-397`), `composeMemberAddedBody` is
  gone, and `{members}` / `{joined}` are gone. Item 2 is DELIVERED and the file
  still lists it as owed. This is the same issue slug the new catalog TODO points
  at, so the next reader lands on a body describing the world before this branch.
- `docs/issues/relay-intro-editable-but-never-overridden.md:30` - names
  `composeMemberAddedBody`, which no longer exists.
- `docs/issues/automated-sms-length-guard.md:33` - "The same shape applies to
  `{members}` in the relay intro (a large roster)". `{members}` is gone, and the
  hazard moved (see finding 15).

`docs/issues/message-interpolate-token-reexpansion.md` WAS updated (commit
b168bf30), which shows the sweep was done for one file and not the others.

---

## 8. [MEDIUM] `routes/relayGroups.ts` reads the discontinued set but not the manual-only twin, so the group thread will lie the moment anything is re-paused

**What is wrong.** The diff adds a discontinued short-circuit to the relay group
thread's scheduled bucket (`app/src/routes/relayGroups.ts:336-345`) and imports
only `DISCONTINUED_REMINDER_KINDS` (`:73-77`). It does not read
`MANUAL_ONLY_REMINDER_KINDS`.

Meanwhile the diff's own docblocks present re-pausing as a zero-cost operation:

- `app/src/jobs/tourReminders.ts:122` - "TO PAUSE AGAIN: add kinds here. Nothing
  else has to change."
- `app/src/jobs/tourReminders.ts:155-162` - "FIVE surfaces read this set, all
  mandatory... If you add a sixth surface that renders a pending rung, it reads
  this set too." (Verified: the five for DISCONTINUED are the poll, force-send,
  `routes/tourReminders.ts`, `routes/contactTimeline.ts`, `routes/relayGroups.ts`.)

The MANUAL_ONLY set has only TWO read surfaces
(`app/src/routes/tourReminders.ts:182`, `app/src/routes/contactTimeline.ts:1122`)
plus the poll. `routes/relayGroups.ts` is the third render surface for a pending
tour rung and it never sees the pause.

**What it implies.** "Nothing else has to change" is false for the surface this
branch just taught to read the OTHER set. On a re-pause, a group-routed tour's
Reminders bucket in the relay thread will go on saying "sends in Nh" for a rung
the poll will never claim - the exact lie the discontinued mechanism was added to
end, one set over. (The condition was equally true before this branch, but the
branch is what enumerated the surfaces and asserted the invariant.)

---

## 9. [MEDIUM] The worker poll has no re-entrancy guard and `listDue` has no batch cap; this diff is what makes `dueRows` non-empty again

**What is wrong.** `app/src/jobs/pollLoop.ts:66-73` schedules
`setInterval(tick, ms)` and fires unconditionally - there is no in-flight flag, so
a tick that outruns `WORKER_POLL_INTERVAL_MS` (30s) overlaps the next one.
`listDue` pages the whole `byDueAt` partition with no limit
(`app/src/repos/tourRemindersRepo.ts:256-266`), and `runDueTourReminders`
processes every row sequentially with per-row IO (`:765-776`); `processReminderRow`
alone does a tour read, a pendingRosterActions read, roster resolution, a unit
read, contact reads and a real `sendMessage`.

From 2026-08-20 the manual-only filter made `dueRows` empty in production
(`app/src/jobs/tourReminders.ts:757` - `if (dueRows.length === 0) return;`), so the
loop returned in one query. This diff empties `MANUAL_ONLY_REMINDER_KINDS`
(`:140`) and releases an eleven-day arming backlog into it in a single first tick.

**Mitigating (checked, and it is why this is MEDIUM not HIGH).** Every rung's dueAt
precedes its own tour by at most ~19h (`computeDueAt`, `:127-152`), so nearly the
entire backlog is caught by the new past-tour gate (`:1054-1060`) and claim-skipped
without an SMS. The burst is therefore mostly reads and conditional writes rather
than sends.

**What it implies.** The safety of the RUNBOOK's "deploy before sweep is fine"
claim (`RUNBOOK.md:302`) rests entirely on that gate running once per backlog row
inside an unguarded 30s loop with no batch cap. That is a real dependency worth
stating, and the loop's lack of an overlap guard is now reachable in a way it was
not for the last eleven days.

---

## 10. [LOW] `overdue` in the PATCH / send-now echo is dead code, and buys a third clock

`app/src/routes/tourReminders.ts:345-352` - `viewOf` mints its own
`new Date().toISOString()` and sets `overdue`. Its docblock (`:340-344`) says the
echo exists so the panel can render a single row.

The only consumer discards it. `dashboard/src/routes/tours/RemindersPanel.tsx:414-425`
(`onToggleCanceled`) and `:310-328` (`onSendNow`) both ignore the response body
entirely and call `fetchNow()` in `.finally`, which replaces the whole committed
state from the LIST route. Nothing reads `reminder` off either response.

Same for `suppression`: `viewOf` never sets it, so if the echo were ever consumed a
discontinued rung would lose its "No longer sent" chip and re-grow a Send now
button (the gate is `rung.suppression?.reason !== 'discontinued'`,
`RemindersPanel.tsx:396`). Today that is latent rather than live, purely because
the echo is thrown away.

---

## 11. [LOW] `overdue` is decided by lexicographic string compare, in the file whose new predicate argues at length against exactly that

`app/src/jobs/tourReminders.ts:35-42` (inside `retiredByTourStart`) spends eight
lines establishing that dueAt must be compared as an INSTANT, because a stored
`'...T15:00:00Z'` sorts before `'...T14:00:00.000Z'` and an offset-bearing dueAt
sorts by its printed hour - and notes that the sweep scans the whole table, so
hand-seeded and imported rows reach the comparison.

The two new `overdue` predicates added in the same wave are text compares:

- `app/src/routes/tourReminders.ts:351` - `row.dueAt < nowIso`
- `app/src/routes/tourReminders.ts:659` - `row.dueAt < listNowIso`

Consistent with pre-existing code in that file (`:585`), so this is a
consistency/maintainability note rather than a live defect - but it is the same
file family arguing both sides in one branch, which is precisely what the
`retiredByTourStart` comment says it wants to prevent.

---

## 12. [LOW] The same wave corrected the "60s worker poll" claim in one file and left it in another it was editing

- Corrected: `e2e/scenarios/steps.ts:1736-1738` - "the worker's 30s wall-clock
  poll... (30s is WORKER_POLL_INTERVAL_MS's default in app/src/lib/config.ts...).
  This comment said 60s until 2026-08-31."
- Still wrong, in a file this diff edits: `dashboard/src/routes/tours/RemindersPanel.tsx:48`
  - "while a rung is past due but still shows upcoming (the worker's poll runs
  every 60s), re-check on this interval."

`OVERDUE_POLL` is tuned off that assumption, and the branch's own added test
reasons about the 20s re-check (`RemindersPanel.test.tsx:653-671`). Confirmed
default: `app/src/lib/config.ts:609` - `Number(env.WORKER_POLL_INTERVAL_MS ?? 30000)`.

---

## 13. [LOW] `resolveMemberRole`'s switch is not tied to `UNIT_CONTACT_ROLES`

`app/src/jobs/relayFanOut.ts:184-192` switches on `row?.role` with cases `'pm'`,
`'landlord'`, `'owner'` and a `default: return undefined`. The declared source of
truth is `UNIT_CONTACT_ROLES` (`app/src/repos/unitsRepo.ts:77-82`), which the
switch does not reference and which no exhaustiveness check ties it to. Adding a
fifth role silently routes every such member to the no-role wording with no
compile error and no log line. Contrast the discipline the same file applies to
the kind sets, where the shared SET is read rather than a literal.

---

## 14. [LOW] `composeNameList` says "1 other person" for an empty roster and for a lone nameless member

`app/src/jobs/relayFanOut.ts:59-64` - when nothing resolves, `others =
Math.max(memberNames.length - 1, 0)` and the result is `others > 1 ? "N other
people" : "1 other person"`. For `memberNames.length` of 0 or 1 this claims one
other person when there is none, so the intro reads "You're now connected with 1
other person on this number."

The docblock owns the single-nameless-member case as a deliberate trade
(`:49-52`). It does not mention the empty-roster case, and the branch's own
preview path can reach the no-names branch (`:46-47` acknowledges "The preview
builder can reach the no-names branch"). Cheap to make honest; noted because the
"TOTAL, never empty" requirement can be met without asserting a false count.

---

## 15. [LOW] `relay.intro_placement` is a ~3-segment SMS to every member, with the length-guard issue left untouched

Template lengths, measured from `app/src/messages/catalog.ts`:

- `relay.intro` (`:305-307`) - 212 chars (was ~126 template + ~85 composed
  sentence, so roughly flat).
- `relay.intro_tour_today` (`:355-358`) / `relay.intro_tour` (`:367-370`) - 235
  chars before substitution.
- `relay.intro_placement` (`:386-391`) - 367 chars before substitution.

At GSM-7 concatenated segmentation (153 chars/segment) the placement intro is 3
segments and the tour intros are 2, sent to every member of the group. There is no
length guard on the path. `docs/issues/automated-sms-length-guard.md` is open and
still describes the hazard in terms of `{members}` (`:33`), a token this branch
deleted - so the issue neither tracks the new templates nor was re-pointed at them.

---

## 16. [LOW] The quiet-hours e2e traded a positive assertion for two negatives

`e2e/tests/scenarios/quiet-hours.spec.ts:416-437` (test 3) previously asserted
`PAUSED_NOTE` VISIBLE plus `QUIET_NOTE` absent. It now asserts only
`expectReminderRung('day_before','upcoming')` plus `toHaveCount(0)` on both notes.
The reasoning is sound and documented (the rung is ~1.8 days out at a fixed 19:30
org-local, so `QUIET_NOTE` would be a coin flip on the hour), but the net effect is
that the test no longer pins what the panel DOES say for that rung - only two
things it does not. A positive assertion on the fire-time line ("sends in ...")
would restore the strength without reintroducing the clock dependence.

---

## 17. [LOW] The `full`-profile demo seed's ladder now actually fires

`app/src/lib/seed/live.ts:519-533` arms TOUR-B (tomorrow) with the real
`armTourReminders`, so `day_before` / `morning_of` / `en_route` become genuinely
pending rows. Until this branch, `MANUAL_ONLY_REMINDER_KINDS` meant the worker
never claimed them. Now it will, against `+1555017xxxx` fixtures
(`app/src/lib/seed/live.ts:72-79`).

In a `npm run dev` loop with live comms (real Twilio, per the repo's dev-mode
note), that is three real Twilio API calls per seeded tour returning invalid-number
errors, at times derived from the seed instant - i.e. new recurring ERROR lines in
a dev environment whose log hygiene the repo has already had to defend
(`app/src/jobs/pollLoop.ts:4-14`, the orphan-logs incident). Not a correctness
defect; worth knowing before the next dev-log triage.

---

## Sweeps performed that came back CLEAN (recorded so they are not redone)

- **Renamed exports.** `composeConnectionSentence`, `composeMemberAddedBody`,
  `ANONYMOUS_JOINED_LABEL` have no remaining code references in `app/src`,
  `dashboard/src`, `e2e`, `app/scripts` - only comments and `docs/issues` prose
  (finding 7). `composeIntroBody`'s new two-argument signature has exactly two
  callers outside its own module, both updated
  (`app/src/services/rosterEdits.ts:510`, `:738`).
- **`{members}` / `{joined}` tokens.** No live `resolveMessage` call passes either.
- **`interpolate` rewrite** (`app/src/messages/resolve.ts:33-53`). Behaviourally
  equivalent to the old loop for every input except the re-expansion it fixes:
  undeclared tokens stay literal, declared-but-unvalued still throws in strict mode
  and blanks otherwise, and the callback form avoids `$&`/`$1` expansion. Every
  `vars` name in `MESSAGE_CATALOG` matches the regex charset
  `[A-Za-z][A-Za-z0-9_]*` (checked by extracting all `vars:` arrays).
- **`ScheduledSuppressionReason` + `discontinued`.** All four dashboard consumers
  handled: `types.ts:1181-1196`, `REMINDER_SUPPRESSION_LABELS:1292-1315`,
  `ScheduledCard.tsx:33/64/128`, `DeadlinesNudgesCard.tsx:73` (label-only, branch
  deliberately absent). No fifth exhaustive `Record` over the union exists.
- **`ReminderSkipReason` + 3 members.** `REMINDER_SKIP_REASON_LABELS`
  (`dashboard/src/api/types.ts:1311-1325`) covers all three; the panel's fallback
  renders a bare "Skipped" for an unknown token
  (`RemindersPanel.tsx:118-127`), which makes `RUNBOOK.md:304`'s degradation claim
  accurate.
- **Five read surfaces for `DISCONTINUED_REMINDER_KINDS`.** Claim at
  `app/src/jobs/tourReminders.ts:155-162` verified: poll (`:735`), force-send
  (`:1638`), `routes/tourReminders.ts:521/642`, `routes/contactTimeline.ts:1029`,
  `routes/relayGroups.ts:342`. No sixth surface reads a pending tour rung
  (`app/src/routes/placements.ts:414` uses the repo for cancel only).
- **`RelayComposeDeps` wiring.** Both owner preview routes wire the three new
  optional picks (`app/src/routes/tours.ts:525-534`,
  `app/src/routes/placements.ts:923-935`); the standalone preview
  (`app/src/routes/relayGroups.ts:385`) has no owner and correctly degrades naked.
- **`resolveRelayComposeInputs` totality.** Its "IT NEVER THROWS" claim
  (`app/src/jobs/relayFanOut.ts:206-212`) holds: the two calls made outside a
  try/catch, `unitContacts` (`app/src/repos/unitsRepo.ts:295-303`) and
  `formatStreet` (`app/src/lib/address.ts:90-104`), are both explicitly total
  functions.
- **Lazy repo init order.** `contacts` is assigned before `resolveOwnerInputs` runs
  in both handlers (`app/src/jobs/relayFanOut.ts:982`, `:1053`).
- **Sweep script write.** PK is `reminderId` alone
  (`app/src/repos/tourRemindersRepo.ts:95-96`); the conditional at
  `retire-paused-tour-reminders.ts:193-195` matches `claimSkip`'s own condition;
  `skipReason` values are both in the union; `_reminderPartition` is preserved and
  `listDue` filters on `skippedAt`, so a swept row leaves the queue exactly once.
  `tableName('tourReminders', env)` matches `app/src/lib/tables.ts:426`.
- **PII in new log lines.** Every new `log.*` in `jobs/tourReminders.ts`,
  `jobs/relayFanOut.ts` and the sweep script carries ids
  (`reminderId`/`tourId`/`unitId`/`ownerId`), counters and `err` only - no name,
  phone or body. The sweep's PII claim (`retire-paused-tour-reminders.ts:50`) is
  accurate.
- **Arm-time supersession widening** (`app/src/jobs/tourReminders.ts:523-536`).
  Checked against the en_route exemption for tours at 08:30 and 09:00 with the
  default 21:00-08:00 window; `otherDue <= dueAt` is what retires the clamped
  `morning_of`, and the `undefined` guard is correct. The fire-time twin
  (`supersededInBatch`, `:1082-1087`) stays LADDER_ORDER-keyed, which is a
  different rule but not reachable into disagreement, because the inverted pair is
  already retired at arm time.
