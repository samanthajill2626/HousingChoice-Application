# S3 slice report - app reads

Kind: SLICE REPORT (mission record). Branch `feat/primary-contact-integrity`,
worktree `W:\tmp\primary-contact-integrity`, base 7cb3ff03 (S2b report).
Plan: `docs/superpowers/plans/2026-10-13-primary-contact-integrity.md`
Tasks S3.1-S3.7 (sections 0-3 and the 3.2 rulings binding; R1, R2, R15,
R16, R17, R18, R19 applied). The "S3 additions" of
`research/worklist-deltas.md` carry nothing to code; their two informational
items are in section 6. Implementer: Claude Opus 5.5, alone in the worktree.
Date: 2026-10-13.

Environment checks before the first vitest run: `env | grep '^AWS_'`
printed nothing (exit 1). DynamoDB Local (`hc-dynamodb-local`) was already
Up; it was never started, stopped, restarted or reseeded. No `npm test`,
`npm run e2e`, `npm run e2e:session` or `npm run dev` was run. No background
command was left running.

## 1. Commits

| task | commit | subject |
|---|---|---|
| S3.1 | b9ebd67f | feat(relay): introFallback reasons on resolveRelayComposeInputs (primary-contact-integrity S3.1) |
| S3.2 | 212c39e9 | feat(relay): log the general-intro fallback reasons in the relay intro job (primary-contact-integrity S3.2) |
| S3.3 | bcafc0b6 | feat(roster): RosterPreview.introFallback on the tour and placement open preview (primary-contact-integrity S3.3) |
| S3.4 | 9cde6088 | feat(units): project the primary-assignment reason on the unit Activity wire (primary-contact-integrity S3.4) |
| S3.5 | 0bef6446 | feat(units): roster row flags and the propertyContact block on GET /api/units/:id (primary-contact-integrity S3.5) |
| S3.6 | ac286827 | feat(units): propertyContact block on the contact-list add and remove responses (primary-contact-integrity S3.6) |
| S3.7 | (none) | slice gate - no code change, nothing forced a fix |

Every commit: gating bare `git status` read first, `MERGE_HEAD` absent
(`git rev-parse -q --verify MERGE_HEAD || echo no-merge-in-progress`),
explicit paths only, the plan's subject, the `Co-Authored-By: Claude Opus
5.5` trailer. The S3.6 commit carries one extra body line naming the
granted comment leave (D3). `npm run typecheck` after each task's commit:
exit 0 every time, 0 `error TS` lines (logs
`.superpowers/sdd/S3-typecheck-S3.<n>.log`).

## 2. Files touched

Source (3): `app/src/jobs/relayFanOut.ts`, `app/src/services/rosterEdits.ts`,
`app/src/routes/units.ts` (ONLY the propertyContact import line, the
`UnitActivityEvent` docblock line / interface / `toUnitActivityEvent`, the
new module-level `UnitContactView` / `PropertyContactBlock` /
`propertyContactBlockOf` before `const DEFAULT_PAGE_LIMIT = 50;`, the tail
of `enrichRoster` plus the new `enrichRow` / `enrichRosterView` beside it,
the GET `/:unitId` response line, the two contact-list `res.json` lines, and
the add route's header comment - leave (b), D3).

Tests (10, all under `app/test/`): NEW `relayIntroFallback.test.ts`,
`relayIntroFallbackJob.test.ts`, `rosterPreviewIntroFallback.test.ts`,
`unitsApiPropertyContact.test.ts`, `unitsApiPropertyContactWrites.test.ts`;
EDITED `rosterEdits.test.ts`, `toursApi.test.ts`, `placementsApi.test.ts`,
`unitsApiActivity.test.ts`, `unitsApiRoster.test.ts`.

`git diff --stat 7cb3ff03..HEAD` (before this report): exactly these 13
files, 1895+ / 102-. No file outside the brief's list was edited.
`app/src/lib/rosterResolution.ts` was NOT edited (leave (a) not needed, D4).

Ruling R16 / CI-4: before S3.6 the line
`    res.json({ unit: { ...updated, contacts: await enrichRoster(updated) } });`
counted exactly 2 (add handler, remove handler); after the `replace_all`
`...(await enrichRosterView(updated))` counts 2 and the old line 0. The
restore response keeps `contacts: await enrichRoster(restored)` (R18).

## 3. Tests and RED/GREEN evidence

Method: the five NEW test files were created by byte-exact extraction of the
plan's fenced blocks (`sed -n` over plan lines 11289-11774, 12167-12387,
12499-12661, 13128-13436, 13745-13912); every existing file was changed with
the Edit tool (S3.6 with `replace_all`). A script then counted each plan
new_string block in its target file: every block found exactly once
(relayFanOut.ts 6 blocks, rosterEdits.ts 3, units.ts 7, each test edit 1).
All new/edited lines are ASCII (checked before every commit).

### S3.1 - `relayIntroFallback.test.ts` (31 tests)

describe "resolveRelayComposeInputs - introFallback (primary-contact-integrity
spec 5.1)": absent (4) - "a tour that composes its own intro carries no
introFallback"; "a placement that composes its own intro carries no
introFallback"; "an ownerless conversation never carries it: the general
intro is its only intro"; "a deleted primary next to a live landlord of
record resolves past it (P1): the tour intro". Owner (2) - "an owner read
that THROWS is lookup_failed ALONE - and nothing else is read"; "an owner
that is MISSING, or has no repo wired, is the same: lookup_failed alone".
Unknown unit (4) - "a unit read that THROWS: lookup_failed, with the unitId
the owner named"; "a failed unit read keeps tour_not_scheduled /
tour_started beside lookup_failed"; "a MISSING unit, or no units repo
wired, reads like a failed unit read"; "a placement on an unknown unit
carries NO tour reason". Each reason alone (13) - no_property_contact;
property_contact_deleted (soft-deleted, and NO record); property_contact_is_tenant;
property_contact_no_first_name (id rides along); no_street_address;
tour_not_scheduled; tour_started; lookup_failed x4 (THROWN P1 read, no
contacts repo, settings throws / answers nothing / not wired, unformattable
time); "a failed TENANT read is NOT a reason: the tour intro still
composes". Order (5) - "reports in SPEC order, not evaluation order"; "does
not stop at the first miss: no contact AND a failed settings read are both
reported"; "no first name + no street + not scheduled"; "a deleted contact +
no street + an unformattable time"; "lookup_failed is reported ONCE however
many reads fail". Placements (1) - "never carry a tour reason, and never
read settings". Plus "the member-added role is still resolved when the intro
falls back" and "NEVER throws: every read failing at once answers
lookup_failed".

- RED: `Test Files  1 failed (1)`, `Tests  25 failed | 6 passed (31)` -
  exactly the plan's split (the 6 passing: the four absent pins, the failed
  TENANT read, the member-added role). Lines `expected undefined to deeply
  equal { reasons: [ 'lookup_failed' ], ...(2) }`, `tour: expected {
  variant: 'naked' } to deeply equal { variant: 'naked', ...(1) }`. No
  SKIPPED line.
- GREEN (with relayFanOut 152): `Test Files  2 passed (2)`,
  `Tests  183 passed (183)`. `npx tsc -p tsconfig.test.json --noEmit` ->
  `EXIT:0`, no output.

### S3.2 - `relayIntroFallbackJob.test.ts` (6 tests)

"a tour that composes its own intro sends it and logs NO fallback line"; "a
tour whose start has passed: the general intro and ONE INFO line, ids and
reason codes only"; "a placement-owned group logs ownerType placement and its
own reasons"; "an operator-edited intro is sent verbatim and logs NO fallback
line"; "an ownerless group sends the general intro and logs NO fallback
line"; "the member-added announcement logs NO fallback line, even on a group
whose intro falls back".

- RED: `Tests  2 failed | 4 passed (6)` - the past-tour and placement tests,
  each `AssertionError: expected [] to have a length of 1 but got +0`, as
  the plan says.
- GREEN (with relayIntroFallback 31, relayFanOut 152):
  `Test Files  3 passed (3)`, `Tests  189 passed (189)`.

### S3.3 - `rosterPreviewIntroFallback.test.ts` (4), `rosterEdits.test.ts` (2 changed), `toursApi.test.ts` (+2), `placementsApi.test.ts` (+2)

New: "the OPEN preview carries the resolver introFallback when the owner
falls back to the general intro"; "the OPEN preview carries NO introFallback
when the tour intro composes"; "the STANDALONE preview never carries
introFallback"; "the ADD-MEMBER preview never carries introFallback, even on
an owner whose intro falls back". Changed: "produces an IDENTICAL preview for
the same member set" and "carries the SAME quiet-hours verdict through both
paths" (introFallback is the one owner-only difference; that fixture wires
no tours repo, so `{ reasons: ['lookup_failed'] }`). toursApi: "preview-open
explains the general intro: introFallback carries the reasons, the unit and
the street (primary-contact-integrity spec 5.2)"; "preview-open carries NO
introFallback when the tour intro composes". placementsApi: "preview-open
explains a general intro with introFallback - never a tour reason
(primary-contact-integrity spec 5.1-5.2)"; "preview-open carries NO
introFallback when the placement intro composes".

- RED: `Test Files  4 failed (4)`, `Tests  4 failed | 312 passed (316)` -
  one per file, exactly the plan's four (`expected undefined to deeply
  equal { reasons: [ 'lookup_failed' ] }`, `... { reasons: [ 'tour_started'
  ], ...(2) }`, `... { ...(2) }`, `... { ...(3) }`).
- GREEN (with relayGroupPreview 13): `Test Files  5 passed (5)`,
  `Tests  329 passed (329)`. tsc test config -> `EXIT:0`.

### S3.4 - `unitsApiActivity.test.ts` (+3)

"projects unit_primary_contact_assigned with contactId, contactName, reason
and from"; "projects every primary-assignment reason code verbatim"; "keeps a
listing_status_changed free-text reason OFF the wire" (the R17 pin).

- RED: `Tests  2 failed | 12 passed (14)` (`expected { ...(6) } to deeply
  equal { id: Any<String>, ...(6) }`; `expected [ undefined, undefined,
  ...(3) ] to deeply equal [ 'auto_on_add', 'backfill', ...(3) ]`); the R17
  pin passed before and after, as planned.
- GREEN: `Test Files  1 passed (1)`, `Tests  14 passed (14)`.

### S3.5 - `unitsApiPropertyContact.test.ts` (13), `unitsApiRoster.test.ts` (1 changed)

Complete read (10): "a landlord-only unit: the landlord is the property
contact, and nobody inherits it"; "470 Bolton: no landlord of record and no
flagged primary - contactId null, reason none, no heir"; "a deleted flagged
primary: its row is marked, reason deleted, and the earliest ELIGIBLE live
contact is the heir"; "only ineligible live contacts (a caseworker, a
tenant): no heir"; "a deleted primary next to a live landlord of record: the
landlord is the property contact AND the heir"; "an OFF-roster landlord of
record is read too, and named as the heir from that read"; "an heir with no
name on record carries its id only"; "a landlord id that names NO contact
record reads as deleted"; "a soft-deleted caseworker row carries BOTH
flags"; "the complete read is ONE requireComplete batch read of the roster
ids AND landlordId". Incomplete read (3): "a raw chunk error: best-effort
names, no deleted/caseworker flags, no propertyContact";
"IncompleteBatchReadError: ..." (same); "both reads failing: bare rows, no
block, still 200". unitsApiRoster "returns a back-compat single-row roster
for a roster-less unit (derived from landlordId)" now seeds the live
landlord record and pins `{ contactId: 'c-ll-9', heirIfPrimaryRemoved: null }`.

- RED: `Test Files  2 failed (2)`, `Tests  11 failed | 27 passed (38)` -
  new file `13 tests | 10 failed` (the three incomplete-read pins green),
  unitsApiRoster `25 tests | 1 failed`. See D1 for two line shapes.
- GREEN (with contactsBatchReads 10 - still ONE getManyByIds on the GET -,
  unitsApi 29, unitsRestoreLandlord 33): `Test Files  5 passed (5)`,
  `Tests  110 passed (110)`. tsc test config -> `EXIT:0`.

### S3.6 - `unitsApiPropertyContactWrites.test.ts` (7)

"POST add: the block is decided from the written roster"; "DELETE of a
NON-primary row: the block is decided from the written roster"; "DELETE of
the PRIMARY with a live heir: the block names the heir as the property
contact"; and per failure shape (a raw chunk error, IncompleteBatchReadError):
"<shape>: POST add answers 200 with today's rows and no block", "<shape>:
DELETE of a non-primary row answers 200 with no block".

- RED: `Tests  3 failed | 4 passed (7)`, all three `expected undefined to
  deeply equal { contactId: ..., ...(1) }` - no non-200 status, so S2's
  route behavior matches CI-4.
- GREEN (with unitsApiPropertyContact 13, unitsApiRoster 25,
  unitsApiRosterAutoPrimary 19, unitsApiRosterTypeChecks 23,
  unitsApiActivity 14): `Test Files  6 passed (6)`, `Tests  101 passed (101)`.

## 4. Shipped wire contracts S4 renders (exact)

### 4.1 Intro fallback (`app/src/jobs/relayFanOut.ts`, exported next to `RelayComposeInputs`)

```ts
export type IntroFallbackReason =
  | 'no_property_contact' // P1 (lib/propertyContact): nobody, reason none
  | 'property_contact_deleted' // P1: nobody, reason deleted (deleted or missing)
  | 'property_contact_is_tenant' // P1: nobody, reason is_tenant
  | 'property_contact_no_first_name' // P1 found a contact with no first name
  | 'no_street_address' // formatStreet(unit.address) is empty
  | 'tour_not_scheduled' // tour only: no scheduledAt
  | 'tour_started' // tour only: scheduledAt <= now
  | 'lookup_failed'; // a read failed or could not answer

export interface IntroFallback {
  reasons: IntroFallbackReason[]; // every reason that applies, in the order above; never empty
  unitId?: string;                // absent ONLY when the owner read failed / found nothing
  street?: string;                // formatStreet(unit.address), known unit and non-empty only
  propertyContactId?: string;     // only with property_contact_no_first_name
}

export interface RelayComposeInputs { /* ... */ introFallback?: IntroFallback; }
```

Rules as shipped (spec 5.1 + design notes D1-D3): owner read threw, found
nothing, or no tours/placements repo -> exactly `{ reasons: ['lookup_failed'] }`
(no unitId). Unknown unit (read threw, found nothing, or no units repo) ->
`lookup_failed` plus any tour reason, `unitId` set, no `street`. Otherwise
every check runs; `lookup_failed` is added (once) for a P1 `read_failed`, no
contacts repo or a throw from the name resolution, a settings read that
throws / answers nothing / is not wired, or an unformattable tour time.
`scheduledAt` absent or `''` -> `tour_not_scheduled`; at-or-after now ->
`tour_started`. Settings are read only for a tour with a usable,
not-started time on a known unit; placements never read settings and never
carry a tour reason. Any reason -> `variant: 'naked'` (unchanged rule).
Ownerless (`owner.type === null`) -> `{ variant: 'naked' }`, never
`introFallback`.

`RosterPreview.introFallback?: IntroFallback` (`app/src/services/rosterEdits.ts`):
SET only by `buildOpenPreview`, i.e. the JSON body of `GET
/api/tours/:tourId/roster/preview-open` and `GET
/api/placements/:placementId/roster/preview-open` (the routes send the
preview itself as the body, so `body.introFallback`). The KEY IS ABSENT
(never null/undefined) when the owner's own intro composes. NEVER set by
`buildStandaloneOpenPreview` (`POST /api/relay-groups/preview`) or
`buildAddPreview` (the tour and placement `preview-add` routes) - pinned.

Job INFO line (S3.2): message `relay intro: general intro used`, level 30,
fields `{ conversationId, ownerType, ownerId, reasons }` (plus the pino
mixin's correlation ids) - never a name or the street (pinned). Emitted in
`RELAY_INTRO_JOB`'s composed-default branch only, after `composeIntroBody`
and before `sendRelayAnnouncement`; never for an operator-edited
`intro_body`, an ownerless group, or `RELAY_MEMBER_ADDED_JOB`.
`resolveOwnerInputs`' repo-construction catch now answers
`ownerUnreadable()` (so that path logs `reasons: ['lookup_failed']`).

### 4.2 Property payload (`app/src/routes/units.ts`; types are module-private there - S4 mirrors them in `dashboard/src/api/types.ts`)

```ts
// one roster row on the wire (response only, never stored)
interface UnitContactView extends UnitContact {
  deleted?: true;     // row's contact soft-deleted OR has no record
  caseworker?: true;  // isCaseworker(contact): type 'partner' and role caseworker / case worker
}
// on the unit
propertyContact?: {
  contactId: string | null;                 // P1 with no tenant (decidePropertyContact)
  reason?: 'none' | 'deleted';              // ONLY when contactId is null
  heirIfPrimaryRemoved: { contactId: string; name?: string } | null;
};
```

- Served on: `GET /api/units/:unitId` -> `{ unit: { ...stored, contacts,
  propertyContact?, mediaDisplay } }`; `POST /api/units/:unitId/contacts`
  (200) and `DELETE /api/units/:unitId/contacts/:contactId` (200) -> `{
  unit: { ...written, contacts, propertyContact? } }`, decided from the
  WRITTEN unit the repo returned. Error answers are S2's, unchanged.
- NOT served (no row flags, no block): `POST /api/units/:unitId/restore`
  (R18 - today's best-effort rows; the page must re-read, S4.10), and every
  other unit response (create, PATCH, list, status, photos).
- Source read: ONE `readRosterContacts(contacts, rosterContactIds(unit))` -
  a single `getManyByIds(ids, { requireComplete: true })` over every
  `unitContacts()` row id plus an off-roster `landlordId` (zero calls when
  there is no id at all; the block is then `{ contactId: null, reason:
  'none', heirIfPrimaryRemoved: null }` and `contacts: []`).
- Read failed in EITHER shape (raw chunk error or `IncompleteBatchReadError`):
  rows fall back to the old best-effort `enrichRoster` (names/company as
  before, NO `deleted`, NO `caseworker` on any row) and `propertyContact` is
  ABSENT. If the best-effort read fails too, bare rows. Status is always 200.
- On a complete read `propertyContact` is ALWAYS present (the helper's
  `undefined` branch is unreachable by construction). `reason: 'none'` = no
  candidate at all (no flagged row, no `landlordId`); `'deleted'` = every
  candidate deleted or missing (a `landlordId` naming no record included).
- `heirIfPrimaryRemoved`: `null` when NO row is flagged primary (design D4 -
  there is no primary to remove) or when the heir function finds nobody;
  else `chooseHeir` excluding the flagged row's contact (also when that
  contact is deleted): the live landlord of record (on or off the roster;
  never the landlord when the landlord IS the flagged primary), else the
  earliest-added roster contact eligible for automatic routing. `name` =
  first + last of the heir's record from the same read (trimmed), absent
  when the record has neither - present for an off-roster landlord heir too.

### 4.3 Activity projection (`GET /api/units/:unitId/activity`)

`UnitActivityEvent.reason?: string` - lifted ONLY when `type ===
'unit_primary_contact_assigned'`; values as written by S2 (`auto_on_add`,
`handoff_on_remove`, `handoff_on_delete`, `handoff_on_restore`) and S5
(`backfill`). The same event also carries, through the existing whitelist:
`contactId` (the NEW primary), `contactName` (best-effort read-time
enrichment of `contactId`), `from` (the PREVIOUS primary's contact id - the
hand-offs only; `auto_on_add` has none; NOT name-enriched), `actorId` when
the writer passed `actor`. `listing_status_changed`'s free-text `reason`
stays off the wire (pinned, R17). The docblock's event list gains
`unit_primary_contact_assigned`.

## 5. Divergences from the plan text

- D1 (RED shape, S3.5). The call-shape test "the complete read is ONE
  requireComplete batch read ..." failed at its ids assertion (`expected [
  'c-pat' ] to deeply equal [ 'c-ll', 'c-pat' ]`) before the
  `requireComplete` assertion the plan quotes as the typical line, and "an
  heir with no name on record carries its id only" failed with `TypeError:
  Cannot read properties of undefined (reading 'heirIfPrimaryRemoved')`
  rather than an AssertionError. Same root cause (the old best-effort read
  covered roster ids only and served no block); counts exactly as planned.
- D2 (brief). S3.7 step (2b), the whole app workspace (`npm test -w
  @housingchoice/app`), was NOT run: the brief forbids the full suite and
  defines the slice gate as typecheck plus the named files. Extra neighbor
  runs stand in as evidence (section 8).
- D3 (granted leave (b), comment only). The contact-list add route's header
  comment now reads "the roster resolvers take the live row marked primary,
  else the live landlord of record - see unitsRepo.addContact" (re-wrapped
  to three lines). Folded into the S3.6 commit with a body line naming it.
- D4 (granted leave (a), NOT used). The `RosterResolutionDeps` docblock at
  `app/src/lib/rosterResolution.ts:160-169` (S1's W1) was checked against
  the shipped S3.1 rules and left unchanged: an omitted `tours` (tour owner)
  or `placements` (placement owner) answers `{ reasons: ['lookup_failed'] }`
  and an omitted `settings` adds `lookup_failed` whenever the tour's time
  would otherwise compose - so whenever an omitted read degrades a tour or
  placement OPEN preview, its reasons include `lookup_failed`, which is what
  the docblock says. (Its older sentence that an omission always degrades is
  pre-S1 and was already loose for a placement, which reads no settings.)
- D5 (brief). `npm run typecheck` ran after every task commit (the plan asks
  for it at S3.7 and a test-config tsc at S3.1/S3.3/S3.5); all exit 0.

No code divergence: every plan code block landed byte-identical (script
check, section 3), every predicted RED matched (D1 aside), every GREEN
matched its expected counts.

## 6. Worries for the orchestrator (non-blocking)

- W1 (worklist delta S3-F7, informational). The INFO line fires when the
  intro is COMPOSED, before `sendRelayAnnouncement` - which can still no-op
  on an unusable conversation - and also on the dev intro-replay endpoint
  (`devRelayReplay` drives the same handler). The spec's "when it sends"
  wording describes it loosely.
- W2 (worklist delta S3-F6, informational). `contactTimeline.ts` keeps a
  fixed landlord event-type list, so `unit_primary_contact_assigned` never
  appears on a landlord's timeline; it lives on the property Activity tab
  only, as the spec places it.
- W3 (for S4). The Activity row's `from` is a raw contact id - only
  `contactId` gets a `contactName`. A renderer that wants "from <name>" has
  no name on the wire. Also (S2b W2): a "Restore without a landlord" that
  promotes writes `unit_restored` (its `primaryPromoted` object is NOT
  projected) AND `unit_primary_contact_assigned { reason: 'handoff_on_restore'
  }`, so the feed shows one restore row plus one primary-assignment row.
- W4 (logs). A failed complete read on a pure READ (the GET and the two
  contact-list responses) now logs `readRosterContacts`' own WARN
  `property contact: roster liveness read failed - liveness unknown` (with
  err) before the best-effort fallback - "liveness" wording on a page view.
  Read count: on success the GET and each contact-list response still make
  ONE contacts batch read (now `requireComplete`, and now including an
  off-roster `landlordId`); on a failed read they make a second, best-effort
  one.
- W5 (reads). A tour with a usable, future time whose intro falls back for a
  PROPERTY reason now reads org settings (to decide `lookup_failed`); before,
  the resolver returned naked without that read. By design (D3), only on
  degraded tours, job and preview.
- W6 (for S4). `heirIfPrimaryRemoved: null` has two meanings - nobody would
  take over, OR no row is flagged at all. S4's 7.3 notice uses the block only
  when removing the FLAGGED row, so the second meaning is never shown there.
- W7. A degenerate roster row whose `contactId` is `''` serves `deleted:
  true` on a complete read (no record) and is no P1 candidate; before, it
  served un-enriched. No such row is written by any current path.
- W8. The extra smoke run rebuilt the gitignored `app/dist/`.

## 7. Cycle safety (ruling R3)

No module in the `lib/propertyContact.ts <-> repos/unitsRepo.ts` cycle was
edited. `routes/units.ts` gained the VALUE imports `decidePropertyContact`
and `rosterContactIds` (both read only inside function bodies:
`propertyContactBlockOf`, `enrichRosterView`); `jobs/relayFanOut.ts` and
`services/rosterEdits.ts` gained TYPE-only imports (`PropertyContactResult`,
`IntroFallback`), erased at runtime. The new top-level constants in
relayFanOut.ts (`INTRO_FALLBACK_ORDER`, `NOBODY_REASON`) are literals that
read no imported binding. `npm run smoke` resolves every compiled import
(section 8).

## 8. S3.7 slice gate (bare, output under `.superpowers/sdd/`, real exit codes)

1. `env | grep '^AWS_'` -> nothing printed, `EXIT:1`. Log
   `S3-gate-aws-env.log`.
2. `cd W:/tmp/primary-contact-integrity && npm run typecheck` -> `EXIT:0`;
   0 `error TS` lines; all five workspaces ran (app: src, scripts and tests;
   dashboard; e2e; fake-twilio; fake-twilio-web). Log `S3-gate-typecheck.log`.
3. `cd app && npx vitest run` on the plan's 20 files (they include all 10
   files this slice created or edited) -> `EXIT:0`;
   `Test Files  20 passed (20)`, `Tests  712 passed (712)`; 0
   `[dynamoAdmin]` lines; 0 SKIPPED lines. Per file: relayIntroFallback 31,
   relayIntroFallbackJob 6, rosterPreviewIntroFallback 4, relayFanOut 152,
   rosterEdits 22, relayGroupPreview 13, relayProvisioning 10,
   devRelayReplay 7, relayQueuedMessages 4, toursApi 232, placementsApi 58,
   unitsApiActivity 14, unitsApiPropertyContact 13,
   unitsApiPropertyContactWrites 7, unitsApiRoster 25,
   unitsApiRosterAutoPrimary 19, unitsApiRosterTypeChecks 23,
   unitsRestoreLandlord 33, unitsApi 29, contactsBatchReads 10. Log
   `S3-gate-vitest.log`.
4. Whole app workspace (plan step 2b): NOT RUN (brief; D2).
5. `npx eslint` on the plan's 13 paths -> `EXIT:0`, empty output (log
   `S3-gate-eslint.log`). No baseline comparison needed.
6. ASCII: `git diff main...HEAD -- <the three S3 sources> app/test | grep -nP
   '^\+.*[^\x00-\x7F]' || echo ascii-clean` -> `ascii-clean`; the same over
   `7cb3ff03..HEAD` (all paths) -> clean. Log `S3-gate-ascii.log`.

Extra evidence (not gate steps):

- 33 neighbor files on the same surfaces (every other app test that hits
  `/api/units/`, `preview-open`, the relay intro job or the resolver, plus
  the S1/S2 lookup, heir and hand-off files): inboundMessagePush 23,
  listingSendsApi 18, mmsMedia 13, personEvents 3, placementsRelay 23,
  placementsVoiceRouting 11, relayApi 59, relayIntroPropertyContact 4,
  relayOwner.integration 13, relayWebhook 27, rosterActionsPoll 29,
  transitionRoutes 25, unitsApiOrgNames 14, unitsApiPhotos 50,
  unitsApiPlacements 4, unitsApiPrimaryOnAdd 17, unitsApiPrimaryOnRemove 7,
  unitsApiSimilar 4, unitsLandlordOfRecord 21, unitsRestorePrimaryHandoff
  11, unitsSoftDelete 4, tourContacts 15, tourRemindersApi 69,
  contactTimeline 65, contactDeletePrimaryHandoff 9,
  primaryHandoffParity.integration 9, propertyContact 10,
  propertyContactLookup 18, propertyContactHeir 17, rosterResolution 34,
  activityEventsRepo.integration 5, suggestionReclassification.integration
  7, seedHistory 40 -> `EXIT:0`, `Test Files  33 passed (33)`,
  `Tests  678 passed (678)`; 0 `[dynamoAdmin]` lines (two `media seed
  SKIPPED - no MEDIA_BUCKET configured` lines are the seed's MinIO notice,
  not a skipped test). Log `S3-extra-neighbors.log`.
- `npm run smoke` -> `EXIT:0`, `smoke-dist: OK - 1676 import specifier(s)
  across 291 emitted file(s) resolve under plain Node.` Log
  `S3-extra-smoke.log`.

`git status` after the gate: clean on `feat/primary-contact-integrity`, six
S3 commits on top of 7cb3ff03 (this report is the seventh).

Next step: slice S4 (plan line 14029), starting with its contract issue and
decisions; it renders the contracts in section 4 above.
