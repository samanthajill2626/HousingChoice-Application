# Tour / Placement Contact Rosters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rosters for tours/placements resolve from the property's primary
contact by default, are editable on the People card, compose the group text
and masked calls, and defer system-authored sends through quiet hours.

**Architecture:** PLAN vs FACT (spec D1): a `roster` override on the
tour/placement is the plan, consumed at provision; once a relay thread exists
(any status) its `participants` are the single truth every surface reads. One
shared resolver serves resolution, previews, the card, tabs, and reminders.

**Tech Stack:** Express 5 + DynamoDB (app/), React 19 + Vitest (dashboard/),
Playwright (e2e/). ESM throughout - relative imports end `.js`.

**Spec:** `docs/superpowers/specs/2026-08-04-tour-placement-contact-rosters-design.md`
(v3.1, @97d3c6a0). The spec WINS on any conflict with this plan.

## Global Constraints

- Worktree `w:/tmp/contact-rosters`, branch `feat/contact-rosters`. Never
  move HEAD in the shared checkout; `cd` explicitly in EVERY command.
- Gates per task: `npm run typecheck` + `npm test` (workspace-scoped runs OK
  mid-task; full at task end). Gates run BARE - never piped. e2e ONLY from
  the worktree, at slice ends: `timeout 1500 npm run e2e`.
- Commit discipline: bare `git status` (separate command) before EVERY
  commit; stage explicit paths; commit by explicit pathspec; trailer
  `Co-Authored-By:` naming the authoring model. Commit after every green
  task.
- ASCII-only in all new/edited source, tests, seed strings, labels:
  `tr -d '\11\12\15\40-\176' < FILE | wc -c` must print 0.
- NEVER edit `app/src/lib/seed/lean.ts` (byte-stable e2e world). FULL-profile
  seed changes go in the full seed module only.
- PII: log ids/counts/types only - never phones, names, or message labels.
- Clocks in tests are PINNED (inject `now`); never wall-clock.
- Domain nouns: `unit` in code/data; "property" in landlord/staff copy;
  "home" in tenant copy. Update `documentation/GLOSSARY.md` with any noun
  change (Task 1 does).
- UI: accessibility-first selectors (`getByRole`/`getByLabel`); every new
  surface verified at 360px (spec 6.7).

---

## SLICE 1 - RENAME

### Task 1: `primaryVoice` -> `primaryContact` (mechanical, storage keys included)

**Files:**
- Modify: `app/src/repos/unitsRepo.ts` (33 hits), `app/src/routes/units.ts`
  (11), `app/src/routes/webhooks/voice.ts` (6 + the stale comment at :388),
  `app/src/lib/unitFields.ts` (2), `app/src/routes/placements.ts` (1),
  `app/src/repos/conversationsRepo.ts` (1 comment)
- Modify: `dashboard/src/api/types.ts` (2), `dashboard/src/routes/listing/buildListingFile.ts` (5),
  `dashboard/src/routes/listing/ListingDetail.tsx` (2)
- Modify tests: `app/test/unitsApiRoster.test.ts`, `app/test/unitsRepoRoster.integration.test.ts`,
  `app/test/placementsVoiceRouting.test.ts`, `app/test/helpers/twilioWebhookHarness.ts`,
  `app/test/unitsApi.test.ts`, `app/test/unitFields.test.ts`, `app/test/publicIntake.test.ts`,
  `dashboard/src/routes/listing/buildListingFile.test.ts`, `dashboard/src/routes/listing/ListingDetail.test.tsx`
- Modify: `documentation/GLOSSARY.md`, `README.md` (1 mention)

**Interfaces:**
- Produces: `UnitContact.primaryContact: boolean`; unit scalar
  `primary_contact`; `CannotRemoveLandlordOfRecordError`; API field
  `primaryContact` on POST /api/units/:unitId/contacts; 409 code
  `cannot_remove_landlord_of_record`. Every later task uses THESE names.

Renames (exact, global):
1. `primaryVoice` -> `primaryContact` (TS property + API body field)
2. `primary_voice_contact` -> `primary_contact` (persisted unit scalar)
3. `CannotRemovePrimaryLandlordError` -> `CannotRemoveLandlordOfRecordError`
4. `cannot_remove_primary_landlord` -> `cannot_remove_landlord_of_record`
5. Error message -> `cannot remove the unit's landlord of record; reassign landlordId first`
6. `landlordVoiceOverride` internals: rename ONLY the `primary_voice_contact`
   reads it performs; the block itself dies in Task 6 - do not touch its
   logic here.
7. `voice.ts:388` stale comment: rewrite its `primary_voice_contact` mention
   to `primary_contact` and append: `NOTE (contact-rosters spec 2026-08-04
   section 12): when this path is built it must consult the THREAD roster,
   not the unit scalar.`

- [ ] **Step 1: Sweep and rename.** `rg -l "primaryVoice|primary_voice_contact|CannotRemovePrimaryLandlord|cannot_remove_primary_landlord" --glob '!node_modules' --glob '!docs'` then apply the renames with the Edit tool (`replace_all: true` per file). NEVER PowerShell Get-Content/-replace/Set-Content.
- [ ] **Step 2: Comment pass.** Re-sweep for prose forms: `rg -n "primary voice|voice contact" app dashboard --glob '!node_modules'` - update comments that describe the old meaning to "the property's default contact - group texts and masked calls" (unitsRepo.ts:59-63 docblock, voice.ts M1.10d comment).
- [ ] **Step 3: GLOSSARY.** Add to `documentation/GLOSSARY.md`: `primary contact` (the property-side person we put on group texts and reach by masked call; `UnitContact.primaryContact`, scalar `primary_contact`; at most one per unit) and `landlord of record` (`unit.landlordId`; who owns the unit; immovable from the roster - reassign landlordId first). Note the rename date + old names.
- [ ] **Step 4: Verify zero stragglers.** `rg -n "primaryVoice|primary_voice|CannotRemovePrimaryLandlord|cannot_remove_primary_landlord" app dashboard e2e --glob '!node_modules'` -> ZERO hits (docs/ historical files stay).
- [ ] **Step 5: Gates.** `npm run typecheck` EXIT=0; `npm test` EXIT=0. Dev-DB note: stale `primaryVoice` keys in existing dev items now read as absent (no primary) - deliberate (spec D2); reseed clears.
- [ ] **Step 6: Commit** `refactor(units): rename primaryVoice -> primaryContact (storage keys included)` - explicit pathspec.

---

## SLICE 2 - TABS REFACTOR (mechanical re-plumbing)

### Task 2: id-keyed person channels in `useTourChannels` / `usePlacementChannels`

**Files:**
- Modify: `dashboard/src/routes/tours/useTourChannels.ts`,
  `dashboard/src/routes/tours/TourConversation.tsx` (+ its `.module.css`),
  `dashboard/src/routes/placements/usePlacementChannels.ts`,
  `dashboard/src/routes/placements/PlacementConversation.tsx` (+ css)
- Modify tests: `dashboard/src/routes/tours/TourConversation.test.tsx`,
  `dashboard/src/routes/placements/usePlacementChannels.test.tsx`,
  `dashboard/src/routes/placements/PlacementConversation.test.tsx`

**Interfaces:**
- Consumes: Task 1 names only (no server change in this slice).
- Produces (both hooks, twin shapes):
  ```ts
  export interface PersonChannelInput { contactId: string; label: string }
  export interface PersonChannel { contactId: string; label: string; unread: number }
  export interface TourChannelsState {
    status: 'loading' | 'ready' | 'error';
    group: TourGroupChannel;                 // unchanged
    people: PersonChannel[];                 // replaces tenant/landlord fields
    setGroupConversationId: (conversationId: string) => void;
    markGroupRead: (conversationId: string | null, unread: number) => void;
    markPersonRead: (contactId: string, unread: number) => void;  // key = contactId
  }
  export function useTourChannels(tour: Tour, people: PersonChannelInput[]): TourChannelsState
  ```
  `TourPersonKey` / `PlacementPersonKey` are DELETED. Callers build `people`
  from the SAME ids the page renders today: `[{contactId: tour.tenantId,
  label: tenantName}, ...(landlordId ? [{contactId: landlordId, label:
  landlordName}] : [])]`. The label is the person's DISPLAY NAME, nothing
  else - never a type-derived role word (the spec deletes those). DO NOT
  consume `resolveTourMembers` or any phone-gated source (spec slice 2: a
  phone-less tenant must keep their tab).

- [ ] **Step 1: Failing test.** In `TourConversation.test.tsx` add:
  ```tsx
  it('renders one 1:1 tab per person input, keyed by contactId', async () => {
    // render with people [{contactId: 'c-t', label: 'Tasha Nguyen'}, {contactId: 'c-l', label: 'Marcus Webb'}]
    expect(await screen.findByRole('tab', { name: /Tasha Nguyen/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Marcus Webb/ })).toBeInTheDocument();
  });
  it('falls back to the Group tab when the active person leaves the people list', async () => {
    // select the second person tab, re-render with that person removed
    // expect the Group tab to be aria-selected
  });
  ```
  Run: `npm test -w dashboard -- TourConversation` -> FAIL (people prop does not exist).
- [ ] **Step 2: Rewrite the hooks.** In `useTourChannels.ts`: replace the
  `tenant`/`landlord` fields with `people: PersonChannel[]`; `sumUnread`
  unchanged, applied per entry:
  ```ts
  people: peopleInputs.map((p) => ({ ...p, unread: sumUnread(summaries, p.contactId) }))
  ```
  `markPersonRead(contactId, unread)`: same falsy-contactId + `unread <= 0`
  guard, local zero by matching `contactId`, then `markInboxRead`. PRESERVE
  VERBATIM: the loading-placeholder `forId` machinery, debounce, the
  markGroupRead contract, and every mark-read guard comment (they encode the
  MF1/M1 regressions). Mirror in `usePlacementChannels.ts` (including its
  `tenantId: ''` placeholder note - an empty contactId input is legal and its
  markPersonRead stays guarded).
- [ ] **Step 3: Rewire consumers.** `TourConversation.tsx`: `tabs` = group +
  one entry per `people[]`; active key type becomes `'group' | string`
  (contactId); when `activeKey` is not `'group'` and not in `people`, treat
  as `'group'` (selection-on-remove rule, spec 6.6). `ContactCommsTab` mount
  keyed by contactId (already is - keep the `key=` prop). Same in
  `PlacementConversation.tsx`.
- [ ] **Step 4: Scrolling rail.** In both `.module.css`: `.tabRail {
  flex-wrap: nowrap; overflow-x: auto; }` plus an overflow edge fade
  (`mask-image: linear-gradient(to right, black calc(100% - 24px),
  transparent)` applied only while scrollable) and a carried unread dot: an
  absolutely-positioned dot at the rail's right edge, rendered when any tab
  whose offsetLeft+width exceeds scrollLeft+clientWidth has unread > 0
  (recompute on scroll + resize via a rAF-throttled handler). Component test:
  narrow container, 5 tabs, off-screen tab with unread -> edge dot visible.
- [ ] **Step 5: Update existing tests mechanically** (`markPersonRead('tenant', ...)`
  call sites become `markPersonRead(contactId, ...)`); the mark-read
  regression tests MUST pass UNCHANGED in behavior.
- [ ] **Step 6: Gates + visual check.** `npm run typecheck`, `npm test`;
  verify with Playwright MCP at 360px + desktop: tour + placement pages look
  IDENTICAL to before (same two tabs, same behavior). Full e2e (slice end).
- [ ] **Step 7: Commit** `refactor(comms): key 1:1 tabs by contactId; one-row scrolling rail`.

---

## SLICE 3 - ROSTER MODEL, RESOLVER, READ-ONLY CARD, D10, D11

### Task 3: shared roster resolver (app lib)

**Files:**
- Create: `app/src/lib/rosterResolution.ts`
- Test: `app/test/rosterResolution.test.ts`

**Interfaces:**
- Consumes: `unitContactsOf` (unitsRepo), `ConversationParticipant`.
- Produces:
  ```ts
  export interface RosterEntry { contactId?: string; phone?: string }  // exactly one set
  export interface RosterOwner {
    type: 'tour' | 'placement';
    id: string;
    tenantId: string;
    unitId: string;
    groupThreadId?: string;      // tours: groupThreadId; placements: group_thread
    roster?: RosterEntry[];      // the plan override
  }
  export type RosterSource = 'participants' | 'plan' | 'default' | 'unavailable';
  export interface ResolvedMember {
    contactId?: string;          // absent for bare-phone participants
    phone?: string;              // participants: the STORED row phone (fact mode)
    name?: string;
  }
  export interface ResolvedRoster { source: RosterSource; members: ResolvedMember[] }

  export async function resolveRoster(
    deps: { conversations: Pick<ConversationsRepo, 'getById'>;
            units: Pick<UnitsRepo, 'getById'>;
            contacts: Pick<ContactsRepo, 'getById'>;
            log: Logger },
    owner: RosterOwner,
  ): Promise<ResolvedRoster>
  export function isOnRoster(r: ResolvedRoster, contactId: string): boolean
  export function rosterEquals(a: ResolvedMember[], b: ResolvedMember[]): boolean
  ```
  Rules (spec D1/D3/5.2): thread pointer present -> read the conversation's
  `participants` (ANY status). WHEN THE POINTER IS SET BUT THE CONVERSATION
  READ FAILS OR RETURNS NOTHING: source `'unavailable'`, members `[]` - NEVER
  fall through to plan/default. By then the plan was consumed, so the
  fallback would be exactly the roster the operator edited away from: the
  card would silently show the wrong people, and the D11 check could text a
  removed tenant on a Dynamo blip. "Never 500 a page" is right; "never be
  wrong about who gets texted" outranks it - callers handle 'unavailable'
  explicitly (card: unavailable state; reminders: leave the rung unclaimed).
  No pointer -> `roster` override verbatim (resolve names/phones from
  contacts at use time); else default = tenant first + the unit roster's
  `primaryContact` row, FALLBACK to `landlordId` when no row is primary,
  de-duped when tenant === property contact. `rosterEquals`:
  order-insensitive set compare - contactId when both have one, else E.164
  phone (spec 5.2 customized equality).

- [ ] **Step 1: Failing tests** (fake repos = plain objects with `getById`
  maps): thread-pointer-wins (participants returned verbatim incl. a
  bare-phone row, source 'participants'); closed-thread still wins; POINTER
  SET + conversation read throws -> source 'unavailable', empty members
  (never plan/default); pointer set + conversation missing -> same; plan
  override in stored order; default happy path (PM marked primaryContact ->
  PM, not landlordId); ZERO-PRIMARY FALLBACK to landlordId; tenant ===
  primary -> one member; missing unit -> tenant only; `rosterEquals`
  order-insensitive + bare-phone compare; `isOnRoster`. Run -> FAIL (module
  missing).
- [ ] **Step 2: Implement** exactly the rules above; every repo read
  try/caught (resolution must never 500 a page).
- [ ] **Step 3: Green + commit** `feat(roster): shared plan/fact roster resolver`.

### Task 4: roster storage + provision consumes the plan + conversion + D8

**Files:**
- Modify: `app/src/repos/toursRepo.ts` (TourItem.roster?, rosterVersion?;
  `setRoster`/`clearRoster` helpers), `app/src/repos/placementsRepo.ts` (same
  on PlacementItem)
- Modify: `app/src/routes/tours.ts` (POST /:tourId/relay), `app/src/routes/placements.ts`
  (relay provision + convert), `app/src/repos/activityEventsRepo.ts`
  (`placement_group_opened` in ActivityEventType)
- Modify: the FULL seed module (NOT lean.ts): add the PM-managed property -
  owner of record + a PM contact rostered with `primaryContact: true`
  (spec 9). Lands HERE, not slice 6, so every later live-QA step (Tasks 8,
  9, 11) exercises the default-is-the-PM case realistically.
- Test: `app/test/toursApi.test.ts`, `app/test/placementsApi.test.ts` (extend)

**Interfaces:**
- Consumes: Task 3 resolver.
- Produces: `TourItem.roster?: RosterEntry[]`, `rosterVersion?: number`;
  repos expose:
  ```ts
  setRoster(id: string, roster: RosterEntry[], expectedVersion: number | undefined): Promise<Item>
    // UpdateCommand SET roster/rosterVersion, ConditionExpression:
    //   expectedVersion === undefined ? 'attribute_not_exists(roster)'
    //                                 : 'rosterVersion = :v'
    // throws RosterPlanConflictError on ConditionalCheckFailedException
  clearRoster(id: string): Promise<void>   // REMOVE roster, rosterVersion
  ```

- [ ] **Step 1: Failing API tests:**
  - open-with-plan: PATCH-free setup writes a plan via repo (`setRoster`),
    POST /:tourId/relay -> provisioned members == plan (names resolved), and
    the tour item afterwards has NO `roster` attribute (consumed).
  - failed provision keeps the plan (fake poolNumbers throws -> roster attr intact).
  - default resolution now follows primaryContact: unit roster [owner, PM(primary)]
    -> members = [tenant, PM]. Zero-primary -> landlordId (existing tests keep passing).
  - convert: tour WITH thread -> placement needs no roster copy (rebind only,
    assert placement has no roster attr and reads participants); tour with
    plan + NO thread -> placement.roster deep-equals the tour's.
  - placements provision records `placement_group_opened` on each
    contactId-bearing provisioned member (mirror the tours roster-pin tests)
    and NOT on an unreachable member (no-phone contact in an explicit plan).
- [ ] **Step 2: Implement.** Both provision routes resolve via
  `resolveRoster` (replacing `resolveTourMembers`'s body and the placements
  inline block - keep the function name and its unresolvable-detail strings
  for phoneless members: a plan/default member with no phone and no contactId
  phone -> excluded from the SMS members; if fewer than 2 SMS-able members
  remain -> existing `400 relay_member_unresolvable`). On provision success:
  `clearRoster` in the same flow, AFTER the thread pointer is set; a crash
  between the two leaves an INERT stale plan (spec D1) - add that comment.
  Placement provision calls `recordRosterMilestone` with
  `type: 'placement_group_opened', label: 'Group text opened'` over the
  PROVISIONED members. Convert copies `roster` only when `groupThreadId` is
  absent and the tour has one.
- [ ] **Step 3: Green; commit** `feat(roster): plan storage, provision consumes plan, conversion inheritance, placement group-open pin`.

### Task 5: GET roster endpoints (card payload)

**Files:**
- Modify: `app/src/routes/tours.ts`, `app/src/routes/placements.ts`
- Test: extend `app/test/toursApi.test.ts` / `app/test/placementsApi.test.ts`

**Interfaces:**
- Produces `GET /api/tours/:tourId/roster` and
  `GET /api/placements/:placementId/roster` ->
  ```ts
  { source: 'participants' | 'plan' | 'default' | 'unavailable',
    members: [{ memberKey: string /* contactId, else `phone:<E164>` - the ONLY
                                     key the client ever sends back */,
                contactId?: string, phoneLast4?: string /* display only - the
                                     FULL phone never leaves the server */,
                name?: string, role: 'tenant' | UnitContact['role'] | 'added' | 'removed_contact',
                reachability: 'reachable' | 'no_phone' | 'opted_out',
                sharesPhoneWithName?: string }],
    customized: boolean,               // rosterEquals(current, default) === false
    defaultPrimaryName?: string,       // for the "property's default is <name>" note
    tenantOnRoster: boolean,           // D11 note driver
    canOpenGroup: boolean,             // >= 2 reachable AND no thread
    threadExists: boolean }
  ```
  Derivation rules: role per spec 5.2 (tenantId match -> 'tenant'; unit
  roster row -> its role; deleted contact -> 'removed_contact'; else
  'added'). Reachability FACT MODE reads the participant row's STORED phone +
  the conversation's opt-out annotations (`relay_opted_out_members` via
  `relayMemberKey`); PLAN/DEFAULT mode reads the contact's current phone +
  contact-level opt-out. Shared numbers: second member with a duplicate
  resolved phone gets `sharesPhoneWithName` = first member's name.

- [ ] **Step 1: Failing tests:** default-source payload (PM primary ->
  customized:false, roles right); plan-source customized:true with
  defaultPrimaryName; participants-source for open AND closed threads;
  'unavailable' when the pointer is set but the conversation read fails
  (members empty, canOpenGroup false); fact-mode reachability uses the
  STORED participant phone (correct the contact's phone after join -> still
  'reachable' via old number, spec 5.2); opted-out member -> 'opted_out';
  tenant removed -> tenantOnRoster:false; canOpenGroup false when 1
  reachable; dangling contactId -> 'removed_contact'; NO full phone anywhere
  in the payload (bare rows carry memberKey + phoneLast4 only).
- [ ] **Step 2: Implement** (one shared serializer in
  `app/src/lib/rosterResolution.ts` - `describeRoster(deps, owner)` - both
  routes call it). PII: response carries names/last4 to the authed client;
  log ids only.
- [ ] **Step 3: Green; commit** `feat(roster): GET roster endpoints for the People card`.

### Task 6: D10 - delete `landlordVoiceOverride`

**Files:**
- Modify: `app/src/routes/webhooks/voice.ts` (delete the block at ~:850-891
  and the per-leg substitution at ~:920; delete the now-unused
  units/placements reads it required)
- Test: `app/test/placementsVoiceRouting.test.ts` (rewrite), voice webhook tests

- [ ] **Step 1: Failing test first:** owner KEPT on roster + unit
  `primary_contact` pointing at the PM -> the dialed `<Number>` for the
  owner's leg is THE OWNER'S OWN participant phone (the retired substitution
  would have swapped it). Removed tenant calls pool number -> `non_member`
  refusal (this is the API-tier home of the spec 9 test - use
  `twilioWebhookHarness`).
- [ ] **Step 2: Delete the block.** The EXISTING masked-bridge tests (callee
  selection, simultaneous ring, four refusal cases, whisper, self-bridge
  guard) must pass UNCHANGED. Tests that asserted the substitution behavior
  are rewritten to assert roster-number dialing (keep their scenario setups).
- [ ] **Step 3: Green; commit** `feat(voice): masked calls dial the thread roster verbatim - retire landlordVoiceOverride`.

### Task 7: D11 - reminder + nudge suppression `tenant_not_on_roster`

**Files:**
- Modify: `app/src/repos/tourRemindersRepo.ts` + `app/src/repos/placementNudgesRepo.ts`
  (add `'tenant_not_on_roster'` to the SkipReason unions),
  `app/src/jobs/tourReminders.ts`, `app/src/jobs/placementNudges.ts`
- Modify: `dashboard` skip-reason label maps (`RemindersPanel.tsx`,
  `DeadlinesNudgesCard.tsx`, `ScheduledCard.tsx`, `api/types.ts` - the maps
  that already label `quiet_hours`/`past_event`): label
  `Tenant not on this tour's roster` (nudges: `...placement's roster`).
- Test: `app/test/tourRemindersPoll.test.ts` (or the existing poll suite),
  placement nudges suite

**Interfaces:**
- Consumes: `resolveRoster` + `isOnRoster` (Task 3).

- [ ] **Step 1: Failing tests:** (a) self_guided rung due, tenant absent from
  plan roster -> claim-skips with `tenant_not_on_roster`, visible row; (b)
  THE FALLBACK DOOR (spec D11): landlord_led rung due, NO usable group,
  tenant absent -> suppressed (routing outcome, not rung kind); (c)
  landlord_led rung due, usable group exists, tenant absent -> SENDS to the
  group (unaffected); (d) re-add tenant, next due rung sends (no re-arm);
  (e) resolver returns 'unavailable' (thread pointer set, conversation read
  failing) -> the rung is LEFT UNCLAIMED for the next poll - neither sent
  nor skipped (a transient blip must never text a possibly-removed tenant,
  Task 3 rule). Placement-nudge twins for tenant-1:1-routed rungs. Pinned
  clocks.
- [ ] **Step 2: Implement.** In the claim path, exactly where the delivery
  target has been resolved to the tenant 1:1 (both the self_guided branch and
  the group-fallback branch), insert the roster check via `resolveRoster` on
  the tour/placement; on absence, `claimSkipRow(row, 'tenant_not_on_roster', ...)`.
  Force-send ("Send now") also refuses with the same reason surfaced (a human
  pressing send on a rung TARGETING a removed tenant gets a refusal naming
  it, mirroring the existing pre-claim refusals).
- [ ] **Step 3: Green; commit** `feat(reminders): suppress tenant-1:1 deliveries when the tenant is off the roster (visible skip)`.

### Task 8: read-only People card (both hubs) + tabs switch source

**Files:**
- Create: `dashboard/src/routes/shared/PeopleCard.tsx` (+ `.module.css`) -
  shared by both hubs (tour + placement render the same card; the Property /
  provenance rows stay in the page below it per spec 6.2)
- Modify: `dashboard/src/api/endpoints.ts` + `types.ts` (`getTourRoster`,
  `getPlacementRoster` typed to Task 5's payload), `dashboard/src/routes/tours/TourDetail.tsx`
  (People card body -> PeopleCard; `people` inputs for useTourChannels now
  come from the roster payload's contactId-bearing members),
  `dashboard/src/routes/placements/PlacementDetail.tsx` (same)
- Test: `dashboard/src/routes/shared/PeopleCard.test.tsx`, update
  `TourDetail`/`PlacementDetail` tests

Card (read mode only in this task - no edit affordance yet): list rows (name
links to contact, role subtle right, NO phones, role wraps under name below
860px); muted reachability rows (`not on the group text - no mobile number` /
`- opted out`); `shares a number with <name> - one message`; removed-contact
rows; an UNAVAILABLE state when `source === 'unavailable'` (`Couldn't load
this roster - retry`; NEVER render the property default in its place - Task 3
rule); customized note + DISABLED reset placeholder when `threadExists`
(`members are on a live group text - add or remove them individually`);
tenant-not-on-roster note (`Tenant is not on this roster - tour reminders are
paused`); caseworker hint whenever the tenant contact's `caseworker` string
is non-empty (`Caseworker on file: <name> - not a contact record`); [Open
group text] disabled with reason when `canOpenGroup` is false
(`Not enough people to open a group text - two reachable members are needed`).
The type-derived `isPm ? 'Property manager' : 'Landlord'` KV is DELETED.

- [ ] **Step 1: Component tests first** (mock roster payloads): each row
  state above has an assertion; 360px wrap behavior via container query test
  where feasible.
- [ ] **Step 2: Build PeopleCard; rewire both hubs.** Tabs: `people` =
  roster members with a contactId that resolves (skip bare-phone +
  removed_contact rows) - card and tabs now share ONE source (spec goal 4).
  Refetch the roster payload on `tour.updated` / `conversation.updated` SSE
  (both pages already subscribe - piggyback their reload paths).
- [ ] **Step 3: Gates + live QA** (hermetic e2e:session lane ONLY - never
  the live :5174/:8080 stack): use Task 4's FULL-profile PM property if the
  lane's reseed supports the full profile; otherwise hand-build the same
  shape via API (PM contact -> roster -> primary). Verify tour page,
  placement page, 360px.
- [ ] **Step 4: Full e2e (slice end)**; fix fallout (TourDetail tests that
  asserted the old People KV shape).
- [ ] **Step 5: Commit** `feat(roster): People card renders the live roster on both hubs; tabs follow it`.

---

## SLICE 4 - PROPERTY ROSTER EDITOR

### Task 9: Contacts card edit mode on the property page

**Files:**
- Modify: `dashboard/src/routes/listing/ListingDetail.tsx` (+ module.css),
  `dashboard/src/api/endpoints.ts` (`addUnitContact(unitId, {contactId, role,
  primaryContact})` -> POST /api/units/:unitId/contacts;
  `removeUnitContact(unitId, contactId)` -> DELETE .../contacts/:contactId)
- Test: `dashboard/src/routes/listing/ListingDetail.test.tsx`

Edit mode (spec 6.1): per-row remove (landlord-of-record row's remove
disabled + reason), per-row `make primary contact`, role selector
(landlord/pm/owner/other), `+ Add contact` (contact search typeahead -
follow the committed-pick pattern from unit-search; then role picker),
`Done` toggles back. Every action persists on click. Removing the CURRENT
primary confirms first naming the promotion: `<landlord name> becomes the
primary contact - calls and new group texts for this property will go to
<them>.` (resolve the promoted name from `landlordId`; when there is no
landlord to promote, the confirm says the property will have NO primary
contact and tours fall back to the landlord of record). 409
`cannot_remove_landlord_of_record` renders inline on the row; any conflict
refetches the unit and the toggled row VISIBLY settles.

- [ ] **Step 1: Component tests first:** add flow (search -> role -> POST
  body `{contactId, role, primaryContact:false}`); make-primary POST
  (idempotent add with `primaryContact:true`); remove-primary confirm names
  the promotion; landlord-of-record remove disabled; 409 path refetches.
- [ ] **Step 2: Build; gates; live QA** (create a PM contact, roster it, make
  it primary, verify the star + `primary_contact` scalar via API).
- [ ] **Step 3: e2e spec** `e2e/tests/property-roster.spec.ts`: seeded
  property -> add PM -> make primary -> tour page People card now shows the
  PM (slice 3 resolution) -> remove PM -> confirm names the owner ->
  card falls back. Full e2e green.
- [ ] **Step 4: Commit** `feat(listing): property Contacts card edit mode (roster + primary contact)`.

---

## SLICE 5 - CARD EDIT MODE + CONFIRMS + CALL-THROUGH

### Task 10: plan endpoints, LIVE call-through endpoints, previews (server)

**Files:**
- Modify: `app/src/routes/tours.ts`, `app/src/routes/placements.ts`
- Create: `app/src/services/relayMembers.ts` - EXTRACT the add-member and
  remove-member bodies from `app/src/routes/relayGroups.ts` (:280-421 add,
  :423-510 remove) into `addMemberToRelay(deps, conversationId, member,
  {announce: boolean})` and `removeMemberFromRelay(deps, conversationId,
  memberKey)` so the relay route AND the new owner endpoints share ONE
  implementation (roster write, opt-out clear, milestone, announcement
  enqueue, conversation.updated emit). The relay route keeps its exact
  behavior; pure extraction.
- Modify: `app/src/jobs/relayFanOut.ts` (verify `composeMemberAddedBody` +
  `composeConnectionSentence` exports - both exist at :171/:216)
- Test: extend the two API suites + a relayGroups regression run

**Interfaces (tours shown; placements mirror under /api/placements/:id/...):**
```
// PLAN (no thread) - 409 thread_exists when the pointer is set:
POST   /api/tours/:tourId/roster/members          { contactId } | { phone }   -> { roster }  // Task 5 payload
DELETE /api/tours/:tourId/roster/members/:memberKey                            -> { roster }
POST   /api/tours/:tourId/roster/reset                                         -> { roster }

// LIVE call-through (thread exists, any status) - 409 no_thread otherwise.
// THIS is where the deferred-add evaluation will live (Task 13): the
// dashboard NEVER calls the raw relay routes for owner-scoped edits, so the
// deferral machinery has exactly one add path to guard. Standalone relay
// groups keep the raw routes and DO NOT defer (out of spec scope - note it
// in the route comment).
POST   /api/tours/:tourId/roster/live-members     { contactId }                -> { roster }
        // open thread: addMemberToRelay + announcement (Task 13 adds the
        //   quiet-hours evaluation + ?force=send_now here)
        // CLOSED thread: silent-and-immediate add, announce:false, NEVER
        //   deferred (spec section 7 carve-out)
DELETE /api/tours/:tourId/roster/live-members/:memberKey                       -> { roster }
        // SERVER locates the participant row by contactId (or bare-phone
        //   key) and removes by THE PHONE STORED ON THAT ROW - the client
        //   never plumbs a phone (payload only carries phoneLast4).
        //   Immediate, never defers, never announces.

// PREVIEWS - server-resolved, owner-only input:
GET    /api/tours/:tourId/roster/preview-open                                  -> preview
        // 409 relay_already_provisioned when the pointer is set - never
        //   preview an open that can only 409.
POST   /api/tours/:tourId/roster/preview-add      { contactId }                -> preview
        // preview = { body, recipients: [{ name?, reachability }], recipientCount,
        //             deferred: boolean, quietEndsAt?: string }
```
Rules: memberKey = contactId, else `phone:<E164>` (URL-encoded) - matching
Task 5's payload field. Plan-endpoint rules: entry validation EXACTLY one of
contactId/phone (400); remove refuses the LAST member (409 `last_member`);
materialize-then-apply per spec: `setRoster` with
`attribute_not_exists(roster)` holding the resolved default, on conflict
re-read and apply onto the existing override with `rosterVersion` guard,
bounded retries then 409 `roster_conflict`; RESET = `clearRoster`. Previews
take NO client roster: resolve server-side via `describeRoster`; `body`
composed via the SAME code the fan-out uses (`resolveMessage('relay.intro',
{members: composeConnectionSentence(...)})` / `composeMemberAddedBody`);
`deferred`/`quietEndsAt` from `isQuietTime`/`clampOutOfQuietHours` +
`resolveQuietHoursTimezone` over org settings (until Slice 6 wires deferral,
`deferred` is still returned so the dialog can render - live-members sends
immediately, and the dialog copy for that interim is `Quiet hours - this
will still send now` behind a flag the Slice 6 task flips; keep the interim
honest).

- [ ] **Step 1: Failing tests:** materialize race (two concurrent first
  edits via injected repos - second conditional write fails, retries onto
  the winner's override, both members present); add/remove/reset round-trip;
  validation 400s; `thread_exists` 409 on plan endpoints / `no_thread` 409
  on live endpoints; last-member 409; LIVE add on an open thread announces
  (outbox) and on a CLOSED thread adds silently; LIVE remove for a member
  whose contact phone was CORRECTED after joining removes the participant
  row anyway (stored-phone rule) and for a bare-phone member via its
  memberKey; relayGroups' own member routes still pass unchanged (extraction
  regression); preview-open 409 when provisioned; preview-open body matches
  a `resolveMessage('relay.intro', ...)` call for the same roster; preview
  during pinned quiet hours -> `deferred:true, quietEndsAt` = clamped
  instant; preview-add for an opted-out member marks them `opted_out` and
  excludes them from `recipientCount`.
- [ ] **Step 2: Implement; green; commit** `feat(roster): plan + live-members endpoints, relayMembers extraction, server previews`.

### Task 11: card edit mode + confirm dialogs + call-through (dashboard)

**Files:**
- Modify: `dashboard/src/routes/shared/PeopleCard.tsx` (+ css),
  `dashboard/src/api/endpoints.ts` (plan endpoints, LIVE-members endpoints,
  previews, pending cancel/apply-now/dismiss; the raw relay client fns
  `addRelayMember`/`removeRelayMember` stay for standalone groups and are
  NOT used by the card)
- Create: `dashboard/src/routes/shared/RosterConfirmDialog.tsx`
- Modify: `dashboard/src/routes/tours/TourDetail.tsx` /
  `PlacementDetail.tsx` ([Open group text] goes through the confirm)
- Test: PeopleCard.test.tsx, RosterConfirmDialog.test.tsx, hub tests

Behavior:
- Edit mode per spec 6.2: per-row remove on the name line (44px row target),
  LAST member's remove disabled + reason; inline suggestions - unit roster
  members not on the roster (`Also on this property: <name> - <role>[ -
  primary contact]  [+ Add]`) AND the missing tenant (`On this tour: <name> -
  tenant  [+ Add]`); `Add any contact...` search; rows not links while
  editing; Done = view toggle. Every action persists on click.
- Routing: `threadExists` false -> plan endpoints, silent. True -> ADD opens
  RosterConfirmDialog fed by preview-add (body verbatim in an sms-bubble,
  per-recipient list with reachability reasons, count, quiet-hours state);
  confirm calls the OWNER-SCOPED `POST .../roster/live-members` (never the
  raw relay route - that is where Task 13's deferral lives); REMOVE calls
  `DELETE .../roster/live-members/:memberKey` with the payload's memberKey -
  the client NEVER handles a phone (the server does the participant-row
  lookup, Task 10). No confirm on remove.
- The plan-endpoint 409 `thread_exists` race: refetch the roster payload,
  surface the now-live state, do NOT resubmit (spec section 7); the queued
  intent is dropped with a visible toast-level note on the card.
- [Open group text]: click -> preview-open dialog (members, deliverability,
  count, intro body, quiet state) -> confirm -> existing createTourRelay /
  placement provision; disabled state + reason from `canOpenGroup`.
- Reset: enabled only when `!threadExists && customized`; confirmless (it is
  a plan edit).
- Mobile: dialog buttons stack full-width, default on top (spec 6.7).

- [ ] **Step 1: Component tests first** (each behavior above gets one, incl.
  the 409-never-resubmits test: mock add -> 409 thread_exists -> assert NO
  relay add fired and the card refetched).
- [ ] **Step 2: Build; gates; live QA** the two-click swap (suggestion add +
  row remove) and the open confirm end to end on the session lane; verify
  `GET /__dev/outbox` shows the intro exactly as previewed.
- [ ] **Step 3: e2e** `e2e/tests/tour-roster.spec.ts`. The e2e lane runs the
  BYTE-STABLE lean world - Task 4's PM property exists only in the FULL
  profile, so THIS SPEC BUILDS ITS OWN FIXTURES IN-TEST (UI or API: create
  the PM contact, roster it on the seeded property, mark primary), exactly
  as Task 9's spec does. THE SWAP FLOW (spec 9): PM property -> tour
  defaults to PM -> remove owner suggestion case -> open group via confirm
  -> conversation members = card rows; the removed-tenant flow: remove
  tenant -> reminders panel shows paused note -> milestone still pins
  (assert via contact timeline) -> one-click restore via suggestion. 360px
  pass over card, dialogs, rail. Full e2e green.
- [ ] **Step 4: Commit** `feat(roster): People card edit mode, previews, call-through`.

---

## SLICE 6 - DEFERRED OPEN + ADD

### Task 12: pendingRosterActions repo + table + seed

**Files:**
- Modify: `app/src/lib/tables.ts` (new table def - clone the
  placementNudges shape):
  ```ts
  {
    baseName: 'pendingRosterActions',
    hashKey: { name: 'actionId', type: 'S' },
    gsis: [
      { indexName: 'byOwner', hashKey: { name: 'ownerKey', type: 'S' } },   // `${ownerType}#${ownerId}`
      { indexName: 'byDueAt',
        hashKey: { name: '_actionPartition', type: 'S' },                   // fixed 'roster_actions'
        rangeKey: { name: 'dueAt', type: 'S' } },
    ],
  }
  ```
- Create: `app/src/repos/pendingRosterActionsRepo.ts` (clone
  tourRemindersRepo's create/listDue/claimApply/claimSkip/cancel discipline;
  item per spec 5.3 PLUS `dismissedAt?: string`; `actionId` = DETERMINISTIC
  `${ownerType}#${ownerId}#open` / `...#add#${contactId}` so the PK itself
  enforces the dedupe. SUPERSEDE SEMANTICS - one behavior, stated once
  (adjudicated post-review): `upsertPending(input)` REPLACES whatever row
  holds that key - a pending row gets the new dueAt (spec 5.3's "duplicate
  confirm supersedes the earlier pending action"), and a TERMINAL row
  (skipped/canceled/applied) is overwritten back to pending, deliberately
  retiring its old notice: a live pending row about a contact beats a stale
  skip notice about the same contact. Claim transitions still refuse
  terminal rows; only upsertPending may resurrect a key.)
- Create: `app/test/pendingRosterActionsRepo.integration.test.ts` (DynamoDB
  Local, mirror the reminders integration suite)

- [ ] **Step 1: Failing integration tests:** create/listDue ordering; claim
  states are terminal; deterministic-id dedupe (second upsert of the same
  add supersedes - new dueAt, never a duplicate row); upsert onto a SKIPPED
  row resurrects it to pending (old notice retired); dismiss stamps
  dismissedAt (listable but excluded from the card's skipped[]); migrate
  (ownerKey -> new ownerKey) for conversion.
- [ ] **Step 2: Implement; green.**
- [ ] **Step 3: Commit** `feat(roster): pendingRosterActions repo + table`. Flag in the task report: NEW TABLE + GSIs => dev Terraform apply owed at merge (spec section 11 - do NOT run it).

### Task 13: quiet-hours evaluation + worker poller + skip paths

**Files:**
- Create: `app/src/jobs/rosterActions.ts` (`runDuePendingRosterActions(nowIso, deps)`)
- Modify: `app/src/worker.ts` (setInterval registration - clone the
  placement-nudge block at :261-295), `app/src/routes/tours.ts` +
  `placements.ts` - the TWO paths that gain the quiet-hours evaluation,
  named precisely so the add path has a home (post-review finding 1):
  (a) the OPEN path (POST /:tourId/relay and the placement provision route);
  (b) the LIVE ADD path = the owner call-through endpoint
      `POST .../roster/live-members` FROM TASK 10 - and ONLY when the thread
      is OPEN. A CLOSED thread's add stays silent-and-immediate, never
      deferred (spec section 7 carve-out - deferring it would announce to a
      closed group at 8 AM). The raw relay route
      (`POST /api/conversations/:id/members`) is NOT touched - standalone
      relay groups do not defer (out of scope; route comment says so).
  Both accept `?force=send_now` from the dialog's override, applying
  immediately with `automated:false` semantics. Pending-row endpoints:
  `POST /api/tours/:tourId/roster/pending/:actionId/cancel` / `.../apply-now`
  / `.../dismiss` (dismiss stamps dismissedAt on a terminal row - the
  "visible until dismissed" mechanism, spec 6.5)
- Modify: convert path migrates pending actions (Task 4's hook goes live)
- Test: `app/test/rosterActionsPoll.test.ts` (pinned clock), route tests

Apply rules (spec 5.3 + D7): claim -> re-validate the world -> act or skip
with reason: `group_closed`, `owner_canceled`, `already_member`,
`contact_deleted`, `member_no_longer_on_roster`, `roster_too_thin`,
`converted` (only when migration failed). open_group applies by running the
SAME provision flow (resolves the plan AT APPLY TIME, consumes it); add
applies `addMemberToRelay` (the Task 10 relayMembers service) with the
announcement. Reminder coupling (D7, pre-approved
cheap position): in the reminder claim path, a group-eligible rung whose
tour has a PENDING open_group and `now < tour start` is left UNCLAIMED
(re-listed next poll); at/after tour start it proceeds via today's fallback
(which then hits the D11 check if the tenant is off). If this exceeds ~20
lines of ladder change, SKIP IT and document the nondeterminism instead -
the spec pre-approves.

- [ ] **Step 1: Failing tests:** open at 23:00 org-time -> pending action
  (dueAt = clamped quiet-end), NO provision, NO outbox send; LIVE ADD at
  23:00 on an OPEN thread -> pending action, membership unchanged, no
  announcement; LIVE ADD at 23:00 on a CLOSED thread -> immediate silent
  add, NO pending action (the carve-out); poller at quiet-end provisions +
  intro sent + plan consumed (and applies the deferred add + announcement);
  every skip reason has a test scenario; cancel + apply-now + dismiss;
  convert migrates the pending row (ownerKey rewritten); reminder-wait (or
  its documented absence). Pinned clocks throughout.
- [ ] **Step 2: Implement; green.**
- [ ] **Step 3: Commit** `feat(roster): quiet-hours deferral for open/add - pending actions, poller, visible skips`.

### Task 14: pending state UI + final e2e sweep

**Files:**
- Modify: `PeopleCard.tsx` (pending rows: `Joins at <time> - quiet hours /
  Add now - Cancel`; deferred-open banner on the button:
  `Opens at <time> - quiet hours. Send now - Cancel`; skipped rows visible
  until DISMISSED via a per-row dismiss control -> `POST .../pending/
  :actionId/dismiss`; dismissed rows disappear), Task 5/10 roster payload
  gains `pending[]` + `skipped[]` (skipped EXCLUDES dismissed rows),
  `RosterConfirmDialog` flips to the real three-button quiet layout
  ([Cancel] [Send now anyway] [Open at <time>] default - stacked on mobile)
- Create: `e2e/tests/roster-quiet-hours.spec.ts`
- Test: component tests for every pending/skip rendering INCLUDING dismiss
  (skip row -> dismiss click -> row gone -> refetch keeps it gone)

- [ ] **Step 1: Component tests first; build.**
- [ ] **Step 2: e2e:** freeze the lane's org settings into quiet hours (the
  quiet-hours e2e specs show the pattern - reuse their settings fixture
  approach, NEVER wall-clock-dependent assertions): open -> pending banner ->
  Send now anyway -> outbox intro; add -> pending row -> cancel -> visible
  canceled/skip row. 360px pass on the three-button stack.
- [ ] **Step 3: Full gates: typecheck + test + full e2e green on the slice.**
- [ ] **Step 4: Commit** `feat(roster): pending/skipped roster UI + quiet-hours e2e`.

### Task 15: docs, issues, sync

- [ ] **Step 1:** File spec section 12's issues in `docs/issues/` (copy
  `_TEMPLATE.md`, slugs): `tenant-support-contacts-structured.md`,
  `self-guided-group-reminder-gate.md`, `relay-reopen-semantics.md`
  (INCLUDE the never-introduced-member case), `voice-business-number-roster.md`,
  `roster-card-shared-edit-pattern.md`, `relay-stale-participant-phone.md`.
- [ ] **Step 2:** RUNBOOK.md: pendingRosterActions poller (interval, table,
  what a stuck pending row means); the dev-Terraform-owed note.
- [ ] **Step 3:** Merge latest main, resolve keeping both intents, re-run ALL
  gates (`npm run typecheck` + `npm test` + full `npm run e2e`) green on the
  updated base. Commit.

---

## Self-review notes (already applied)

- Spec coverage walked D1-D11 + sections 5-9: every requirement maps to a
  task above; D9's ordering constraint is the slice order itself.
- Type names consistent: `RosterEntry`/`ResolvedRoster`/`describeRoster`
  (Tasks 3/5/10), `PersonChannelInput` (Tasks 2/8), payload shape (Tasks
  5/8/11/14), memberKey (Tasks 5/10/11).
- The two review-mandated negative tests are present: tabs NOT keyed on
  resolveTourMembers (Task 2), 409 never auto-resubmits (Task 11 Step 1).

## Plan-review adjudications (2026-08-04, post-adversarial-review of the plan)

- Deferred ADDS live on the owner call-through endpoints
  (`POST .../roster/live-members`, Task 10), the ONLY add path the dashboard
  uses; the raw relay route is untouched and standalone groups do not defer.
- The client NEVER handles phones: roster payload carries memberKey +
  phoneLast4; live remove is server-side by memberKey (stored-phone rule).
- Resolver failure with a thread pointer set = source 'unavailable', never a
  plan/default fallback: card renders unavailable, reminder rungs stay
  unclaimed. Wrong-roster sends on a Dynamo blip are the outranking risk.
- Supersede = upsert-to-pending replacing ANY prior row for the
  deterministic key (terminal rows' notices deliberately retire); dismiss is
  `dismissedAt` + endpoint, and skipped[] excludes dismissed rows.
- Closed-thread adds are never deferred (spec section 7 carve-out);
  preview-open 409s on an already-provisioned owner.
- FULL-seed PM property moved to Task 4 so slices 3-5 live-QA realistically;
  e2e specs build their own PM fixtures in-test (lean world stays
  byte-stable).
