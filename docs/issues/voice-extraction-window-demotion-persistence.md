---
id: voice-extraction-window-demotion-persistence
title: One un-attributed call demotes a whole conversation's SMS auto-writes for up to 30 days
type: decision
severity: low
status: open
area: app
created: 2026-07-18
refs: app/src/jobs/extraction.ts, app/src/services/extraction/apply.ts
---

**Problem.** Layer 3 of the voice-extraction design demotes at WINDOW
granularity: `hasInferredRoleContent` is true when ANY utterance in the
assembled window has speaker 'unknown' (a legacy or underivable `Speaker N`
call line), and when true the whole run's field writes are demoted to
suggestions. The window is the newest ~50 messages within 30 days, rebuilt on
EVERY run including SMS-triggered ones. So a single un-attributed call sitting
in a conversation's window (a pre-feature bridge call, or any 2-channel
recording that arrived without a channel->role map) causes every subsequent
SMS-triggered extraction in that conversation to see an 'unknown' utterance and
demote ALL field writes to review chips - until that call ages out of the
window (<= 30 days). A clean high-confidence inbound-SMS fact is silently
downgraded to a suggestion because of an unrelated old call.

This is SAFE-DIRECTION (over-caution, never a wrong write) and it is exactly
what the approved all-3-layers spec says ("any window with inferred-role
content demotes"). It is surfaced as a DECISION, not a bug: the persistence
(one call poisons a conversation's direct-write capability for a month) is a
sharper edge than "voice extraction is conservative", and is worth an explicit
product call rather than an implicit side effect.

**Since WP1 B1 (2026-10-27).** A demoted run also appends NO Notes line -
model and system lines alike, feedback lines included - and counts them as
`notesDemoted` in the run record (spec 2026-10-26-wp1-b1-ranking-inputs D4;
Cameron kept the rule at the spec gate, Q1). So while an un-attributed call
stays in the window, the conversation records no Notes lines at all and the
Possible caseworkers `ai_note` signal cannot fire there. That is a loss, not a
downgrade to a review chip; weigh it when this decision is taken. (Recorded by
the WP1 B1 build research, reader E2.)

**Suggested fix.** Optional, if the behavior is judged too broad: scope
demotion to the fact's own SOURCE utterance (tag each extracted fact with the
speaker/channel it came from and demote only facts tracing to an
unknown-speaker line), instead of demoting the whole run. Larger change -
facts are not currently tied to single utterances - so it is a follow-up slice,
not a blocker. Alternative: leave as-is (accepted conservative behavior).
