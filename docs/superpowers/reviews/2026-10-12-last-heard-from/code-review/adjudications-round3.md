# Code review round 3 - orchestrator adjudications

Date: 2026-10-13. Inputs: `conformance-findings-r3.md` (Reviewer A: 0 / 0 / 0 / 2
NIT; every round-2 item closed) and `adversarial-findings-r3.md` (Reviewer B:
0 / 0 / 1 MINOR / 1 NIT; R2-1..R2-5 real fixes). No blocker or major in any
round.

## Rulings

- B R3-1 (MINOR) ACCEPTED - fix wave 3 (one small code change). Undo (`clear`)
  becomes the same compare-and-clear as Interested: when the route READ a
  decline it clears with `{ expectedAt: <its at> }`; when it read none it writes
  nothing (no clearDeclined call, `wrote` false) and re-projects. Regressions: a
  re-decline landing during the Undo survives; an Undo that read no decline
  removes nothing recorded meanwhile.
  Reviewer A ruled "no change" on the same flag, arguing a server-read compare
  cannot close the race that matters (a STALE card). Both are right about
  different windows: B's fix closes the in-request window and makes a
  nothing-to-undo Undo a true no-op (consistent with Interested); A's stale-card
  race needs the client to send the decline it displayed - a contract addition,
  FILED as `docs/issues/outcome-actions-act-on-server-read-decline.md` and named
  in spec 14.7.
- A R3-1 (NIT) ACCEPTED as documentation: only a tour's CREATION is durable; a
  reschedule / reopen after a decline supersedes while the tour qualifies, but a
  later cancel overwrites the single `lastMarkedAt`. Spec 14.7 states it as a
  known limit; the fix-wave-3 child updates the PIN test comment; the handback
  names it for Cameron (a durable revival would need the tours PATCH to clear
  the decline - a product call).
- A R3-2 (NIT) ACCEPTED: the glossary's "send outcome" now spells out what
  "later tour activity" means under 14.7.
- B R3-2 (NIT) - NO CHANGE, recorded in 14.7 as a known limit: a recipient whose
  type changes from tenant (caseworker conversion) reads no tours, so a decline
  its tenant-era tour superseded is effective again - the spec's own "a
  non-tenant never reads a tour" rule (5.4, R3-F5).
- Self-QA re-run on the post-fix tip and the full gate battery are owed (both
  reviewers) - Phase 5 re-check and Phase 6.

## Review closure

After fix wave 3 the orchestrator reads the diff and Reviewer B (who raised
R3-1) is continued once for a narrow closure check of that change. The review
chain then closes: no open BLOCKER / MAJOR / MINOR.
