# Adversarial design review: AI contact-kind suggestions (round 3B)

## 1. [BLOCKING] D11 can let an older classification drain delete or mis-verdict a suggestion for a later Unknown/reclassification state

**What is wrong.** D11 treats the contact PATCH that started a drain as if its
non-Unknown result remains authoritative until the drain's later consistent
suggestion read and CAS delete. That is false: contact type is mutable in the
same PATCH route, including a supported re-type back to `unknown`. Contacts and
AI suggestions live in different DynamoDB tables, and neither contact update nor
suggestion delete carries a shared contact revision/condition. Consequently an
old classification drain can delete a current, reviewable type suggestion after
another writer has put the contact back at the Unknown front door. With a
subsequent classification it can also assign the old action's
`superseded_by_human_edit` verdict to a suggestion that the later action should
have accepted.

**Concrete ordering.**

1. P1 snapshots S1 and changes contact C from Unknown to Landlord.
2. Before P1's D11 drain reads/CASes, P2 changes C back to Unknown. This is a
   supported PATCH, not a hypothetical state.
3. Extraction E puts S2, performs its required post-put consistent contact read,
   sees Unknown, and correctly retains S2 as pending.
4. P1's delayed drain consistently reads S2 and conditionally deletes it. Its
   only fence is S2's revision; it cannot observe or condition on P2's later
   contact update. It stamps S2 `superseded_by_human_edit` for P1 even though C
   is Unknown and S2 is meant to be actionable.
5. If P3 then classifies C using S2's suggested kind, P3 either sees no S2 or
   loses its exact-snapshot CAS; the run has already been terminally
   superseded by P1 rather than accepted by the action that actually reviewed it.

**Evidence.** D11 requires the classification writer to drain solely because
its own PATCH *resulted* in a non-Unknown contact (spec D11 steps 2-3,
`docs/superpowers/specs/2026-08-26-ai-contact-kind-suggestions-design.md:297-310`),
and says the drain stamps a post-write row superseded
(`:300-302`). The current type allowlist permits `unknown`
(`app/src/routes/contacts.ts:251-261`), and the existing test proves a tenant
can be retyped to Unknown through this route
(`app/test/contactTriage.test.ts:324-343`). Contact updates use only
`attribute_exists(contactId)`, no version or expected-type condition
(`app/src/repos/contactsRepo.ts:1152-1211`). Suggestions use a separate
`ai_extraction` table (`app/src/repos/extractionRepo.ts:239-242`), while contacts
use the `contacts` table (`app/src/repos/contactsRepo.ts:673-675`); the deletion
CAS checks only the suggestion revision
(`app/src/repos/extractionRepo.ts:667-693`). The D11 tests cover replacement
contention but omit retype-to-Unknown or a later classification
(`docs/superpowers/specs/2026-08-26-ai-contact-kind-suggestions-design.md:465-490`).

**Implication.** A consistent read does not close this time-of-check/time-of-use
gap. The design needs a contact classification revision/epoch (or an equivalent
atomic cross-record protocol) carried from the contact update through the drain
and checked before terminalizing/deleting a type row. It must specify and test
P1 -> Unknown -> E put -> P1 drain, plus the later matching classification. Until
then D11 cannot truthfully guarantee both no stranded suggestions and correct
AI verdicts under the allowed contact-update orderings.

## Attack surface notes

I also exercised the other D11 orderings: a post-write suggestion that finalizes
before the drain, a drain that deletes before the extraction post-put cleanup,
replacement CAS loss followed by a newer writer's cleanup, and verdict writes
before/after AI-run finalization. The existing ai-run inflight finalization marker
is designed to merge a terminal verdict written before `recordRun`, so no separate
finding arose there (`app/src/repos/aiRunsRepo.ts:203-270,369-477`). The
unresolved failure is specifically the lack of a fence tying the delayed drain to
the *current* contact classification state.
