# S5 plan draft - findings (code vs spec/plan)

Findings only. The S5 draft (`.superpowers/sdd/plan-draft-S5.md`, section
"Contradictions") carries the full list; these two change what gets built
and need a planner ruling.

## F1. requireComplete on a FAILED chunk: the precedent rethrows the raw error

- Spec D5.1: "with `requireComplete` a failed chunk or an unread key throws
  `IncompleteBatchReadError`", citing the contacts repo precedent
  (contactsRepo.ts:776-810).
- The precedent does NOT do that: `batchGetByIds` rethrows the RAW chunk
  error (`if (opts.requireComplete === true) throw err;`,
  app/src/repos/contactsRepo.ts:1092) and throws `IncompleteBatchReadError`
  only for keys still unprocessed after the retries
  (app/src/repos/contactsRepo.ts:1099). Two callers document the two shapes:
  app/src/lib/propertyContact.ts:71-76 and app/src/repos/unitsRepo.ts:243-247.
- Draft's choice: follow the precedent (raw rethrow on a failed chunk,
  `IncompleteBatchReadError` on unread keys). The job catches ANY throw and
  fails the run as `repo` (app/src/jobs/extraction.ts:563-568 pattern), so
  the run outcome is identical either way; only the run record's
  `error.message` differs (the raw error's message is the more diagnostic).
- Planner: confirm, or rule that a failed chunk is wrapped in
  `IncompleteBatchReadError` (then S5.2's second test changes to
  `toBeInstanceOf(IncompleteBatchReadError)` and the catch counts the chunk's
  keys as unprocessed).

## F2. D4 keeps the no-address rule "verbatim"; D5.2 limits it

- Spec D4: "The reconcile, append-only, short-line and no-address rules stay
  verbatim."
- Spec D5.2: "The tenant's own address still never goes in a line ...
  Charter 6.4 amended limits the no-address rule to that."
- Code: the rule today bans every address in a noteLine:
  "- Addresses NEVER go in noteLines - the address output is the only place
  for address information." (app/src/services/extraction/prompt.ts:132-133),
  pinned by app/test/extractionSchema.test.ts:574. Left verbatim, it tells
  the model never to write the label D5.2 asks it to copy (every label is a
  street address).
- Draft's choice: S5.5 rewrites that one bullet to the client's OWN address
  and says a PROPERTIES SENT property is never the client's address, and
  updates the :574 pin. S4 must leave prompt.ts:132-133 as it is.
- Planner: confirm the ownership (S5, not S4) and the wording, which also
  serves D7's control "a tenant with no stored address who talks about a
  sent home must produce NO address op".
