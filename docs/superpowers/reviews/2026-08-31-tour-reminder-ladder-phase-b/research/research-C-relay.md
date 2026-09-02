# Research C - RELAY side worklist (plan Tasks 1, 13, 14)

Base: `feat/tour-reminder-ladder-phase-b`, main @ec32170a. All paths relative to
`W:\tmp\tour-reminder-ladder-phase-b`. Every line number below was read from the
live tree.

---

## 0. DRIFT FLAGS (blocking first)

| # | flag | fix |
|---|---|---|
| D1 | **`ToursRepo` has NO `getById`.** `app/src/repos/toursRepo.ts:131` is `get(tourId)`. Plan Task 14 Interfaces block declares `toursRepo: Pick<ToursRepo, 'getById'>` and step 2 says `toursRepo.getById`. | Use `Pick<ToursRepo,'get'>` / `toursRepo.get(id)`. `PlacementsRepo.getById` (`placementsRepo.ts:203`) and `UnitsRepo.getById` (`unitsRepo.ts:333`) ARE correct. |
| D2 | **relay-group-view e2e: plan's retarget contradicts spec 9.6.** Plan T14 s3 says retarget `relay-group-view.spec.ts:161,172` to the member_added copy. Both are `page.getByText(...)` on the DASHBOARD THREAD. Under 9.6 the persisted row (= the only bubble) carries the NEW MEMBER's body = the NAKED INTRO, which contains no "joined"/"adding" phrase at all. | Retarget :161/:172 to the naked-intro copy (`/You're now connected with/` + first name). The group body (`Hey, adding <name> to the group.`) is asserted on the fake OUTBOX of an EXISTING member, not in the thread. Path is also wrong: `e2e/tests/dashboard-next/relay-group-view.spec.ts` (not `e2e/tests/`). |
| D3 | **Undiscovered `{members}` split tripwire.** `e2e/tests/dashboard-next/contact-create-relay-group.spec.ts:203-215` does the SAME `MESSAGE_CATALOG['relay.intro'].default.split('{members}')` head/tail trick, with the same non-empty guards. Named nowhere in spec 10a.2 or the plan. | This spec is the STANDALONE (`POST /api/relay-groups`) path -> stays NAKED, so it is the correct home for the plan's "keep the split, aim at `{names}`" instruction. Retarget the literal to `'{names}'` here. |
| D4 | **`tour-roster.spec.ts:237-282` cannot keep the split.** Plan T14 s7 says "the split-on-literal tripwire stays aimed at the NAKED entry ... `tour-roster.spec.ts:252-269`", but that block asserts a **TOUR** preview (`GET /api/tours/:id/roster/preview-open`, line 248). Under 9.0 routing it is the tour intro, which opens with `{tenantFirstName}` -> `introHead` empty -> the spec's own guard fires. | Convert the whole block to resolved-copy assertions (plan's own later sentence); move the split trick to D3's file. True lines: comment 237-247, fetch 248-250, split 254-255, guards 256-267, startsWith/endsWith 268-269, name asserts 270-278, textarea value 279-282. |
| D5 | **`MessageId` union anchor wrong.** Plan T13 and spec 9.2a cite `catalog.ts:36-52`. The union is `export type MessageId =` at **`:28`**, members `:34-78`. Relay ids: `relay.intro` `:47`, `relay.member_added` `:49`, `relay.media_only` `:51`, `relay.group_closed` `:53`. |
| D6 | **`sendRelayAnnouncement` roster loop anchor wrong.** Spec 9.6 says `:190-294`. `:190-228` is the PERSIST block; the roster loop is **`:231-316`**; the per-leg `adapter.sendMessage` is `:255-259`. `sendRelayAnnouncement` at `:147` is correct. |
| D7 | **Plan T1's appended test block re-imports.** `resolve.test.ts` already has `import { describe, expect, it } from 'vitest'` (`:5`), `resolveMessage` (`:6`), `MESSAGE_CATALOG` (`:8`). Pasting the plan's block verbatim = duplicate-import TS/ESLint error. Append the `describe(...)` only. Also: the file is **already non-ASCII** (`§`, `—`, `→` on lines 1, 68, 86...) - the ASCII rule applies to ADDED lines only. |
| D8 | **Preview call sites: THREE routes, FIVE production sites** (plan T14 says "TWO routes but FOUR call sites"). `routes/tours.ts:936` (open) `:967` (add); `routes/placements.ts:1262` (open) `:1292` (add); `routes/relayGroups.ts:372` (standalone). |
| D9 | **`app/test/rosterEdits.test.ts` is unnamed by the plan and WILL break.** It imports all four builders (`:6-9`) and hand-builds `RosterResolutionDeps` in `ownerFixture` (`:118-135`) plus ~25 `buildStandaloneOpenPreview` / `buildOpenPreview` / `buildAddPreview` calls. Any widening of `RosterResolutionDeps` with REQUIRED members breaks every fixture. Make the new `tours`/`placements`/`settings` picks OPTIONAL (like the existing `actions?:` at `rosterResolution.ts:139`) and degrade to `variant:'naked'` when absent. |
| D10 | **Missed member_added pins.** Plan T14 s3's "full derived list" omits `app/test/toursApi.test.ts:4133-4135` (`composeMemberAddedBody('Casey Worker', [...])` preview-add pin) and `app/test/relayApi.test.ts:296` (`toContain("You're now connected with")`). Also `relayFanOut.test.ts:648` (`rows[0]!.body === world.sent[0]!.body`) breaks under 9.6 and is not in the list. |

Non-blocking notes: `catalog.test.ts:23` `tokensIn` uses `/\{(\w+)\}/g`, which is BROADER than
Task 1's `/\{([A-Za-z][A-Za-z0-9_]*)\}/g` (`\w` admits a leading digit/underscore). The
new structural test closes the gap; keep both. Spec 9.1's `catalog.ts:250-252`
housing-authority citation is really `:249-250`.

---

## 1. `interpolate` / `resolveMessage` (Task 1)

`app/src/messages/resolve.ts` - docblock `:9-23`, body `:24-45` (plan anchor CORRECT).

```ts
function interpolate(
  template: string,
  vars: Record<string, string> | undefined,
  allowed: readonly string[],
  strict: boolean,
): string {
  let out = template;
  for (const token of allowed) {
    const needle = `{${token}}`;
    if (!out.includes(needle)) continue;
    const value = vars?.[token];
    if (typeof value !== 'string') {
      if (strict) {
        throw new Error(`resolveMessage: missing interpolation var "${token}"`);
      }
      out = out.split(needle).join('');
      continue;
    }
    out = out.split(needle).join(value);
  }
  return out;
}
```

`resolveMessage` `:52-65` (UNCHANGED by this task):

```ts
export function resolveMessage(
  id: MessageId,
  vars?: Record<string, string>,
  overrides?: Partial<Record<MessageId, string>>,
): string {
```

Strict/override split `:57-64`: `const override = def.editable ? overrides?.[id] : undefined;`
`usingOverride = typeof override === 'string' && override.length > 0;`
`interpolate(template, vars, def.vars, !usingOverride)`.
`settingsToOverrides` `:74-79` maps ONLY `welcomeText` -> `welcome.sms` and
`missedCallAutoText` -> `missed_call.autotext`.

**Brief item 8, both answers YES.** `relay.member_added` declares
`vars: ['joined', 'members']` (`catalog.ts:305`) and is `editable: false` (`:303`),
so it is a valid strict probe. `resolveMessage` DOES take a third `overrides` arg
(`resolve.ts:55`). `relay.media_only` exists, `vars: ['name']`, `editable: true`
(`catalog.ts:309-316`) - the plan's override-path probe works.

### Existing cases in `app/test/messages/resolve.test.ts` (134 lines, PRESERVE ALL)

| line | case | pins |
|---|---|---|
| :21 | returns the catalog default when no override is supplied | `relay.group_closed` |
| :25 | an override WINS for an editable entry | |
| :32 | an override is IGNORED for a non-editable entry | `keyword.stop` |
| :39 | an empty-string override falls through to the default | |
| :44 | substitutes a declared token | `verify.cell_code` |
| :50 | substitutes every occurrence and only declared tokens | `{other}` stays literal |
| :57 | an operator OVERRIDE degrades gracefully (no throw) | `'Hi , welcome!'` |
| :73 | THROWS when a catalog DEFAULT declares a token but no value | `/missing interpolation var/` |
| :79 | does NOT require a declared var absent from the template | `WELCOME_SMS` |
| :85-107 | `settingsToOverrides` (2 cases) | |
| :109-134 | `resolveWithSettings` (3 cases) | |

### Token charset - EVERY declared var today

Export name for the structural test: **`MESSAGE_CATALOG`** (`catalog.ts:105`,
`Record<MessageId, MessageDef>`). Full declared-var set, read from source:
`TOUR_NAME_VARS` (`catalog.ts:100-103`) = `when, time, tenantFirstName,
tenantName, propertyContactFirstName, propertyContactName`; plus `where`,
`addressLine`, `members`, `joined`, `name`, `firstName`, `callerLabel`,
`targetLabel`, `code`. **All match `/^[A-Za-z][A-Za-z0-9_]*$/`.** The five new
ids add `names`, `role` - also matching.

---

## 2. Catalog (Task 13)

`MessageId` union - `app/src/messages/catalog.ts:28-78`, byte-exact relay slice:

```ts
  // Operational — relay group intro (jobs/relayFanOut.ts)
  | 'relay.intro'
  // Operational - relay group member-added announcement (jobs/relayFanOut.ts)
  | 'relay.member_added'
  // Operational - relay group media-only fan-out body (jobs/relayFanOut.ts)
  | 'relay.media_only'
  // Operational - relay group closed final message (routes/relayGroups.ts close)
  | 'relay.group_closed'
```

`MessageDef` `:80-97` (fields: `id, default, class, editable, channel, vars,
requiresOptOut?, maxChars?, dead?`).

Docblock block for the two relay entries: **`:228-280`** (founder decisions
2026-08-18 / 2026-08-20, superseded wordings `:252-258`, "Sam is hardcoded"
`:264-266`, editable:false rationale `:266-280`). The housing-authority removal
sentence is `:249-250` (`// Same removal for the housing-authority sentence:
updates come from the landlord, not from Sam.`).

Entries, byte-exact:

```ts
  'relay.intro': {
    id: 'relay.intro',
    default:
      "Hey, it's Sam. {members} Use this group text for anything that comes up. It can be a " +
      'long process, so ask me anything in here!',
    class: 'operational',
    editable: false,
    channel: 'sms',
    vars: ['members'],
  },                                                       // :281-290
```

```ts
  'relay.member_added': {
    id: 'relay.member_added',
    default: 'Hey! {joined} {members}',
    class: 'operational',
    editable: false,
    channel: 'sms',
    vars: ['joined', 'members'],
  },                                                       // :299-306
```

member_added docblock `:291-298`; note it already records the missing ROLE token
and `TODO(founder-message-template-updates-owed)`.

### Catalog tests that pin them - `app/test/messages/catalog.test.ts` (134 lines)

| plan anchor | TRUE lines | asserts |
|---|---|---|
| `:35-41` | `:35-41` CORRECT | every `{token}` in a default is declared in `vars` |
| `:43-52` | `:43-54` (it at 43, loop 47-53) | a NON-editable entry uses every declared var (no dead tokens) |
| `:62-69` | `it` at `:62`, block `:62-70` | `relay.intro`/`relay.member_added` `editable === false` (`:63-64`) **and the THROWING tripwire `:67-69`**: `resolveMessage('relay.intro', { members: 'M.' }, {...})` compared to `.default.replace('{members}', 'M.')` |
| not named | `:109-110` | neither relay default contains `'Reply STOP'` - SURVIVES the new copy |
| not named | `:117` | `relay.intro` default has no `SMS_BRAND_NAME` - SURVIVES |
| not named | `:120` | `relay.intro` default has no `'housing authority'` - SURVIVES (assertion is scoped to `relay.intro`; the new `relay.intro_placement` is a different id, exactly as spec 9.1 says) |
| not named | `:19`, `:22-24` | `entries` = `Object.entries(MESSAGE_CATALOG)`; `tokensIn` regex `/\{(\w+)\}/g` |

---

## 3. `app/src/jobs/relayFanOut.ts` (Tasks 13, 14)

| symbol | line | note |
|---|---|---|
| `RELAY_INTRO_JOB` / `RELAY_MEMBER_ADDED_JOB` | `:54`, `:55` | `'relay.intro'`, `'relay.memberAdded'` |
| `firstNameOnly` (module-private) | `:180-182` | `name.trim().split(/\s+/)[0] ?? name.trim()` |
| `composeConnectionSentence` | `:189-206` | exported |
| `composeIntroBody` | `:217-221` | exported |
| `ANONYMOUS_JOINED_LABEL` | `:224` | `const ANONYMOUS_JOINED_LABEL = 'A new member';` module-private, NOT exported |
| `composeMemberAddedBody` | `:238-250` | exported |
| intro job handler | `:608-657` | plan anchor CORRECT |
| member-added job handler | `:664-698` | plan anchor CORRECT |

`composeConnectionSentence` full body (`:189-206`):

```ts
export function composeConnectionSentence(memberNames: (string | undefined)[]): string {
  const named = memberNames
    .map((n) => (n && n.trim().length > 0 ? firstNameOnly(n) : undefined))
    .filter((n): n is string => n !== undefined);
  if (named.length === 0) {
    const others = Math.max(memberNames.length - 1, 0);
    return others > 0
      ? `You're now connected with ${others} other ${others === 1 ? 'person' : 'people'} on this number. Reply here and everyone in the group sees it.`
      : `You're now connected on this number. Reply here and the group sees it.`;
  }
  const list =
    named.length === 1
      ? named[0]
      : named.length === 2
        ? `${named[0]} and ${named[1]}`
        : `${named.slice(0, -1).join(', ')}, and ${named[named.length - 1]}`;
  return `You're now connected with ${list} on this number. Reply here and everyone in the group sees it.`;
}
```

Note the zero-others branch (`others === 0`) RESTRUCTURES the sentence today -
spec 9.2's table replaces it with `1 other person`. Confirms spec 9.2.

`composeIntroBody` / `composeMemberAddedBody`:

```ts
export function composeIntroBody(memberNames: (string | undefined)[]): string {
  return resolveMessage('relay.intro', { members: composeConnectionSentence(memberNames) });
}                                                                          // :217-221

export function composeMemberAddedBody(
  newMemberName: string | undefined,
  memberNames: (string | undefined)[],
): string {
  const who =
    newMemberName && newMemberName.trim().length > 0
      ? firstNameOnly(newMemberName)
      : ANONYMOUS_JOINED_LABEL;
  return resolveMessage('relay.member_added', {
    joined: `${who} joined this group chat.`,
    members: composeConnectionSentence(memberNames),
  });
}                                                                          // :238-250
```

### Intro job handler `:608-657` - the pieces Task 14 touches

- lazy deps `:610-613`: `adapter ??= createMessagingAdapter({ logger: deps.logger });`
  then `conversations`, `messages`, `contacts` - the pattern to mirror for
  `units`/`tours`/`placements`/`settings`. Declared as `let` at `:319-322` in the
  registrar closure (`registerRelayFanOutJobHandler`, `:316`); `RelayFanOutJobDeps`
  is `:300-314`.
- idempotency marker `:615-622` (`putJobExecutionMarker`) - **precedes** all composition,
  which is why a strict-mode throw loses the announcement (spec 9.4).
- conversation read `:626`, roster `:627` (`(conversation?.participants ?? []) as ConversationParticipant[]`).
- **edited-body precedence, verbatim `:633-634`:**
  ```ts
  const edited = typeof conversation?.intro_body === 'string' ? conversation.intro_body : '';
  const body = edited.length > 0 ? edited : composeIntroBody(roster.map((m) => m.name));
  ```
- `sendRelayAnnouncement` call `:641-656`; `persist:false` spread at `:654`
  (`...(payload.persist === false && { persist: false })`), `kind: 'relay.intro'` `:653`.

### Member-added handler `:664-698`

- payload parse `:286-298`; **`addedMemberKey` is `relayMemberKey(member)`**
  (`messagesRepo.ts:157-161`: `contactId` when non-empty, ELSE `phone#<E164>`) -
  written at `services/relayMembers.ts:261-264`. So it is NOT a contactId in
  general: the resolver's `addedContactId` must come from
  `roster.find(m => relayMemberKey(m) === payload.addedMemberKey)?.contactId`.
- `:680-686`: read conversation, roster, `added = roster.find(...)`,
  `composeMemberAddedBody(added?.name, roster.map(m => m.name))`.
- `:687-697`: `sendRelayAnnouncement(..., { conversationId, body, kind: 'relay.member_added' })`
  - NO `persist` key, so persist defaults true (spec 9.6's note is accurate).

### Importers of each symbol (app-wide grep; the "still compiles" list)

| symbol | importer/site |
|---|---|
| `composeIntroBody` | `app/src/services/rosterEdits.ts:38` (import), `:473` (call); `app/src/jobs/relayFanOut.ts:634`; tests `app/test/relayFanOut.test.ts:28,674,675,676,678,688,697`; `app/test/toursApi.test.ts:25,3998,4096`; `app/test/placementsApi.test.ts:31,989`; `app/test/relayGroupPreview.test.ts:12,151,208` |
| `composeMemberAddedBody` | `rosterEdits.ts:38` (import), `:673` (call); `relayFanOut.ts:683`; tests `relayFanOut.test.ts:29,704,712,715`; `toursApi.test.ts:26,4134`; `placementsApi.test.ts:32,1007` |
| `composeConnectionSentence` | **ZERO code importers.** Only prose mentions: `app/src/lib/groupTitle.ts:60`, `app/src/services/relayGroupDuplicates.ts:11`, `app/test/groupTitle.test.ts:88`, `app/test/relayGroupDuplicates.test.ts:322`. Plan's "grep until zero hits" must include these four comments. |
| `ANONYMOUS_JOINED_LABEL` | not exported; sole use `relayFanOut.ts:245` |
| catalog prose naming the composers | `catalog.ts:261,272,276,293`; `rosterEdits.ts:21-22` |
| `isMemberSuppressed` re-export | `relayFanOut.ts:51` (from `services/relayAnnouncements.js`) - unchanged |

Intro-job ENQUEUE sites (all reach the new routing): `services/relayProvisioning.ts:199`,
`jobs/relayNumberReady.ts:176`, `routes/dev.ts:965` (`persist: false`, the replay seam).
Member-added enqueue: `services/relayMembers.ts:261`.

---

## 4. `app/src/services/rosterEdits.ts` (Task 14)

| symbol | line |
|---|---|
| header contract "same composers ... or a template edit silently diverges" | `:19-25` (spec's `:21-22` is inside it) |
| `RosterPreview` (has `body`) | `:324-341` |
| `QuietHoursState` | `:348-351` |
| `PreviewBodyMember` | `:420-423` |
| `PreviewRecipientRow` | `:427-435` |
| `OpenPreviewParts` | `:443-448` |
| `buildOpenPreviewFromParts` | `:464-481` (composer call `:473`) |
| `FindDuplicateFn` | `:493-495` |
| `buildOpenPreview` | `:508-559` (docblock `:497-507`) |
| `buildStandaloneOpenPreview` | `:586-638` (docblock `:561-585`) |
| `RosterCandidate` | `:641-646` |
| `buildAddPreview` + docblock | docblock `:648-657`, fn `:658-702`, composer call `:673-676` |
| `resolveRosterCandidate` | `:709-748` |

Signatures, byte-exact:

```ts
export function buildOpenPreviewFromParts(
  parts: OpenPreviewParts,
  quiet: QuietHoursState,
): RosterPreview                                                            // :464-467

export async function buildOpenPreview(
  deps: RosterResolutionDeps,
  owner: RosterOwner,
  quiet: QuietHoursState,
  findDuplicate?: FindDuplicateFn,
): Promise<RosterPreviewOutcome>                                            // :508-513

export async function buildStandaloneOpenPreview(
  deps: {
    contacts: ContactsRepo;
    conversations: ConversationsRepo;
  },
  members: ConversationParticipant[],
  quiet: QuietHoursState,
  findDuplicate?: FindDuplicateFn,
): Promise<RosterPreview>                                                   // :586-594

export async function buildAddPreview(
  deps: RosterResolutionDeps,
  owner: RosterOwner,
  candidate: RosterCandidate,
  quiet: QuietHoursState,
): Promise<RosterPreviewOutcome>                                            // :658-663
```

`buildAddPreview` docblock to AMEND (`:648-657`) says the body is "the
relay.member_added body the **WHOLE group** receives" and claims parity with the job.

`RosterResolutionDeps` - `app/src/lib/rosterResolution.ts:128-141`:

```ts
export interface RosterResolutionDeps {
  conversations: Pick<ConversationsRepo, 'getById'>;
  units: Pick<UnitsRepo, 'getById'>;
  contacts: Pick<ContactsRepo, 'getById'>;
  actions?: Pick<PendingRosterActionsRepo, 'listByOwner'>;
  log: Logger;
}
```

`RosterOwner` - `rosterResolution.ts:70-79`:

```ts
export interface RosterOwner {
  type: 'tour' | 'placement';
  id: string;
  tenantId: string;
  unitId: string;
  groupThreadId?: string;
  roster?: RosterEntry[];
}
```

**Useful:** `RosterOwner` ALREADY carries `tenantId` and `unitId`, so the preview
side needs the tours/placements read only for `scheduledAt` (tour variant). The
JOB side has only `{type,id}` from `getOwner`, so the shared resolver must still
read the owner row.

### All five production call sites, with how deps are constructed

| site | route | deps |
|---|---|---|
| `routes/tours.ts:936-940` | `GET /api/tours/:tourId/roster/preview-open` | `rosterDeps` (`tours.ts:520`: `{ conversations, units, contacts, actions: rosterActions, log }`), `rosterOwnerOf(tour)` (`:576-586`), `await quietHoursState()` (`:635-637`), 4th arg `findOpenGroupWithSamePhones({conversations, log}, phones)`. Tour read is `tours.get(tourId)` (`:926`). 409s `relay_already_provisioned` when `threadIdOf(tour)` set (`:932-936`). |
| `routes/tours.ts:967-972` | `POST /api/tours/:tourId/roster/preview-add` | same `rosterDeps` + `rosterOwnerOf(tour)` + `resolvedCandidate.candidate` + quiet. 409 `ROSTER_NO_THREAD` pre-open. |
| `routes/placements.ts:1262-1266` | `GET /api/placements/:id/roster/preview-open` | `rosterDeps` (`placements.ts:923-931`, same 5 fields), `rosterOwnerOf(item)` (`:942-951`), quiet (`:999-1004`). Item read is `placements.getById(...)`. |
| `routes/placements.ts:1292-1297` | `POST /api/placements/:id/roster/preview-add` | same |
| `routes/relayGroups.ts:372-377` | `POST /api/relay-groups/preview` | ad-hoc `{ contacts, conversations }` - **no `RosterResolutionDeps`, no owner**. This is the null-owner path; its pins re-verify UNCHANGED. |

Both owner routes already close over `units`, `settingsRepo`, `tours`/`placements`
in the same factory scope, so adding the picks to `rosterDeps` is a one-line
change per route.

---

## 5. `app/src/services/relayAnnouncements.ts` (Task 14 step 4)

```ts
export interface RelayAnnouncementInput {
  conversationId: string;
  /** Fully-composed announcement text - sent verbatim to every member. */
  body: string;
  /** Log/observability tag ... */
  kind: string;
  /** false = legs-only (dev intro replay): send, persist nothing. Default true. */
  persist?: boolean;
}                                                                           // :111-119
```

`RelayAnnouncementDeps` `:99-109`. `RelayAnnouncementResult` `:121-125`.
`sendRelayAnnouncement` `:147-323`.

| what | line | note |
|---|---|---|
| `const { conversationId, body, kind } = input;` | `:153` | |
| `const persist = input.persist !== false;` | `:154` | |
| usability gate (type/status/pool/roster) | `:168-181` | |
| PERSIST block | `:190-228` | seeds `delivery_recipients` `:191-194`; `messagesRepo.append({... body })` `:196-207` |
| **`touchLastActivity(conversationId, body, providerTs)`** | `:213-217` | inbox preview inherits the PERSISTED body - spec 9.6 correct |
| `events.emit('message.persisted', ...)` | `:222-227` | |
| **roster loop** | `:231-316` | (spec's `:190-294` is wrong - D6) |
| suppression skip | `:238-250` | |
| `tokenBucket.acquire(1)` | `:254` | |
| **`adapter.sendMessage({ to, from: poolNumber, body })`** | `:255-259` | THE line `bodyFor` must feed: `const legBody = input.bodyFor?.(member) ?? body;` |
| `persist:false` -> `putSystemSidMarker` only | `:262-279` | no slots, no pointers - `bodyFor` still drives copy |
| slot + relaysid pointer | `:281-294` | |

`persist:false` semantics confirmed: legs are sent, NOTHING is appended, no
`touchLastActivity`, no `message.persisted` event. Only `routes/dev.ts:965` uses it.

---

## 6. Owner / repo / helper contracts (Task 14 step 2)

`getOwner` - `app/src/repos/conversationsRepo.ts:385-400` (spec anchor `:385` CORRECT).
Return type `RelayOwner` `:376`:

```ts
export type RelayOwner = { type: 'tour' | 'placement'; id: string } | { type: null };
```

Body: `conv.owner` wins (tour/placement with string id), else `{type:null}`;
legacy `conv.placementId` non-empty -> `{type:'placement', id}`; else `{type:null}`.
`ConversationItem.owner` declared `:223` (`{ type: 'tour'|'placement'|null; id?: string }`),
`intro_body` `:236`, `participants` shape `ConversationParticipant` `:104-109`
(`contactId: string; phone: string; name?: string`).
Write site for `intro_body`: `conversationsRepo.ts:1902` (spec anchor CORRECT).
`relayMemberKey` - `app/src/repos/messagesRepo.ts:157-161`.

| contract | truth |
|---|---|
| tours getter | `ToursRepo.get(tourId): Promise<TourItem \| undefined>` - `toursRepo.ts:131` (**NOT `getById`**) |
| placements getter | `PlacementsRepo.getById(placementId)` - `placementsRepo.ts:203` |
| units getter | `UnitsRepo.getById(unitId)` - `unitsRepo.ts:333` |
| contacts getter | `ContactsRepo.getById(contactId, opts?)` - `contactsRepo.ts:593` |
| `TourItem` | `tenantId: string` `:69`, `unitId: string` `:71`, **`scheduledAt?: string`** `:77` (OPTIONAL - absent on `requested` tours -> spec 9.5 naked), `groupThreadId?` `:84`, `tourType` `:80` |
| `PlacementItem` | `tenantId: string` `:103`, `unitId: string` `:105`, `group_thread?: string` `:114`. **No `scheduledAt`** - placement intro needs none (spec 9.2a: `tenantFirstName, propertyContactFirstName, where`) |
| `UnitContact.role` | `'landlord' \| 'pm' \| 'owner' \| 'other'` - `unitsRepo.ts:69` (spec anchor CORRECT). `UNIT_CONTACT_ROLES` `:77-82`. `unitContacts(unit)` `:295-303` synthesizes `{contactId: landlordId, role: 'landlord', primaryContact: true}` when `contacts` is empty |

```ts
export async function resolveTourContactNames(args: {
  tenantId: string;
  unit: UnitItem | undefined;
  tenantContact?: ContactItem;
  contactsRepo: Pick<ContactsRepo, 'getById'>;
  logger?: Logger;
}): Promise<ResolvedTourNames>                    // lib/tourContacts.ts:96-104
```

Returns `{ names: TourContactNames; tenantReadFailed: boolean; propertyReadFailed: boolean }`
(`:13-28`). NEVER throws. `inertName` brace-strips (`:60-62`). Property contact =
unit primary contact, else `landlordId`, **de-duped against `tenantId`** (`:138-139`).

```ts
export function formatStreet(a: Address | string | undefined): string   // lib/address.ts:90-104
export function formatLocalDate(iso: string, timezone: string): string  // lib/localTime.ts:55-57  "Thu, Jul 23"
export function formatLocalTime(iso: string, timezone: string): string  // lib/localTime.ts:60-62  "3:00 PM"
export function resolveQuietHoursTimezone(
  settings: { timezone: string },
  _contact?: unknown,
): string                                                               // lib/quietHours.ts:39-44
```

`formatStreet` is TOTAL (returns `''` for null/undefined). `formatLocal*` THROW
RangeError on an unparseable instant - wrap per spec 9.3's degrade-to-naked rule.
`OrgSettings.timezone` `settingsRepo.ts:140`, default `'America/New_York'` `:176`;
`getOrgSettings()` `settingsRepo.ts:189`.

Phase A's `'there'` fallback the plan cites as `tourCopy.ts:80-85` is really
**`app/src/messages/tourCopy.ts:79-84`**:

```ts
  const nameVars = {
    tenantFirstName: names.tenantFirstName ?? 'there',
    tenantName: names.tenantName ?? names.tenantFirstName ?? 'there',
    propertyContactFirstName: names.propertyContactFirstName ?? '',
    propertyContactName: names.propertyContactName ?? '',
  };
```

`{when}` is built as `` `${date} at ${time}` `` (`tourCopy.ts:118`) - matches spec 9.1's
"Tue, Sep 8 at 3:00 PM" and its "on {when}" ruling.

---

## 7. THE RELAY TRIPWIRE INVENTORY

`T13` = breaks at Task 13 (`{members}` -> `{names}` rename / naked-intro rewrite).
`T14` = breaks at Task 14 (owner routing, member_added split, composer signatures, 9.6).

### 7a. Unit / API suites

| file:line | expectation (quoted) | task |
|---|---|---|
| `app/test/messages/catalog.test.ts:67-69` | `resolveMessage('relay.intro', { members: 'M.' }, {...})` vs `.default.replace('{members}', 'M.')` - **THROWS** after the rename (strict + non-editable) | T13 |
| `app/test/messages/catalog.test.ts:63-64` | `MESSAGE_CATALOG['relay.intro'/'relay.member_added'].editable === false` | survives; extend to the 4 new ids |
| `app/test/messages/catalog.test.ts:109,110,117,120` | no `'Reply STOP'`, no `SMS_BRAND_NAME`, no `'housing authority'` in `relay.intro` | survive |
| `app/test/messages/resolve.test.ts:*` | Task 1 probe uses `relay.member_added` old shape | switch to `relay.member_added_role` at T14 |
| `app/test/relayFanOut.test.ts:28-29` | imports `composeIntroBody, composeMemberAddedBody` | T13/T14 (signature) |
| `app/test/relayFanOut.test.ts:521-533` | intro job: each body `toContain('Alice'/'Bob'/'Carol')` | survives (naked, no owner - `seedRelay` `:45-65` writes no `owner`/`placementId`) |
| `app/test/relayFanOut.test.ts:551` | edited-intro case: `not.toContain("You're now connected with")` | survives (precedence 1 unchanged) |
| `app/test/relayFanOut.test.ts:563` | blank edited -> `toContain("You're now connected with")` | survives |
| `app/test/relayFanOut.test.ts:642` | `world.sent[0]!.body` `toContain('Carol joined this group chat.')` | T14 - Alice's leg becomes `Hey, adding Carol to the group.` |
| `app/test/relayFanOut.test.ts:643` | `toContain('Alice, Bob, and Carol')` | T14 - group body has no name list |
| `app/test/relayFanOut.test.ts:648` **(plan misses)** | `expect(rows[0]!.body).toBe(world.sent[0]!.body)` | T14 - 9.6 makes them DIFFER (row = new member's naked intro) |
| `app/test/relayFanOut.test.ts:662` | `toContain('A new member joined this group chat.')` (raced-remove case) | T14 -> `Hey, adding a new member to the group.` |
| `app/test/relayFanOut.test.ts:674-678` | `composeIntroBody([...])` Oxford / `/connected with 1 other person/` | T13 signature + move to `composeNameList` |
| `app/test/relayFanOut.test.ts:686-694` | intro has no brand, no `Reply STOP`, still `"it's Sam"` | survives for naked; parameterize |
| `app/test/relayFanOut.test.ts:696-701` | `'Brenda and Sam'`, not `'Morris'`/`'Whitfield'` | T13 signature |
| `app/test/relayFanOut.test.ts:703-717` | `'Carol joined this group chat.'`, `"You're now connected with Alice, Bob, and Carol"`, `'A new member joined this group chat.'` x2 | T14 |
| `app/test/toursApi.test.ts:25-26` | composer imports | T13/T14 |
| `app/test/toursApi.test.ts:3813` | live-add: `world.sent[0]!.body` `toContain('Casey joined this group chat.')` | T14 |
| `app/test/toursApi.test.ts:3998` | `res.body.body).toBe(composeIntroBody(['Tina Tenant','Pat Manager']))` - TOUR preview | T13 sig + **T14 variant** |
| `app/test/toursApi.test.ts:4096` | same with `['Tina Tenant','Pat Manager','Otto Out']` | T13 sig + T14 variant |
| `app/test/toursApi.test.ts:4133-4135` **(plan misses)** | `composeMemberAddedBody('Casey Worker', [...])` preview-add pin | T14 |
| `app/test/placementsApi.test.ts:31-32` | composer imports | T13/T14 |
| `app/test/placementsApi.test.ts:989` | `open.body.body).toBe(composeIntroBody(['Tasha Tenant','Pat Manager']))` - PLACEMENT preview | T13 sig + T14 variant |
| `app/test/placementsApi.test.ts:1007` | `composeMemberAddedBody('Casey Worker', [...])` | T14 |
| `app/test/relayGroupPreview.test.ts:12,151,208` | standalone preview `.toBe(composeIntroBody([...]))` | T13 signature ONLY - **value re-verifies UNCHANGED** (null-owner path) |
| `app/test/relayApi.test.ts:296` **(plan misses)** | standalone create: every `sent.body` `toContain("You're now connected with")` | survives (naked) - verify, do not move |
| `app/test/relayApi.test.ts:1046` | `world.sent[0]!.body` `toContain('Bob joined this group chat.')` (standalone add) | T14 -> Alice's leg = `Hey, adding Bob to the group.` |
| `app/test/relayApi.test.ts:1052` | `systemRows.some(m => m.body.includes('Bob joined this group chat.'))` | T14 -> persisted row is Bob's NAKED INTRO (9.6) |
| `app/test/rosterEdits.test.ts:6-9,118-135,~25 call sites` **(plan misses)** | builder imports + hand-built `RosterResolutionDeps`; `:488-495` pins that a nameless roster still degrades to the count phrasing | T13/T14 - see D9 |
| `app/test/relayAnnouncements.test.ts:47,56,85,100` | `kind: 'relay.intro'` marker/warn tags | survive; add a `bodyFor`-omitted byte-identity case here |
| `app/test/rosterActionsPoll.test.ts:297-315` | deferred add applied at quiet-end "the whole group was told" | check its body needles at build time |
| `app/test/devRelayReplay.test.ts:227+` | `persist:false` replay persists no rows | survives |

### 7b. E2E

| file:line | expectation | task |
|---|---|---|
| `e2e/scenarios/steps.ts:1887` | `this.page.getByText(/You're now connected with/)` in the tour's DASHBOARD thread, inside `teamOpensTourGroup` (`:1833-1890`) | **T14** - tour-owned -> tour intro. Breaks all **6** callers: `e2e/tests/scenarios/tours.spec.ts:111,189,385`, `approval-and-move-in.spec.ts:118`, `post-tour-application.spec.ts:99`, `dashboard-next/relay-number-lifecycle.spec.ts:283` |
| `e2e/scenarios/steps.ts:1923-1952` (`expectGroupIntros`), poll body `:1930-1949`, needle `/You're now connected with/` at `:1942` | every member's fake thread | **T14**. Callers: `tours.spec.ts:112,190,386` |
| `e2e/tests/tour-roster.spec.ts:237-282` (split at `:254-255`) | `MESSAGE_CATALOG['relay.intro'].default.split('{members}')` head/tail against a **TOUR** preview | T13 **and** T14 (double break, per spec 10a.2). See D4 |
| `e2e/tests/dashboard-next/contact-create-relay-group.spec.ts:203-215` **(UNLISTED)** | same split trick, on the **STANDALONE** preview textarea | **T13**. See D3 |
| `e2e/tests/dashboard-next/relay-group-view.spec.ts:161` | `page.getByText('Leon joined this group chat')` in the thread. Group is `conv-live-relay-group`, **`owner: {type:'tour', id: LIVE_IDS.tourTomorrow}`** (`app/src/lib/seed/live.ts:301`) | **T14** - thread bubble becomes the NAKED intro (9.6). See D2 |
| `e2e/tests/dashboard-next/relay-group-view.spec.ts:170-172` | `'A new member joined this group chat'` - the ONLY nameless-joiner coverage (raw-phone add `4045550199`) | **T14** - retarget, never delete. See D2 |
| `e2e/tests/roster-quiet-hours.spec.ts:485` | `expectSentTo(req, tenant.phone, 'joined this group chat')` - tenant is an EXISTING member of a TOUR relay | **T14** -> `Hey, adding <PM first> to the group as the <role>.` |
| `e2e/tests/roster-quiet-hours.spec.ts:486` | `expectSentTo(req, pm.phone, 'joined this group chat')` - pm is the NEW member | **T14** -> the NAKED intro. The two lines now expect DIFFERENT copy |
| `e2e/tests/dashboard-next/relay-connect-when-ready.spec.ts:50,302,311,324` | `INTRO_NEEDLE = 'Use this group text'`; group created via `POST /api/relay-groups` (`:115`) | standalone -> naked -> **survives**. Keep the phrase in the naked entry (spec 9.2 does) |
| `e2e/tests/dashboard-next/relay-open-stop.spec.ts:43,143,144` | same `INTRO_NEEDLE` | standalone -> **survives** |
| `e2e/tests/dashboard-next/thread-history-paging.spec.ts:56-57` | relies on the relay.intro system row existing on both provisioning paths | survives (9.6 changes bodies, not row counts) |
| `e2e/tests/dashboard-next/relay-number-lifecycle.spec.ts:42` | `relay.group_closed` default | untouched (spec 9.7) |
| `e2e/tests/dashboard-next/outbound-mms.spec.ts:57` | `relay.media_only` default | untouched |

### 7c. Dashboard

No dashboard file renders or asserts relay intro/member_added COPY. Prose-only
references (safe to leave, worth re-wording in T14): `dashboard/src/api/types.ts:1103`,
`dashboard/src/api/endpoints.ts:2277,2322,2684`,
`dashboard/src/routes/shared/RosterConfirmDialog.tsx:6-7`,
`dashboard/src/routes/shared/PeopleCard.tsx:39`,
`dashboard/src/routes/shared/rosterWrites.ts:201`.
The confirm dialog renders the SERVER body verbatim, so no dashboard change is owed.

### 7d. Behaviour-changes-without-a-failing-assertion (spec 10a.1 cat 4, relay half)

- `routes/dev.ts:965` (`POST /__dev/relay/replay-intros`, `persist:false`) re-fires
  intros for EVERY open relay group at boot. Under T14 the seeded tour/placement-owned
  groups start replaying VARIANT intros into the fake-phones world. Nothing asserts
  on it, so it will not go red - but any spec that greps a seeded fake thread for
  intro text is silently reading different copy.
- `services/relayGroupDuplicates.ts` + `lib/groupTitle.ts` build their own name
  lists and only MENTION `composeConnectionSentence` in prose; the rename must not
  be applied to their logic.
