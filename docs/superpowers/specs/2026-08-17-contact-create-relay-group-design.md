# Create a relay group from the contact file

Date: 2026-08-17
Status: revised after design review round 1 (adjudications at
`.superpowers/design-review/adjudications.md`)
Branch: `feat/contact-create-relay-group`

## 1. Problem

The contact detail page ("Relay groups" card, `GroupTextsCard`) lists the relay
groups a contact belongs to but offers no way to start one. Today a relay group
can only be opened from a Tour (`POST /api/tours/:tourId/relay`) or a Placement
(`POST /api/placements/:placementId/relay`). An operator who wants to connect a
tenant and a landlord on a masked number, with no tour or placement in play, has
no path at all.

`POST /api/relay-groups` already exists and does the whole job. Its header calls
it "the test scaffold"; no dashboard code calls it. This change makes it a
product path and gives it the same confirm-before-send treatment the tour and
placement paths have.

## 2. Verified current behavior (do not re-derive)

Every claim below was read in code during design review. A builder can rely on
them.

1. **Provisioning never buys at create time.** `poolNumbersService
   .provisionForGroup` runs a three-tier ladder: reuse a burnable active number
   -> take a warm spare -> connect-when-ready, where buying is solely
   `warmOneNumber`. (Tiers 1-2 at `services/poolNumbers.ts:532-563`; tier 3 at
   `566-589`.) DO NOT trust that
   module's file header (`poolNumbers.ts:5-13`): it still describes the OLD
   two-tier behavior, "(c) else PROVISION a fresh one through the adapter",
   which is the opposite of what the code now does. Section 9 files it.
2. **Tier 3 with the kill-switch ON returns `needs_connecting`**, and
   `provisionRelayGroup` then creates the group with NO pool number, enqueues a
   warm job, and sends **no intro at all** - the intro is deferred to the
   `relay.numberReady` handler. (`services/relayProvisioning.ts:99-151`)
3. **Tier 3 with the kill-switch OFF throws** `RelayProvisioningDisabledError`
   rather than returning `needs_connecting`, so a connecting group is never
   stranded. The route's 503 `relay_provisioning_disabled` IS reachable.
   (`services/poolNumbers.ts:577-579`, the implementation, not the doc comment
   at 77-84.) Note: the comment at `services/relayProvisioning.ts:87` claims
   provisioning never throws this; that comment is stale (section 9 files it).
4. **Tours and placements share this exact path** and already handle
   `connecting` explicitly in their audit, log, and milestone code
   (`services/rosterProvision.ts:432-434, 466-472`; the 597-610 block is the
   placement idempotency guard, a different concern). The confirm dialog's
   "N recipients will receive this" is therefore ALREADY imprecise on tier 3 for
   both shipped surfaces. This change does not introduce that gap.
5. **`buildOpenPreview` uses two different name sources**: the intro body is
   composed from `resolveRoster`'s members (stored names, no backfill) while
   `recipients` comes from `describeRoster`'s view (names backfilled from the
   contact). (`services/rosterEdits.ts:396-401`)
6. **`recipientCount` is not "distinct reachable phones".** The real rule is:
   filter to phone-bearing members, de-dupe by phone FIRST WINS, then count
   those whose member key is reachable. A phone whose first member is opted out
   does not become reachable because a later member on the same number is.
   (`services/rosterEdits.ts:381-393`)
7. **`relay.intro` is marked `editable: true` but no override is ever applied.**
   `composeIntroBody` calls `resolveMessage` with no overrides argument
   (`jobs/relayFanOut.ts:201-205`); `resolveMessage` only honors an override
   when one is passed (`messages/resolve.ts:52-65`). Server-side composition is
   still required - not because of operator edits, but because the composition
   logic (Oxford list, pluralization, brand/STOP shell) lives in
   `composeConnectionSentence` and a client copy would drift from it.
8. **The real send-time suppression gate is `isMemberSuppressed`**
   (`services/relayAnnouncements.ts:61` through its return): contact by id,
   `findByPhone` fallback, contact `sms_opt_out`, plus a per-phone STOP record
   read from the 1:1 conversation. `describeRoster`'s reachability rule is a
   different, narrower predicate. It is deliberately NOT wrapped in try/catch -
   a repo failure PROPAGATES so callers fail CLOSED rather than texting a
   possibly-opted-out number.
9. **The hermetic e2e stack lands a fresh pair CONNECTING by design** (twilio
   driver, spare target K=0, seeded numbers are `console`-provisioned and
   skipped by the reuse ladder) and ships helpers to drive it open.
   (`e2e/fixtures/relayConnect.ts:9-26, 134-186`)
10. **`relayGroups.ts` has no injected clock** (`getNow`), unlike the tours and
    placements routers.
11. **`parseRelayMember` requires a phone** and 400s without one
    (`services/relayMembers.ts:63-79`), so a member without a phone cannot reach
    this route.
12. **`resolveMemberName` short-circuits** when a `name` is supplied and returns
    without reading the contact (`services/relayMembers.ts:49-60`). It cannot be
    used to obtain opt-out state.

## 3. Goals

- A `+ Create group` action on the "Relay groups" card of the tenant and
  landlord contact files.
- A member picker, then a confirm step reusing the existing
  `RosterConfirmDialog` so the operator sees the real intro body and the real
  recipient list before anything is created.
- ONE backend implementation of "what an open sends", shared by the tour,
  placement, and standalone previews.
- Honest handling of the `connecting` outcome (section 6.6).

## 4. Non-goals

- Quiet-hours DEFERRAL for a standalone create (section 6.7). Filed instead.
- Changing how tours or placements open their groups. Their observable
  behavior must be identical after the refactor. Additive changes to shared
  helpers (a new optional prop, a new mapped error string) are permitted; the
  behavior those two surfaces exhibit today is not.
- Correcting the shared dialog's recipient wording for the tier-3 case. Filed
  (section 10); the standalone path handles it locally per 6.6.
- Creating NATIVE group texts (the sibling "Group threads" card).
- Reusing an existing group when the same member set already has one. Each
  confirm creates a NEW group. COST, stated because it is not obvious: pool
  numbers are claimed by burn overlap, so a second group for the SAME pair can
  never reuse the first group's number - it forces a new number every time.

## 5. Why a standalone preview route is needed

`RosterConfirmDialog` renders a server-built `RosterPreview`. The only producers
are the two owner-scoped `preview-open` routes, both of which call
`buildOpenPreview(deps, owner, quiet)` with a `RosterOwner` of type `tour` or
`placement`.

A standalone group HAS a roster once it exists: `conversation.participants`,
resolver source `'participants'`. What it lacks is a roster BEFORE it exists. A
tour or placement carries a PLANNED roster (the `plan` override, or the
`default` derived from the unit's contacts) that `preview-open` reads while
`groupThreadId` is still absent. A standalone group has no owner row and nothing
stored, so at preview time the only copy of the member list is the one in the
browser.

That is the entire asymmetry, and it is why the standalone preview accepts
`members` as request input while the owner-scoped previews must not.

## 6. Design

### 6.1 The shared preview core

In `app/src/services/rosterEdits.ts`, extract the tail of `buildOpenPreview`
into one exported function. It takes TWO lists because the owner path genuinely
has two (section 2.5) and collapsing them would change the output:

```
export interface OpenPreviewParts {
  /** Members provisioning will put on the thread: phone-bearing, de-duped by
   *  phone (FIRST WINS), in roster order. Names as the BODY composer sees them. */
  bodyMembers: { name?: string; memberKey: string }[];
  /** Everyone who will be ON the thread, in display order, with display names
   *  and reachability. The owner path passes its full roster view (phone-less
   *  rows included - they are still participants); the standalone path passes
   *  its phone-de-duplicated list, because create drops the duplicates before
   *  they ever become participants. See 6.2 step 4. */
  recipients: { name?: string; memberKey: string; reachability: RosterReachability }[];
}

export function buildOpenPreviewFromParts(
  parts: OpenPreviewParts,
  quiet: QuietHoursState,
): RosterPreview
```

It owns, once:

- `body` = `composeIntroBody(parts.bodyMembers.map((m) => m.name))`.
- `recipients` = `parts.recipients.map(toRecipient)` - names only, never phones.
- `recipientCount` = the number of `bodyMembers` whose `memberKey` is reachable
  according to `parts.recipients`. This reproduces section 2.6's rule EXACTLY:
  de-dupe first, then filter reachable.
- `deferred` / `quietEndsAt` via `withQuietHours`.

`buildOpenPreview(deps, owner, quiet)` keeps its exact signature and becomes
owner resolution -> `OpenPreviewParts` -> the core. `buildAddPreview` is NOT
refactored (different body, different catalog entry; folding it in is scope
creep).

CONSTRAINT: the existing tour and placement preview tests must pass UNTOUCHED.
Any change to their expectations is a red flag, not a fixup.

### 6.2 The standalone preview route

`POST /api/relay-groups/preview` on the existing relay-groups router, same auth
posture as its siblings. Body is the same shape the create route accepts:
`{ members: [{ phone, contactId?, name? }] }`. `tag` is ignored here - it does
not affect the intro body.

1. Validate with `parseRelayMember` - the SAME parser create uses. Empty or
   absent members -> `400 { error: 'members (non-empty array) is required' }`,
   create's wording verbatim. A bad member returns create's 400 for that member.
2. For each parsed member, resolve the display name with `resolveMemberName` -
   THE SAME resolver the create route uses, short-circuit included. This is
   load-bearing: `resolveMemberName` returns a supplied `name` verbatim without
   reading the contact (section 2.12), so if the preview instead recomputed the
   name from the contact, a client-supplied name would produce ONE name in the
   confirm dialog and a DIFFERENT one in the intro create actually sends. The
   preview and the create must resolve names identically or the dialog is not a
   preview of the send.
   Determine suppression separately with `isMemberSuppressed(contacts,
   conversations, member)` - the REAL send gate (section 2.8). Suppression and
   naming are different questions and use different resolution rules; do not try
   to serve both from one read.
3. Reachability is `opted_out` when suppressed, else `reachable`. There is NO
   `no_phone` case on this route: `parseRelayMember` guarantees a phone
   (section 2.11).
4. Build `OpenPreviewParts`. `memberKey` is `contactId` when present, else
   `` `phone:${e164}` `` - the SAME key shape `describeRoster` builds
   (`lib/rosterResolution.ts:560`), so the core's reachable-key join behaves
   identically on both paths.
   - `recipients` = the parsed members after the SAME first-wins phone de-dupe
     the create route applies (`routes/relayGroups.ts:267`), in the order sent.
   - `bodyMembers` = that same de-duplicated list.

   PARITY IS OF MEANING, NOT OF LIST CONSTRUCTION. `recipients` means "everyone
   who will be on the thread". On the owner path every resolved member becomes a
   participant, so nothing is dropped. On the standalone path CREATE ITSELF
   de-dupes by phone, so a second member sharing a number never becomes a
   participant at all - listing them would name a person in the confirm dialog
   who will not be in the group and will not be texted, with no annotation
   saying so (`toRecipient` carries only name and reachability; the roster
   view's `sharesPhoneWithName` never reaches the dialog). De-duplicating here
   is what makes the two paths agree.

   The picker prevents this case from arising through the UI anyway (6.5), but
   the route must be deterministic for any direct API caller.
5. `buildOpenPreviewFromParts(parts, await quietHoursState())`, returned AS THE
   BODY (not wrapped), matching the two owner-scoped preview routes.

DELIBERATE ASYMMETRY, to be stated in the function header: the standalone path
derives reachability from `isMemberSuppressed` while the owner path keeps
`describeRoster`'s narrower rule. The owner path is not changed because
non-goal 2 forbids it, and that divergence is already a known, filed issue
(`docs/issues/relay-member-suppression-diverges-from-number-seam.md`). The
standalone path uses the true gate because it has no conversation from which to
read opted-out keys, and matching the send is the point of a preview.

The route needs a clock for a fixed-time test. `relayGroups.ts` has none
(section 2.10), so it gains an injectable `getNow` in its router deps, matching
the tours and placements routers. This IS a new router dependency.

The preview does NOT provision, does NOT touch pool numbers, and does NOT check
`RELAY_LIVE_PROVISIONING`: a preview must never be what discovers provisioning
is disabled. The create call surfaces that refusal, as it does today.

`isMemberSuppressed` throws on a repo failure BY DESIGN (section 2.8). Do NOT
catch it here. The preview then 5xxs, the picker shows the error, and the
confirm dialog never opens - which is the correct outcome: a preview that
cannot determine who is suppressed must not be rendered as though it could.

CONSISTENCY RULE: with no server-side roster to resolve, the client's list IS
the input to both calls. The modal MUST post the identical `members` array to
`/preview` and to create. State this in the function header so it does not read
as though `rosterEdits.ts`'s "input is the owner only" invariant was ignored -
that invariant stops a client list disagreeing with a server-resolved roster,
and here there is no server-resolved roster to disagree with.

### 6.3 What is NOT changed on the backend

`POST /api/relay-groups` is unchanged. No new repo, no schema change, no new
GSI, no new dependency, no infra.

### 6.4 API client

In `dashboard/src/api/endpoints.ts`, modelled on `createTourRelay`:

- `previewRelayGroup(members, signal?): Promise<RosterPreview>`
- `createRelayGroup(members, tag?): Promise<{ conversation: ConversationHeader }>`
  - the dashboard type is `ConversationHeader`; there is no `ConversationItem`
  in the dashboard (that is the app-side repo type). NOTE: `ConversationHeader`'s
  `status` docblock does not list `'connecting'`, the value 6.6 branches on,
  even though the server sends it - a fourth stale comment for issue 9.4. Verify
  the union admits it and widen the DOC, not the behavior.

Both receive the same `members` array value, passed through unchanged.

### 6.5 The card action and the picker

`GroupTextsCard` gains an OPTIONAL `onCreate?: () => void`, rendered as the
`Card`'s `aside`:

```
<CardAction onClick={onCreate} label="Create a relay group">+ Create group</CardAction>
```

Optional so every existing render and test of the card is unaffected. Sentence
case matches every other `CardAction`. `CardAction` itself is NOT modified - it
has no `disabled` or `title` prop and is used across many surfaces.

New `dashboard/src/routes/contact/CreateRelayGroupModal.tsx` (+ `.module.css`
+ test), using the existing `Modal`:

- SEEDED with the contact whose page this is, as a locked row; it cannot be
  removed. A group created from Sam's page that does not contain Sam is a
  foot-gun.
- The seeded contact's phone is `contact.phones?.find((p) => p.primary)?.phone
  ?? contact.phone` - `phones` is OPTIONAL on the dashboard `Contact`, so the
  optional chain is required to typecheck. If that resolves to nothing, the row
  renders as "no mobile number - cannot start a relay group" and Create stays
  disabled. The card action still renders; the modal is where the reason is
  explained.
- Additional members via `ContactSearchField` over `useContacts('all')` (already
  loaded by `ContactDetail` as `editCandidates`). SCOPE: `'all'` fans out across
  `tenant`, `landlord`, and `unknown` ONLY - team members are excluded
  (`routes/contacts/useContacts.ts:55-66`). Partner and team-member contacts are
  therefore NOT pickable. Accepted limitation, called out so it is not mistaken
  for a bug; widening the roster is out of scope.
- `ContactSearchField` yields only `{ name, contactId }` and emits on EVERY
  keystroke with `contactId` undefined for uncommitted free text. A member may
  be added ONLY from a committed pick (`contactId` set); free text is never
  addable. The modal maps `contactId` back to its `Contact` in the candidate
  array to read the phone. Candidates are filtered out when they have no
  resolvable phone, are already added, or SHARE A PHONE with an already-added
  member (6.2: create would silently drop them).
- ONE IDENTITY PER PERSON across the picker and the confirm dialog. The name is
  built from `firstName`/`lastName` ONLY. When that yields a real name it is
  sent as `name`, and both the preview and create use it verbatim (6.2 step 2).
  When it yields nothing, no `name` is sent and the picker MUST render the
  dialog's exact string, `Unnamed number` - not a phone, and not a third
  variant. Do NOT use the dashboard's `contactDisplayName` helper here: it falls
  back to a FORMATTED PHONE NUMBER (`routes/contact/format.ts:101-110`), which
  would both print a phone in the preview and embed one in the outbound intro.

  SCOPE LIMIT, stated so the builder does not chase it: the rule CANNOT extend
  to the intro body. `composeConnectionSentence` OMITS a nameless member from
  the sentence entirely rather than rendering a placeholder, so a nameless
  member appears in the picker and the dialog as "Unnamed number" but is simply
  absent from the intro text. That is existing behavior on all three relay
  surfaces and is not changed here.
- Optional `Name (optional)` text input -> the create call's `tag` only.
- `Create group` is disabled below 2 picked rows. This is a UI affordance over
  PICKED ROWS, not a guarantee about the resulting group: opted-out legs are
  suppressed at send, so two rows can still yield a one-recipient send. (The
  picker filters same-phone candidates, so collapsing is not a factor from the
  UI.) The confirm dialog is where the true count is shown.

### 6.6 The confirm step

On `Create group`, call `previewRelayGroup(members)` and mount the EXISTING
`RosterConfirmDialog` with `title="Open the relay group?"`,
`confirmLabel="Open relay group"`, `deferLabel="Open"`, `allowDefer={false}`,
and `onConfirm` -> `createRelayGroup(members, tag)` with the IDENTICAL array
that was previewed.

NO new copy is authored for this dialog. It shows the server-composed
`relay.intro` body verbatim, every member by name with the not-receiving reason
where it applies, and the server's recipient count. It prints no phone numbers
and says nothing about provisioning a number.

ONE MODAL AT A TIME. The picker UNMOUNTS when the confirm dialog mounts.
`Modal` registers a document-level Escape handler with no propagation guard, so
two stacked modals would both close on one keypress and silently discard the
assembled member list. Member state lives in the PARENT, so returning from the
confirm dialog restores the picker with its selection intact.

A failed preview surfaces its error in the PICKER and never opens the confirm
dialog: an operator must never confirm a send whose content could not be shown.

Outcomes after a successful create:

- `conversation.status === 'connecting'` -> the group exists but has NO number
  and NO intro was sent (section 2.2). DO NOT navigate. The confirm dialog
  closes and the picker modal REMAINS OPEN, replaced by a short result panel
  that names the unsent intro specifically - for example "This group is still
  getting its number. The intro text has not been sent yet; it goes out once the
  number is ready." - with a single `Go to the group` button that navigates to
  `/conversations/:conversationId`, and nothing else.

  WHY IN THE MODAL: the notice must appear on a surface this flow already owns.
  The dashboard has no toast system and no router-state banner precedent, so
  "navigate and show a banner" has no seam to hang on and would mean inventing
  one. The modal is already mounted, already owns the result of the create, and
  is where the operator's attention is. It is also the only place a test can
  assert the notice without depending on the conversation route.

  The existing connecting affordances on the conversation view are NOT a
  substitute: it shows a status pill and a composer note about replies being
  queued, and neither says the intro has not gone out. The operator was just
  shown that exact intro body in a confirm dialog, so silence reads as "sent".
- otherwise -> navigate to `/conversations/:conversationId`, the same
  destination the card's rows link to.
- Failure -> the dialog's own inline error path (`refusalMessage`); the dialog
  stays open and nothing was created. `relay_provisioning_disabled` must read as
  a sentence; if `refusalMessage` does not already map it, extend it there so
  all three relay-open surfaces benefit. `pool_number_unavailable` is NOT
  specified: buying moved to the warm job, so `VoiceCapabilityError` at create
  time appears unreachable.

### 6.7 `allowDefer` (quiet hours)

`RosterConfirmDialog` gains one optional prop:

```
/** False when the confirming endpoint CANNOT defer (a standalone relay create
 *  has no owner row to hold a pending action). The quiet-hours warning still
 *  renders; the deferral button does not, because no backend row can keep that
 *  promise. Defaults to true - tour and placement are unaffected.
 *  TODO(standalone-relay-group-quiet-hours-deferral): */
allowDefer?: boolean;   // default true
```

When `allowDefer` is false AND `preview.deferred` is true: the footer is
`[Cancel] [<confirmLabel>]` - no "Send now anyway", no "Open at 8:00 AM" - and
the quiet-hours warning line still renders. `onConfirm(false)` is called;
`force` carries no meaning because `POST /api/relay-groups` has no force
parameter. `deferLabel` is unused on this path.

When `allowDefer` is true (tour, placement) nothing changes.

RATIONALE: `POST /api/relay-groups` has no quiet-hours handling. Tours and
placements defer by writing a `pendingRosterActionsRepo` row keyed
`` `${ownerType}#${ownerId}#open` `` with an owner type of `tour | placement`; a
standalone create has no owner id. Deeper: a pending `open_group` row stores NO
roster and re-resolves from the owner when it fires, so a standalone deferral
needs a new row shape carrying its own member list. Showing an "Open at 8:00 AM"
button the endpoint would ignore is exactly the lie `RosterConfirmDialog` exists
to prevent.

### 6.8 Wiring

`ContactDetail` owns the modal state and already holds the contact roster and
`navigate`. It passes `onCreateRelayGroup` to `TenantFile` and `LandlordFile`,
which forward it to `GroupTextsCard`. `PartnerFile` and `UnknownFile` do not
render this card and are untouched.

## 7. Testing

Unit (Vitest):

- NEW `app/test/rosterEdits.test.ts` (no such file exists today): the core's
  count rule against a shared-phone roster whose FIRST member on a number is
  opted out (must count 0, not 1); body names vs recipient names when they
  differ; quiet on/off against a fixed clock.
- Parity test: the same member set through the owner path and the standalone
  builder yields the same `body`, `recipients`, `recipientCount`, and quiet
  fields. Its fixture MUST contain NO suppressed members AND NO two members
  sharing a phone. Both constraints are load-bearing and for different reasons:
  the reachability rules differ by design (6.2), and the count is DERIVED from
  reachability, so a suppressed member makes the count comparison incoherent;
  and only the STANDALONE side de-duplicates by phone (6.2 step 4), so a shared
  phone makes the `recipients` comparison fail on a difference the design
  intends. Each excluded case gets its OWN test rather than being folded in:
  (a) an opted-out-by-phone-STOP member that `isMemberSuppressed` catches and
  `describeRoster`'s rule does not; (b) a shared-phone roster where the owner
  path lists both members and the standalone path lists one.
- Existing tour/placement preview tests, UNMODIFIED, as the no-behavior-change
  proof.
- Route: 400 on empty/absent members, 400 on a bad member, an opted-out member
  listed but excluded from the count, same-phone members collapsed to ONE
  recipient (matching what create will actually put on the thread), `deferred`
  true/false against the injected clock, a propagated `isMemberSuppressed`
  failure surfacing as a 5xx rather than a preview claiming everyone is
  reachable, and that nothing is provisioned.
- `GroupTextsCard`: renders the action when `onCreate` is set, not when absent.
- `CreateRelayGroupModal`: seeds the contact, blocks Create below 2 rows,
  refuses to add uncommitted free text, filters already-added, phone-less, and
  same-phone candidates, sends a `name` only when built from first/last, renders
  "Unnamed number" for a nameless pick, previews before confirming, posts the
  identical members array to both calls, keeps the picker mounted-and-restored
  around the confirm dialog, and keeps the dialog open on failure.
- The connecting result: a create returning `status: 'connecting'` leaves the
  MODAL open showing the unsent-intro notice and a `Go to the group` button, and
  does NOT navigate; a create returning an open group navigates immediately and
  shows no notice.
- `RosterConfirmDialog`: `allowDefer={false}` inside quiet hours renders the
  two-button footer with `confirmLabel`, still shows the warning, and calls
  `onConfirm(false)`; the default is unchanged.

E2E (Playwright, accessibility-first selectors): one spec driving contact file
-> `+ Create group` -> add a member -> confirm -> lands on the conversation. It
MUST use `e2e/fixtures/relayConnect.ts`: a fresh pair lands CONNECTING in the
hermetic lane (section 2.9), so assert the connecting landing, then use
`driveConnectingGroupToOpen` before asserting any intro. Do not assert an intro
in the dev outbox straight after create - it will not be there.

Gates, bare, from the worktree: `npm run typecheck`, `npm test`, `npm run e2e`.

## 8. Risks and watch items

- The `rosterEdits` refactor touches a service two LIVE routes depend on. The
  untouched existing tests are the gate.
- `RosterConfirmDialog` is shared by TourDetail, PlacementDetail, and
  PeopleCard - THREE call sites, not two. `allowDefer` must default to true and
  all three existing usages must be left alone.
- Previews carry names, never phone numbers. The new route must hold that line.
  The modal MAY send a client-derived name, but ONLY one built from
  `firstName`/`lastName` - never via `contactDisplayName`, whose phone fallback
  is exactly how a number would leak into the preview and the intro (6.5).
- This change authors NO new outbound copy; it reuses `relay.intro`. The
  connecting notice (6.6) is in-dashboard UI text, not an outbound message, so
  it does not go through the message catalog.
- PER-MEMBER COST: the name resolution does one `contacts.getById`, and
  `isMemberSuppressed` independently does its own contact read (by id, or
  `findByPhone`) PLUS a `findByParticipantPhone` GSI query. That is two contact
  reads and one GSI query per member, and the two reads use different resolution
  rules. Acceptable for a picked roster of single digits; never use this shape
  over an unbounded list.
- ACCEPTED TRADE (human decision, 2026-08-17): on tier 3 the confirm dialog
  still says "N recipients will receive this" at the only moment the operator
  can cancel, and the correction arrives only AFTER the irreversible create. The
  alternative was editing a dialog three shipped surfaces depend on. Section 9
  files the wording gap.

## 9. Follow-up issues to file in this change

Copy `docs/issues/_TEMPLATE.md` for each:

1. `standalone-relay-group-quiet-hours-deferral.md` - a standalone relay group
   created during quiet hours sends its intro immediately; full parity needs a
   third owner type, a pending row carrying its own member list, and a poller
   path that provisions from stored members. Referenced from the `allowDefer`
   prop comment.
2. `relay-confirm-dialog-overstates-tier3-send.md` - `RosterConfirmDialog` says
   "N recipients will receive this" on all three surfaces, but a tier-3
   `connecting` create sends nothing until a warmed number registers.
3. `relay-intro-editable-but-never-overridden.md` - `relay.intro` is
   `editable: true` in the catalog, but `composeIntroBody` never passes
   overrides, so an operator edit is silently inert.
4. `relay-provisioning-stale-comments.md` - stale comments that assert the
   opposite of, or omit, what the code does: `services/relayProvisioning.ts:87`
   claims provisioning never throws the kill-switch error (contradicted by
   `poolNumbers.ts:577-579`); the `poolNumbers.ts:5-13` file header still
   describes the pre-tier-3 behavior "(c) else PROVISION a fresh one through the
   adapter" (contradicted by `poolNumbers.ts:566-589`); and the dashboard
   `ConversationHeader.status` docblock omits `'connecting'`, which the server
   really sends. All three mislead a reader of otherwise-correct code.

Items 2-4 are pre-existing defects this review surfaced, NOT regressions from
this change.

## 10. Post-merge obligations

None expected. No dependency, schema, GSI, infra, or environment change.
