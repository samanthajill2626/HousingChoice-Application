---
id: manual-extraction-route-has-no-spend-fence
title: The manual extraction route spends money with no per-user rate limit, unlike every other billed route
type: decision
severity: med
status: open
area: app/extraction
created: 2026-08-16
refs: app/src/routes/contacts.ts:1957, app/src/middleware/rateLimit.ts:174, app/src/routes/api.ts:1124, app/src/routes/voiceApi.ts:112, docs/superpowers/specs/2026-08-13-manual-extraction-trigger-design.md
---

**A recorded decision, not a defect.** Design section 5 decides it explicitly:
"No rate limiting. It is a human-speed action, each press costs one model call
per eligible thread, and the sliding upsert already collapses bursts." The route
conforms to the approved spec. This file exists so the decision is findable in
the registry rather than only in a review transcript, and so the human can
revisit it with the fact below in hand.

**Problem.** `POST /api/contacts/:contactId/extraction-run`
(`app/src/routes/contacts.ts:1957`) bills one real model call per eligible 1:1
thread on every press, and carries no limiter. Every other money-spending route
in this repo carries a per-user `createUserRateLimit`
(`app/src/middleware/rateLimit.ts:174`), whose own header calls it "the spend
fence": manual sends (`app/src/routes/api.ts:1124`), broadcast sends
(`app/src/routes/broadcasts.ts:577`), outbound call origination
(`app/src/routes/voiceApi.ts:112`), and the media presign/confirm pairs. This
route is now the exception.

**What the spec's reasoning does and does not cover.** The debounce collapse is
real but per-CONVERSATION: two presses on the SAME contact while its row is
still waiting produce one run. It does nothing about a script (or a stuck UI)
walking a contact list, because presses across different contacts do not
collapse, and the manual waiver makes each of those runs the WIDEST window the
system ever produces (the 30-day floor is waived, so the whole newest-50 page is
sent). See also `manual-extraction-bulk-backfill`, which is the sanctioned way
to sweep a population and is deferred.

The blast radius is bounded by authentication: the route sits behind the
dashboard's authenticated router, so this is a staff-facing spend surface, not a
public one.

**Suggested fix (only if the human decides to close it).** A
`createUserRateLimit` per user on this route, sized to a human's press rate
rather than to a script's. That is a one-line addition next to the sibling
limiters and needs no change to the job, the repo, or the UI.
