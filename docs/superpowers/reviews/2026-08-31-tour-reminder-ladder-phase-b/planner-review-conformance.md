# Independent SPEC-CONFORMANCE review - Phase B

Reviewer: planner-side conformance agent (independent of the build orchestrator).
Branch: `feat/tour-reminder-ladder-phase-b`, worktree `W:\tmp\tour-reminder-ladder-phase-b`.
Base `main` @`ec32170a`; one main merge @`9b6d972c`; head @`fa2fdd29`.
Spec: `docs/superpowers/specs/2026-08-31-tour-reminder-ladder-phase-b-design.md`.
Method: `git diff main...HEAD -- app dashboard e2e RUNBOOK.md docs/issues`, read
against the spec section by section. NO test suite, server or e2e lane was
started (a gate run was live). Every claim below carries a `file:line` from the
worktree at head.

The section 2 decisions are LOCKED and are not re-argued here; each is checked
only for whether the code implements it.

## 1. Conformance table

Legend: DELIVERED / DEVIATED (built, but not as written) / MISSING.

### Section 2 - locked decisions

| # | decision | verdict | proof |
|---|---|---|---|
| D1 | confirmation gone entirely - not armed, not sent | DELIVERED | `app/src/jobs/tourReminders.ts:339` `REMINDER_KINDS` = 3 rungs; `:283` `DISCONTINUED_REMINDER_KINDS`; poll filter `:713`; force-send refusal `:1625` |
| D2 | two new sweep skip tokens, not one | DELIVERED | `app/src/repos/tourRemindersRepo.ts:78` `tour_already_passed`, `:84` `kind_retired` |
| D3 | no new dev seam for immediate sends; test-only vehicles | DELIVERED | `createDueReminder` exists ONLY in `app/test/tourReminders.test.ts:136`; no production seam added; `app/src/routes/dev.ts:131` runs production semantics |
| D4 | one-hour bound on the names re-list | DELIVERED | `app/src/jobs/tourReminders.ts:1252` (1:1) and `:1436` (group), both via `rosterWaitExpired` |
| D5 | `overdue` flag on the reminder view | DELIVERED | `app/src/routes/tourReminders.ts:158`, set at `:349` and `:648` |
| D6 | ledger item 8 assessed, dropped, NOT filed | DELIVERED | no new issue file for it (`docs/issues` adds only `outbound-mms-viewer-scroll-capture-flake.md`); disposition recorded at `docs/issues/tour-reminder-ladder-phase-b.md` item 8; `supersededInBatch` untouched |
| D7 | `en_route` exempt from quiet hours at BOTH sites | DELIVERED | arm `app/src/jobs/tourReminders.ts:415`; fire `:1109` |
| D8 | three intro variants; no-owner one unchanged | DELIVERED | `app/src/messages/catalog.ts:337/349/371`; naked `:303` |
| D9 | `{members}` removed in favour of `{names}` | DELIVERED | `app/src/messages/catalog.ts:310`; `composeNameList` `app/src/jobs/relayFanOut.ts:246`; no live `{members}` anywhere (grep: comments only) |
| D10 | `member_added` splits per recipient; ONE row carrying the NEW MEMBER's body | DELIVERED (one documented refinement, see DEV-4) | `app/src/jobs/relayFanOut.ts:1090` `body:`, `:1094` `bodyFor:`; `app/src/services/relayAnnouncements.ts:139` selector, `:279` leg-only application |
| D11 | missing intro inputs fall back to the naked intro | DELIVERED | `app/src/jobs/relayFanOut.ts:408` (contact/where), `:418` (no tour time), `:323/:369/:429` (read failures) |
| D12 | real single-pass `interpolate` fix | DELIVERED | `app/src/messages/resolve.ts:41` regex + callback |
| D13 | merge everything incl. the unpause; human runs the sweep and deploys | DELIVERED | `MANUAL_ONLY_REMINDER_KINDS` empty `app/src/jobs/tourReminders.ts:229`; `RUNBOOK.md:287-303`; script header `app/scripts/retire-paused-tour-reminders.ts:36-39` |

### Section 3 - ordering and the send-side guard

| item | verdict | proof |
|---|---|---|
| 3.1 separate permanent `DISCONTINUED_REMINDER_KINDS` holding `confirmation` | DELIVERED | `app/src/jobs/tourReminders.ts:283` |
| 3.1 surface 1 - poll due-row filter excludes it | DELIVERED | `app/src/jobs/tourReminders.ts:713` `blocked()` |
| 3.1 surface 2 - `forceSendReminder` REFUSES `kind_retired` | DELIVERED | `app/src/jobs/tourReminders.ts:1625-1631` (pre-claim, above target resolution) |
| 3.1 surface 3 - tour panel chip reads "no longer sent", never "Paused" | DELIVERED | `app/src/routes/tourReminders.ts:641`; `dashboard/src/routes/tours/RemindersPanel.tsx:129` (ABOVE `paused`) |
| 3.1 surface 4 - the contact timeline's OWN read | DELIVERED | `app/src/routes/contactTimeline.ts:1029-1031` |
| 3.1 `kind_retired` has no in-app skip writer; `claimSkipRow` docblock gains the third category | DELIVERED | `app/src/jobs/tourReminders.ts:786-796` |
| 3.1a widen `ScheduledSuppressionReason`; add the ONE placement-card label entry; do NOT build the chip there | DELIVERED | `app/src/services/scheduledSendSuppression.ts:9`; `dashboard/src/api/types.ts:1154`; label `dashboard/src/routes/placements/DeadlinesNudgesCard.tsx:73-79`; chip deliberately absent with the reason written at `:103-110` |
| 3.1a discontinued evaluated OUTSIDE `suppressionOf`, in the `paused`-fallback position | DELIVERED | `app/src/routes/tourReminders.ts:641-651` - `discontinued` is a branch ahead of the `suppressionOf !== undefined` test, never an argument to it; evaluator itself unchanged (`scheduledSendSuppression.ts` produces no `discontinued`) |
| 3.1a `MANUAL_ONLY_REMINDER_KINDS` docblock FULLY rewritten and points at the new set | DELIVERED | `app/src/jobs/tourReminders.ts:190-228` |
| 3.2 the RUNBOOK sequence, the either-order note, the bare-"Skipped" degradation note | DELIVERED | `RUNBOOK.md:293-302` |
| 3.2 within-branch build order (sweep -> vehicle -> manual-only) | DELIVERED | commit order `f47ff7a`..`7345dd36` per `git log`; T4 before T5 before T7 in the work map |

### Section 4 - the retirement sweep

| item | verdict | proof |
|---|---|---|
| 4.2 population A (dueAt precedes a past tour), `no_show_checkin` exempt by construction | DELIVERED | `app/scripts/retire-paused-tour-reminders.ts:83` via `retiredByTourStart` |
| 4.2 the sweep planner SHARES the runtime predicate (not two hand-written conditions) | DELIVERED | one exported `retiredByTourStart` at `app/src/jobs/tourReminders.ts:176`, imported by the script `:56` and used by the poll `:1054` and force-send `:1688`. No second implementation exists (grep) |
| 4.2 population B - every pending row of a discontinued kind, read from the SET not a literal | DELIVERED | `app/scripts/retire-paused-tour-reminders.ts:90` |
| 4.2 a row in both takes A's token | DELIVERED | A tested first, `:83` before `:90`, with the rationale at `:70-73` |
| 4.2 operator-restored past-tour rungs are swept knowingly; the repo docblock reversal recorded | DELIVERED | `app/src/repos/tourRemindersRepo.ts:169-180` |
| 4.3 `tour_already_passed` at all six sites | DELIVERED | 1 `tourRemindersRepo.ts:78`; 2 `dashboard/src/api/types.ts:1239`; 3 `types.ts:1314`; 4 `types.test.ts:109`; 5 `tourReminders.ts:1566`; 6 `types.ts:1367` |
| 4.3 `kind_retired` at all six sites | DELIVERED | 1 `:84`; 2 `types.ts:1242`; 3 `types.ts:1315`; 4 `types.test.ts:110`; 5 `tourReminders.ts:1569`; 6 `types.ts:1368` |
| 4.3 `names_unavailable` at four sites, keeping the generic retry copy | DELIVERED | 1 `:90`; 2 `types.ts:1245`; 3 `types.ts:1316`; 4 `types.test.ts:111`; refusal union already present `tourReminders.ts:1561`; NO `SEND_NOW_ERROR_COPY` entry (correct) |
| 4.3 labels byte-match the spec table | DELIVERED | `dashboard/src/api/types.ts:1314-1316` - `the tour had already happened` / `this reminder is no longer sent` / `couldn't look up the names` |
| 4.3 a completeness test for site 6 | DEVIATED - DEV-6 | `dashboard/src/api/types.test.ts:135-150` enforces only a hand-named `PERMANENT_REFUSALS` pair; it is not the label test's exact-key-set shape |
| 4.4 pure planner, `--dry-run`, conditional writes, `tableName`/`DYNAMODB_ENDPOINT`, PII limits, RUNBOOK entry, no agent runs it | DELIVERED | `app/scripts/retire-paused-tour-reminders.ts:75` (pure), `:251` (dry run), `:193-203` (condition), `:165` (tableName), `:50` + `:241` (PII), `RUNBOOK.md:287`, `:36-39` (agent prohibition) |
| 4.5 nothing re-arms in-flight rows | DELIVERED | no re-arm path added; documented `RUNBOOK.md` and ledger item 6 |

### Section 5 - stopping `confirmation`

| item | verdict | proof |
|---|---|---|
| remove from `REMINDER_KINDS` ONLY | DELIVERED | `app/src/jobs/tourReminders.ts:339` |
| kind stays in the union, `computeDueAt`, `LADDER_ORDER`, catalog | DELIVERED | `LADDER_ORDER` `:228`; catalog `app/src/messages/catalog.ts:138`, `:150` both retained |

### Section 6 - `en_route` quiet-hours exemption

| item | verdict | proof |
|---|---|---|
| 6 site 1 arm-time clamp bypassed for `en_route` only | DELIVERED | `app/src/jobs/tourReminders.ts:415` |
| 6 site 2 fire-time backstop | DELIVERED | `app/src/jobs/tourReminders.ts:1109` |
| 6 `clampOutOfQuietHours` itself untouched | DELIVERED | `app/src/lib/quietHours.ts` not in the diff |
| 6 ADDENDUM site 3a - tour panel estimate exempts the QUIET disjuncts only | DELIVERED | `app/src/routes/tourReminders.ts:592-603` (`quietExempt` forces the quiet operand alone; `evaluate` still runs) + call site `:647` |
| 6 ADDENDUM site 3b - contact timeline mirror, decided at the call site not inside `quietFor` | DELIVERED | `app/src/routes/contactTimeline.ts:875` (`!quietExempt && quietFor(dueAt)`), call site `:1035`; helper stays kind-blind per `:832-841` |
| 6 `placementNudges.ts` untouched | DELIVERED | absent from the diff |
| 6.1a fire-time gate, claim-skipped `tour_already_passed` | DELIVERED | `app/src/jobs/tourReminders.ts:1054-1060` |
| 6.1a the dueAt-precedes-the-tour qualifier (derived, not a name list) | DELIVERED | `app/src/jobs/tourReminders.ts:190` `due < start && nowMs >= start` |
| 6.1a PRECEDENCE - gate FIRST, above `supersededInBatch`, `isQuietTime`, `beforeStart`, roster, names | DELIVERED (with DEV-1) | gate `:1054`; `supersededInBatch` `:1076`; `isQuietTime` `:1109`; `beforeStart` `:1160`; roster/names below |
| 6.1a absent OR UNPARSEABLE `scheduledAt` -> gate does not apply | DELIVERED | `app/src/jobs/tourReminders.ts:181-184` (`Number.isFinite` on `Date.parse`) |
| 6.1a naming - not "start passed" | DELIVERED | `retiredByTourStart`, rationale `:184-186` |
| 6.1a force-send REFUSES with the SAME predicate, never claim-skips | DELIVERED | `app/src/jobs/tourReminders.ts:1688` calling the same helper; `refuse()` leaves the row pending |
| 6.1a `beforeStart` comment rewritten | DELIVERED | `app/src/jobs/tourReminders.ts:1151-1159`; the disjunct is KEPT as defence-in-depth for `no_show_checkin`, which the spec's reasoning supports (it only ruled the COMMENT false) |
| 6.2 widen `supersededBySlot` to `otherDue <= dueAt` | DELIVERED | `app/src/jobs/tourReminders.ts:539` |
| 6.2 explicit `undefined` guard, polarity as written | DELIVERED | `otherDue !== undefined && otherDue <= dueAt && otherDue < scheduledIso` at `:539` - character-for-character the spec's line |
| 6.2 `LADDER_ORDER` docblock rewritten to say why an inequality is required | DELIVERED | `app/src/jobs/tourReminders.ts:206-222` |
| 6.2 `supersededInBatch` NOT made symmetric | DELIVERED | unchanged in the diff |

### Section 7 - the names bound

| item | verdict | proof |
|---|---|---|
| BOTH sites bounded, identically | DELIVERED | 1:1 `app/src/jobs/tourReminders.ts:1249-1258`; GROUP `:1433-1442` |
| grace = `ROSTER_UNAVAILABLE_GRACE_MS` via the roster twin's helper | DELIVERED | both call `rosterWaitExpired(row.dueAt, now)` |
| claim-skip `names_unavailable` | DELIVERED | same lines |
| FORCE-SEND path unchanged (still refuses, generic copy) | DELIVERED | no `names_unavailable` entry in `SEND_NOW_ERROR_COPY`; refusal union member pre-existing |

### Section 8 - the `overdue` flag

| item | verdict | proof |
|---|---|---|
| 8.1 additive boolean, `state` union NOT widened | DELIVERED | `app/src/routes/tourReminders.ts:158`; `dashboard/src/api/types.ts:1249`; `state` union untouched |
| 8.1 docblock text as the spec's fenced block | DELIVERED | both sites carry "Derived, never stored: ... Composes with `suppression`, which says WHY." |
| 8.1 formula `state === 'upcoming' && row.dueAt < nowIso`, omitted when false | DELIVERED | `:350` and `:648`; conditional spread at `:355`/`:655` |
| 8.2 BOTH builders set it | DELIVERED | `viewOf` `:349`; GET list `:648` |
| 8.2 EACH builder computes its OWN `nowIso` | DELIVERED | `:348` and `:635`, with the reason written in place |
| 8.2 `contactTimeline.ts` and `relayGroups.ts` EXCLUDED | DELIVERED | grep: `overdue` appears nowhere in either file |
| 8.2 the excluded surfaces are named in the placement issue | DELIVERED (spec self-correction) | `docs/issues/placement-nudge-overdue-invisible-on-card.md:49-73` - added by this branch; the spec's claim that the file already named them was false and is recorded as such at `:70-73` |
| 8.3 `routes/placementNudges.ts` untouched | DELIVERED | absent from the diff |

### Section 9 - relay group templates

| item | verdict | proof |
|---|---|---|
| 9.0 all four composer call sites route through the shared resolver | DELIVERED | intro job `app/src/jobs/relayFanOut.ts:1015`; member-added job `:1074`; `buildOpenPreview` `app/src/services/rosterEdits.ts:586`; `buildAddPreview` `:733` |
| 9.0 the preview shows the same variant the job would send | DELIVERED | same resolver, same entry set; deliberate clock-dependence documented `rosterEdits.ts:575-585` |
| 9.0 `buildAddPreview` shows the GROUP body | DELIVERED | `app/src/services/rosterEdits.ts:738` `composeMemberAddedGroupBody` |
| 9.0 `buildAddPreview` docblock amended to say the new member gets something different, and where | DELIVERED | `app/src/services/rosterEdits.ts:704-717` |
| 9.1 precedence 1 edited -> 2 tour -> 3 placement -> 4 naked | DELIVERED | `app/src/jobs/relayFanOut.ts:1004-1013` (edit wins, reads not even made); `:415-421` variant order; naked `:424` |
| 9.1 routing on `getOwner(conv)` | DELIVERED | `app/src/jobs/relayFanOut.ts:1016` |
| 9.1 tour-today copy BYTE-EXACT | DELIVERED | `app/src/messages/catalog.ts:339-343`; concatenation reproduces the spec's line 719 character for character (checked incl. the apostrophe in `you're` and both `!` marks) |
| 9.1 tour-dated copy BYTE-EXACT ("on {when}") | DELIVERED | `app/src/messages/catalog.ts:351-355` vs spec line 725 |
| 9.1 placement copy BYTE-EXACT | DELIVERED | `app/src/messages/catalog.ts:373-378` vs spec line 740 |
| 9.1 "today" uses `resolveQuietHoursTimezone` | DELIVERED | `app/src/jobs/relayFanOut.ts:348`, compared via `localDateOf` `:356` |
| 9.1 no "tomorrow" variant | DELIVERED | only two tour entries exist |
| 9.1 sender-identity exposure recorded, copy shipped as written | DELIVERED | `app/src/messages/catalog.ts:325-331`; founder item 2 |
| 9.1 housing-authority note recorded with its date | DELIVERED | `app/src/messages/catalog.ts:363-370`; test scoping `app/test/messages/catalog.test.ts:190-197` |
| 9.2 naked intro copy BYTE-EXACT | DELIVERED | `app/src/messages/catalog.ts:305-308` vs spec line 779 |
| 9.2 sent text byte-identical to today's for every roster but the nameless-single | DELIVERED | pinned `app/test/relayFanOut.test.ts:812` and `:828` |
| 9.2 `{names}` TOTAL, all four table rows | DELIVERED | `app/src/jobs/relayFanOut.ts:249-252`: `others > 1 ? '<n> other people' : '1 other person'`, which yields `1 other person` for both the 1-other and 0-other rows |
| 9.2 never a phone number | DELIVERED | only `firstNameOnly(name)` or the count phrasing |
| 9.2a six entries' `vars` order, class, channel, `editable:false` | DELIVERED | `app/src/messages/catalog.ts:344/356/379/386/410`; pinned `app/test/messages/catalog.test.ts:82-129` |
| 9.2a every new id added to `MessageId` | DELIVERED | `app/src/messages/catalog.ts:48-61` |
| 9.2a `{where}` LAST in every entry | DELIVERED | asserted `app/test/messages/catalog.test.ts:113-116` |
| 9.3 reuse `resolveTourContactNames` / `formatStreet` / `formatLocal*` | DELIVERED | `app/src/jobs/relayFanOut.ts:313`, `:329`, `:355`, `:362` |
| 9.3 composer PURE + synchronous, no repo reads below it | DELIVERED | `composeIntroBody` `:383`, `composeMemberAddedGroupBody` `:437`, both sync and read-free |
| 9.3 ONE exported resolver keyed on the OWNER, not a conversation | DELIVERED | `resolveRelayComposeInputs(owner, deps, addedContactId)` `:361` |
| 9.3 `unitsRepo` (+ tours/placements) wired into the JOB and the PREVIEWS | DELIVERED | job `:620-628`, `:669-672`; previews `app/src/lib/rosterResolution.ts:156-158` and wired at `app/src/routes/tours.ts:526-532`, `app/src/routes/placements.ts:929-934` |
| 9.3 a read failure degrades to missing inputs, never throws | DELIVERED | `app/src/jobs/relayFanOut.ts:289`, `:297`, `:320`, `:349`, `:363`, plus repo CONSTRUCTION `:673-681` |
| 9.4 group entry + no-role entry, both BYTE-EXACT | DELIVERED | `Hey, adding {name} to the group as the {role}.` `app/src/messages/catalog.ts:408`; `Hey, adding {name} to the group.` `:383` |
| 9.4 new member receives the naked intro with the full post-add roster | DELIVERED | `app/src/jobs/relayFanOut.ts:1080-1083` (`variant: 'naked'`, post-add roster names) |
| 9.4 `{name}` TOTAL, first name, `a new member`, never a phone | DELIVERED | `joinedName` `app/src/jobs/relayFanOut.ts:298` |
| 9.4 `ANONYMOUS_JOINED_LABEL` REPLACED, not left beside | DELIVERED | grep: the const no longer exists anywhere |
| 9.4 STOP omitted on both | DELIVERED | pinned `app/test/messages/catalog.test.ts:171-180` |
| 9.4 role source `UnitContact.role`, and the four-row role table | DELIVERED | `resolveMemberRole` `app/src/jobs/relayFanOut.ts:329-347`: `pm`->property manager, `landlord`/`owner`->landlord, owner's tenant->tenant, everything else->no role |
| 9.5 missing landlord / address / tour time -> naked | DELIVERED | `app/src/jobs/relayFanOut.ts:408` and `:418` |
| 9.5 missing tenant first name degrades IN-SENTENCE, not to naked | DELIVERED | `app/src/jobs/relayFanOut.ts:395` (`?? 'there'`); the resolver keeps the variant (`withNames` spread carries only the name) |
| 9.6 ONE persisted row, per-member selector on `sendRelayAnnouncement` | DELIVERED | `app/src/services/relayAnnouncements.ts:139` + `:279` |
| 9.6 the persisted `body` is the NEW MEMBER's copy | DELIVERED with a documented refinement (DEV-4) | `app/src/jobs/relayFanOut.ts:1090` |
| 9.6 default (no selector) byte-identical for every other caller | DELIVERED | `input.bodyFor?.(member) ?? body`; pinned `app/test/relayAnnouncements.test.ts:252` |
| 9.6 `persist:false` legs-only still drives per-member bodies | DELIVERED | the selector is applied inside the send loop, above and independent of the persistence branch (`relayAnnouncements.ts:279`) |
| 9.7 `relay.group_closed` and the placement nudges untouched | DELIVERED | `app/src/messages/catalog.ts:472` still present; `placementNudges.ts` absent from the diff |

### Sections 10-15

| item | verdict | proof |
|---|---|---|
| 10 unit vehicle is test-only | DELIVERED | `createDueReminder` only at `app/test/tourReminders.test.ts:136` |
| 10 e2e vehicle is the existing future-rung tick | DELIVERED | e.g. `e2e/tests/scenarios/tours.spec.ts:153`, `:264` |
| 10 converted specs ASSERT the same-tour retirement | DELIVERED | `e2e/tests/scenarios/tours.spec.ts:266-303` (`expectRungsSuperseded(['morning_of'])`) |
| 10 the dev tick's deliberate divergence DELETED | DELIVERED | `app/src/routes/dev.ts:123-131` |
| 10 the dev tick does NOT bypass `DISCONTINUED_REMINDER_KINDS` | DELIVERED | the set is read directly in `runDueTourReminders` (`tourReminders.ts:713`) with no deps seam; `manualOnlyKinds`' docblock states the prohibition `:596-599` |
| 10a.1/10a.2 the conversion inventory worked, incl. the "green but changed" category | DELIVERED | tripwires all resolved: `catalog.test.ts:82`, `tour-roster.spec.ts`, `steps.ts`, the preview/job parity pins; category-4 site rebuilt at `tours.spec.ts:291-303` |
| 11 single pass, CALLBACK replacement | DELIVERED | `app/src/messages/resolve.ts:41-53` |
| 11 undeclared stays literal | DELIVERED | `:43` `return match`; test `app/test/messages/resolve.test.ts:110` |
| 11 declared+missing: strict THROWS, override -> empty | DELIVERED | `:46-50`; test `:120` |
| 11 declared but absent from the template needs no value | DELIVERED | scan is template-driven; test `:128` |
| 11 regression test with `$&` / `$1` | DELIVERED | `app/test/messages/resolve.test.ts:102-108` (also `` $` `` and `$'`) |
| 12 item 8 NOT filed; item 9 TODO re-pointed | DELIVERED | `app/src/messages/tourCopy.ts:172` now `TODO(tour-copy-where-token-declared-not-passed)` |
| 13 out-of-scope respected | DELIVERED | no settings UI; `relay.intro` still `editable:false`; `missed_call.autotext`, `welcome.sms`, `placementNudges.ts` untouched |
| 14 unit coverage as enumerated | DELIVERED | sweep planner `app/test/retirePausedTourReminders.test.ts`; en_route + widening `app/test/tourReminders.test.ts:4572`, the 08:30 regression `:4674`, the no-op proof `:4713`; timeline discontinued `app/test/contactTimeline.test.ts:1293`, `:1328`; force-send `app/test/tourRemindersApi.test.ts:1641`; overdue in both builders (route tests + `RemindersPanel.test.tsx:441`) |
| 14 e2e coverage as enumerated | DELIVERED except the overdue flag (not a spec-14 e2e item) | `e2e/tests/relay-intro-variants.spec.ts:214` (tour walk: preview, both legs, add split, ONE bubble) and `:314` (placement walk) |
| 15 founder items owed | DELIVERED | `docs/superpowers/reviews/2026-08-31-tour-reminder-ladder-phase-b/founder-handback-items.md` carries all five spec items plus four build-found |

## 2. Verification of the handback's five named rulings/deviations

1. **T3 - `beforeStart` disjunct KEPT.** Confirmed at `app/src/jobs/tourReminders.ts:1160`, with the comment rewritten at `:1151-1159`. Spec 6.1a ruled the COMMENT false and put it on the rewrite list; it never ordered the disjunct removed, and `no_show_checkin` (exempt from the new gate by construction) is a real consumer of it. HONOURS the spec.
2. **T8 - a FIFTH discontinued surface (`routes/relayGroups.ts`).** Confirmed at `app/src/routes/relayGroups.ts:336-345`. Spec 3.1's table names four, but the same section's "standing hazard" instruction is to grep for readers app-wide. Widening HONOURS the spec's stated intent; suppression only, no `overdue`, so spec 8.2's exclusion of the same file is not violated.
3. **T12 - no e2e assertion for `overdue`.** Confirmed: no e2e references `overdue`. Spec 14's E2E list never asked for one; the route- and component-level pins exist. NOT a spec deviation. See LOW-8 for the residual risk.
4. **T14 - inclusive past-tour boundary.** Confirmed `now >= start` at `app/src/jobs/tourReminders.ts:190` and `startedAt <= Date.parse(nowIso)` at `app/src/jobs/relayFanOut.ts:397`. Agrees with spec 6.1a's "a tour that has already started"; a hair stricter than spec 4.2's "in the past" for the zero-width t=start instant. HONOURS the spec, see LOW-2.
5. **Discontinued OUTRANKS opt-out / kill switch.** Confirmed at `app/src/routes/tourReminders.ts:641` and `app/src/routes/contactTimeline.ts:1029`, both short-circuiting ahead of the evaluator. This is exactly what spec 3.1a directs ("evaluated in the SAME POSITION as today's `paused` fallback - outside `suppressionOf`... it is terminal, so it does not belong in that ordering at all"). HONOURS the spec.

## 3. Findings

### HIGH-1 - the tour intro variant is unreachable in the product's primary tour flow

The tour intro composes only when `getOwner(conv)` resolves a tour that already
has a `scheduledAt` (`app/src/jobs/relayFanOut.ts:280`, `:418`). The documented
landlord-led / PM-team flow opens the relay group at INTEREST so the parties can
negotiate the time inside it, and books afterwards
(`e2e/tests/scenarios/tours.spec.ts:11-16`, `:127-133`). At open time there is
no `scheduledAt`, so those groups get the NAKED intro; the new founder wording
reaches only relays opened AFTER booking. The build found this and it is
recorded as founder item 7, but nothing in the spec anticipated it, and it means
the most visible half of Sam's 2026-08-24 rewrite will rarely fire in
production. Not a spec violation - the code implements 9.1 and 9.5 exactly - but
the human should decide before deploy whether "tour relay, time not set yet"
deserves a variant, because otherwise this mission's headline copy is largely
dead code in the field. No code change is required to merge.

### MEDIUM-2 - `tour_missing` moved above supersession and quiet hours as a side effect of the tour-read hoist

Spec 6.1a's precedence table inserts ONE new gate at position 1. The build also
moved the tour READ (and therefore the `tour_missing` claim-skip) to the top of
`processReminderRow` (`app/src/jobs/tourReminders.ts:1044-1051`), which the
table does not describe. Two behaviours change: a rung whose tour is missing and
which is superseded in-batch now reads `tour_missing` instead of
`quiet_hours_superseded`, and one due inside a quiet window now retires
immediately instead of deferring unclaimed until quiet-end. Both new answers are
truer than the old ones, the change is documented in place at `:1039-1043` and
pinned by a test, and it cannot send anything. Recorded so it is attributed to
this branch rather than re-diagnosed later; no action recommended.

### LOW-3 - the relay intro carries an extra past-tour guard the spec does not describe

`app/src/jobs/relayFanOut.ts:280-282` drops `scheduledAt` when the tour has
started, routing a post-start open to the naked intro. Spec 9.1's precedence has
no such condition and 9.5's fallback list is "missing landlord, address or tour
time". The guard is additive, well-reasoned (both tour entries end "let us know
when you're on the way"), boundary-matched to the ladder gate, and documented at
`:256-279`. It changes shipped founder copy in a reachable case (a quiet-hours
deferred open that straddles the tour start), so it belongs in the record.

### LOW-4 - the persisted `member_added` body is the GROUP copy in the raced-remove case

Spec 9.6 states flatly that the persisted body is the new member's. The code
persists the group body when the joiner is no longer on the roster
(`app/src/jobs/relayFanOut.ts:1090`, rationale `:1084-1089`) - i.e. exactly when
no recipient received the new member's copy. The refinement preserves the rule's
purpose (the bubble quotes something somebody actually got) rather than its
letter. Correct call; recorded as a deviation because the spec's sentence is
unconditional.

### LOW-5 - the site-6 completeness test is narrower than the pattern the spec named

Spec 4.3 calls `SEND_NOW_ERROR_COPY` "the one site nothing enforces" and asks
for a completeness test "in the shape of `dashboard/src/api/types.test.ts`'s
label test", whose shape is a hand-copied vocabulary plus an exact key-set
equality. The shipped test
(`dashboard/src/api/types.test.ts:135-150`) asserts only that two hand-named
permanent refusals are not the generic fallback. A future permanent refusal
added to `ForceSendRefusal` and omitted from `SEND_NOW_ERROR_COPY` still
compiles, ships, and tells an operator to retry - the exact failure the spec
wanted enforced. Cheap to tighten later; not merge-blocking.

### LOW-6 - the sweep's population-A boundary is inclusive where spec 4.2 reads exclusive

`retiredByTourStart` uses `now >= start` (`app/src/jobs/tourReminders.ts:190`),
so a tour whose `scheduledAt` is exactly the sweep instant is swept; spec 4.2
says "scheduledAt is in the past at sweep time". Zero-width window, and the
inclusive form is what spec 6.1a's "already started" and the relay guard both
use - one instant, one answer. Recorded only because the two spec sentences
differ.

### LOW-7 - spec 8.2's claim about the placement issue was false and the branch corrected it

Spec 8.2 asserts the two excluded surfaces were already named in
`docs/issues/placement-nudge-overdue-invisible-on-card.md`. They were not; the
branch added them (`:49-73`) and says so at `:70-73`. Correct handling of a spec
error; noted so the next reader does not treat the spec sentence as evidence.

### LOW-8 - `overdue` has no end-to-end proof

Route-level and component-level pins exist, and spec 14's E2E list never asked
for one, so this is not a gap against the spec. The handback's reason
(time-injected tick vs wall-clock flag, and a live worker that sends a past-due
rung within 30s) is sound. Residual risk: the wire field is the only link
between the two pinned halves, and nothing exercises it together. Accept.

### NOTE-9 - `viewOf`'s `overdue` is currently read by nobody

Spec 8.2 mandates it on BOTH builders and the build complied
(`app/src/routes/tourReminders.ts:349`). The panel refetches after a PATCH, so
the echo's flag is dead today. Conformant; recorded for completeness.

## 4. Verdict

No BLOCKING conformance defect. Every RULED and DECIDED statement in sections
3-11 is implemented, and the six-site token checklist, the 6.1a precedence
table, the four (now five) DISCONTINUED reads, the 9.5 naked fallback with its
tenant-name exception, the 9.6 one-row rule and the shared sweep/runtime
predicate all check out against the code. The founder copy in all six catalog
entries is byte-exact against the spec's fenced blocks, verified character by
character including apostrophes and terminal punctuation.

CONFORMANCE: 92 delivered / 4 deviated / 0 missing.
(Deviations: DEV-4 the raced-remove persisted body, DEV-6 the narrowed site-6
test, plus the two boundary/scope notes LOW-3 and MEDIUM-2, all judged to honour
the spec's intent.)
