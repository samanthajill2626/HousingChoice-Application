# Create a relay group from the contact file

Date: 2026-08-17
Status: approved (design conversation 2026-08-17)
Branch: `feat/contact-create-relay-group`

## 1. Problem

The contact detail page ("Relay groups" card, `GroupTextsCard`) lists the relay
groups a contact belongs to, but offers no way to start one. Today a relay group
can only be opened from a Tour (`POST /api/tours/:tourId/relay`) or a Placement
(`POST /api/placements/:placementId/relay`). An operator who wants to connect a
tenant and a landlord on a masked number, with no tour or placement in play, has
no path at all.

`POST /api/relay-groups` already exists and does the whole job (provision a pool
number, create the conversation, assign, audit, send the intro to each member,
emit). Its header calls it "the test scaffold"; no dashboard code calls it. This
change makes it a product path and gives it the same confirm-before-send
treatment the tour and placement paths already have.

## 2. Goals

- A `+ Create group` action on the "Relay groups" card of the tenant and
  landlord contact files.
- Picking members, then a confirm step that shows EXACTLY what will be sent and
  to whom, reusing the existing `RosterConfirmDialog` verbatim.
- ONE backend implementation of "what an open sends", shared by the tour,
  placement, and standalone preview routes, so the three cannot drift.

## 3. Non-goals

- Quiet-hours DEFERRAL for a standalone create. Out of scope; filed as a
  follow-up issue (section 9). This spec ships the truthful warning without the
  deferral button.
- Any change to how tours or placements open their groups. Their observable
  behavior must be byte-identical after the refactor.
- Creating NATIVE group texts (the sibling "Group threads" card). Untouched.
- Reusing an existing group when the same member set already has one. Not in
  scope; each confirm creates a new group.

## 4. Why a standalone preview route is needed

`RosterConfirmDialog` renders a server-built `RosterPreview`. The only producers
are `GET /api/tours/:id/roster/preview-open` and
`GET /api/placements/:id/roster/preview-open`, both of which call
`buildOpenPreview(deps, owner, quiet)` with a `RosterOwner` (`type: 'tour' |
'placement'`).

A standalone group HAS a roster once it exists: `conversation.participants`,
resolver source `'participants'` - the same thing `resolveRoster` reads for an
opened tour group, and the same thing `GET /api/conversations/:id/members`
serves. What it lacks is a roster BEFORE it exists. A tour or placement carries
a PLANNED roster (the `plan` override, or the `default` derived from the unit's
contacts) that `preview-open` reads while `groupThreadId` is still absent. A
standalone group has no owner row and nothing stored, so at preview time the
only copy of the member list is the one in the browser.

That is the entire asymmetry, and it is why the standalone preview must accept
`members` as request input while the owner-scoped previews must not.

## 5. Backend

### 5.1 The shared preview core (the anti-drift measure)

Extract the tail of `buildOpenPreview` in `app/src/services/rosterEdits.ts` into
one exported function, and route every caller through it:

```
export interface PreviewMember {
  name?: string;
  phone?: string;
  reachability: RosterReachability;
}

export function buildOpenPreviewFromMembers(
  members: PreviewMember[],
  quiet: QuietHoursState,
): RosterPreview
```

It owns, once:

- `body`: `composeIntroBody(names)` over the phone-bearing, phone-de-duplicated
  members - the set provisioning will actually put on the thread.
- `recipients`: EVERY member via `toRecipient` (names only, never phone
  numbers), including no-phone and opted-out rows.
- `recipientCount`: the count of DISTINCT REACHABLE phones.
- `deferred` / `quietEndsAt`: `withQuietHours(...)`.

`buildOpenPreview(deps, owner, quiet)` keeps its exact signature and becomes
owner resolution -> `PreviewMember[]` -> the core. `buildAddPreview` is NOT
refactored in this change (it composes a different body from a different
catalog entry; folding it in is scope creep).

CONSTRAINT: the existing tour and placement preview tests must pass UNTOUCHED.
They are the proof the owner path did not change.

KNOWN WRINKLE, to preserve rather than fix: today `buildOpenPreview` builds
`recipients` from `describeRoster`'s view but the body names from
`resolveRoster`'s list, matching them via `resolvedMemberKey`. If those two
lists ever disagree, the core must reproduce the CURRENT behavior exactly. Do
not "fix" the divergence in this change; report it if found.

### 5.2 The standalone preview route

`POST /api/relay-groups/preview` on the existing relay-groups router
(`app/src/routes/relayGroups.ts`), same auth posture as its siblings (mounted
under `/api` behind `requireAuth`, no admin gate).

Request body is the SAME shape `POST /api/relay-groups` accepts:

```
{ members: [{ phone, contactId?, name? }], tag? }
```

Handling:

1. Validate with `parseRelayMember` - the SAME parser the create route uses -
   and de-dupe by normalized phone within the request, exactly as create does.
   An empty/absent `members` array is `400 { error: 'members (non-empty array)
   is required' }`, matching create's wording. A bad member returns create's
   400 for that member verbatim.
2. Resolve each member's display name via `resolveMemberName` (the create
   route's resolver) and read `sms_opt_out` from the contact.
3. Derive reachability: no phone -> `no_phone`; `contact.sms_opt_out === true`
   -> `opted_out`; else `reachable`. This is `describeRoster`'s rule minus the
   per-conversation opted-out-keys term, which cannot apply because no
   conversation exists yet.
4. `buildOpenPreviewFromMembers(members, await quietHoursState())` and return
   the `RosterPreview` AS THE BODY (not wrapped) - the same contract the two
   owner-scoped preview routes use.

`quietHoursState()` is the two-line helper the tours and placements routers
already define (`getNow()` + `readQuietHoursWindow(settingsRepo, log)`). The
relay-groups router already imports `readQuietHoursWindow` and holds
`settingsRepo` and `contactsRepo`, so the route adds NO new router
dependencies.

The preview does NOT provision, does NOT touch pool numbers, and does NOT
check `RELAY_LIVE_PROVISIONING`. It is a pure read: a preview must never be the
thing that discovers provisioning is disabled. The create call surfaces that
refusal, as it does today.

CONSISTENCY RULE: because there is no server-side roster to resolve, the
client's list IS the input to both calls. The modal MUST post the identical
`members` array to `/preview` and to the create route. This is stated in the
new function's header comment so it does not read as though the
"input-is-the-owner-only" invariant in `rosterEdits.ts` was ignored - that
invariant exists to stop a client list disagreeing with a server-resolved
roster, and here there is no server-resolved roster to disagree with.

### 5.3 What is NOT changed on the backend

`POST /api/relay-groups` is unchanged. No new repo, no schema change, no new
GSI, no new dependency, no infra.

## 6. Frontend

### 6.1 API client

`dashboard/src/api/endpoints.ts`, modelled on the existing `createTourRelay`:

- `previewRelayGroup(members, signal?): Promise<RosterPreview>` ->
  `POST /api/relay-groups/preview`.
- `createRelayGroup(members, tag?): Promise<{ conversation: ConversationItem }>`
  -> `POST /api/relay-groups`.

Both take the same `members` array value, passed through unchanged.

### 6.2 The card action

`GroupTextsCard` gains an optional prop:

```
/** When set, the card heading offers "+ Create group". */
onCreate?: () => void;
```

Rendered as the `Card`'s `aside`:

```
<CardAction onClick={onCreate} label="Create a relay group">+ Create group</CardAction>
```

The prop is OPTIONAL so every existing render and test of the card is
unaffected. Copy is sentence case (`+ Create group`) to match every other
`CardAction` in the repo.

### 6.3 The pick-members modal

New `dashboard/src/routes/contact/CreateRelayGroupModal.tsx` (+ `.module.css`
+ test), using the existing `Modal`.

- SEEDED with the contact whose page this is, as a locked row labelled with
  their name; it cannot be removed. A group created from Sam's page that does
  not contain Sam is a foot-gun.
- Additional members via `ContactSearchField` over the contact roster
  (`useContacts('all')`, already loaded by `ContactDetail` as `editCandidates`),
  filtered to contacts that have a phone and are not already in the list. Each
  added row has a Remove button.
- Optional `Name (optional)` text input -> the create call's `tag`. The tag is
  NOT sent to the preview route (it does not affect the intro body); the
  preview request carries `members` only.
- `Create group` is disabled until there are 2 or more members. The API accepts
  one, but a one-person relay group is not a group.
- The seeded contact having no valid phone is handled at the card, not here
  (6.5).

### 6.4 The confirm step

On `Create group`, call `previewRelayGroup(members)` and mount the EXISTING
`RosterConfirmDialog` from `dashboard/src/routes/shared/`:

- `title="Open the relay group?"`
- `confirmLabel="Open relay group"`
- `deferLabel="Open"`
- `allowDefer={false}` (see 6.6)
- `onConfirm` -> `createRelayGroup(members, tag)` with the IDENTICAL members
  array that was previewed.

No new copy is authored for this dialog. What it shows is fixed by the
component: the server-composed `relay.intro` body rendered verbatim in a
bubble, every member by name with `not receiving - opted out` /
`not receiving - no mobile number` where applicable, and "N recipients will
receive this" using the server's distinct-reachable count. It prints no phone
numbers and says nothing about provisioning a number - deliberately, because
the pool has spares and a create may reuse one rather than buy one.

Outcomes:

- Success -> `navigate('/conversations/' + conversation.conversationId)`, the
  same destination the card's rows link to.
- Failure -> the dialog's own inline error path (`refusalMessage`), dialog
  stays open, nothing was sent. The two known 503s must read as sentences:
  `relay_provisioning_disabled` and `pool_number_unavailable`. If
  `refusalMessage` does not already map them, extend it there so all three
  relay-open surfaces benefit.
- A preview request that fails surfaces the error in the PICK modal and never
  opens the confirm dialog. An operator must never confirm a send whose content
  could not be shown.

### 6.5 Wiring

`ContactDetail` owns the modal state and already holds both the contact roster
and `navigate`. It passes `onCreateRelayGroup` to `TenantFile` and
`LandlordFile`, which forward it to `GroupTextsCard`. `PartnerFile` and
`UnknownFile` do not render this card and are untouched.

If the contact has no valid phone, the action renders DISABLED with a title
explaining why, because the API rejects a member without one.

### 6.6 The `allowDefer` prop (quiet hours, option A)

`RosterConfirmDialog` gains one optional prop:

```
/** False when the confirming endpoint CANNOT defer (the standalone relay
 *  create has no owner row to hold a pending action). The quiet-hours warning
 *  still shows; the deferral button does not, because no backend row can keep
 *  that promise. Defaults to true - tour and placement are unaffected. */
allowDefer?: boolean;   // default true
```

When `allowDefer` is false AND `preview.deferred` is true:

- the footer is `[Cancel] [Create and send now]` (no "Send now anyway", no
  "Open at 8:00 AM"),
- the quiet-hours warning line STILL renders,
- `onConfirm` is called with `force: true`, because sending now IS what
  happens.

When `allowDefer` is true (tour, placement) nothing changes: same three-button
quiet layout, same default-is-deferral behavior, same labels.

RATIONALE: `POST /api/relay-groups` has no quiet-hours handling -
`provisionRelayGroup` sends the intro immediately at any hour. Tours and
placements defer by writing a `pendingRosterActionsRepo` row whose `actionId`
is `` `${ownerType}#${ownerId}#open` `` with `RosterActionOwnerType` of
`tour | placement`. A standalone create has no owner id to key that row by.
Deeper: a pending `open_group` row deliberately stores NO roster and re-resolves
membership from the owner when it fires, so a standalone deferral would need a
new row shape carrying its own member list. Showing an "Open at 8:00 AM" button
the endpoint would ignore is exactly the lie `RosterConfirmDialog` exists to
prevent.

## 7. Testing

Unit (Vitest):

- `rosterEdits`: the same member set through `buildOpenPreview` (owner path) and
  the standalone builder yields an IDENTICAL preview - the test that makes drift
  fail loudly. Plus the existing preview tests, unmodified, as the
  no-behavior-change proof.
- Route: `POST /api/relay-groups/preview` - 400 on empty/absent members, 400 on
  a bad member, opted-out member listed but excluded from the count, phone
  de-duplication, `deferred` true/false against a fixed clock, and that it
  provisions nothing.
- `GroupTextsCard`: renders the action when `onCreate` is set, and does not when
  it is absent.
- `CreateRelayGroupModal`: seeds the contact, blocks Create at one member,
  filters already-added and phone-less candidates, previews before confirming,
  posts the same members array to both calls, maps both 503s, navigates on
  success, and keeps the dialog open on failure.
- `RosterConfirmDialog`: `allowDefer={false}` inside quiet hours renders the
  two-button footer, still shows the warning, and confirms with `force: true`;
  the default (`allowDefer` unset) is unchanged.

E2E (Playwright, accessibility-first selectors per `e2e/support/selectors.md`):
one spec covering contact file -> `+ Create group` -> add a member -> confirm ->
lands on the new conversation, with the intro visible in the dev outbox.

Gates, bare, from the worktree: `npm run typecheck`, `npm test`, `npm run e2e`.

## 8. Risks and watch items

- The `rosterEdits` refactor touches a service two LIVE routes depend on. The
  untouched existing tests are the gate; any change to their expectations is a
  red flag, not a fixup.
- `RosterConfirmDialog` is shared by Tour and Placement. `allowDefer` MUST
  default to true, and both existing call sites must be left alone.
- The intro body comes from the founder-editable `relay.intro` catalog entry.
  Never rebuild it client-side.
- Previews carry names, never phone numbers (`rosterEdits.ts` section 9 PII
  rule). The new route must hold that line.
- New user-facing automated copy goes through the message catalog. This change
  authors NO new outbound copy - it reuses `relay.intro`.

## 9. Follow-up issue to file in this change

`docs/issues/standalone-relay-group-quiet-hours-deferral.md` (copy
`docs/issues/_TEMPLATE.md`): a standalone relay group created during quiet
hours sends its intro immediately, because there is no owner row to hold a
pending action. Records what full parity would take: a third
`RosterActionOwnerType`, a pending row that carries its own member list (today's
`open_group` row stores none and re-resolves from the owner), and a poller path
that provisions from stored members. Referenced from the `allowDefer` prop
comment as `TODO(standalone-relay-group-quiet-hours-deferral):`.

## 10. Post-merge obligations

None expected. No dependency, schema, GSI, infra, or environment change.
