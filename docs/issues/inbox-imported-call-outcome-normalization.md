---
id: inbox-imported-call-outcome-normalization
title: The inbox does not normalize imported call outcomes or read call_duration_seconds, so an imported call reads richer on the timeline than in the inbox
type: debt
severity: low
status: open
area: app/inbox
created: 2026-08-18
refs: app/src/routes/inbox.ts, app/src/lib/callPreview.ts, app/src/routes/contactTimeline.ts, app/src/lib/import/apply.ts
---

**Problem.** The Quo importer writes call rows whose `call_outcome` is OUTSIDE
the `CallOutcome` union and whose duration lives under a different key
(`app/src/lib/import/apply.ts:445-448`):

```
call_duration_seconds: c.durationSeconds,
call_outcome: c.durationSeconds === 0 ? 'no_answer' : 'completed',
```

The union is `answered | missed | voicemail`, and the native duration field is
`call_duration`. So an imported row carries `'no_answer'` / `'completed'` and a
duration nothing looks for.

The contact TIMELINE now handles both. `contactTimeline.ts` normalizes
(`'no_answer' -> 'missed'`, `'completed' -> 'answered'`, membership-test after,
drop anything still unrecognized) and falls back to `call_duration_seconds`
through the `MessageItem` index signature, so an imported Quo call renders
"Connected - 4m 12s" on the card.

The INBOX does neither. `deriveLatest` (`app/src/routes/inbox.ts`) passes
`callOutcome` only when `isCallOutcome(latest.call_outcome)` holds - a raw
membership test with no normalization in front of it, which an imported
`'no_answer'` / `'completed'` fails - and passes `callDuration` only from the
native `call_duration`, so an imported duration is invisible to it. On top of
that, the derive arm requires a known `call_status`, which the importer never
writes, so an imported row does not reach `callPreview` at all: the inbox shows
the stored body or nothing. Same underlying row, two different richnesses,
depending on which surface you open.

This was declared and filed rather than folded into the comms-panel
call-direction mission (spec
`docs/superpowers/specs/2026-08-18-comms-panel-call-direction-design.md`, section
8, F22), on the grounds that sharing the helper would change inbox previews for
every historical imported row - a second read surface with its own precedence
rules and its own tests, none of it needed to deliver the timeline panel.

**Suggested fix.** Promote the timeline's two helpers
(`normalizeCallOutcome` and the `call_duration_seconds` fallback) out of
`contactTimeline.ts` into a shared module both read surfaces import, then feed
the normalized outcome and the resolved duration into `callPreview`. Two things
to watch:

- It CHANGES the visible inbox preview for every imported call row that has ever
  been imported - that is the point, but it is a user-visible change to
  historical data and should be described as such, not slipped in.
- The inbox has its own precedence rule (a stored `body` wins over any derived
  preview, and the D12 derive arm deliberately preserves a specific row), so the
  normalization must sit INSIDE the derive path and must not start overriding
  stored previews.

A shared helper would also delete the deliberate duplication of `isCallStatus` /
`isCallOutcome` between `inbox.ts` and `contactTimeline.ts`, which is accepted
today only because the two surfaces were kept independent.
