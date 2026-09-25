# Spec review round 4 - adjudications (terminal round)

Planner adjudication of `spec-review-r4.md` (reviewer B, continued; 7 findings)
against spec DRAFT 4 @`3b43a4a3`. The reviewer returned "STOP: precision only":
no finding changes what gets built, adds or removes a surface, or moves an
invariant. Per the stop rule this is the TERMINAL round: the edits are folded into
DRAFT 5 and the design goes to Cameron's spec gate.

Result: all 7 ACCEPTED as precision edits; 0 REJECT, 0 DEFER; no decision changed.

| finding | verdict | edit |
| --- | --- | --- |
| R4-1 the bounded-acquire timeout has no stated way out; reconcile calls the acquire best-effort | ACCEPT | D4 names the path: a distinct outcome (or a job-side catch) before the unit's `attempted` write, closed through `refuseGate`, never `transient`; today the error would escape and strand the rung at `queued`. Section 5 gains requirement 5: for a relay retry rung a deadline timeout is terminal whatever phase model `sendOneRelayLeg` adopts. Reconcile cited at revision 5 @`922675db`. |
| R4-2 the server-clock estimate's three traps | ACCEPT | D8 names them: the API client discards headers (`client.ts:92-126`); a server-now field needs `no-store` (304 bodies are stale); the ticker's arming predicate reads the same estimate. Section 4 lists the surfaces. |
| R4-3 "relay wins" plus the relay-default `rosterKind` | ACCEPT | D8: the one-to-one chip never passes `relay`; D12 keeps that rationale in the rewritten comment; test intention 7 renders with the default `rosterKind`. |
| R4-4 residuals omit D3a's fail-open without a stamp | ACCEPT | Section 9 and the double-send issue's gap 2 name it. |
| R4-5 section 1 states both bounds without exceptions | ACCEPT | Section 1 names the no-usable-origin exception (D5) and the pending-reconcile promise; section 9 lists the first as accepted. |
| R4-6 two precision gaps in D3 step 2 | ACCEPT | The preview runs the gates in the job's order; a read failure on that path is `claim_failed` (ERROR, 5xx, redelivery), not WARN - D9 corrected. |
| R4-7 section 7 omits the round's one visible change | ACCEPT | Section 7 lists it: a late 30003 after a human action now reads the plain "Phone unreachable (error 30003)" instead of "Not retried - ...". |

## Review totals across the four rounds

| round | reviewer(s) | findings | accepted | rejected | decisions changed |
| --- | --- | --- | --- | --- | --- |
| 1 | A and B, independent | 24 | 24 | 0 | 6 |
| 2 | B, continued | 14 | 14 | 0 | 5 |
| 3 | B, continued | 11 | 11 | 0 | 4 |
| 4 | B, continued | 7 | 7 | 0 | 0 (terminal) |
