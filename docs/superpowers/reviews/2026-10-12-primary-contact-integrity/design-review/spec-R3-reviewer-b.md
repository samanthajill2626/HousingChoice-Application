# Spec review R3 - reviewer B (adversarial)

Spec: `docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md` rev 3 @1f546052
(diffed against rev 2 @8c2c727e). Adjudications: `adjudications.md` Round 2 (K1-K12).
Also re-read: the `fix/caseworker-integrity` spec (git objects; I4 and L2). Read-only;
nothing was run. Code citations are file:line actually read.

Summary list:

1. MEDIUM - Failure-shape gap: a thrown BatchGet chunk rethrows the RAW error, not `IncompleteBatchReadError`. 7.5 and the section-10 injected test name only the latter. With K1 every add does this read, so a narrow catch turns a transient throw into a failed ADD, a 500 property GET and a 500 (not 503) remove.
2. MEDIUM - The heir function cannot tell what TYPE of contact it is promoting. P2, P3 and the script now promote whoever is earliest-added and live, including a caseworker who already had a seat (caseworker-integrity I4 refuses only NEW seats; L2 leaves existing ones). The intro then names that caseworker as the landlord, and the script does this in bulk with name-free output.
3. LOW - Two rev-2 sentences in 4.4 contradict K1, and P2's no-heir branch now splits flag from scalar.
4. LOW - The placement diagnostic's is_tenant case is `relay_member_unresolvable` today, not `landlord_unreachable`; rev 3 contradicts its own "keep each text for the state it describes".
5. LOW - Precision: the 4.2 id set must include the ADDED contact; the fan-out's re-decide must re-check that the deleted contact is still primary; the 7.4 "make them primary" copy is now automatic.

Only finding 2 could change a decision (it adds an eligibility rule to the heir function).
Finding 1 changes no decision but is the one most likely to ship as a real regression. No
adjudication contested: K1 and K2 are the mechanisms I proposed in R2, and K3-K12 match their
findings.

Specifically asked:
- K1 cost: one extra BatchGet per roster add, re-role or Make primary - small rosters, a human-rate
  action. Acceptable.
- K1 failure modes: see finding 1.
- K1 and caseworker-integrity's add-route checks: no conflict. Its checks are route-level reads
  made before the repo call (caseworker spec "Contact list (I4)": `contact_list_caseworker`, then
  `landlord_not_landlord`, both before the repo). The liveness read sits in the repo write loop.
  The 409 `primary_contact_deleted` placement is already pinned to "after" those checks (4.4).
- K1 and a healthy landlord-primary unit: no behavior change while the landlord is live - the
  flagged derived row is live, so P2 does not run. It changes only when the flagged landlord is
  deleted or missing (intended), plus finding 1's failure mode.
- K2: correct in shape - exclusion at every step, consistent Scan, consistent re-read on a
  conditional failure, bounded retries. One precision point is in finding 5.

---

## 1. MEDIUM - Two failure shapes, but the text names one

What is wrong. `getManyByIds(..., { requireComplete })` fails in TWO ways:
- a chunk whose request THROWS is rethrown as the raw error (`app/src/repos/contactsRepo.ts:986-990`);
- keys left unprocessed after retries throw `IncompleteBatchReadError` (`:994-996`).

Rev 3 names only the second. 7.5: "If that read is incomplete (`IncompleteBatchReadError`, which
carries no partial map), it falls back to today's best-effort read". Section 10: "the 503 /
unknown paths are tested with an injected contacts repo whose batch read throws
`IncompleteBatchReadError`". 4.2's general rule ("A failed or incomplete read means liveness
UNKNOWN") covers both, but the two concrete sites a builder will code and test against name one
class.

What it implies. With K1, every add now does this read. A builder who catches only the named class
passes every specified test and ships:
- a failed ADD (500) on a transient BatchGet throw, where 4.4 promises "the add still succeeds
  without a promotion" - a new way for an ordinary add on a healthy unit to fail;
- a 500 on `GET /api/units/:id`, which today never 500s on a contact lookup failure
  (`app/src/routes/units.ts:391-396`). That GET also feeds the tour and placement pages
  (`useTour.ts:90`, `PlacementDetail.tsx:185`);
- a 500 instead of the specified 503 `roster_read_failed` on remove.
Fix: say "any throw from the read, or an incomplete read" at 7.5 and section 10, and test BOTH
shapes - an injected raw throw as well as `IncompleteBatchReadError`.

## 2. MEDIUM - The heir function promotes contacts of any type

What is wrong. 4.3's heir is "the earliest-added LIVE roster contact". Liveness is the only test.
Before this spec, no write ever chose a primary on its own: today `removeContact` promotes only the
landlord of record (`app/src/repos/unitsRepo.ts:898-905`), and every other primary was a human's
"Make primary". Rev 3 adds three automatic choosers - P2 on every add, P3 on remove and delete,
and the script over all prod data - and none looks at contact type.

caseworker-integrity, which section 11 makes this build's base, states that caseworkers may
ALREADY hold seats. Its I4 refuses only a "NEW contact-list seat"; existing seats "remain
editable"; and L2 says caseworkers "can already exist without the conversion (created directly
as a partner with the Caseworker role); whether production holds any such contact on a contact
list ... is unverified" (caseworker spec, I4 definition and section 6 L2). The same spec bars them
from contact lists ("Caseworkers can't be on a property's contact list").

So on any property where a legacy caseworker seat is the earliest live row and no live landlord
exists, P2, P3 or the script makes the caseworker the primary. P1 then names them in the TOUR
intro as the person the tenant will tour with, and puts them on every new tour's default list.
The script does it in bulk, and its output is deliberately name-free (section 8: "unit ids only"),
so nobody can see it happen. The same holds for a tenant-typed contact on a roster, which 7.6
already concedes can exist.

What it implies. Give the heir function an eligibility test as well as liveness - at least "not
`isCaseworker`" (`app/src/lib/caseworkers.ts:86-88`). The 4.2 batch already returns full contact
items, so this costs no read. Have the script count units whose only live candidates are
ineligible (as `noHeir`, or a new `ineligible` count) rather than promote them. If Cameron prefers
type-blind heirs, the spec should say so as a decision, because it is a new behavior: the system
choosing a property's contact on its own.

## 3. LOW - Stale sentences after K1, and a flag/scalar split

- 4.4: "Re-sending `primaryContact: true` for a row that is ALREADY primary ... is allowed even
  if that contact is deleted - it changes nothing." Under K1's trigger, after that write the
  flagged primary is deleted, so P2 runs and the flag MOVES to a live heir. A role edit on a
  deleted primary row now hands the primary off. That is reasonable, but the text says it changes
  nothing, and the route's audit row will record `primaryContact: true` for a contact who is no
  longer primary.
- 4.4: "Properties whose landlord-of-record row is flagged primary are untouched." Not when that
  landlord is deleted or missing; K1 deliberately promotes then. Add "and live".
- 4.4 no-heir branch: "the scalar is REMOVEd if present". In rev 2 that branch ran only with ZERO
  flags. Under K1 it also runs when a deleted contact is flagged and nobody live remains, so the
  flag stays on X and the scalar goes. The delete fan-out, in the same no-heir state, keeps BOTH
  (4.6), and the script's `scalarAligned` covers only a LIVE flagged primary (section 8). Either
  remove the scalar only when no row is flagged, or have both paths do the same thing. No runtime
  reader, so LOW.

## 4. LOW - Placement diagnostic, is_tenant

4.1 now says: keep each text "for the state each text describes today", and "The placement
diagnostic has a single unreachable code (`landlord_unreachable`) and keeps it for every nobody
outcome." Today, when the property contact IS the tenant, the placement diagnostic passes the
`landlord_unreachable` check (it read the tenant-as-landlord, who has a phone - the tenant's phone
was checked first) and answers `relay_member_unresolvable` 'this placement roster has fewer than
two reachable members' (`app/src/services/rosterProvision.ts:515-544`). So "every nobody outcome ->
`landlord_unreachable`" changes the is_tenant answer the rule above it says to keep. Map is_tenant
to `relay_member_unresolvable`, as the tour side's is_tenant mapping already implies.

## 5. LOW - Precision points

- 4.2's id set is "the roster's contact ids AND `landlordId`". P2 runs the heir function "over the
  resulting roster (the added row included)", so the batch must include the ADDED contact, which
  is not on the pre-write roster. The route's own `getById` of that contact
  (`app/src/routes/units.ts:1097`) is eventually consistent, so one consistent source is simplest:
  put it in the batch.
- 4.6 fan-out: "re-reads that unit consistently and re-decides" should say the re-decision first
  re-checks that the deleted contact is STILL the unit's primary. A concurrent Make primary, or
  the K1 trigger on a concurrent add, may already have moved the flag, and then the unit is no
  longer a target.
- 7.4, zero live contacts: "Add a contact and make them primary." After K1 the add promotes them
  automatically, so "Add a contact." is now the whole instruction - and the empty-state's "Tours
  need a primary contact." stays true.

---

## Round-2 fixes checked against the mechanism

- K1: correct trigger; side effects in findings 1 and 3.
- K2: correct; precision point in finding 5.
- K3 (landlordId in every read): correct.
- K4 (tenant id test before the read): correct; matches `tourContacts.ts:138-142`.
- K5: correct for the tour side; placement is_tenant in finding 4.
- K6: correct in intent; failure shape in finding 1. It costs a second batch read only on the
  degraded path - fine.
- K7 (the refetch becomes the roster source): correct.
- K8 (`scalarAligned`): correct for live flagged primaries; deleted-flagged case in finding 3.
- K9 (copy): correct. The off-roster heir now carries a name.
- K10 (the seam mints its own unit): correct.
- K11 (unit-read failure keeps the tour reasons): correct; matches `relayFanOut.ts:460-482`
  before `:507`.
- K12 (injected failing repo): correct; widen it to both failure shapes (finding 1).
