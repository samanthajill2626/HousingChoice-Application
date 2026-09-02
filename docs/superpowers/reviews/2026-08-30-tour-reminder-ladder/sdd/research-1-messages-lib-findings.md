> **FINDINGS HALF ONLY.** Extracted 2026-09-01 from `research-1-messages-lib.md`, which was 77-87%
> byte-exact quotation of code git holds at the commits cited here. Only the DRIFT
> (plan/spec vs the live tree) and GAPS (what the change breaks that the plan omits)
> sections are kept. The reference half was not committed.

## DRIFT — plan/spec versus the live tree

| # | Claim | Where | Live |
| --- | --- | --- | --- |
| D1 | Spec 6: "a declared token present in the copy with no value THROWS for a code default (`resolve.ts:36`)" | spec §6 | The throw is at **`resolve.ts:37`**. `:36` is `if (strict) {`. |
| D2 | Spec 6: "a declared token absent from a template is skipped (`resolve.ts:33`)" | spec §6 | CORRECT — `:33` is `if (!out.includes(needle)) continue;`. |
| D3 | Spec §7 / plan Global Constraints: "Resolve it with `resolveQuietHoursTimezone` (`lib/quietHours.ts:39`)" | both | CORRECT, exact. |
| D4 | Plan Global Constraints implies `readQuietHoursWindow` sits near `quietHours.ts` | plan `:66-68` | It lives in **`app/src/jobs/tourReminders.ts:175`**, not in `lib/quietHours.ts`. Any new module importing it takes a dependency on the JOB module (which pulls repos and the SDK). Not a problem for Task 4 Step 8 (`routes/tourReminders.ts:67` already imports it) but a trap for anything meant to stay pure. |
| D5 | Spec §9: "`ReminderKind` IS persisted (`tourRemindersRepo.ts:76`)" | spec §9 | `:76` is `/** byTour GSI hash key */`. The persisted field `kind: ReminderKind;` is at **`:78`** (which is what the PLAN says at its Global Constraints — plan is right, spec is drifted). The UNION itself is declared at `:29-34`. |
| D6 | Spec 6.1: "as in `lib/rosterResolution.ts:274`" for the 2-line rule | spec 6.1 | The rule spans **`:273-275`**; `:274` is only the `.find()` line and `:275` carries the `?? nonEmpty(...)`. Plan's `:273-275` is correct. |
| D7 | Spec 6.1: "Roster entries carry a denormalized `name` (`unitsRepo.ts:63`)" | spec 6.1 | `:63` is the docblock sentence; the FIELD `name?: string;` is at **`:72`** (plan's Task 2 citation `:72` is correct). |
| D8 | Spec 6.1: "handled inside `unitContacts` (`unitsRepo.ts:296`)" | spec 6.1 | `:296` is the parameter line. The synthesized-primary branch is **`:299-301`**; the function opens at `:295`. Plan's `:295-303` is correct. |
| D9 | Plan Step 1: "the no-address describe's day_before/morning_of/en_route cases at `:52-75`" | plan Task 4 Step 1 | Those three kinds are asserted inside a SINGLE `it` at **`:53-62`** together with `confirmation`; the range `:52-75` also swallows the "the home" test and the all-empty-address test, and OMITS the three address-shape tests at **`:77-105`** that the plan's replacement block also supersedes. |
| D10 | Plan Step 1: "the pins at `:22-49`" | plan Task 4 Step 1 | The `it`s are at `:22-49` but the enclosing `describe` (`:14`), the `addr` const (`:15`) and the token-contract comment (`:17-21`) must go too — 8 more lines than stated. |
| D11 | Plan Step 1: "KEEP the ASCII guard" | plan Task 4 Step 1 | The ASCII assertion (`:115`) lives inside an `it` TITLED "OUR copy is ASCII **and single-segment** with the seeded address" (`:109`). Deleting `:116` leaves the title false. The plan never says to rename it. |
| D12 | Plan Task 4 files list: "`app/test/tourReminders.test.ts:101` (`rungBody`)" | plan | The `composeTourReminderBody` call is at **`:102`**; `:101` is the helper's signature line. |
| D13 | Plan Task 4 files list: "`app/src/routes/tourReminders.ts` (`bodyFor:229` ...)" vs spec §10 "`routes/tourReminders.ts:238`" | plan / spec | Both correct for different things: `bodyFor` declared at `:229`, its compose call at `:238`. Not a conflict — noting it so nobody "fixes" one. |
| D14 | Plan Task 4 Step 4: "the D2 sentence at `:51-52`" | plan | EXACT. |
| D15 | Plan Task 4 Step 4: "`computeDueAt` in `jobs/tourReminders.ts:96-117` is the in-repo precedent" for a returnless exhaustive switch | plan | EXACT — switch `:96-117`, function `:89-118`, no trailing return. |
| D16 | Spec 9.1 / plan: `tourCopy.ts:67` unguarded cast | both | EXACT (`:67-69`). |
| D17 | Spec 9.2: "`tourCopy.ts:53` - the composer's early return" | spec | EXACT. |
| D18 | Spec 9.2 / plan Step 8: `routes/tourReminders.ts:548` bypass, docblock `:532-537`, handler `:538-549` | both | ALL EXACT. |
| D19 | Plan Step 7: "`addressOf` (`:200-211`)" | plan | EXACT. |
| D20 | Plan Step 11: composer import at `steps.ts:37`; `TourReminderContext:140`; `tourReminderContext:164`; `tourReminderBody:173`; `REMINDER_BODY_MARKERS:191` | plan | ALL EXACT. |
| D21 | Plan Task 4 Step 4 comment: "settingsToOverrides maps only welcome.sms and missed_call.autotext - messages/resolve.ts:74-79" | plan | EXACT, and independently verified: no tour compose site passes an `overrides` argument. |
| D22 | Spec §6 / plan: `catalog.test.ts:43` (no dead tokens) and `catalog.test.ts:35` (undeclared token) | both | BOTH EXACT. |
| D23 | Spec 6.1: "`nonEmpty` in `rosterResolution.ts:151` is MODULE-PRIVATE" | spec | EXACT and CONFIRMED (no `export`, no importer). |
| D24 | Plan File Structure: "`app/src/lib/localTime.ts` — ADD `shiftLocalDate()`" | plan | CONFIRMED absent repo-wide. |
| D25 | Plan Task 1 Step 1: appends `import { shiftLocalDate } from '../src/lib/localTime.js';` to a file that ALREADY imports from that exact specifier at `:2` | plan | Two import statements from one module. Compiles, but `import/no-duplicates` / `no-duplicate-imports` would flag it under gate 5 (`npx eslint` over touched files). Merge into `:2` instead. |

---

## GAPS — things in this subsystem the change breaks that the plan does not name

**G1. `app/src/messages/index.ts` is a third catalog surface the plan never mentions.**
```ts
 4:export {
 5:  MESSAGE_CATALOG,
 6:  type MessageId,
 7:  type MessageDef,
 8:  type MessageClass,
 9:} from './catalog.js';
10:export { resolveMessage, settingsToOverrides } from './resolve.js';
11:export { resolveWithSettings } from './resolveWithSettings.js';
```
No edit is strictly required (it re-exports the whole symbol), but note that `:11` VALUE-exports `resolveWithSettings`, which imports `createSettingsRepo` and therefore the AWS SDK (`resolveWithSettings.ts:1-5` says so in terms). **Anything importing from `messages/index.js` drags the SDK.** `routes/tourReminders.ts:43` imports `resolveMessage` from `../messages/index.js` — the import plan Step 8 tells you to DELETE. Deleting it is safe (routes are server-side), but if any future refactor points the composer or a test helper at `messages/index.js` instead of `messages/resolve.js`, the harness bundle silently gains the SDK. Worth a one-line note in the composer header.

**G2. The plan's compose-path list omits a THIRD copy of the primary-contact rule, and it is the one WITHOUT the empty-string guard.**
Spec 6.1 and plan Task 2 both cite `services/rosterProvision.ts:233`. There is a second occurrence in the same file at `:525`:
```ts
525:    unitContacts(unit).find((c) => c.primaryContact === true)?.contactId ?? unit.landlordId;
```
This one uses a bare `?? unit.landlordId` — exactly the empty-string bug spec 6.1 warns about. It is pre-existing and out of scope, but a builder reading "the established rule, as in rosterProvision.ts:233" may copy the WRONG line if they grep instead of following the citation. Flag it; do not fix it here.

**G3. `app/test/tourCopy.test.ts:109`'s `it` title becomes a lie.** (See D11.) The plan deletes the assertion but keeps the name "OUR copy is ASCII **and single-segment** with the seeded address". Spec §5 explicitly rules there is no segment requirement — leaving that phrase in a test name re-asserts the rule the ruling removes.

**G4. The composer's new `.trim()` is a behaviour change for FOUR paths the plan does not enumerate.** Today neither return path trims (`tourCopy.ts:54`, `:71-75`). After Task 4 every body is trimmed — including `confirmation` and `no_show_checkin`, whose copy the plan says is "UNTOUCHED". Their current defaults have no leading/trailing whitespace, so no rendered output changes; but any test comparing a `sentBody` snapshot written under the old composer against a freshly recomposed body would now differ if the stored value had stray whitespace. Low risk, worth one sentence in the handback rather than a discovery.

**G5. `interpolate` ignores UNDECLARED vars passed by the caller — silently.** The new composer always passes `addressLine`, `time`, `when` and all four name vars to every entry, but only `tour.morning_of` will declare `addressLine`. `interpolate` iterates `def.vars` (`resolve.ts:31`), so extras are dropped with no error. That is what makes the plan's uniform `nameVars` object safe — but it also means a TYPO in a var key (`addresLine`) fails SILENTLY: the token stays literal in the body and only the `expect(body).not.toContain('{')` assertion in the plan's new morning_of test would catch it. There is no generic "every declared token in every tour entry got a value" test. Worth adding to the matrix test.

**G6. `catalog.test.ts:35` is the ONLY thing that catches a token used but not declared, and it runs over defaults only.** The new `{addressLine}` is computed in code and injected. If a future operator override (Phase B's generic map) adds `{addressLine}` to an entry that does not declare it, nothing fails — the override path is `!strict` (`resolve.ts:64`) and, worse, an UNDECLARED token in an override is never inspected at all and ships literally to the tenant. Spec 6.5 says the twin guard "is gone" and `{addressLine}`'s defined empty rendering replaces it — true for the DEFAULT, not for a future override. The plan's `TODO(tour-reminder-ladder-phase-b)` on `reminderNamesUsed` names the adjacent hazard but not this one.

**G7. `e2e/scenarios/steps.ts:191-197` `REMINDER_BODY_MARKERS` breaks on THREE rungs, and the plan lists the constant but not which markers die.** Current:
```ts
191:export const REMINDER_BODY_MARKERS: Record<ReminderKind, string> = {
192:  confirmation: 'your tour is set for',
193:  day_before: 'confirming your tour tomorrow at',
194:  morning_of: 'excited for you to see',
195:  en_route: "let me know when you're on the way",
196:  no_show_checkin: 'Do you need to reschedule?',
197:};
```
Against the new copy: `confirmation` survives (untouched), `day_before` survives ("confirming your tour tomorrow at"), `morning_of` DIES ("excited for you to see" -> "looking forward to having you tour at"), `en_route` DIES ("let me know when you're on the way" -> "text me/here when you're on the way"; spec §13 prescribes `on the way`), `no_show_checkin` survives. Two markers must be re-picked, and the `en_route` one must satisfy the marker invariant across BOTH new type-fork entries.

**G8. `e2e/scenarios/steps.ts:143` `address?: string` is typed `string`, not `Address | string`.** `TourReminderContext` at `:140-144` carries `address?: string;` and `tourReminderContext` fills it from `unit.addressLine1` (`:165`). Adding `tourType` and `names` per plan Step 11 is fine, but note the harness context has no notion of a structured address — irrelevant to this change, listed so nobody "helpfully" widens it.

**G9. `app/test/messages/resolve.test.ts:17` carries a comment that becomes stale:**
```ts
17:  // relay.group_closed is the TOKEN-FREE editable example: every tour.* default
```
The sentence continues past the grep window and describes the tour entries as a class. Not a failing assertion, but it is a reader in this subsystem that will disagree with the new catalog. The plan's "Test files modified" list does not include `app/test/messages/resolve.test.ts`.

**G10. `e2e/tests/tour-no-show-checkin.spec.ts:30` names the catalog id in a comment** (`// 'tour.no_show_checkin') - unique to this rung, so a body match cleanly ...`). Spec 13.2 flags `tour-no-show-checkin.spec.ts:63-75` going vacuous; it does not flag `:30`'s comment, which describes a body-match strategy that changes once the copy carries `{tenantFirstName}`.

**G11. Nothing pins that every `tour.*` entry stays `channel: 'sms'`.** `messageCatalogAscii.test.ts` filters on `def.channel !== 'sms'` (`:20`, `:33`) — a new `tour.en_route_*` entry written with the wrong channel would silently escape BOTH the ASCII and GSM-7 guards, which are the guards spec §5 leans on as the reason the segment assertion can be dropped. The plan's new "token declarations" test pins `editable` but not `channel`. One extra `expect(MESSAGE_CATALOG[id].channel).toBe('sms')` in that loop closes it.

**G12. `ContactItem.getById`'s optional second parameter is invisible to the plan's `Pick<ContactsRepo, 'getById'>`.** That is fine for compilation, but the plan's `tourContacts.ts` calls `getById(id)` with no `{ consistentRead: true }`. Every other read on the send path does the same, so this is consistent — noting it only because a reviewer looking for "did the send path read a stale name" will ask, and the answer (eventually-consistent read, deliberately, matching `resolveReminderTarget`) belongs in the handback rather than in a review comment.