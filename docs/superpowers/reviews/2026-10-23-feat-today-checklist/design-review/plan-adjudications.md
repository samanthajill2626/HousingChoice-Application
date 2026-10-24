# Plan design review - adjudications

Plan: `docs/superpowers/plans/2026-10-24-today-checklist.md`.
Reviewers: A (`plan-r1-reviewer-a.md`) and B (`plan-r1-reviewer-b.md`), both
opus, same brief (plan + spec + repo), independent. ACCEPT = the plan was
edited; REJECT = no edit, with the reason; DEFER = filed. New rulings are
PR81-PR93 in plan section 4.

## Round 1 (plan v1 @05519039 -> v2)

Both reviewers ran every quoted old-text anchor against the tree (A: 347,
B: all) and found none dead; both found the W1-W8 / no-stamp writer map
complete. Nothing BLOCKING.

| Finding | Verdict | What changed / why |
|---|---|---|
| A1 founder-triage inbound call misclassified "touch first" | ACCEPT | Verified `voice.ts:802-814` (ring time emits only `message.persisted`; the comment says an abandoned ring has no Dial summary) and the touch at ~834. PR81: add the post-touch `contact.updated` there too. DECISION CHANGED (new surface). |
| A2, B2a WI1 pin reads the wrong `recipientDisplayCalls` shape, passes vacuously | ACCEPT | PR82 + slice text fixed to `call.opts?.consistentRead`. |
| B2 verbatim drafts contradict binding rulings | ACCEPT | PR83: every ruling that changes slice text is applied INTO the slice text (marked with the ruling id), so a literal builder never has to merge section 4 by hand. Section 4 still wins on any residue. |
| A3, B7 S2.2 harness default send path now judges world contacts; stale harness comment | ACCEPT | PR84: S2.2 names the harness suites that reach the default 1:1 send path, states the red-case rule (seed consent on the world contact, named in the report, never weaken the assertion), and fixes the harness comment itself. |
| A4 handback obligations (post-deploy backfill, tracker #31) in no task | ACCEPT | PR85: the S8 report template carries both lines. |
| A5, B4 PR25 drops a soft-deleted unit's address and WARNs every load | ACCEPT | PR86 replaces PR25's degrade rule: a present unit (deleted or not) uses `formatAddress(address) || unitId`; only a throw or an absent item yields the unitId + WARN. DECISION CHANGED (rule). |
| A6 W6 tests do not prove the stamp starts after the TwiML | ACCEPT | PR87: the injected `afterResponse` asserts the response finished and the fake touch was not yet called when the body was produced. |
| A7 one after-loop event per fan-out PASS vs spec "one per staff send" | ACCEPT (ruled) | PR88: accepted - continuation passes exist only for deferred members and are bounded; recorded as a deliberate reading of spec 7.3. |
| A8 PR77 has no terminal for "checklist empty, a section unavailable / fallback" | ACCEPT | PR89: terminals add "We couldn't load " (contains) and "Some sections can't load right now.". |
| A9, B1 WI8 names the wrong eventually consistent reads; the live tour promises ride GSIs | ACCEPT (record) | PR90: WI8 corrected (tours byStatus and byUnit GSIs, units byStatus GSI; listing sends is a base-table Query). No new mechanism: the same residue Today already carries for `conversation.updated` over the byUnread GSI (#30 W8); recorded in the S4 report and the S7 cost issue, and no e2e is read as proof of prod liveness. |
| A10 PR78's helper guard is not in the helper code | ACCEPT | Slice text fixed: the helper asserts the endpoint host and the `hc-local-<L>-` prefix before its UpdateCommand (PR83). |
| B3 a staff Retry of an automated / system-copy row stamps | ACCEPT | Verified the Retry route always sends `automated: false` (`api.ts:1877`). PR91: W2 also requires `original.automated !== true`; a Retry of a Send-now row (stored automated:false) still stamps - rare, accepted, recorded. The backfill applies the same rule where the retried row is in the window. DECISION CHANGED (gate). |
| B5 the type-filter-first unread walk runs to its budget on most loads | ACCEPT (record) | PR92: WI7 records the unread pages a load now reads; the S7 cost issue names it. Not a correctness change. |
| B6 stranded-afterSend arm widens spec W4 without saying so | ACCEPT (record) | PR93: recorded as a deliberate widening (the provider accepted the text); the backfill cannot see it (no slot sid), noted in the RUNBOOK entry. |
| B8 S6 C1 cites a 1:1 reconcile adoption that does not exist | ACCEPT | PR93 amends PR70: only relay-leg adoption; `adoptRetry` rows are machine retries (excluded). |

Round 1 changed decisions (A1, A5/B4, B3), so round 2 runs. Reviewer A is
continued (all 10 of its findings accepted, including the surface-level A1).

### Write-through (PR83) results, before round 2

The amender applied 23 rulings into slice text and found 30 already matched
(`plan-r1-amendments.md`), and raised three items, all ruled:

- S2.2 route-level cases asserted `world.sent`, but the /api router's
  default send service has no injected adapter (`api.ts:694-703`) and the
  harness api deps inject none (`twilioWebhookHarness.ts:5682-5700`), so it
  sends via the console driver. Verified. PR94: those cases prove the send by
  the persisted outbound row in `world.messages`; no adapter is wired in.
- PR95: PR89's terminals go in the ERROR group (precedent at
  `e2e/performance/routes.ts:506`).
- PR96: PR86 makes PR24's units `isDeleted` alias unnecessary.

Plan v2 @e04c578f. Round 2: reviewer A continued with the RE-REVIEW CHARGE.
