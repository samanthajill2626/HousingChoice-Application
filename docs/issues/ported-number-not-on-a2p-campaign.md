---
id: ported-number-not-on-a2p-campaign
title: The ported 678 number is not on the A2P campaign's number inventory
type: bug
severity: high
status: in-progress
area: ops/a2p
created: 2026-08-06
refs: docs/a2p/campaign-resubmission.md:209, docs/superpowers/specs/2026-08-05-quo-airtable-import-design.md:18
---

**Problem.** `docs/a2p/campaign-resubmission.md` item 9 ("Number inventory")
requires that **every number the app can send from** is attached to the campaign's
Messaging Service, and names two things: the main opt-in number **(404) 982-4978**
and **every relay pool number**.

It does not name **+1 678-284-2537** — the founder's Quo number, which ports to
Twilio at the M1.11 cutover (2026-08-10) and immediately becomes the number the
app sends the great majority of its traffic from. It was not on the inventory
because at the time the doc was written it was not ours yet.

The consequence is the failure mode the whole A2P exercise exists to prevent: a
number that carries traffic without belonging to the approved campaign gets
carrier-filtered (error 30034). Everything on our side would look healthy —
messages accepted, no errors in the dashboard — while tenants simply never receive
them. That is the specific outcome the campaign doc calls "the one thing that can
look fine on our end and still be broken".

A grep of `docs/` and `RUNBOOK.md` finds the number only in the M1.6 import
design; nothing ties it to the campaign, the Messaging Service, or the cutover
checklist.

**Operator plan (Cameron, 2026-08-06).** Attaching the ported number to the
Messaging Service via the Twilio console, immediately after the port completes, as
part of the cutover run. That is the correct mechanism and closes the filtering
risk above - this issue stays open only until the step is actually performed and
item 9 of the campaign doc is updated.

**Suggested fix.** Add attaching the ported number to the campaign's Messaging
Service as an explicit, ordered step in the M1.11 cutover procedure — it can only
be done once the port completes, so it is a cutover-day action rather than
something that can be front-loaded. Then:

1. Confirm the number is attached before any outbound send is attempted from it.
2. Send one real message to a verified staff cell and confirm delivery (not just
   acceptance) before `SMS_SENDING_ENABLED` is flipped on prod.
3. Update `docs/a2p/campaign-resubmission.md` item 9 so the inventory list names
   the ported number alongside the main number and the relay pool, and so the next
   person reading it does not rediscover this.

Related: the same doc notes the campaign re-submission must be **approved** before
live SMS is enabled at all. If approval is still pending on 2026-08-10, texting
does not work on day one regardless of this issue — worth tracking as the same
gate.
