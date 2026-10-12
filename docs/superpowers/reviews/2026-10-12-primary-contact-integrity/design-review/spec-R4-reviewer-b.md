# Spec review R4 - reviewer B (adversarial, final round)

Nothing found in this round should change a decision. One finding (1) needs a spec line so the
property box agrees with L2; the other two are precision.

Spec: `docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md` rev 4 @8b7208fe
(diffed against rev 3 @1f546052). Adjudications: Round 3 (L1-L5). Also re-read the
caseworker-integrity spec (git objects: I3, I4, L2). Read-only; nothing was run.

Summary list:

1. MEDIUM - The 7.4 box offers "Make <Name> primary" on a property whose only live contact is a caseworker. That steers Sam into the state L2 calls wrong, and once she clicks it the K1 trigger never fires again.
2. LOW - Heir step 1's caseworker exclusion is undone by P1. P1's landlord fallback still resolves a caseworker landlord of record, so the 4.3 rationale overclaims and the 7.3 no-heir notice is false in that state.
3. LOW - Precision: the heir function needs contact TYPE as well as liveness, and its result must say WHY there is no heir, or the script cannot split `noHeir` from `caseworkerOnly`.

Asked specifically:
- An explicitly made caseworker primary is still honored by P1, and K1 treats it as a live flagged
  primary, so P2 never overrides it. That is consistent with L2 ("Make primary is not affected").
  The problem is the box inviting that explicit choice (finding 1).
- The script's counts are sound once the heir result carries its reason (finding 3). A caseworker
  landlord of record lands in `caseworkerOnly` although tours already use that landlord
  (finding 2).
- The property box with only a caseworker live: finding 1.

The other rev 4 changes were checked against the mechanism and are correct:
- 4.1 placement mapping, which matches `app/src/services/rosterProvision.ts:515-544`;
- 4.2's added contact and the two throw shapes (`contactsRepo.ts:986-990`, `:994-996`);
- 4.4's no-heir flag-plus-scalar rule, which now matches the fan-out, and the re-sent-true wording;
- 4.6's re-check before re-deciding;
- the 7.4 no-live-contact line - true under K1 plus L2, because the picker offers live contacts and
  caseworkers cannot take a new seat;
- 7.5's two throw shapes, and section 10's tests.
No adjudication contested.

---

## 1. MEDIUM - The property box can promote the caseworker that L2 excludes

What is wrong. 7.4 picks its action from the count of LIVE roster rows: one live row gets "Make
<Name> primary", two or more get "Choose a primary", none gets "Add a contact - they become the
primary automatically." Rows carry no contact type. `enrichRoster` returns the roster role plus
name and company (`app/src/routes/units.ts:397-410`), and 7.5 adds only `deleted`. So a property
whose only live contact is a legacy caseworker seat looks like this:
- P1 finds nobody (no flag, no landlord), so the box shows;
- the count is one live row, so the box offers "Make <Caseworker> primary".

That is the 470 Bolton shape with a caseworker in Mark's place, and it is exactly the units
section 8 now counts as `caseworkerOnly` "so Sam can choose by hand".

This works against L2 in two ways:
- the box's one-click fix is the outcome 4.3's new paragraph calls wrong - the caseworker "named as
  the landlord in the tour intro and put on every new tour's default list";
- once clicked, the caseworker is a LIVE flagged primary, so K1's trigger ("no LIVE flagged
  primary", 4.4) never fires again. When Sam later adds the real PM, the PM does not take over,
  where on the same property without the click the add would have promoted the PM automatically.

What it implies. 7.5 should mark caseworker rows - a per-row `caseworker: true`, or an
eligible-live count on the block - and 7.4 should count only eligible live rows. When the only live
rows are caseworkers, show the "Add a contact - they become the primary automatically" line; under
L2 that line is true. The edit-mode "Make primary" on a caseworker row can stay, since explicit
choice is L2's carve-out. This is not a new decision, only the box following L2.

## 2. LOW - Step 1's exclusion does not keep a caseworker landlord out of the intro

What is wrong. 4.3 step 1 now skips a landlord of record who is a caseworker. P1 candidate 2
(4.1) has no type test. caseworker-integrity's I3 requires a typed `landlord` only for new writes;
its L2 leaves earlier violating records in place ("Records created before this branch that
violate I2-I4 stay as they are"). For such a unit:
- removing the primary PM finds no heir and clears the flags (4.6). P1 then finds the caseworker
  landlord through candidate 2, so tours include them and the intro names them - while the 7.3
  notice just told Sam "New tours won't include a landlord, and tour group texts will use the
  general intro";
- the delete fan-out, with no heir, leaves the deleted PM flagged. P1 skips it and lands on the
  caseworker landlord anyway;
- the script counts the unit `caseworkerOnly` although its tours already use that landlord.

So 4.3's rationale ("without this rule ... named as the landlord in the tour intro") holds for step
2 and not for step 1, where the exclusion changes only the flag. Either drop the exclusion at step 1
- the flag then follows the person P1 already uses, and the notice stays true - or keep it and state
that a caseworker landlord of record remains the property contact through P1 (a legacy I3 violation,
caseworker-integrity L2), with the 7.3 no-heir notice reworded for that case. Rare, hence LOW.

## 3. LOW - Heir function inputs and outputs

- 4.3 still lists the inputs as "the unit's `unitContacts()` roster, its `landlordId`, an optional
  contact to exclude, and the liveness map". The caseworker test needs each contact's `type` and
  `role` (`app/src/lib/caseworkers.ts:86-88`). Name the input as the contact records (or a
  {live, caseworker} map), so the shared API-test fake (`twilioWebhookHarness.ts:2940-3017`) is fed
  the same facts as the real repo.
- The heir result is heir / no heir / unknown. Section 8 counts `noHeir` and `caseworkerOnly`
  separately. Either the result carries its reason ("no live candidate" vs "only caseworkers"), or
  the script re-derives it - in which case the rule exists twice, which J22 set out to prevent.
