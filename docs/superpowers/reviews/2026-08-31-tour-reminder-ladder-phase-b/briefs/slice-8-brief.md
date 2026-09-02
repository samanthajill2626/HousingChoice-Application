# Slice 8 - Task 14 (relay resolver, owner-routed intros, member_added per-recipient split, preview parity, e2e)

Common brief (READ FIRST): `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\implementer-brief-common.md`
Report path: `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\reports\slice-8.md`
Research: report C in FULL (sections 3-7: job handlers, `addedMemberKey`, importers,
`rosterEdits` builders + the FIVE production call sites and how each constructs deps,
`sendRelayAnnouncement` roster loop + persist semantics, owner/repo/helper contracts, the
complete TRIPWIRE inventory with the T14 column). Read `.superpowers/sdd/reports/slice-7.md`
first: Task 13 shipped `composeNameList`, `joinedName` (unwired), the five catalog entries,
and a module-private `legacyConnectionSentence` that keeps `composeMemberAddedBody`
byte-identical - THIS slice deletes `legacyConnectionSentence` AND `ANONYMOUS_JOINED_LABEL`.

Scope: plan Task 14 steps 1-8 (its step 8 includes the FULL app suite; the orchestrator runs
the FULL e2e after you return - you do NOT run Playwright; every e2e file you touch must
compile: `cd .../e2e && npx tsc --noEmit -p .`). One commit at the end, or two if you prefer
(app + e2e) - both green.

Binding deltas (worklist s0, s1 R9, R10, R11; s2 T14; spec 9.0-9.6):
- `ToursRepo` getter is `get(tourId)` -> `Pick<ToursRepo,'get'>`; `PlacementsRepo.getById`,
  `UnitsRepo.getById`, `ContactsRepo.getById`, `SettingsRepo.getOrgSettings`.
- Resolver signature per the plan's Interfaces block (owner `{type,id} | {type:null}`, deps,
  optional `addedContactId`), EVERY read in its own try/catch degrading toward `variant:'naked'`;
  never throws; `formatLocalDate`/`formatLocalTime` THROW on unparseable -> inside the try.
  `TourItem.scheduledAt` is OPTIONAL (absent on requested tours -> naked). "Today" judged in
  `resolveQuietHoursTimezone(settings)` (same-day test in the org zone; a settings read
  failure -> naked, or default zone - choose, state it). `{where}` via `formatStreet(unit.address)`;
  empty street -> naked (spec 9.5). Names via `resolveTourContactNames({ tenantId, unit, contactsRepo })`
  (reuse; `propertyContactFirstName` absent -> naked; `tenantFirstName` absent -> 'there' fallback
  in-sentence, keeps the variant). Role table (spec 9.4): `pm` -> `property manager`;
  `landlord`/`owner` -> `landlord`; the owner's `tenantId` -> `tenant`; `other`/none -> no role ->
  `relay.member_added` (no-role entry). Role source is `unitContacts(unit)` roles, NOT
  `ContactItem.type`.
- `composeIntroBody(inputs, memberNames)` selects the entry from `inputs.variant`; TOTALITY:
  `tenantFirstName: inputs.tenantFirstName ?? 'there'` - test that a tour variant with no tenant
  name yields "Hey there! ..." and does not throw. `composeMemberAddedGroupBody(inputs, newMemberName)`
  -> `relay.member_added_role` when `inputs.role` is set, else `relay.member_added`; `{name}` via
  `joinedName`. NOW rewrite `relay.member_added` to `Hey, adding {name} to the group.` with
  `vars: ['name']` and the DATED 2026-07-14 reversal docblock (spec 9.4) - this is the ONE
  time it changes. Switch `resolve.test.ts`'s Task-1 probe to `relay.member_added_role`
  (`{ name, role }`) and update its comment. Delete `legacyConnectionSentence`,
  `ANONYMOUS_JOINED_LABEL`, and the old `composeMemberAddedBody`.
- Intro job: precedence 1 (operator `intro_body`) verbatim FIRST, then `getOwner(conversation)`
  -> resolver -> `composeIntroBody(inputs, roster.map(m => m.name))`. Lazy deps `units ??=`,
  `tours ??=`, `placements ??=`, `settings ??=` in the registrar closure (mirror the existing
  `??=` pattern; extend `RelayFanOutJobDeps` with optional picks so tests can inject fakes).
- Member-added job: `addedMemberKey` is `relayMemberKey(member)` (contactId, else `phone#E164`),
  NOT a contactId -> `addedContactId = roster.find(m => relayMemberKey(m) === payload.addedMemberKey)?.contactId`.
  Group body via `composeMemberAddedGroupBody`; new-member body = `composeIntroBody({...inputs,
  variant:'naked'}, postAddRoster names)`. `sendRelayAnnouncement({ body: NEW MEMBER's body
  (persisted, spec 9.6), bodyFor: (m) => relayMemberKey(m) === payload.addedMemberKey ? newMemberBody : groupBody })`.
- `sendRelayAnnouncement`: optional `bodyFor?: (member: ConversationParticipant) => string` on
  `RelayAnnouncementInput` with spec 9.6's docblock (NAMED, DATED exception to the 2026-07-14
  visibility rule; one row; persisted body = `body`; per-LEG override only; identical in
  `persist:false`). In the roster loop `const legBody = input.bodyFor?.(member) ?? body;` feeds
  ONLY `adapter.sendMessage`; persistence, `touchLastActivity`, slots keep `body`. Test in
  `relayAnnouncements.test.ts`: omitting `bodyFor` sends `body` to every member (byte-identical
  default) and with `bodyFor` each leg gets its own body while the row keeps `body`.
- Preview parity (spec 9.0/9.3): `buildOpenPreview` derives `{type: owner.type, id: owner.id}`
  from its `RosterOwner`, calls the resolver, passes `inputs` through `OpenPreviewParts` to
  `buildOpenPreviewFromParts` -> `composeIntroBody(inputs, ...)`. `buildStandaloneOpenPreview`
  takes the null-owner path -> naked, BYTE-IDENTICAL to today (its pins are re-VERIFIED, not
  moved). `buildAddPreview`: resolver(owner, candidate.contactId) -> preview body =
  `composeMemberAddedGroupBody(...)` (the GROUP body - spec 9.0 ruling); amend its docblock (new
  member receives the naked intro, defined at the member-added handler). R11: extend
  `RosterResolutionDeps` with OPTIONAL `tours?`, `placements?`, `settings?` picks (like
  `actions?`); absence -> naked. `rosterEdits.test.ts` hand-builds deps ~25x - it must stay
  green without them. WIRE the picks in all FIVE production sites: `routes/tours.ts` (`rosterDeps`
  ~`:520` - used by preview-open ~`:936` and preview-add ~`:967`), `routes/placements.ts`
  (`rosterDeps` ~`:923-931` - ~`:1262`, ~`:1292`), `routes/relayGroups.ts ~:372` (standalone,
  no owner - nothing to wire; verify). The toursApi/placementsApi parity pins go through the
  REAL routes and are what prove the wiring.
- Re-baseline EVERY pin (spec 10a.2 floor + report C s7a additions): `relayFanOut.test.ts
  :630-662,703-716,648` (`:648` now asserts row body !== an existing member's leg body and ===
  the new member's leg), `toursApi.test.ts:3813,3989-3998,4096,4133-4135`, `placementsApi.test.ts
  :989,1007`, `relayApi.test.ts:296` (verify UNCHANGED), `:1046` (existing member's leg =
  `Hey, adding Bob to the group.`), `:1052` (persisted row = Bob's NAKED intro),
  `relayGroupPreview.test.ts:151,208` (verify UNCHANGED), `rosterEdits.test.ts:488-495`,
  `rosterActionsPoll.test.ts:297-315` (check needles). New parity pins SPLIT PER MESSAGE (plan
  review P13): INTRO preview body === the intro job's body for the same owner/roster;
  MEMBER_ADDED preview body === the job's GROUP leg body AND the persisted row body === the job's
  NEW-MEMBER leg body. Resolver + composer unit tests per plan step 1 (every fallback row,
  today/other-day, role table, throwing reads).
- E2E (plan step 7 + R9/R10): `steps.ts` `teamOpensTourGroup` (~`:1887`) and `expectGroupIntros`
  (~`:1923-1952`) parameterized by expected variant - tour-owned groups (ALL current callers:
  `tours.spec.ts:111-112,189-190,385-386`, `approval-and-move-in.spec.ts:118`,
  `post-tour-application.spec.ts:99`, `relay-number-lifecycle.spec.ts:283`) assert Sam's tour
  wording (`Putting you in a group text with` + first names); placement-owned (grep callers)
  assert `Excited to have you move into`; naked keeps `/You're now connected with/`. NOTE: a
  tour relay opened for a tour TODAY in org-local composes `relay.intro_tour_today` - specs
  use `tourSchedule()` (+48h) so `relay.intro_tour`; assert on text common to both variants
  where a fixture could straddle midnight, or assert the exact variant only where the date is
  fixed. `tour-roster.spec.ts:237-282`: rewrite wholly to resolved-copy assertions (starts
  with `Hey <tenant first name>!`, contains the street and `Putting you in a group text with`);
  the split trick lives ONLY in `contact-create-relay-group.spec.ts` (standalone/naked).
  `e2e/tests/dashboard-next/relay-group-view.spec.ts:161,172`: the dashboard THREAD bubble is
  the NEW MEMBER's NAKED intro (R9) - retarget `:161` to naked copy with Leon's first name in
  the list, `:172` (nameless joiner, the ONLY such coverage) to the naked intro's count phrase;
  NEVER delete `:172`. `roster-quiet-hours.spec.ts:485-486`: the EXISTING member (tenant)
  gets `Hey, adding <PM first> to the group as the <role>.`, the NEW member (pm) gets the naked
  intro - two different needles. Add ONE new e2e scenario (extend `tour-roster.spec.ts` or a new
  spec under `e2e/tests/`): open a tour relay -> every member's fake thread gets the tour intro
  with resolved names; add a member -> new member's thread carries the naked intro, existing
  members carry `Hey, adding <name> to the group as the landlord.` (or the role the fixture
  yields - derive it), dashboard thread shows ONE bubble whose body is the NEW member's,
  preview-add showed the GROUP body. Use accessibility-first selectors and the existing fake-
  phone helpers (`expectSentTo`, outbox readers in steps.ts).
- Dashboard prose mentions (report C s7c) - re-word only if they now mislead; no dashboard
  code change is owed.

Verify: `cd .../app && npx vitest run test/relayFanOut.test.ts test/toursApi.test.ts
test/placementsApi.test.ts test/relayGroupPreview.test.ts test/relayApi.test.ts test/messages/
test/rosterEdits.test.ts test/relayAnnouncements.test.ts test/rosterActionsPoll.test.ts`, then the
FULL app suite (timeout 600000) - PASS; `npm run typecheck` (root); `cd .../e2e && npx tsc --noEmit -p .`;
`npx eslint <touched ts>` with baseline attribution; `grep -rn "ANONYMOUS_JOINED_LABEL\|legacyConnectionSentence\|composeMemberAddedBody\b" app dashboard e2e` -> zero hits. Commit:
`feat(relay): owner-routed intros and per-recipient member_added`. In your report list every
e2e assertion changed with a one-line derivation - the orchestrator's full e2e is their first
pass/fail signal.
