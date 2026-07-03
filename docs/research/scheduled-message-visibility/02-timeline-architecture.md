# Contact 1:1 Comms Timeline — End-to-End Architecture

Research map for adding a new `kind:'scheduled'` FUTURE item (tour reminders, placement
nudges) to the contact's 1:1 communications timeline. Traces server builder → client
types → renderer → live-update flow, with the exact insertion points a planner needs.

All paths relative to repo root `w:/tmp/sched-msg-visibility`.

---

## 0. TL;DR insertion map

| Layer | File | Where the new kind slots in |
|---|---|---|
| Server union | `app/src/routes/contactTimeline.ts:110-121` | Add `interface TimelineScheduled extends TimelineBase` + union member (there's already a `TODO(scheduled-message-visibility)` anchor at L118). |
| Server gather | `app/src/routes/contactTimeline.ts:344-378` | Gather this contact's not-yet-sent scheduled rows as candidates (anchor `TODO` at L346). **Ordering caveat below.** |
| Client union | `dashboard/src/api/types.ts:1130-1137` | Add `TimelineScheduled` member to `TimelineItem`. |
| Renderer switch | `dashboard/src/routes/contact/Timeline.tsx:321-336` | Add `case 'scheduled':` to `StreamItem`; new `ScheduledCard` component. |
| Live updates | `app/src/lib/events.ts:192-197` + `dashboard/src/api/EventStreamProvider.tsx` | Add new event(s) (`scheduled.updated`?) OR reuse existing signals to trigger refetch. |
| Refetch trigger | `dashboard/src/routes/contact/useContactTimeline.ts:246-249` | Add `onScheduledUpdated: scheduleRefetch` (or reuse existing). |

---

## 1. Server builder — `app/src/routes/contactTimeline.ts`

### 1.1 HTTP route + response envelope

Route mounted under `/api/contacts` (behind `requireAuth`):

```
GET /api/contacts/:contactId/timeline?cursor=&kinds=&limit=
   → { items: TimelineItem[], nextCursor: string | null }
```

Handler: `router.get('/:contactId/timeline', ...)` at **L293**. Response is emitted at
**L404**:

```ts
res.json({ items: page.map((c) => c.item).reverse(), nextCursor });
```

- `kinds` (**L305**, `parseKinds` L149) — comma list of `message|call|milestone`; absent/empty ⇒ all. An unknown token ⇒ 400. **`ALL_KINDS` is `['message','call','milestone'] as const` (L133)** — a new `'scheduled'` kind must be added here to be a valid filter value.
- `limit` (**L310**, `parseLimit` L137) — 1..100, default 50.
- `cursor` (**L315-323**) — opaque base64url of a `<at>#<id>` boundary key, EXCLUSIVE upper bound. Malformed ⇒ 400.

### 1.2 Discriminated-union item shapes (the wire contract)

Defined **VERBATIM** at **L74-117** (comment L72: "the frontend imports identical field names"):

```ts
interface TimelineBase {
  id: string;
  /** ISO 8601 — the global sort key. */
  at: string;
}
interface TimelineMessage extends TimelineBase {
  kind: 'message';
  conversationId: string;
  tsMsgId: string;
  direction: MessageDirection;
  author: MessageAuthor;
  type: 'sms' | 'mms';
  body?: string;
  media_attachments?: MediaAttachment[];
  delivery_status: DeliveryStatus;
  error_code?: string;
  retry_of?: string;      // tsMsgId of the FAILED message a retry supersedes
  fromPhone?: string;
  toPhone?: string;
  delivery_recipients?: Record<string, RelayRecipientDelivery>;
}
interface TimelineCall extends TimelineBase {
  kind: 'call';
  conversationId?: string;
  call_outcome: CallOutcome;
  call_duration?: number;
  party_phone?: string;
  recording_s3_key?: string;
  transcript?: string;
}
interface TimelineMilestone extends TimelineBase {
  kind: 'milestone';
  type: ActivityEventType;
  label: string;
  refType?: ActivityEventRefType;
  refId?: string;
}
type TimelineItem = TimelineMessage | TimelineCall | TimelineMilestone;
```

Immediately below (**L118-121**) is the planted anchor:

```ts
// TODO(scheduled-message-visibility): add a future `kind: 'scheduled'` member here
// and merge not-yet-sent scheduled outbound sends (tour reminders, placement
// nudges — see the candidate-gather in the route handler) into the timeline so a
// pending text shows up as a FUTURE item (body + send time) before it fires.
```

### 1.3 Sources that merge in + their mappers

Three sources today, each mapped to a wire item:

1. **Messages** (SMS/MMS) — `messages.listByConversation()` → `toTimelineMessage()` (**L204-234**). FULL body, no truncation.
2. **Calls** — the SAME `messages.listByConversation()` page; rows where `m.type === 'call'` → `toTimelineCall()` (**L243-268**). (Calls are stored in the messages table as `type:'call'` entries — L359.)
3. **Milestones** — `activityEvents.listByContact()` → `toTimelineMilestone()` (**L271-281**). Link-out only (refType/refId), never inline content.

`atOf(sortKey, fallback)` (**L198-201**) derives the ISO `at` from the `<ISO ts>#<id>` sort-key prefix, so `at` is ALWAYS the exact value the server sorts/paginates by.

### 1.4 How conversations/threads are resolved (per-number 1:1 vs relay groups)

**L325-337** — the contact's phone numbers → deduped set of 1:1 conversationIds:

```ts
const phones = contactPhones(contact).map((p) => p.phone);
const convById = new Map<string, ConversationItem>();
for (const phone of phones) {
  const linked = await conversations.findByParticipantPhone(phone);
  for (const conv of linked) {
    if (conv.type === 'relay_group') continue; // pool-number thread, not 1:1
    if (!convById.has(conv.conversationId)) convById.set(conv.conversationId, conv);
  }
}
```

**Key rule: `relay_group` threads are EXCLUDED** (they front a pool number, not the
contact's real phone). Group-text activity surfaces only as milestones. This matters for a
scheduled item: a **group-routed** tour reminder (landlord_led/pm_team tours — see §5.1)
targets a relay_group thread that this timeline deliberately does not include. A scheduled
item must resolve the SAME thread the poller will actually send to (tenant 1:1 for
self_guided; the group otherwise), and only self_guided/1:1-routed reminders map cleanly
onto a thread this timeline shows.

### 1.5 Sort order + pagination (the ordering problem for future items)

**Locked contract (L11-18, L380-404):**
- Candidates are gathered `< boundaryKey` (**L344-378**), `limit+1` from EACH source.
- Merge: **sort DESC** by `globalKey` (`<at>#<id>`), take newest `limit` (**L383-384**):
  ```ts
  candidates.sort((a, b) => (a.globalKey < b.globalKey ? 1 : a.globalKey > b.globalKey ? -1 : 0));
  const page = candidates.slice(0, limit);
  ```
- `nextCursor` = the OLDEST returned item's key (pages BACKWARD in time) (**L386-387**).
- Wire response is **reversed to ASCENDING** (oldest→newest) so the client renders as-is (**L404**).

**The future-item ordering hazard (call this out to the planner):** a scheduled item's
`dueAt` is in the *future*, so its `globalKey` sorts NEWER than every real message. Under
the current DESC-take-newest-`limit` slice, future items would (a) always land in the first
page and (b) push real recent messages out of that page, AND (c) corrupt the cursor
boundary (nextCursor is derived from the descending slice; a future item as the boundary
would skip/dup real rows). So future items **cannot** be dropped naively into the same
sort+slice. Options the planner must weigh:
   - Gather scheduled candidates SEPARATELY from the paginated stream and append them to
     the FIRST page only (cursor === undefined), outside the `limit` slice — a distinct
     "upcoming" bucket in the envelope (e.g. add `upcoming: TimelineScheduled[]` alongside
     `items`), OR
   - Include them in `items` but exclude them from the cursor-boundary computation.
   The `kinds` filter and `at`=`dueAt` still apply for rendering; only the pagination math
   needs the carve-out.

### 1.6 Where a `kind:'scheduled'` item merges (the gather anchor)

**L344-350** — planted anchor inside the candidate gather:

```ts
// TODO(scheduled-message-visibility): also gather this contact's not-yet-sent
// scheduled sends here (tourRemindersRepo.listByTour + placementNudgesRepo,
// for this contact's conversation(s)) as future `kind:'scheduled'` candidates —
// reflecting send-time suppression (opt-out/manual/breaker) honestly.
const candidates: Candidate[] = [];
```

The builder is constructed via `createContactTimelineRouter(deps)` (**L283-289**) with
injectable repos — a `tourRemindersRepo` / `placementNudgesRepo` (and probably a
`toursRepo`/`placementsRepo` to resolve contact→tour/placement) would be added to
`ContactTimelineRouterDeps` (**L63-70**). Note there is no direct contact→reminder index;
resolving a contact's scheduled rows requires walking tours/placements the contact
participates in, then `listByTour`/`listByPlacement` (see §5).

---

## 2. Client types — `dashboard/src/api/types.ts`

The C2 union is copied verbatim from the server. `TimelineBase` at **L1094-1097**; the
members at **L1099-1137**:

```ts
export interface TimelineMessage extends TimelineBase {
  kind: 'message';
  conversationId: string;
  tsMsgId: string;
  direction: MessageDirection;
  author: MessageAuthor;
  type: 'sms' | 'mms';
  body?: string;
  media_attachments?: { s3Key: string; contentType: string }[];
  delivery_status: DeliveryStatus;
  error_code?: string;
  retry_of?: string;
  fromPhone?: string;
  toPhone?: string;
  delivery_recipients?: Record<string, RelayRecipientDelivery>;
}
export interface TimelineCall extends TimelineBase {
  kind: 'call';
  conversationId?: string;
  call_outcome: CallOutcome;
  call_duration?: number;
  party_phone?: string;
  recording_s3_key?: string;
  transcript?: string;
}
export interface TimelineMilestone extends TimelineBase {
  kind: 'milestone';
  type: TimelineMilestoneType;
  label: string;
  refType?: 'placement' | 'unit' | 'conversation' | 'broadcast' | 'tour';
  refId?: string;
}
export type TimelineItem = TimelineMessage | TimelineCall | TimelineMilestone;

export interface ContactTimelinePage {
  items: TimelineItem[]; // chronological; client renders oldest→newest
  nextCursor: string | null;
}
```

`TimelineMilestoneType` enum is at **L1082-1092** (`placement_opened`, `placement_closed`,
`listing_sent`, `listing_reviewed`, `tour_scheduled`, `tour_took_place`, `stage_changed`,
`number_added`, `added_to_group_text`, `removed_from_group_text`).

**Every existing `kind` and its discriminating fields:**
- `kind:'message'` — `conversationId, tsMsgId, direction, author, type, body?, media_attachments?, delivery_status, error_code?, retry_of?, fromPhone?, toPhone?, delivery_recipients?`
- `kind:'call'` — `conversationId?, call_outcome, call_duration?, party_phone?, recording_s3_key?, transcript?`
- `kind:'milestone'` — `type, label, refType?, refId?`

**Where a new member slots in (after L1136, before the union at L1137):**

```ts
export interface TimelineScheduled extends TimelineBase {
  kind: 'scheduled';
  // at === dueAt (the scheduled fire instant, ISO)
  conversationId?: string;     // the resolved 1:1 thread (may be group-routed → absent)
  source: 'tour_reminder' | 'placement_nudge';
  reminderKind?: ReminderKind; // 'confirmation' | 'day_before' | ...
  nudgeKind?: NudgeKind;       // 'receipt_check' | 'approval_check' | ...
  body: string;                // what WILL send (the canned template)
  status: 'upcoming' | 'suppressed'; // suppressed = opt-out/manual/breaker will skip it
  refType?: 'tour' | 'placement';
  refId?: string;
}
export type TimelineItem = TimelineMessage | TimelineCall | TimelineMilestone | TimelineScheduled;
```

(Field shape is a planner recommendation, not existing code.) Note `types.ts` also carries a
DIFFERENT, older flat `Message` interface around **L1050-1065** (`delivery_status`,
`call_outcome`, `started_at`, `created_at`, `[key:string]:unknown`) used by the legacy
per-conversation view / fallback path — NOT the C2 timeline union. Don't confuse the two.

---

## 3. Renderer — `dashboard/src/routes/contact/Timeline.tsx`

### 3.1 The kind switch

`StreamItem` (**L321-336**) is the single dispatch point:

```ts
function StreamItem({ item, onRetry }: {...}): React.JSX.Element {
  switch (item.kind) {
    case 'message':   return <MessageBubble msg={item} onRetry={onRetry} />;
    case 'call':      return <CallCard call={item} />;
    case 'milestone': return <MilestonePin ms={item} />;
  }
}
```

A new `case 'scheduled': return <ScheduledCard item={item} />;` goes here. (TS exhaustiveness
on the union will flag the missing case once the type is added — a compile-time nudge.)

### 3.2 UI primitives that exist

- **`MessageBubble`** (**L147-285**) — inbound white / outbound light-blue bubble; body as
  escaped text; media gallery; a `delivery` chip via `presentDeliveryStatus` with tone
  classes (`toneNeutral/toneInfo/toneSuccess/toneDanger`, L183-190); relay opt-out note;
  a **Retry** button on failures.
- **`CallCard`** (**L287-319**) — collapsed card, outcome pill (answered/voicemail/missed),
  transcript behind a `<details>`.
- **`MilestonePin`** (**L131-145**) — a colored pill (`milestoneVariant` L95-108:
  amber/purple/green/neutral) that LINKS OUT via `milestoneHref` (L113-129:
  placement/unit/conversation/broadcast/tour). Good template for a scheduled "chip"-style row.

There is **NO existing `DeadlineChip` or future/pending affordance in this file.** A
`DeadlineChip` DOES exist but lives in the placements feature —
`dashboard/src/routes/placements/DeadlineChip.tsx` — a compact red/amber "overdue / due in
Nd" chip driven by `next_deadline_at`/`next_deadline_type`, keyed off `deadlineRelative()`.
It is NOT imported by the timeline; it's a reusable pattern the planner can mirror for a
"sends in Nh" affordance (relative-time formatting via `placementsFormat.ts`).

### 3.3 Ordering / grouping / date separators

- Items arrive **chronological (oldest→newest)** from the hook (§4). No sorting in the
  renderer itself beyond `visible` filtering.
- **`visible`** (**L367-379**) — applies the "Comms only" toggle (hides milestones) and
  RETRY-COLLAPSE (hides a `message` whose `tsMsgId` is in some later message's `retry_of`).
- **`clusters`** (**L385-408**) — iMessage-style grouping: a new cluster starts on a new
  day OR a >1h gap from the previous item. Each cluster gets one centered time-divider label
  (`formatDayDivider` + `formatTime`). Rendered at **L503-512**.

### 3.4 Where a scheduled/future item renders — "pinned upcoming at bottom" vs "inline by time"

**Currently EVERYTHING is inline-by-time** — the stream is a single flat chronological list
(`clusters.map`), newest at the bottom. There is **no** separate "upcoming" section and no
pinned-at-bottom affordance today; the reply composer (`div.reply`, **L515-560**) sits below
the scrollable `div.stream` (**L484-513**).

Two rendering strategies for the planner, tied to the §1.5 server decision:
   - **Inline by time (at === dueAt):** future items sort last (after newest message) since
     the clusters are chronological and `dueAt > now`. They'd appear at the BOTTOM of the
     stream, just above the composer — visually "next up." Requires the server to actually
     place them in `items` (with the cursor carve-out from §1.5), OR the hook to append them.
   - **Distinct "Upcoming" section pinned at the bottom:** render a separate block below the
     `clusters.map` (still above the composer) fed by a separate `upcoming[]` array (matches
     the "gather separately, first page only" server option). Cleaner semantics, avoids the
     cursor hazard entirely, and reads as a deliberate "what's queued" panel.

Either way the item must be **unmistakably not-yet-sent**: a distinct bubble style (dashed
border / muted / clock icon), the fire time in the reader's tz, the body it will send, and a
"will be suppressed" state when `status==='suppressed'` (§ the issue's suppression-honesty
requirement).

---

## 4. Live updates — SSE / event-stream flow

### 4.1 The bus (server) — `app/src/lib/events.ts`

In-process typed `EventEmitter` singleton `appEvents` (**L246**). Single-instance
assumption is load-bearing (L4-13): the one app process serves both mutation paths and the
SSE stream. The typed event map (**L192-197**):

```ts
export interface AppEventMap {
  'conversation.updated': ConversationUpdatedEvent;
  'message.persisted': MessagePersistedEvent;
  'broadcast.updated': BroadcastUpdatedEvent;
  'placement.updated': PlacementUpdatedEvent;
}
```

`MessagePersistedEvent` (**L117-123**): `{ conversationId, tsMsgId, direction, deliveryStatus }`.

A NEW event (e.g. `'scheduled.updated'`) would be added to `AppEventMap` here, with its
payload interface + (optionally) a `toScheduledUpdatedEvent()` builder mirroring
`toPlacementUpdatedEvent` (L167-190). PII rule: IDs/counts only — never bodies/phones.

### 4.2 The SSE route (server) — `app/src/routes/api.ts`

`GET /api/events` at **L1086-1151**. Sets `text/event-stream` headers (L1096-1101), writes
a `: connected` frame, then subscribes one listener per event and re-emits over the socket:

```ts
const writeEvent = (event: string, payload: unknown): void => {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
};
const onMessagePersisted = (payload: MessagePersistedEvent): void => {
  writeEvent('message.persisted', payload);
};
...
events.on('conversation.updated', onConversationUpdated);
events.on('message.persisted', onMessagePersisted);
events.on('broadcast.updated', onBroadcastUpdated);
events.on('placement.updated', onPlacementUpdated);
```

Cleanup on `res.on('close')` (**L1139-1150**) frees the cap slot, clears the heartbeat, and
`events.off(...)` every listener. **A new event needs its own `onScheduledUpdated`
subscribe + off pair here** (L1121-1124 and L1142-1145), plus a connection-cap-safe
listener.

### 4.3 `message.persisted` emit sites (server)

Emitted wherever a message row lands or its delivery status moves — canonical example
`app/src/services/sendMessage.ts:322` and `app/src/routes/api.ts:769`; also every Twilio &
voice webhook (`routes/webhooks/twilio.ts:393,722,800,867`;
`routes/webhooks/voice.ts:507,724,793,1335,1507,1584`) and `services/originateCall.ts:185`.
**Relevant to future→sent:** when a scheduled row fires, the poller calls
`sendMessageService` (`jobs/tourReminders.ts:310`), which already emits `message.persisted`
→ the timeline refetches → the real sent bubble appears. So **future→sent already produces a
refetch signal for free** IF the scheduled item is dropped from the timeline once its row
has `sentAt` (the refetch will re-gather and see the row sent).

### 4.4 The client stream provider — `dashboard/src/api/EventStreamProvider.tsx`

Owns the ONE shared `EventSource('/api/events')` (**L117**) with capped-exponential-backoff
reconnect. Registers a listener per event name (**L124-142**) and fans each out to every
subscriber's current handler via `dispatch`:

```ts
source.addEventListener('message.persisted', (ev) => {
  const data = parse<MessagePersistedEvent>((ev as MessageEvent).data);
  if (data) dispatch((h) => h.onMessagePersisted, data);
});
```

`EventStreamHandlers` (**L32-48**) is the handler contract:
`onConversationUpdated?, onPlacementUpdated?, onMessagePersisted?, onBroadcastUpdated?,
onOpen?, onError?, enabled?`. **A new `onScheduledUpdated?` handler + a new
`source.addEventListener('scheduled.updated', ...)` block would be added here.** (Handler
types are imported from `./types.js` — L25-30 — so the payload type must be exported there
too.)

### 4.5 The timeline hook (client) — `dashboard/src/routes/contact/useContactTimeline.ts`

- `fetchNow()` (**L204-218**) → `loadTimeline()` (**L94-132**) calls
  `getContactTimeline(contactId, {kinds}, signal)`; on 404 falls back to a messages-only
  client assembly (`buildTimelineFallback`). The server C2 path is the live one.
- `normalizeServerItems()` (**L77-92**) defensively sorts oldest→newest by `at`; a no-op
  when the server already orders. **Items with no derivable `at` sort LAST** — a future item
  with `at=dueAt` sorts NEWEST (after real messages), consistent with §3.4 inline-at-bottom.
- **Refetch-on-event wiring (L246-249):**
  ```ts
  useEventStream({
    onMessagePersisted: scheduleRefetch,
    onConversationUpdated: scheduleRefetch,
  });
  ```
  `scheduleRefetch` (**L231-237**) is a 300ms-debounced `fetchNow`. **To make schedule
  changes reflect live, add `onScheduledUpdated: scheduleRefetch` here** (or, cheaper, reuse
  existing signals — see §4.6).
- Optimistic-send merge (**L255-261**) appends in-flight sends; future items don't interact
  with this path (they're server-sourced), but note the merge only dedups `kind:'message'`.

### 4.6 New events needed for future→sent / reschedule / cancel

| Transition | Server trigger | Cheapest client signal |
|---|---|---|
| **future → sent** | poller sends → `sendMessageService` emits `message.persisted` (`jobs/tourReminders.ts:310`, `jobs/placementNudges.ts:~350`) | **Already covered** — timeline already refetches on `message.persisted`; the re-gather sees `sentAt` set and drops the scheduled item, and the new sent message appears. |
| **arm / reschedule** | `armTourReminders` (`routes/tours.ts:210,453`), placement nudge arm | Needs a NEW signal — no existing event fires on reminder-row creation. Emit `scheduled.updated` (with `{contactId}` or `{conversationId}`) from the arm/cancel sites, OR piggyback: tour reschedule already writes the tour (a `placement.updated`/tour update may fire) but there is **no tour SSE event** today, so a new one is cleanest. |
| **cancel** | `cancelTourReminders` (`routes/tours.ts:452,461`), `cancelForPlacement` | Same — new `scheduled.updated` emit at the cancel site so the future item disappears without a manual refetch. |

Reschedule is arm+cancel back-to-back (`routes/tours.ts:452-453`): cancel old ladder, arm
new one — one `scheduled.updated` after both suffices.

---

## 5. Scheduled-send data sources (for the gather in §1.6)

### 5.1 Tour reminders — `app/src/repos/tourRemindersRepo.ts` + `app/src/jobs/tourReminders.ts`

- Row (`TourReminderItem`, repo **L36-51**): `{ reminderId, tourId, kind, dueAt (ISO),
  _reminderPartition:'reminders', sentAt?, canceledAt?, createdAt }`.
- `ReminderKind` (**L29-34**): `confirmation | day_before | morning_of | en_route | no_show_checkin`.
- **State test for "upcoming":** `sentAt === undefined && canceledAt === undefined`
  (mirrors `cancelForTour` filter, repo L184).
- Read methods: `listByTour(tourId)` (**L101-111**, via `byTour` GSI) and `listDue(now)`
  (**L113-147**). **No contact-keyed index** — resolving a contact's reminders means finding
  the tours the contact is on (`toursRepo` by tenantId/participant), then `listByTour`.
- Canned bodies (`REMINDER_BODIES`, job **L48-54**) — **static `[AUTO]` templates, NOT
  personalized at send time** (the job sends `REMINDER_BODIES[row.kind]` verbatim, L290/432).
  So the preview body is faithful and stable. Good for "what it will say" fidelity.
- **Target thread resolution** (job `processReminderRow` **L232-351**): landlord_led/pm_team
  tours route to the masked **group** thread (excluded from this timeline!); self_guided (and
  any tour with no usable group) routes to the tenant's **1:1** conversation via
  `findByParticipantPhone` → `type==='tenant_1to1' || 'unknown_1to1'` (**L280-281**). A
  scheduled item should only appear in the 1:1 timeline for reminders that will actually
  route to a 1:1.
- Suppression: send goes through `sendMessageService({automated:true})` (**L310**) which
  gates on opt-out/manual/breaker at send time → `SendRefusedError` (**L327**). The future
  item's `suppressed` state must mirror these gates to be honest.
- Arm/cancel call sites: `armTourReminders` at `routes/tours.ts:210` (create) & `:453`
  (reschedule); `cancelTourReminders` at `:452,461`.

### 5.2 Placement nudges — `app/src/repos/placementNudgesRepo.ts` + `app/src/jobs/placementNudges.ts`

- Row (`PlacementNudgeItem`, repo **L37-53**): `{ nudgeId, placementId, kind, dueAt,
  _nudgePartition:'nudges', sentAt?, canceledAt?, createdAt }` — a rename-clone of the tour
  reminders repo (identical claim-before-send semantics).
- `NudgeKind` (**L31-35**): `receipt_check | completion_check | approval_check | rta_window_closing`.
- Reads: `listByPlacement(placementId)` (**L104-114**, `byPlacement` GSI), `listDue` (L116-150).
- **Target resolution** (job **L248-327**): tenant rungs → `placement.tenantId`; landlord
  rungs (`approval_check`/`rta_window_closing`) → `unit.landlordId`. Resolve phone → 1:1
  conversation; `wantedType = tenant ? 'tenant_1to1' : 'landlord_1to1'` (**L295**); landlord
  1:1 is **created on demand** if absent (L299-318). Both route to a **1:1 thread** (never
  the masked group — founder decision, L293), so placement nudges map cleanly onto this
  timeline for the resolved contact.

### 5.3 Other scheduled-send sources to sweep (per the issue)

`app/src/services/statusTransition.ts` (stuck-placement `next_deadline` — likely a board
deadline, not a text — confirm), `app/src/jobs/retrySend.ts`, `app/src/adapters/scheduler.ts`.
Not read in depth here; the planner should confirm whether any produces a durable
`dueAt`/`send_at` outbound-text row that belongs in the timeline.

---

## 6. Existing anchors already in the tree

Two `TODO(scheduled-message-visibility)` anchors are already planted in
`app/src/routes/contactTimeline.ts`: the union-member anchor at **L118-121** and the
candidate-gather anchor at **L346-349** — the exact two edit points for the server side.
