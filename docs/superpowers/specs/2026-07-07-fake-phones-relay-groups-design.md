<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-07-08).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Fake-phones relay groups — test group relay conversations in `--local --mock`

**Date:** 2026-07-07
**Status:** Approved design, ready for implementation
**Branch:** `feat/fake-phones-relay-groups` (worktree `w:/tmp/fake-relay-groups`)
**Author:** Claude (brainstormed with Cameron)

---

## 1. Problem

There is no way to exercise a relay group (masked group text) interactively in
`npm run dev -- --local --mock`. The app side is fully relay-ready — fan-out
sends go through the same adapter and reach the fake, and the fake's control API
(`POST /control/send-as-party`) already accepts an arbitrary `to` (that's how the
e2e suite drives full relay round-trips). The gaps are all on the fake-phones
side:

1. **The UI can't address the pool number.** The Composer collects only a body;
   `App.handleSend` calls `sendAsParty({from, body})` with no `to`
   (fake-twilio/web/src/ui/App.tsx:106, Composer.tsx:14), so every interactive
   send defaults to the app business number (`APP_NUMBER = '+15550009999'`,
   fake-twilio/src/engine/registry.ts:5) and the app routes it as a 1:1 — the
   relay fan-out never triggers.
2. **No group/pool concept in the fake's messaging model.** Threads are strictly
   app ↔ one party number (store.ts:4, web types.ts:53). A fan-out scatters into
   per-persona 1:1 threads, and `MessageBubble` doesn't render `from`/`to` — a
   pool-origin message is indistinguishable from business-number traffic.
3. **Seeded relay groups produce no fake traffic.** Seeds write straight to
   DynamoDB; no intro ever flowed through the fake, so even the fan-out-capable
   seeded group (`conv-live-relay-group`, pool `+15550160001`, members Diana
   `+15550170001` / Gloria `+15550170003` — app/src/lib/seed/live.ts:62-69,
   282-285) is invisible until first app-side traffic.

## 2. Goal & confirmed decisions (Cameron)

Make relay groups first-class, **discoverable and drivable** in the fake phones:

- **Rich fidelity:** a dedicated group view (unified transcript + roster +
  reply-as-member), plus pool-origin badges in the persona 1:1 view.
- **Pure dynamic inference — NO static mirror.** The fake learns groups from
  traffic only. No `SEEDED_RELAY_GROUPS`, no new static personas, **no
  `seedPersonaDrift.test.ts` changes** (its 11-persona pin stays).
- **Seeded groups appear at startup via intro-replay,** not static seeding: a
  dev-only app seam re-fires the real `relay.intro` job for seeded open groups;
  the fake captures those legs exactly as if the groups were created live.
- **Roster maintenance without announcement texts:** every fan-out burst
  enumerates the current roster (one leg per member, sender excluded), so the
  fake **sets** the roster from each burst rather than accumulating. (Real
  add/remove notification texts are a separate go-live product item —
  docs/issues/relay-roster-change-notification-texts.md — out of scope here;
  when they land, the fake picks them up for free.)

## 3. Non-goals

- **No app product-code changes** (webhooks, fan-out, repos, dashboard all
  untouched). The only app-side additions are the dev-only replay seam + dev.mjs
  wiring (§7). No schema, no seed-file changes.
- **No store restructure.** Pool legs continue to land in the recipient
  persona's single thread (badged, §6.4) — we do not split per-correspondent
  threads. The group transcript is the unified view.
- **No voice-side changes.** The voice `NumberRegistry` stays as-is (it may be
  *consulted* to confirm runtime pools, §4.1).
- Existing e2e flows must keep working **byte-stable** (steps.ts drives
  `sendAsParty({from, to: pool})` — semantics unchanged; `/__dev/outbox`
  assertions must see no new traffic in e2e contexts).

## 4. Engine — group inference

New traffic-derived group state in the fake messaging engine (alongside, not
replacing, the party-keyed thread store).

### 4.1 When a group is born / updated
- **Outbound leg:** `recordOutboundFromApp` with `from` present and
  `from !== APP_NUMBER` ⇒ `from` is a pool number. Get-or-create the group keyed
  by that number; the `to` recipient is a member (auto-registration of unknown
  recipients already exists — engine.ts:235-241 — keep bare-number labels).
  Where the voice `NumberRegistry` knows the number (`isPool`,
  numberRegistry.ts:80 — true for runtime-provisioned pools), that's positive
  confirmation; seeded pools aren't in it, so the `from !== APP_NUMBER` rule is
  the baseline discriminator. (Nothing else in the app sends from a non-business
  number today; a future false-positive just creates a spurious group in a dev
  tool — acceptable, noted.)
- **Inbound reply:** `sendAsParty` with an explicit `to !== APP_NUMBER` ⇒ `to`
  is a pool number. Get-or-create the group; the `from` persona is a member; the
  message is a group-transcript entry. (Engine contract unchanged — `to` is
  already accepted and forwarded; engine.ts:172-212.)

### 4.2 Burst model (dedupe)
A team reply or member message to an N-member group produces N−1 (or N)
adapter legs with the **same pool `from` and same body**. The engine groups
consecutive same-pool legs within a short quiet-gap window into a **burst**:
- Legs with an **identical body** collapse into ONE logical group message
  carrying a per-recipient delivery list (each leg keeps its own SID/status so
  the existing status-callback flow drives per-recipient chips).
- Legs with **differing bodies** in one burst (the creation-time intros are
  personalized per recipient) stay separate transcript entries — they still
  contribute recipients to the roster.

### 4.3 Roster semantics (set, not accumulate)
`roster := recipients of the most recent burst ∪ senders of inbound messages
since that burst`. A removed member disappears on the next message (absent from
the burst); an added member appears when they first receive a leg. Staleness is
bounded by one message. Member entries reference personas by number.

### 4.4 Transcript & lifecycle
- Group transcript = ordered entries: inbound member→pool messages + collapsed
  outbound bursts (bodies already carry `"Name: …"` sender prefixes — display
  verbatim; no name parsing).
- `reset()` (control /control/reset) clears groups along with threads —
  traffic-derived state resets with traffic. (Personas persist, as today.)
- Close/reopen in the app mints a fresh pool number → naturally appears as a
  new group; the old one just goes quiet. Documented, not special-cased.

## 5. Control API

- **`GET /control/groups`** → `{ groups: [{ poolNumber, members: [{number,
  label}], entries: [...transcript...], lastActivityAt }] }` — or fold a
  `groups` slice into the state snapshot the web already consumes; implementer
  picks whichever matches the existing `useFakePhones` data flow, but group
  updates must reach the UI **live, by the same mechanism threads do** (no
  manual refresh).
- `POST /control/send-as-party` — **unchanged** (already accepts `to`).
- `POST /control/reset` — now also clears groups (§4.4).
- No other control-surface changes.

## 6. Web UI (fake-phones)

1. **RosterRail:** new **"Group texts"** section (below the persona role groups)
   listing inferred groups — label = formatted pool number + member count (+
   unread indicator consistent with persona rows). Selecting one opens the group
   panel.
2. **GroupPanel** (new, sibling of PhonePanel): header (pool number + roster
   strip of member labels), unified transcript (§4.4) with sender-labeled
   entries, and per-recipient **delivery chips** on outbound bursts (reusing the
   existing StatusChip vocabulary).
3. **Reply-as-member:** in GroupPanel, a member picker + the existing Composer →
   `sendAsParty({ from: <member>, to: <poolNumber>, body, mediaUrls })`. This is
   the interactive path that triggers the app's real fan-out. (Delivery-profile
   radiogroup stays as-is.)
4. **Pool-origin badges in the 1:1 view:** `MessageBubble` shows a small
   "via ‹pool number›" tag on messages whose `from` ≠ APP_NUMBER, so scattered
   legs in a persona's thread are identifiable and link the mental model to the
   group.
5. Follow the existing a11y-first selector conventions (roles/labels) so tests
   use `getByRole`/`getByLabel`.

## 7. App dev seam — intro-replay at boot (seeded groups at startup)

- **`POST /__dev/relay/replay-intros`** (new, on the existing triple-gated dev
  router — `devAuthEnabled && NODE_ENV !== 'production' && local DynamoDB
  endpoint`, app/src/lib/devRoutes.ts:19): scan **open** `relay_group`
  conversations; for each with a `pool_number` **and a well-formed participants
  roster** (objects with phones — skip the cast seeds' bare-id rosters
  gracefully, count them in the response), enqueue the **real `relay.intro` job**
  (app/src/jobs/relayFanOut.ts:466 — sends per-member intro legs from the pool
  number and **persists no message rows**, so the DB stays exactly as seeded).
  Response: `{ replayed: n, skipped: m }`.
- **dev.mjs:** when `--mock` **and** `--seeded`, after app+worker are healthy,
  POST the seam once. Result: `conv-live-relay-group` (and any other well-formed
  seeded open group) materializes in the fake phones **at startup** — same
  inference path as a runtime-created group.
- **Not** wired into `/__dev/reseed` (keeps e2e outbox byte-stable). Document in
  the fake-twilio README: after a manual `/__dev/reseed?profile=full`, re-POST
  `/__dev/relay/replay-intros` to re-hydrate the fake.

## 8. Testing

- **fake-twilio unit tests (engine):** group born from outbound pool leg; born
  from inbound `to`-pool; burst dedupe (3 identical legs → 1 entry, 3 delivery
  slots); intro burst with differing bodies → separate entries, roster still
  inferred; roster **set** semantics (removed member gone after next burst;
  added member appears); reset clears groups; APP_NUMBER traffic never creates a
  group.
- **fake-twilio web:** component tests for RosterRail group section, GroupPanel
  transcript/delivery chips, reply-as-member send (asserting the `to`); **run
  the web workspace's BUILD** (tsc runs there — tests alone don't typecheck).
- **app:** dev-seam test — gating (404/absent in non-dev), replays well-formed
  open groups only (skips bare-id cast rosters + closed groups), enqueues the
  intro job per group, persists nothing.
- **e2e:** full suite must stay green **with no behavioral deltas** (no new
  outbox traffic in e2e contexts — the seam is dev-boot-only). No new e2e specs
  required (the fake-phones UI isn't Playwright-driven today); the manual
  checklist below covers the interactive path.
- **Manual verification (document in the fake README):**
  `npm run dev -- --local --mock --seeded` → fake phones show the live group at
  startup → reply as Diana from the GroupPanel → dashboard's relay view shows
  the inbound + Gloria's phone shows the fanned leg (badged) → team reply from
  the dashboard shows up as one collapsed group entry with 2 delivery chips.

## 9. Risks

- **Discriminator false-positives:** any future app send from a non-business
  number would create a spurious group. Acceptable for a dev tool; tighten with
  `NumberRegistry.isPool` when the number is known. Noted in code comments.
- **Burst window:** a too-short quiet-gap could split one fan-out into two
  entries under load; a too-long one could merge unrelated same-body sends. Pick
  a conservative window (hundreds of ms of quiet, or key on body identity within
  a few seconds) and unit-test both edges.
- **State-snapshot growth:** folding groups into the web's polled/WS state must
  not regress the existing threads flow — keep the slice additive.
- **e2e compatibility:** `sendAsParty`/`recordOutboundFromApp` contracts are
  additive-only; steps.ts and outbox assertions must remain untouched.
