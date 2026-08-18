---
id: extraction-notes-current-state-summary
title: Contact notes are append-only with no line identity, so a note can never be revised or superseded
type: improvement
severity: med
status: open
area: app/extraction
created: 2026-08-18
refs: app/src/services/extraction/apply.ts:657, dashboard/src/routes/contact/TenantFile.tsx:157
---

**Problem.** `contact.notes` is a single free-text string. Extraction appends
`[Auto - <MMM D>] <line>` lines to it and the dashboard renders the whole blob. A note
line therefore has no identity: nothing addresses it, so nothing can revise, replace,
or retire it.

The eight scalar fields and the address object all get a real reconciliation contract -
the model chooses `op: none | write | suggest` against the current value, and a
same-fact-better-form answer REPLACES what is stored. Note lines get none of that.
Appending is the only operation available, which means the model's only way to express
"what is noted is now wrong" or "what is noted should read differently" is to append a
competing line and leave both standing.

The product intent is that notes read as an up-to-date current-state summary of what we
know about this person, with a history section where one is warranted. The append-only
model cannot express that. The motivating case: a client says they do not want to move
forward on a unit, then later changes their mind. The desired end state is one line
reading roughly "originally did not want to move forward, now does" - a REWRITE. What
the current model produces is two contradictory lines, with nothing marking the second
as superseding the first, and a reader left to infer precedence from the dates in the
`[Auto - ...]` prefixes.

Observed on production contact 9556186f-f040-525a-b86d-e651e920ba72.

**Suggested fix.** Give note lines identity and a revise path. Sketch, not a decision:

- Model notes as an ordered list of entries (id, text, source, created, superseded-by)
  rather than one string, with the blob kept as the rendered view.
- Extend the wire schema so a note output can carry an op against an existing entry
  (`add` / `revise` / `none`) the way fields already do, with the entry id supplied in
  the profile snapshot.
- Decide how human edits interact. Field writes clear per-field `<field>_source`
  provenance on a human PATCH and delete superseded suggestions; notes have no
  provenance at all today, so a human rewrite is currently indistinguishable from an AI
  one.
- Decide whether a revise is a direct write or a suggestion. Overwriting a human's note
  text is a materially bigger action than filling an empty scalar field.

This is a data-model change with dashboard and human-edit consequences, deliberately
deferred rather than folded into the prompt-level fix.

**Interim mitigation (2026-08-18, branch `fix/extraction-note-restatement`).** The
system prompt now tells the model to reconcile each note line against the existing
notes and, when a fact is already noted, to append only what is NEW in as few words as
possible instead of re-telling the fact. That removes the redundant-copy symptom
without giving notes identity - the model still cannot revise a line, and contradictory
lines can still coexist. The underlying gap in this issue is unchanged.

Related: [extraction-tour-outcome-and-application-intent](./extraction-tour-outcome-and-application-intent.md)
