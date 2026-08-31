# Plan round 1 adversarial review

## 1. [BLOCKING] The type drain has no initial post-write read when the pre-write snapshot is empty

**What is wrong**

Task 4 explicitly requires an empty-pre-write race test: a type suggestion put after
the contact update must be drained.  But its prescribed algorithm says that the
first drain candidate is `pendingTypeBefore`, and only reads again *after every
attempt*.  When the pre-write snapshot is absent, there is no candidate to inspect
or delete, and no specified first consistent read.  A builder who implements the
shown loop literally has no operation that observes the injected row.  Passing the
required empty-snapshot test requires inventing an initial `getSuggestion` step.

**Evidence**

- Spec D11 requires the classification writer to do a bounded consistent
  point-read/drain after every kind-carrying PATCH, including a row first observed
  after the contact write (docs/superpowers/specs/2026-08-26-ai-contact-kind-suggestions-design.md:309-317).
- The plan makes the first candidate only `pendingTypeBefore` and says subsequent
  point reads happen after an attempt (docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:1145-1158).
- The plan's own required race explicitly begins with no pre-write type row and
  injects one after the write (docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:1098-1105).
- The current route only snapshots fields before `contacts.update` and its
  replacement remains pending if it was created during that update
  (app/src/routes/contacts.ts:1506-1539), so there is no existing post-write read
  that could accidentally satisfy the missing operation.

**Implication**

The literal plan leaves an unreachable-but-required D11 case: a newly published
older-epoch type suggestion can remain in Today with no Unknown-card review
surface.  Specify the initial consistent type read after the successful contact
write (then bounded rereads after each CAS result), including how its errors are
handled, before implementation starts.

## 2. [HIGH] The new pre-write type read is not kept best-effort

**What is wrong**

Task 4 adds a separate `await extraction.getSuggestion(..., { consistentRead:
true })` before the contact write, but gives it no try/catch or error rule.  The
existing generic snapshot deliberately catches that same repository failure and
continues to the contact update.  A literal implementation of the new snippet
therefore turns a transient extraction-repository read error into a failed contact
PATCH, contrary to D11's retained best-effort contract.

**Evidence**

- The plan's new pre-write path is a bare awaited read
  (docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:1120-1131).
- The existing snapshot treats `getSuggestion` failures as unsafe-to-delete but
  non-fatal, logging and continuing (app/src/routes/contacts.ts:1506-1516).
- The specification says repository failures retain the best-effort,
  log-and-continue boundary rather than fail an otherwise successful contact PATCH
  (docs/superpowers/specs/2026-08-26-ai-contact-kind-suggestions-design.md:347-353).

**Implication**

A navigator can be unable to classify a contact solely because the advisory
suggestion store was temporarily unavailable.  The task must prescribe a guarded
read that logs and leaves `pendingTypeBefore` absent, while still performing the
post-write drain if the contact write succeeds.

## 3. [HIGH] Task 1 makes Partner and Property Manager live suggestion values before any consumer can honor them

**What is wrong**

Task 1 widens the schema/parser and commits it before the reconciliation, route,
and dashboard tasks.  That is not an isolated contract change: the current apply
path immediately persists any parsed type suggestion, while the current Unknown
card has only Tenant/Landlord actions and the current route compares only the raw
patched `type`.  Thus a Partner/Property Manager suggestion can be published for
three tasks with no matching card action; a Property Manager completed through the
existing editor is judged against `landlord`, not `property_manager`.

**Evidence**

- Task 1 changes the applicable parser and commits that change
  (docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:150-185,
  259-270), while the dashboard replacement is not scheduled until Task 5
  (docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:1227-1245).
- The current apply service creates a pending `target: 'type'` row directly from
  every parsed suggestion for an Unknown contact
  (app/src/services/extraction/apply.ts:534-557).
- The current card only exposes `onTriage` for tenant/landlord and renders only
  those two buttons (dashboard/src/routes/contact/UnknownFile.tsx:54-57,
  101-118); the current dashboard writer sends only `{ type }`
  (dashboard/src/routes/contact/ContactDetail.tsx:637-645).
- The current route's type verdict compares the suggestion to
  `parsed.patch[f]`, not the updated contact's complete type-plus-role shape
  (app/src/routes/contacts.ts:1540-1549).  The spec requires complete-kind
  comparison precisely to distinguish Property Manager from Landlord
  (docs/superpowers/specs/2026-08-26-ai-contact-kind-suggestions-design.md:224-247).

**Implication**

The plan has a false independent slice: after Task 1 a real extraction may create
an advisory value the current UI cannot apply correctly, and Property Manager
accuracy can be recorded incorrectly.  Reorder or feature-gate the parser change
with its end-to-end consumer path; at minimum, do not present Task 1 as a green,
committable standalone behavior change.

## Attacked areas that held

- The proposed contact revision is deliberately absent on creates and atomically
  incremented in the existing single `UpdateCommand`, matching D11's logical-zero
  forward-compatibility requirement (plan:327-368; app/src/repos/contactsRepo.ts:1152-1211).
- The guarded delete is correctly planned as one transaction with a contact
  `ConditionCheck` and exact suggestion-identity `Delete`, rather than a
  vulnerable read/delete pair (plan:484-521; spec:339-346).
- The plan retains the generic type-accept refusal and keeps classification on the
  existing PATCH route, as required (plan:1190-1199; app/src/services/suggestionResolution.ts:203).
