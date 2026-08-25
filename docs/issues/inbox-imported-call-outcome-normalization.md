---
id: inbox-imported-call-outcome-normalization
title: Three surfaces render a call outcome and only the contact timeline normalizes imported ones - the inbox row and the relay thread both drop the outcome, ignore call_duration_seconds, and still render a zero duration
type: debt
severity: low
status: open
area: app/inbox
created: 2026-08-18
refs: app/src/routes/inbox.ts:530-545, app/src/routes/inbox.ts:956-957, app/src/lib/callPreview.ts:20, app/src/lib/callPreview.ts:28, app/src/routes/contactTimeline.ts:497-525, app/src/lib/import/apply.ts:435-452, dashboard/src/routes/conversation/useRelayThread.ts:73-87
updated: 2026-08-25
---

**Re-adjudicated 2026-08-25 against main @88ac7b36.** The defect still
reproduces on both halves, but the old "Suggested fix" was a NO-OP for the rows
this issue is about, and the surface count was wrong: there are THREE call-outcome
renderers, not two, and imported GROUP threads are not reached by any fix inside
`deriveLatest`. Corrected in place below; severity stays `low`.

**Problem.** The Quo importer writes call rows whose `call_outcome` is OUTSIDE
the `CallOutcome` union and whose duration lives under a different key
(`app/src/lib/import/apply.ts:446-449`):

```
call_duration_seconds: c.durationSeconds,
call_outcome: c.durationSeconds === 0 ? 'no_answer' : 'completed',
```

The union is `answered | missed | voicemail`, and the native duration field is
`call_duration`. So an imported row carries `'no_answer'` / `'completed'` and a
duration nothing looks for.

`app/src/lib/import/apply.ts:435-452` is the EXHAUSTIVE field list for an
imported call row, and three ABSENCES from it matter more than the two
out-of-union values above:

- no `call_status` - nothing in the importer writes one;
- no `body` - an imported call row is content-less;
- no `last_message_preview` on the conversation - `upsertConversation`
  (`app/src/lib/import/apply.ts:1082-1223`) has no preview clause in either its
  full or its reduced expression.

The contact TIMELINE now handles both. `contactTimeline.ts` normalizes
(`'no_answer' -> 'missed'`, `'completed' -> 'answered'`, membership-test after,
drop anything still unrecognized) and falls back to `call_duration_seconds`
through the `MessageItem` index signature, so an imported Quo call renders
"Connected - 4m 12s" on the card.

The INBOX does neither, and the ORDER of its two failures is the whole point.
`deriveLatest` (`app/src/routes/inbox.ts:530-545`) short-circuits on
`callStatus !== undefined` (line 535) BEFORE it evaluates any outcome or duration
handling. The importer writes no `call_status`, so `callStatus` is `undefined`,
the entire derive arm is skipped, and `preview` falls back to
`conv.last_message_preview` - which the importer never wrote either
(`app/src/routes/inbox.ts:472-473`). The inbox row is a Call chip with an EMPTY
preview line, not a stored body.

The two inner defects are real but UNREACHABLE for an imported row: `callOutcome`
is passed only when `isCallOutcome(latest.call_outcome)` holds (line 542) - a raw
membership test with no normalization in front of it, which an imported
`'no_answer'` / `'completed'` fails - and `callDuration` is read only from the
native `call_duration` (line 543), so an imported duration is invisible. Both
live INSIDE the true-branch the `callStatus` gate already refused to enter.

`callPreview` cannot be reached without a status in any case: `callStatus` is a
REQUIRED field on `CallPreviewInput` (`app/src/lib/callPreview.ts:20`).

Same underlying row, two different richnesses, depending on which surface you
open. Both ends are pinned green today: `app/test/voiceInboxActivity.test.ts:223`
asserts `preview: ''` for an imported row, while
`app/test/contactTimeline.test.ts:619-620` asserts the same stored shape projects
`call_outcome: 'missed'` / `'answered'`.

This was declared and filed rather than folded into the comms-panel
call-direction mission (spec
`docs/superpowers/specs/2026-08-18-comms-panel-call-direction-design.md`, section
8, F22), on the grounds that sharing the helper would change inbox previews for
every historical imported row - what was believed at the time to be a second read
surface with its own precedence rules and its own tests, none of it needed to
deliver the timeline panel. That count was wrong; see the next section.

**THREE renderers, not two (corrected 2026-08-25).** This issue was written as an
inbox-vs-timeline divergence. Enumerating every surface that renders a call
outcome (grep `call_outcome|callOutcome` across `app/src`, and
`kind: 'call'|=== 'call'` across `dashboard/src`) finds a third:

| Surface | Where | Normalizes imported outcome? | Zero duration? |
| --- | --- | --- | --- |
| Inbox row (1:1 contact rows only) | `app/src/routes/inbox.ts:530-545` -> `app/src/lib/callPreview.ts` | No | Renders "0s" |
| Contact comms pane / timeline | `app/src/routes/contactTimeline.ts:566-619` -> `dashboard/src/routes/contact/presentCallState.ts` + `Timeline.tsx:1254` | Yes | Dropped |
| Relay / group conversation thread | `dashboard/src/routes/conversation/useRelayThread.ts:73-87` | **No** | **Renders "0s"** |

Today page (`app/src/routes/today.ts`) renders no call outcome or preview, and the
activity log (`app/src/repos/activityEventsRepo.ts`) carries milestone kinds
(`tour_outcome` and friends), not call outcomes. Neither is affected.

The third one is the sharper divergence, because it renders the SAME
`TimelineCall` card component as the contact timeline: an imported call shows an
outcome chip on the contact page and NO chip in the relay thread - identical
pixels, different content. `useRelayThread.ts:87` uses a bare membership test
(`isCallOutcome(m.call_outcome)`) with no normalizer, `:73-76` admits a zero
duration (`m.call_duration >= 0`), and it reads `call_duration` only - it has no
`call_duration_seconds` fallback at all.

It also sits ACROSS A PACKAGE BOUNDARY that an `app/src` shared module cannot
cross. The rule is stated repeatedly in the dashboard's own source - "the
dashboard cannot import from app/src"
(`dashboard/src/api/endpoints.ts:618`, `dashboard/src/api/types.ts:44`, `:71`,
`:105`, `:159`) - and the established remedy there is a MIRROR plus a
keep-in-sync note (`app/src/lib/phone.ts:1`,
`app/src/lib/groupTitle.ts:13`). The one direction that IS proven to work is an
app-side TEST importing a pure, import-free dashboard module: `presentCallState`
is reached that way from `app/test/contactTimeline.test.ts:38`, and
`dashboard/src/lib/consentCopy.js` from `app/test/consentDrift.test.ts:34`. No
app RUNTIME module imports from `dashboard/src` anywhere today.

**Imported GROUP threads are not reached by any fix inside `deriveLatest`.** The
importer creates a group thread as `type: 'relay_group'`, `status: 'connecting'`
(`app/src/lib/import/apply.ts:1087-1088`). Relay and group inbox rows are built
by `relayRowFor` (`app/src/routes/inbox.ts:956-957`) and `groupRowFor`
(`app/src/routes/inbox.ts:994`), which read `conv.last_message_preview` directly
and never call `deriveLatest`. So an imported group whose newest row is a call
keeps a blank inbox preview no matter what `deriveLatest` learns to do.

**Suggested fix (rewritten 2026-08-25; Cameron's ruling 2026-08-25: fix ALL THREE
renderers with a shared normalizer in a location both packages can import, AND
cover imported group threads).**

The remedy this file carried until now was: promote `normalizeCallOutcome` and
the `call_duration_seconds` fallback out of `contactTimeline.ts` into a shared
module, then feed the normalized outcome and resolved duration into
`callPreview`. **Do not re-propose that on its own - it is a no-op for exactly
the rows this issue is about.** Every one of those substitutions lands inside the
true-branch of the ternary at `app/src/routes/inbox.ts:539-544`, whose condition
(`callStatus !== undefined`, line 535) an imported row has already failed. It
would typecheck, pass every existing test unchanged, and change no imported
preview. The old text stated the `call_status` blocker in its own Problem section
and then proposed a remedy that did not address it.

Do this instead, in this order:

1. **Make `callStatus` OPTIONAL on `CallPreviewInput`**
   (`app/src/lib/callPreview.ts:20`). The body already survives it: the `ringing`
   and `in-progress` checks (`app/src/lib/callPreview.ts:39-40`) are equality
   tests that are simply false for `undefined`, so a status-less row falls
   straight through to the terminal outcome arms - which is exactly the semantics
   a historical imported row wants. No new branch is needed.
2. **Add a FOURTH derive-arm clause** at `app/src/routes/inbox.ts:534-538` for a
   status-less row whose `call_outcome` normalizes, gated on
   `fallbackPreview === ''`. The three existing clauses stay keyed on a KNOWN
   `callStatus` exactly as they are today.
3. **Then** promote the shared helpers to a location BOTH packages can import,
   and make the third renderer use them. The package boundary above is a hard
   constraint, so the builder must first prove the chosen location: either a
   pure, import-free module the app's compiled output can also resolve (prove it
   under `npm run smoke`, which builds the app workspace with the real `tsc` and
   runs it under plain `node dist/` - a cross-package source import is precisely
   the shape that passes tsx and fails there), or the repo's established
   mirror-plus-drift-guard pattern. Do not assume a single shared file is
   reachable; the seam precedents above are TEST-side reach only.
4. **Extend coverage to the group-thread path** so `relayRowFor` /
   `groupRowFor` no longer leave an imported group's call row blank.
5. **Fold in the one-character `< 0` -> `<= 0` change** to `formatCallDuration`
   (`app/src/lib/callPreview.ts:28`) and align the third renderer's `>= 0`, so all
   three agree that a non-positive duration is ABSENT. This also updates
   `app/test/callPreview.test.ts:7`, which currently pins
   `formatCallDuration(0) === '0s'`.

Five things to watch:

- It CHANGES the visible inbox preview for every imported call row that has ever
  been imported - that is the point, but it is a user-visible change to
  historical data and should be described as such, not slipped in.
- The inbox has its own precedence rule (a stored `body` wins over any derived
  preview, and the D12 derive arm deliberately preserves a specific row), so the
  normalization must sit INSIDE the derive path and must not start overriding
  stored previews.
- **Do NOT thread the normalizer through the D12 clause**
  (`app/src/routes/inbox.ts:537`). That clause tests
  `latest.call_outcome === undefined` on the RAW value on purpose, and the
  comment at `app/src/routes/inbox.ts:508-511` says so: "Raw absence of
  call_outcome is the test (NOT isCallOutcome)". Normalizing there would change
  which rows count as gate-refusal stamps.
- The two halves of this issue DO NOT COMPOSE. A zero duration is reachable in
  the inbox only on NATIVE rows, because the `call_status` gate stops an imported
  row first. Step 5 alone does nothing for imported rows; steps 1-2 are what make
  it matter for them.
- The `<= 0` change fixes the derive path and all FUTURE stored previews, but it
  cannot rewrite `last_message_preview` strings already persisted as
  "Outgoing call - 0s" by `app/src/routes/webhooks/voice.ts:1746-1758`. Those
  rows keep reading "- 0s" until newer activity supersedes them. Say so in the
  change description, or the reconciliation gets reported as complete while the
  old strings are still on screen.

A shared helper would also delete the deliberate duplication of `isCallStatus` /
`isCallOutcome` between `inbox.ts` and `contactTimeline.ts` (and a third copy in
`useRelayThread.ts:58-64`), which is accepted today only because the surfaces
were kept independent.

**Widened 2026-08-19: a ZERO duration is now a second divergence case.** The
comms-panel call-direction fix wave stopped the timeline projecting a zero call
duration - `callDurationOf` (`app/src/routes/contactTimeline.ts:521-525`) treats a
non-positive value as ABSENT on both the native `call_duration` and the imported
`call_duration_seconds`, because a miss has no meaningful talk time. The inbox
still renders one: `formatCallDuration`
(`app/src/lib/callPreview.ts:28`) guards `seconds < 0` rather than `<= 0`, so
zero survives and `callPreview` appends it
(`app/src/lib/callPreview.ts:44-45`). So does the relay thread
(`dashboard/src/routes/conversation/useRelayThread.ts:73-76`, `>= 0`) - the third
renderer named above, which this section did not know about when it was written.

Net effect on a zero-duration ANSWERED row: the inbox and the relay thread read
`Call - 0s` while the timeline card shows the outcome with no duration at all.
Same row, two readings - the same divergence this issue already describes, one
case wider.

This is reachable on NATIVE rows, not imported ones: an imported row never gets
past the `call_status` gate to reach `formatCallDuration` at all. It is also
reachable on the WRITE side - `app/src/routes/webhooks/voice.ts:1606-1609` parses
a `DialCallDuration` of `'0'` to `0`, and `:1746-1758` STORES the resulting
"Outgoing call - 0s" into `last_message_preview`.

The one-character fix (`< 0` becomes `<= 0`) was deliberately not taken with the
timeline change: it alters inbox preview text for historical rows, which spec
section 8 of
`docs/superpowers/specs/2026-08-18-comms-panel-call-direction-design.md` declares
an explicit non-goal. It is now step 5 of the Suggested fix above; take it only
as part of the change that reconciles all three surfaces, not before.
