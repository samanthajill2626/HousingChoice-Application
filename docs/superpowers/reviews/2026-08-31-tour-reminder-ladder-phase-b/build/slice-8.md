# Slice 8 report - Task 14 (relay resolver, owner-routed intros, member_added split, preview parity, e2e)

Branch `feat/tour-reminder-ladder-phase-b`, worktree `W:\tmp\tour-reminder-ladder-phase-b`.
Base at slice start: `642b8755`. ONE commit: **`66229715`**
`feat(relay): owner-routed intros and per-recipient member_added` (23 files, +1770/-200).

## Status: SHIPPED, all eight plan steps. No skips. Three reported divergences (section 5), one of them large and e2e-shaped - READ 5.1 BEFORE THE E2E RUN.

---

## 1. What shipped

### `app/src/jobs/relayFanOut.ts`
- `RelayComposeInputs` (variant + tenantFirstName/propertyContactFirstName/where/when/time/role)
  and `RelayComposeDeps` (all repo picks OPTIONAL, plus `nowIso` and `logger`).
- `resolveRelayComposeInputs(owner, deps, addedContactId?)`. `ToursRepo.get`,
  `PlacementsRepo.getById`, `UnitsRepo.getById`, `SettingsRepo.getOrgSettings`,
  names via `resolveTourContactNames`. Owner read / unit read / names / settings /
  time-formatting each in their OWN try/catch, every failure degrading to
  `variant:'naked'`. Never throws. Null owner returns naked WITHOUT reading anything
  (pinned by a counter in the test).
- **`role` is resolved independently of the variant** - a group whose intro degraded
  for want of a street still knows who joined. Pinned by its own test.
- "Today" = `localDateOf(now, tz) === localDateOf(scheduledAt, tz)` in
  `resolveQuietHoursTimezone(settings)` - literally the seam `tourReminders.ts:467`
  uses for the booked-too-late same-day test, so the two cannot disagree.
- `composeIntroBody(inputs, memberNames)` selects the entry; `tenantFirstName ?? 'there'`;
  a variant missing its OWN tokens falls back to the naked entry rather than throwing
  (9.5's last line of defence, tested).
- `composeMemberAddedGroupBody(inputs, newMemberName)` -> `relay.member_added_role`
  when `inputs.role` is set, else `relay.member_added`; `{name}` via `joinedName`.
- Both handlers rewired. Intro: precedence 1 verbatim FIRST (and the four owner reads
  are then not made at all). Member-added: `addedContactId` derived from the roster row
  matching `relayMemberKey(m) === payload.addedMemberKey` (NOT the key itself),
  `bodyFor` splitting the legs, `body` = the new member's.
- **DELETED: `legacyConnectionSentence`, `ANONYMOUS_JOINED_LABEL`, `composeMemberAddedBody`.**
  Grep for all three across `app dashboard e2e`: zero code hits (two comment mentions
  remain, both dated historical records of removed copy).

### Other source
- `catalog.ts`: `relay.member_added` -> `'Hey, adding {name} to the group.'`,
  `vars:['name']`, with the DATED 2026-07-14 reversal docblock and the superseded
  wording preserved for reference. The `relay.member_added_role` comment's
  "wired in Task 14" paragraph replaced with the role-source rule.
- `relayAnnouncements.ts`: optional `bodyFor?: (member) => string` with spec 9.6's
  named/dated docblock; `const legBody = input.bodyFor?.(member) ?? body;` feeds ONLY
  `adapter.sendMessage`. Persistence, `touchLastActivity` and the slots keep `body`.
- `rosterResolution.ts`: `RosterResolutionDeps` gains OPTIONAL `tours` / `placements` /
  `settings` picks (R11).
- `rosterEdits.ts`: `OpenPreviewParts.inputs?` (absent -> naked, which is what keeps
  the ~25 hand-built parts/deps objects in `rosterEdits.test.ts` valid);
  `buildOpenPreview` and `buildAddPreview` call the resolver through a small
  `composeDepsOf(deps, quiet)` helper that passes `quiet.nowIso` as the resolver's
  clock (so a pinned-clock route previews a deterministic variant);
  `buildAddPreview` now composes the GROUP body and its docblock says where the new
  member's body is defined. `buildStandaloneOpenPreview` is untouched -> naked.
- Routes: `tours.ts` `rosterDeps` gains `tours` + `settings`; `placements.ts` gains
  `tours` + `placements` + `settings`. `relayGroups.ts` verified: standalone, no owner,
  nothing to wire.
- Dashboard: two PROSE blocks re-worded because they now actively mislead
  (`api/types.ts` RosterPreview docblock and `RosterConfirmDialog.tsx` header both said
  the previewed body is what the group receives, full stop). Comment-only. No dashboard
  code change; `npx vitest run src/routes/shared` = 111 passed.

## 2. Tests (TDD - red first)

RED run before any source edit: `npx vitest run test/relayFanOut.test.ts` -> exit 1,
**17 failed / 41 passed**, every failure "resolveRelayComposeInputs /
composeMemberAddedGroupBody is not a function".

New coverage:
- resolver: today/other-day/placement/null-owner; the "today is judged in the ORG zone
  not UTC" case (22:00 Sep 7 New York while UTC says Sep 8); a TEN-row table of
  degradations (missing tour row, no scheduledAt, no unit, no street, no property
  contact, tour read throws, unit read throws, settings read throws, unparseable
  scheduledAt, NO repos wired at all) each asserting `variant === 'naked'` and no throw;
  tenant-name absence keeping the variant; the full role table incl. the owning
  tenant, `other`, a stranger, and a phone-only member; role-survives-naked.
- composers: entry routing per variant (byte-exact founder copy), the naked body, the
  "Hey there!" totality case, the missing-token fallback, and the group body's
  role/no-role/nameless/no-STOP rows.
- a whole new job describe (`relay.intro / relay.memberAdded on an OWNED group`) with
  its own world: tour-owned intro sends Sam's dated tour copy to every member and
  persists it; an operator-edited body still wins over the routing; the SAME group with
  `scheduledAt` removed falls back to naked; member_added on it carries "as the property
  manager" to the group and the naked intro to the joiner, with ONE row = the joiner's
  leg; the tenant joining reads "as the tenant".
- `relayAnnouncements.test.ts`: `bodyFor` OMITTED is byte-identical (both legs get
  `body`, row matches); supplied, each leg differs while the row keeps `body` and the
  inbox preview inherits it; and it still drives legs in `persist:false` mode.

Re-baselined pins (every one from the brief's floor plus report C s7a):
`relayFanOut.test.ts` composer block + `:642-648` (row body now `!==` an existing
member's leg and `===` the new member's) + the raced-remove case;
`toursApi.test.ts` live-add (now a full parity pin), preview-open, opted-out
preview-open, preview-add; `placementsApi.test.ts` preview-open + preview-add;
`relayApi.test.ts:1046,1052` (Alice's leg = the group line, the row = Bob's naked
intro, and the group line is asserted ABSENT from the rows);
`relayApi.test.ts:296` and `relayGroupPreview.test.ts:151,208` re-verified UNCHANGED;
`rosterEdits.test.ts` and `rosterActionsPoll.test.ts` green untouched (no body needles);
`resolve.test.ts`'s four probes switched to `relay.member_added_role` `{name, role}`
with the comment rewritten; `catalog.test.ts` gains the `relay.member_added`
vars+default pin.

**New parity pins are SPLIT PER MESSAGE (P13).** INTRO: `toursApi` / `placementsApi`
preview-open body `===` `composeIntroBody(await resolveRelayComposeInputs(...))` for the
same owner/roster, PLUS a resolved-copy assertion ("Putting you in a group text with Pat
to tour 318 Marietta St") that cannot pass vacuously. MEMBER_ADDED: `toursApi`'s live-add
captures the REAL preview-add body first, then asserts preview === each existing
member's leg AND the persisted row === the new member's leg.

## 3. Verification

| command | exit | result |
|---|---|---|
| `npx vitest run test/relayFanOut.test.ts` (RED, pre-implementation) | 1 | 17 failed / 41 passed (58) |
| `npx vitest run test/relayFanOut.test.ts test/toursApi.test.ts test/placementsApi.test.ts test/relayGroupPreview.test.ts test/relayApi.test.ts test/messages/ test/rosterEdits.test.ts test/relayAnnouncements.test.ts test/rosterActionsPoll.test.ts` | **0** | **10 files, 463 passed** |
| `npx vitest run` (FULL app suite) | **0** | **347 files passed, 1 skipped; 6387 passed, 9 skipped** |
| `npm run typecheck` (root) | **0** | clean |
| `npm run smoke` | **0** | 1365 specifiers / 239 files resolve under plain Node |
| `cd e2e && npx tsc --noEmit -p .` | **0** | clean |
| `cd dashboard && npx vitest run src/routes/shared` | **0** | 111 passed |
| `npx eslint <23 touched files>` | 1 | **3 errors, ALL PRE-EXISTING** (below) |
| grep `ANONYMOUS_JOINED_LABEL\|legacyConnectionSentence\|composeMemberAddedBody\b` | - | zero code hits |
| ASCII on every ADDED diff line | - | 0 non-ASCII |

Lint attribution against the merge base (`ec32170a`), by symbol usage, not line number:
- `routes/placements.ts:165` `nameFromContact` unused - base has the identical single
  occurrence (the import). PRE-EXISTING.
- `routes/tours.ts:57` `TourOutcome` unused - base has the identical three occurrences
  (`isTourOutcome` import, `type TourOutcome` import, one `isTourOutcome` call).
  PRE-EXISTING.
- `RosterConfirmDialog.tsx:113` `react-hooks/set-state-in-effect` - the same
  `setDraft(preview.body)` sits at base `:109`; my four added comment lines moved it.
  PRE-EXISTING.

`git status` read bare before the commit (exactly the 23 expected paths, no
`.git/MERGE_HEAD`); paths staged explicitly, never `git add -A`.

## 4. Every e2e assertion changed, with its one-line derivation

The orchestrator's full e2e is the first pass/fail signal for all of these.

| file:where | change | derivation |
|---|---|---|
| `scenarios/steps.ts` `teamOpensTourGroup` | takes `variant: RelayIntroVariant = 'naked'`; the thread assertion is `INTRO_NEEDLE[variant]` | all six callers open on a TIMELESS tour -> naked (see 5.1); behaviour for them is UNCHANGED |
| `scenarios/steps.ts` `expectGroupIntros` | takes the same optional variant; needle parameterized, names logic unchanged | ditto; the docblock now says to pass only the people the chosen variant NAMES |
| `scenarios/steps.ts` new `INTRO_NEEDLE` map | tour needle is `Putting you in a group text with` - text common to BOTH tour forms | the today form says "at {time}", the dated one "on {when}"; a fixture straddling midnight still matches |
| `tests/dashboard-next/relay-group-view.spec.ts` (was `:161`) | thread bubble -> `/You're now connected with Diana, Gloria, and Leon/`; NEW outbox assertion that Diana got exactly `Hey, adding Leon to the group.` | R9 + 9.6: the one row is the NEW member's naked intro; post-add roster is Diana+Gloria+Leon. Leon (`contact-live-tenant-b`) is neither the tour's tenant (that is Diana) nor on `unit-live-b`'s roster (landlordId Gloria only) -> NO role -> the no-role entry |
| `tests/dashboard-next/relay-group-view.spec.ts` (was `:172`) | nameless-joiner assertion MOVED to Diana's outbox (`Hey, adding a new member to the group.`) and a `toHaveCount(2)` on the naked bubbles | **R9's "retarget :172 to the count phrase" is not derivable**: three of the four members ARE named after the raw-phone add, so the persisted body lists them and says nothing about the joiner. The namelessness is only observable on the group leg. Coverage PRESERVED, never deleted; the test now also takes the `request` fixture |
| `tests/roster-quiet-hours.spec.ts:485` | `Hey, adding <pm.firstName> to the group as the property manager.` | tenant is an EXISTING member; the PM is rostered on the property with `role:'pm'` and the group is tour-owned -> 9.4's table |
| `tests/roster-quiet-hours.spec.ts:486` | `You're now connected with` | the PM is the NEW member -> the naked intro |
| `tests/tour-roster.spec.ts:237-282` | KEPT as the `{names}` split trick; added the derivation comment + fixed a stale `editable: true` claim | see 5.1 - that block previews a TIMELESS tour, so 9.5 routes it to `relay.intro` and the trick is still valid there |
| `tests/relay-intro-variants.spec.ts` (NEW) | the whole owner-routed walk | below |

The new spec books the tour (+48h, so never "today") BEFORE opening, and asserts:
preview-open is the tour variant (`Hey <tenant>!` + `Putting you in a group text with
<owner>` + the unit's street, and the PM's name ABSENT); every member's fake thread
received a body BYTE-EQUAL to that preview; the dashboard thread shows it; preview-add
for the PM is exactly `Hey, adding <pm> to the group as the property manager.`; the live
add sends that same line to both existing members, the naked post-add intro to the PM
(and neither the group line nor any tour copy to the PM); and the thread ends with the
new member's bubble and ZERO occurrences of the group line.

## 5. Divergences - all deliberate, all reported

### 5.1 THE BIG ONE: no existing e2e caller opens a relay on a SCHEDULED tour, so the shared steps stay NAKED.

The brief (and report C s7b) says `steps.ts:1887` / `expectGroupIntros` break for all six
callers because tour-owned groups now compose the tour intro. **They do not.** Every one
of the six calls `teamCreatesTourFromInterest` - whose own step label is "(no time yet)",
creating a TIMELESS `requested` tour - and books AFTERWARDS
(`tours.spec.ts:113,195,414`, `approval-and-move-in.spec.ts:118`,
`post-tour-application.spec.ts:99`, `relay-number-lifecycle.spec.ts:283`; in each, the
`teamBooksTour` call is BELOW the open). `TourItem.scheduledAt` is optional and spec 9.5
routes its absence to the naked intro, so those groups compose exactly what they
composed before.

Same finding for `tour-roster.spec.ts:237-282`, which drift flag D4 says "cannot keep the
split": its `createTour` helper is documented "Timeless ('requested')", so the preview is
the naked entry and the `{names}` split trick remains correct there. I KEPT it (trusting
the FILE over the plan) rather than converting it to resolved tour copy, and wrote the
dependency into the comment so a future booking of that tour is a loud, explained change
rather than a mystery failure.

Consequences the orchestrator should weigh:
- the helpers are parameterized as the brief requires, but every existing caller passes
  the default `'naked'`; the tour variant's e2e coverage lives entirely in the new
  `relay-intro-variants.spec.ts`. If the mission wants an existing scenario to exercise
  it too, the one-line change is to move a `teamBooksTour` above its `teamOpensTourGroup`.
- **this is also a product observation, not just a test one**: today's demoed flow opens
  the group before the time is agreed (the negotiation happens IN the group), so in
  practice Sam's tour intro will only fire for relays opened after booking. Worth a
  founder line in the handback.

### 5.2 `RelayComposeDeps` fields are OPTIONAL (the plan declares them required).
R11 makes the preview picks optional and "absence -> naked"; the resolver is the only
thing that can honour that, so its own deps carry the optionality. The job wires all
four. Also added `nowIso` (not in the plan): the previews pass `quiet.nowIso`, which is
the routes' injected clock, so a pinned-clock test gets a deterministic variant instead
of reading the wall clock.

### 5.3 Settings-read failure degrades the TOUR variants to naked (the brief asked me to choose and state it).
`{time}` / `{when}` are FACTS in a tenant's SMS and a wrong-zone "3:00 PM" is worse copy
than the naked intro; `getOrgSettings()` already answers with defaults when no row
exists, so a throw there is a genuine read failure, not an unconfigured org. The
placement variant reads no settings at all.

## 6. Open worries - not blocking, your eye

1. **The intro/member-added jobs now do up to four repo reads on an OWNED group.**
   Three unit suites had to have the four repos INJECTED (`toursApi` x2 describes,
   `placementsApi`, `placementsRelay`) - and `placementsRelay.test.ts` is the instructive
   one: it has NO `queueAdapter.settle()`, so once the handler awaited real network I/O
   the in-process intro stopped landing inside the provisioning request and `world.sent`
   came back empty with the job still logging "job succeeded". Nothing in production
   depends on that timing (the worker runs the job), but it is exactly the shape that
   would make a future test flake.
2. **Repo CONSTRUCTION is now wrapped in its own try/catch** in the handler closure,
   degrading to naked with a WARN. Without it an unbuildable repo would throw AFTER the
   idempotency marker and LOSE the announcement - the failure mode 9.4/9.5 exist to
   prevent. Production's `registerHandlers.ts` passes no repos at all, so this path is
   the live one; the smoke gate proves the imports resolve, and e2e exercises it for real.
3. **`toursApi` / `placementsApi` fixtures gained a unit ADDRESS** (`unit-abc`,
   `unit-r`) and their seeded threads gained the `owner` the real provision stamps.
   Without both, every preview pin in those files would have passed whether or not the
   routes wired the resolver - i.e. the wiring proof needed the fixtures to be realistic.
   Both changes are scoped to the roster-editing describes' `beforeEach`.
4. **`routes/dev.ts:965` replay-intros now replays VARIANT intros** (`persist:false`) for
   seeded tour/placement-owned groups at boot. Nothing asserts on it, so it cannot go
   red - but any spec that greps a seeded fake thread for intro text is now reading
   different copy. The live seed's own relay group is tour-owned
   (`owner: {type:'tour', id: tourTomorrow}`), and that tour HAS a `scheduledAt`, so its
   replayed intro really is the tour variant now.
5. **`relay-group-view.spec.ts` now produces TWO identical naked-intro bubbles** after
   the two adds (the raw-phone joiner adds no name to the list). The assertions use an
   explicit `toHaveCount(2)` rather than `toBeVisible`, which would be a strict-mode
   violation. If a third add is ever added to that walk, the count moves.
6. The `relay.member_added` no-role entry is now reachable in production for any
   standalone group and for any owned group whose joiner is not on the property roster -
   which is the common case for a caseworker. Sam only ever saw the role wording; if she
   dislikes the bare form, that is a copy question for the founder handback.
