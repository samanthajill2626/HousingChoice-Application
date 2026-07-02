---
id: dnc-registry-scrubbing
title: National DNC Registry scrubbing for outbound cold calls (deferred from Voice Phase 1)
type: improvement
severity: low
status: deferred
area: app
created: 2026-07-02
refs: app/src/services/originateCall.ts, docs/issues/voice-do-not-call.md
---

**Problem.** Spun out of the resolved `voice-do-not-call` (its item 3). Manual,
human-dialed calls are outside the TCPA autodialer rules, and cold calls are
permitted — **unless the number is on the National DNC Registry** for a
solicitation call. Phase 1 (decided 2026-06-30, per the founder) ships with NO
automated registry check: cold-call volume is low, the primary cold-call targets
are landlords responding to their own public rental ads (often exempt as prior
invitation / non-solicitation), and the company `voice_opt_out` flag covers
anyone who tells US not to call. The residual exposure is a staffer cold-calling
a registry-listed number on a call a regulator would read as solicitation.

**Suggested fix (when volume warrants).** Operational first: the founder registers
for a Subscription Account Number at telemarketing.donotcall.gov and the team
scrubs cold-call lists manually. App-side later: a `dnc_status` field on the
contact (`listed | clear | unchecked` + checked-at), populated by a scrubbing
integration (third-party API or periodic list import), consulted by the originate
service as a warn-or-block for contacts with no prior relationship. Revisit when
cold-call volume grows or the team starts cold-calling tenants (not just
landlords advertising rentals).
