# Research findings — scheduled-message-visibility

Phase-1 research for [docs/issues/scheduled-message-visibility.md](../../issues/scheduled-message-visibility.md).
Four parallel read-only sweeps, each with `file:line` citations a planner can build off.

1. [01-scheduled-send-sources.md](./01-scheduled-send-sources.md) — every durable scheduled-send
   mechanism. **Verdict: only TWO real future-dated outbound-SMS row sources** — tour reminders
   (`tourReminders` table) and placement nudges (`placementNudges` table). `next_deadline` is a
   board clock (no SMS); `retrySend` is ephemeral (≤240s, no queryable row); broadcasts fire
   immediately. Bodies are canned `[AUTO]` per-`kind` templates (faithful preview). Rows key on
   `tourId`/`placementId` — **no by-conversation index**.
2. [02-timeline-architecture.md](./02-timeline-architecture.md) — server builder → client types →
   renderer → SSE. Two `TODO(scheduled-message-visibility)` anchors already planted. **Ordering
   hazard: a future `dueAt` sorts newer than every message and corrupts the DESC-take-limit
   pagination + cursor** — future items need a carve-out (a separate `upcoming[]` bucket).
   future→sent already refetches for free on `message.persisted`; arm/cancel need a new event.
3. [03-send-gates.md](./03-send-gates.md) — the send-time suppression gates. Read-only-evaluable:
   kill-switch, opt-out, manual-mode (subsumes tripped breaker). N/A: JIT consent (automated
   bypasses), live breaker (unpredictable). Plus row-level canceled + nudge stale-stage.
   **Recommends a shared `evaluateScheduledSendSuppression()` helper** both send + preview call.
4. [04-e2e-seams.md](./04-e2e-seams.md) — deterministic tick seams (`POST /__dev/tour-reminders/tick`,
   `/__dev/placement-nudges/tick`, both take an injectable `now`), fake-twilio `listThreads()`
   proof-of-send, the `Scenario` verb vocabulary, and a concrete recipe for the four target specs.
