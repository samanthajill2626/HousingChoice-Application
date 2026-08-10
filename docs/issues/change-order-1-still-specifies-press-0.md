---
id: change-order-1-still-specifies-press-0
title: PHASE1_CHANGE_ORDER_1 still specifies press-0 as scope and as a required golden-suite test, with no pointer to its removal
type: debt
severity: low
status: open
area: docs
created: 2026-08-06
refs: PHASE1_CHANGE_ORDER_1.md:9, PHASE1_CHANGE_ORDER_1.md:22, docs/issues/press-0-team-escape-removed.md
---

**Problem.** The press-0 "reach the team" escape was removed from the relay
whisper gate on 2026-08-06 (`press-0-team-escape-removed`, and the removal
shipped in `feat/business-number-config` @25944207). Two lines in
`PHASE1_CHANGE_ORDER_1.md` still describe it as live scope:

- `:9` - "optional press-0 for the caller to reach the team instead", listed as
  part of the masked-calling requirement.
- `:22` - "press-0 -> team" listed among the **required tests (add to the golden
  suite)**.

That second one is the one that matters. Anyone auditing the golden suite
against this document finds a required test that no longer exists and cannot
tell whether it was dropped deliberately or lost. The removal WAS deliberate and
is fully adjudicated - but not from where this reader is standing.

**This is doc drift, not a broken contract.** The file's own header says it is a
mid-flight instruction pasted into a build agent ("You are mid-execution on
`PHASE1_KICKOFF_PROMPT.md` ... Do not restart the phase; integrate"), so it is a
historical build record, already executed - not a live specification. It should
be corrected the way this repo corrects historical docs: with a dated pointer,
not by rewriting what it said at the time.

Found by the plan-blind adversarial reviewer during the pre-merge review of
`feat/business-number-config`. It was outside every surface map because nothing
greps change orders for feature copy.

**Suggested fix.** Add a dated superseded-note beside both lines (or once at the
top) pointing at `docs/issues/press-0-team-escape-removed.md`, in the same style
as the repo's other historical-doc banners. Do NOT delete the original text -
the record of what was asked for at the time is the point of the document.

Check `PHASE1_KICKOFF_PROMPT.md` in the same pass; it also mentions press-0.
