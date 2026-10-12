# Spec review R2 - reviewer B (adversarial)

Spec: `docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md` rev 2 @8c2c727e.
Also read: `design-review/adjudications.md` (round 1, J1-J24) and `spec-R1-reviewer-a.md`.
Tree: `W:\tmp\primary-contact-integrity` (code unchanged since round 1; the rewrite is
docs-only). Read-only; nothing was run. Severity is consequence-if-shipped. Rev 2 sections are
cited by number; code by file:line actually read.

Summary list:

1. HIGH - P2 still fires only when NO row is flagged, but J1 now leaves the flag on a deleted sole contact: "delete Mark, add his replacement" never promotes the replacement
2. MEDIUM - The heir function's step 1 ignores the exclusion, and the delete fan-out reads the just-deleted contact's liveness back through an eventually consistent batch, then works from an eventually consistent Scan
3. MEDIUM - 7.5's complete batch read covers only roster rows; an OFF-ROSTER landlord reads as "missing" = deleted, so the page warns while tours use that landlord
4. LOW - P1 lists the read before the tenant check; a throw on a tenant-primary read yields `readFailed` with the TENANT's id, which the default list keeps as a bare property-contact row
5. LOW - "Every nobody maps to today's no-landlord code" changes asserted diagnostic strings for the tenant and deleted cases, and the placement diagnostic has no such code
6. LOW - Switching enrichRoster to `requireComplete` drops EVERY name on a partial read; "un-enriched exactly as today" is false
7. LOW - The post-restore refetch does not displace a stale `rosterUnit`, which the Contacts card prefers
8. LOW - P4's "legacy scalar fixed by the next roster write or the script" is not delivered by either
9. LOW - Copy gaps the rewrite introduced: the 7.4 "primary contact was deleted" lead, a nameless off-roster heir in 7.3, the 7.6 sentence
10. LOW - The e2e seam does not say whether it mints its own unit or rewrites a shared lean unit (serial run, no reseed between specs)
11. LOW - Contest J24: on a UNIT read failure the tour reasons ARE decidable; the adjudication asserted the opposite of the code

Adjudications contested: J1 is accepted as a mechanism but incomplete (finding 1). J24's 5.1 wording
(finding 11). J6: no contest - it is the second option I proposed in R1-B6. All other
adjudications: no contest.

---

## 1. HIGH - P2's flag-only trigger plus J1 re-creates the reported bug in the commonest workflow

What is wrong. J1 (rev 2 section 4.6, Delete): when the deleted primary has no heir, "NOTHING
changes (the deleted contact stays flagged)". P2 (4.4) fires only when, after the write, "NO
roster row is flagged primary". A flag on a DELETED contact is still a flag. Rev 1 said this out
loud ("It reads the FLAG, not the flagged contact's liveness"); rev 2 removed the sentence but kept
the mechanism.

Walk the ordinary "Mark left, here is his replacement" workflow on 470 Bolton (no landlord, Mark
primary after the script):
- Sam deletes Mark. Delete fan-out: no live heir, so nothing changes; Mark stays flagged.
- Sam adds Jane. After the write a row is flagged (Mark, deleted), so P2 does not run. Jane is
  added unflagged.
- P1: candidate 1 = Mark, deleted -> skip; no landlord -> nobody, reason `deleted`. Every new tour
  leaves Jane off the default list and sends the general intro - the exact symptom in section 1.

The opposite order (add Jane first, then delete Mark) heals through the fan-out's heir. So the
result depends on click order. The same holds for a landlord-only property whose landlord is
deleted: the derived landlord row is flagged (`app/src/repos/unitsRepo.ts:300-301`), and P2 says
"Properties whose landlord-of-record row is flagged primary are untouched" - even when that landlord
is deleted.

G1 promises a LIVE primary; P4 (4.7) only promises "has a primary", and a deleted one satisfies it.
The two statements disagree, and the mechanism follows P4. The property box (7.4) is the only thing
that catches this. The script is one-time and will not.

What it implies. P2's trigger must be "no LIVE flagged primary after the write": the flag is absent,
or the flagged contact is deleted or missing. 4.2 already reads that liveness for P2, so this costs
no new read. With it, re-sending `primaryContact: true` on an already-primary deleted row (allowed by
4.4) also hands off correctly instead of pinning the deleted contact. J1's "no heir changes nothing"
stays right; it just needs P2 to finish the job when an heir appears.

## 2. MEDIUM - Heir exclusion and the delete fan-out's read discipline

What is wrong, three linked parts:

(a) 4.3 takes "an optional contact to exclude", but only step 2 honors it ("not the excluded
one"). Step 1 is "the landlord of record, if live", with no exclusion. For the 7.5 field
`heirIfPrimaryRemoved` ("heir function excluding the primary"), the commonest property - the
landlord row is the primary - returns THE PRIMARY ITSELF as its own heir. The UI happens to hide
that (the landlord row cannot be removed, `ListingDetail.tsx:879,895`), but the definition is wrong
and tests will pin it.

(b) In the delete fan-out the excluded or deleted contact is usually the landlord of record (every
landlord-only unit's derived primary). The spec never says the fan-out treats the contact it just
deleted as not live. A builder following 4.2 re-reads liveness with ONE `getManyByIds` batch. That
BatchGet carries no `ConsistentRead` (`app/src/repos/contactsRepo.ts:979`), so straight after
`softDelete` it can return the contact without `deleted_at`. Step 1 then picks the deleted landlord
as heir of themselves: a no-op that skips the live PM who should have taken over. Nothing re-runs a
contact's delete fan-out. The route already holds the authoritative ALL_NEW item
(`app/src/routes/contacts.ts:2235`); it should override the read.

(c) The fan-out finds units with ONE Scan, and `units.list` has no `ConsistentRead` option
(`app/src/repos/unitsRepo.ts:1026-1043`). Its handoff write is conditional on the roster it read
(4.2 / `updateRosterIfCurrent`). A stale Scan item therefore fails its condition. 4.6 calls every
per-unit failure "logged with the unit id", so a lost race becomes a lost handoff. 4.2's own
accepted-race argument ("catches it if its Scan reads the unit after that write") assumes a Scan
that sees recent writes. The script specifies a "consistent Scan" (section 8); the fan-out does not.

What it implies. Step 1 must honor the exclusion. The delete fan-out must mark the deleted contact
not live from the delete's own result. On a condition failure it should re-read the unit
(`getById` supports `consistentRead`, `unitsRepo.ts:610-618`) and retry like the roster writes do,
rather than log and drop.

## 3. MEDIUM - 7.5's read omits an off-roster landlord

What is wrong. 7.5 says only that "enrichRoster moves its batch read to `requireComplete`".
`enrichRoster` reads exactly the roster rows' ids (`app/src/routes/units.ts:385-390`). The 7.5
block is "P1 with no tenant" plus the heir function, and both consult the LANDLORD OF RECORD
(4.1 candidate 2; 4.3 step 1). Rev 2 itself now treats the off-roster landlord as a real state
(section 3; 9.1 names the PATCH reassign and the importer's `if_not_exists(landlordId)`,
`app/src/lib/import/apply.ts:1545-1552`). Run over a complete batch that never asked for that
landlord, P1 sees "missing", treats it as deleted, and skips to nobody with reason `deleted`.

Result: the page shows "The primary contact was deleted" and "Add a contact and make them primary",
`heirIfPrimaryRemoved` skips the landlord, and the 7.3 notice says "New tours won't include a
landlord" - while every runtime reader resolves P1 through `getById` and finds the live landlord.
The page and the system disagree on exactly the importer-touched properties this feature targets.

What it implies. 7.5 must add `landlordId` to the batch, as 4.2 already requires for writes.
Better: one shared "liveness map for a unit" helper used by 7.5, P2, P3 and the script, so the
id set cannot differ between them.

## 4. LOW - P1 reads before it checks the tenant

4.1 lists the outcomes in order: read throws -> STOP `readFailed` with `candidateId`; THEN "the
candidate IS the given tenant -> STOP". Today the tenant comparison is an id check made BEFORE any
read (`app/src/lib/tourContacts.ts:138-142`; `app/src/lib/rosterResolution.ts:298-300` compares
ids before `memberFromContact`). Read-first means a throw on a tenant-primary returns `readFailed`
with the tenant's id. 4.1 tells the default list to keep a bare `{ contactId }` row for that
candidate, so the TENANT appears twice on the default list (and in a materialized plan). The
reminders also fail closed where today no read was attempted. Say the tenant check is by id and
comes first.

## 5. LOW - Diagnostics mapping does not "keep their codes"

4.1: "every 'nobody' outcome maps to today's no-landlord code". Today the TOUR diagnostic has no
tenant de-dupe. When the property contact is the tenant, it reads that contact, finds the phone,
and returns 'this tour roster has fewer than two reachable members'
(`app/src/services/rosterProvision.ts:236-247`). A missing contact returns 'landlord contact not
found' (`:239`). Rev 2 sends `is_tenant` and `deleted` both to 'unit has no landlord (cannot
resolve landlord)' (`:236`). That changes strings the file says are "asserted verbatim by the API
tests" (`:194-196`), and it is false for a unit that HAS a (deleted) landlord. The placement
diagnostic has no no-landlord code at all: one `landlord_unreachable` covers missing, no phone and
no id (`:515-532`). State the per-outcome mapping explicitly.

## 6. LOW - `requireComplete` makes the degraded display worse than today

7.5: on an incomplete read "the rows serve un-enriched exactly as today". Today a partial read
KEEPS the names from chunks that succeeded (`app/src/repos/contactsRepo.ts:944-947`) and drops only
the unread keys. With `requireComplete`, a single unprocessed key throws
`IncompleteBatchReadError`, which carries no partial map (`contactsRepo.ts:622-633`), so every row
loses its name. Do a best-effort read for display and judge completeness separately - for example,
the returned map plus a separate complete-or-not signal - rather than throwing the names away.

## 7. LOW - The post-restore refetch does not replace `rosterUnit`

7.5: "After either unit restore ... the page REFETCHES the unit". The Contacts card prefers
`rosterUnit` whenever one exists for this unitId (`dashboard/src/routes/listing/ListingDetail.tsx:285-287`).
`rosterUnit` survives a delete, because the card only becomes read-only. So for a property whose
roster Sam edited before deleting it, a refetch that only updates `unit` leaves the stale pre-delete
roster and block on screen after a restore that ran a handoff. The rule should say the refetch
also replaces the last roster source.

## 8. LOW - P4's scalar repair claim

4.7: legacy scalars "may disagree until their next roster write or the script". The script targets
only units whose flagged primary is absent or not live (section 8), so a unit with a live flagged
primary and a stale or foreign scalar - for example one set by today's unchecked POST/PATCH
`primary_contact`, `app/src/lib/unitFields.ts:104` - is never written. And a non-primary remove
writes no scalar (`app/src/repos/unitsRepo.ts:892-913`, the patch touches `primary_contact` only
when the removed row was primary). Either let the script also count or fix scalar-only drift, or
drop "or the script" and "next roster write". No runtime reader, so LOW.

## 9. LOW - Copy gaps the rewrite introduced

- 7.4's lead "The primary contact was deleted." shows whenever P1's reason is `deleted`, which
  includes "no flagged primary, and the landlord of record (candidate 2) is deleted". 7.1 was
  reworded to "the contact on file"; 7.4 was not.
- 7.3 heir present: the block carries only an id. When the heir is an off-roster landlord (J16),
  the row is not in `contactRows`, so today's lookup falls back to the raw id
  (`ListingDetail.tsx:471-476`) - "contact-abc becomes the primary contact".
- 7.6's sentence says "the next contact on that property takes over", but the heir is the landlord
  first (4.3), and with no heir nothing happens at all. It is also hidden for `tenant`-typed
  contacts, who can sit on a property roster as the primary (the roster add route checks no type
  for non-landlord roles, `app/src/routes/units.ts:1061-1137`).

## 10. LOW - The e2e seam's blast radius

Section 10's seam "puts one property into the imported shape". It does not say whether it MINTS a
new unit and contact or rewrites an existing lean unit. The suite runs serially in one world
(`e2e/playwright.config.ts:140-141`), and the lean world is byte-stable by contract, so rewriting a
shared unit leaks into every later spec that uses it. Say the seam mints its own unit and contact,
following the org-fixture seam's targeted writes (`app/src/routes/dev.ts:1213-1240`).

## 11. LOW - Contest J24 (5.1)

Reviewer A (F18) noted that on a UNIT read failure the tour reasons are still decidable. J24
"fixed" this by asserting "nothing else can be decided", and 5.1 now says reasons are
`['lookup_failed']` alone when the owner OR unit read fails. In the code the tour is read first and
`scheduledAt` / the started check are settled before the unit read is attempted
(`app/src/jobs/relayFanOut.ts:460-482` vs `:507`). Either evaluate the tour reasons on a unit
failure, or say plainly that suppressing them is a choice, not an impossibility. Cosmetic either way.

---

## Round-1 fixes checked against the mechanism

- J1 (delete no-heir changes nothing): correct for delete-then-restore; incomplete without the P2
  trigger change (finding 1).
- J2 (4.2 liveness contract): right shape; read consistency for the deleting contact and the Scan
  unstated (finding 2); location (the repo has no contacts dependency, `unitsRepo.ts:754-941`) left
  to the plan - acceptable.
- J3 (block absent on incomplete): correct, except the id set (finding 3) and the name loss
  (finding 6).
- J4 (409 only for not-already-primary; Make primary hidden on deleted rows; own copy): correct.
- J5 (suggestions skip deleted rows): correct; degrades to today's behavior when the block is absent.
- J6 (refetch after restore; keep the last roster source): correct, plus finding 7.
- J7 (readFailed carries the candidate id): correct, plus finding 4's ordering.
- J8 (P2 runs the heir function): correct choice of heir; wrong trigger (finding 1).
- J9 (script's own conditional write): correct. `updateRosterIfCurrent` is module-private
  (`unitsRepo.ts:522`), so the plan needs a repo method - fine.
- J10 (script target): correct.
- J12 (tenant stops the walk): correct semantics; ordering, finding 4.
- J16 (off-roster landlord heir adds a row): sound. It matches what P1 already resolves at runtime,
  so it changes no tour behavior. It exposes finding 3 on the read side.
- J19 (swap re-runs the heir function): correct.
- J22 (pure heir function shared with the fake): correct. The fake's `getManyByIds` ignores
  `requireComplete` (`app/test/helpers/twilioWebhookHarness.ts:2274-2280`), so "unknown" paths
  cannot be exercised through the fake. API tests for 503 / unknown need an injected failing
  contacts repo - worth one line in section 10.
