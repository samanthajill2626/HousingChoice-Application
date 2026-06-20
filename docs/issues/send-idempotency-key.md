---
id: send-idempotency-key
title: No server-honored idempotency key on manual SMS send — retry can double-send
type: bug
severity: med
status: open
area: app/send-path
created: 2026-06-18
refs: app/src/routes/api.ts
---

**Problem.** `POST /api/conversations/:id/messages` has no idempotency key. If a send POST
reaches Twilio but the client sees a network failure, the user retries and the SMS goes out
**twice**. Confirmed 2026-06-18: no idempotency/dedup key exists on the send path in
the backend or the dashboard. (The retry route's "no double-text on a delivered message"
guard at `api.ts:478` is a different mechanism and does not cover this transient.)

**Suggested fix (backend).** Accept a client-generated stable idempotency key per logical
send (e.g. the original `tsMsgId`/`localId`), thread it to `sendMessage`, and dedupe a
re-POST server-side.

**Accepted risk meanwhile.** Manual human resends are low-volume, so the residual
double-send was explicitly accepted at M1.4.

Graduated 2026-06-18 from an inline `TODO(idempotency)` in the (now-deleted) legacy
dashboard's `useThreadMessages.ts`. The fix is backend-side, so it covers the send path
for the current dashboard regardless of the legacy removal.
