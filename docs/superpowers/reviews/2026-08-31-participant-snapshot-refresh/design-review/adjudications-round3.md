# Spec design review - round 3 adjudications

Spec v3 @a5b95d7b. Reviewer: B continued (third pass, same context).
Findings at `../spec-review-round3-findings.md`. 15 findings, 1 BLOCKING.

**13 ACCEPT, 1 REJECT, 1 SPLIT.**

## Convergence judgment (the thing that matters most here)

Rounds 1 and 2 changed the DESIGN. Round 3 did not. Every finding below is
about the spec's CLAIMS - what it asserts is complete, closed, measured, or
non-colliding - and not one of them faults S1, S3, or S2's core mechanism,
which have now survived three adversarial passes unchanged.

That is a different state from round 2 and it should be read differently: the
design has converged; the spec's accounting of what it does NOT fix has not.
The remedy is to narrow the claims to what is true, which is what this round's
edits do - not to change the build.

---

## The blocking finding

### ACCEPT - T1. S5 cannot measure the gap section 3 assigns it.

v3 gives S5 five metrics and tells section 3's stated gap to rely on the last
one, "members whose `contactId` resolves to nothing". The stub-merge population
is invisible to it: `services/groupMembers.ts:105-119` mints a REAL contact row
for a stub, so its `contactId` DOES resolve - to a contact with no name. Such a
member is therefore counted by neither "resolves to nothing" (it resolves) nor
"stored name MISSING while the contact has one" (the contact has none either).

So S5 would ship a number that gets believed and is measuring the wrong
population. ACCEPT: S5 gains a sixth metric that carries the actual signature -
**a member whose `contactId` resolves to a NAMELESS contact while a contact
matching that member's PHONE has a name.** That is the merged-stub shape, and
it is the only metric that sizes the gap section 3 admits.

## Accepted - the gap statement was wrong in three ways

### ACCEPT - T6 (HIGH). The gap is RECURRING, not residual. Planner-verified.

v3 says the stub case "stays owned by the EXISTING converge-on-read write at
`routes/api.ts:2099-2114`, which resolves by phone and writes the corrected
name back - after which this branch's rung 2 reads a fresh snapshot."

I read `:2099-2114`. It writes `{ ...p, name }` - **`name` only, never
`contactId`.** The dead id survives the write-back, so rung 1 misses again on
the NEXT rename, and every rename after that. The population is not
self-healing; it is permanently outside this branch's reach, and the fix is
bundle M8 (`participants[].contactId` ownership), which is fenced.

This is the load-bearing sentence of section 3 and it was wrong. Corrected to
say the gap RECURS per rename and names M8 as its owner.

### ACCEPT - T7 (HIGH). A second uncovered population.

Bare-phone RELAY members are skipped at `routes/relayGroups.ts:470`
(`if (!member.contactId) return member;`), have no phone resolver in this
branch, and no writer anywhere refreshes them. v3's gap statement names only
the group_text stub case. Added.

### ACCEPT - T2 (HIGH). 5.3's soft-delete posture is defeated by a write v3 keeps.

5.3 says a soft-deleted contact supplies no name. But `routes/api.ts:2086`
derives its name WITHOUT a deleted check and `:2099-2114` writes it into the
stored snapshot - which is this branch's rung 2. So a deleted contact's name
can still render, arriving through rung 2 rather than rung 1.

ACCEPT as a stated limitation, not a fix: that write belongs to a route this
branch deliberately does not change (2.1), and adding a deleted-check there is
a behavior change to a shipped converge mechanism, outside this scope. 5.3 is
narrowed to "rung 1 never serves a deleted contact's name; rung 2 may, because
an existing write-back can seed one."

## Accepted - the phase-b boundary, corrected in both directions

### SPLIT - T5 (HIGH). Both the reviewer and the planner were half right.

**Half one, reviewer WRONG, planner right.** T5 says phase-b "does NOT edit
`relayGroups.ts` (zero plan hits; explicitly excluded at its spec `:653`)".
Its plan has zero hits and its spec does exclude it - both verified. But it has
already COMMITTED an edit there: `6328970e` "discontinued reads on all read
surfaces". The reviewer checked the plan and not the commits, which is the
mirror image of the planner's own earlier error. The co-edit is real.

The useful correction is to the FRAMING: it is one landed commit that exceeds
that branch's own stated exclusion, with no further planned work there. So it
is a one-time textual merge, not ongoing contention. Reworded.

**Half two, reviewer RIGHT, planner wrong, and this is the real finding.**
S3 flips `describeRoster`'s precedence. `services/rosterEdits.ts:514` calls
`describeRoster` to build the preview's RECIPIENT list (`:439-441` states the
split: body from `resolveRoster`, recipients from `describeRoster`). Phase-b's
Task 14 Step 6 **re-baselines exactly those pins** -
`relayGroupPreview.test.ts:151,208`, `toursApi.test.ts:3989-3998,4096`,
`placementsApi.test.ts:989,1007`.

So both branches move the same test expectations, from different directions, at
the same time. I asserted no collision; there is one, and it is transitive
through a file I correctly avoided editing. Added to the spec as a merge-order
hazard and raised to Cameron.

## Accepted - claims that overreach

| # | finding | disposition |
|---|---|---|
| T3 (HIGH) | The disposition table says `group-roster-name-snapshot-never-refreshed` is "CLOSED for every staff-facing surface" while 2.3 leaves the two staff push titles stale. | ACCEPT. Reworded to name the exclusion in the table itself, not two sections away. |
| T4 (HIGH) | The cut leaves ONE push notification with two name sources - a fresh body sender (S4) and a stale title - a disagreement `main` does not have, and v3 deleted v2's risk row for it. | ACCEPT the fact; KEEP S4. A fresh sender name beside a stale title is strictly better than both stale, and the alternative (drop S4 too) buys consistency by keeping a known-wrong name. But it is a real new intra-surface disagreement, so the risk row is RESTORED and the trade stated rather than deleted. |
| T8 (MEDIUM) | S2's mandated `GroupTextView.tsx:191-211` amendment would write a FALSE statement: `changed` is not permanently false, because header hydration keys on contactId while the panel resolves by phone. | ACCEPT - and doubly so now, since 5.5 dropped header hydration entirely, so the premise is gone. The amendment is rewritten to describe what actually holds. |
| T9 (MEDIUM) | S4's masked-posture guarantee is not delivered: rung 2 is a FULL name, so the persisted `call_party_label` masks or not depending on whether a read succeeded. | ACCEPT. Sharp. For `maskedPartyLabel` ONLY, rung 2 is dropped - masked-or-nothing, never a full name via fallback. A persisted privacy posture cannot be contingent on a read. |
| T10 (MEDIUM) | Section 3's rung-3 claim is false for two readers in v3's own client list: `rosterPeople.ts:28` falls back to a contact ID, and relay `senderLabel` renders nothing by design. | ACCEPT. Rung 3 is described as the common client fallback, not a universal one, with both exceptions named. |
| T11 (MEDIUM) | "Reconcile onto one rule" is not achieved for `api.ts:2017-2117`, which keeps three different rules while S2 changes only a comment. | ACCEPT. Section 2.1's headline is narrowed: this branch reconciles the surfaces it hydrates and leaves that route's internal rules alone, deliberately. |
| T12 (MEDIUM) | `relayGroupDuplicates` is handed to a branch whose plan has no task for it, and 2.3 names no issue file. | ACCEPT. It gets a filed issue of its own rather than an assumed owner. |
| T13 (MEDIUM) | 5.4's own standing requirement is undischarged for `rosterEdits.ts:425-426, :437-441`, which S3 still makes stale - the FOURTH instance, surviving the very commit that wrote the rule. | ACCEPT, with the embarrassment recorded: a rule against silently inverting commented behavior was violated in the commit that introduced it. Those two comments are added to S3's amendment list. |
| T14 (MEDIUM) | S5's run timing is unspecified, and "measured, then resolved" needs a PRE-merge baseline. | ACCEPT. S5 runs before and after, and both numbers go in the handback. |
| T15 (LOW) | A padded-name divergence remains inside one `group_text` thread between `api.ts:2083` (outer trim) and `contactDisplayName` (part-wise trim). | ACCEPT as a stated cosmetic residue; fixing it means editing that route's derivation, which 2.1 excludes. |

## Rejected

**T4's implied remedy, REJECTED.** T4 is right that the push gains an internal
disagreement, but the only in-scope way to remove it is to abandon S4's free
precedence flip. That trades a correct name for a consistently wrong one. The
finding is accepted as a risk; the implied fix is not.

## Contested adjudications, resolved

The reviewer CONCEDED round 2's R11 sequencing half and confirmed round 1's A1
partial rejection as correct from its own reading this time - noting that the
same fact (a stub's contactId does resolve) is precisely what makes T1 a
finding. Recorded: A1's rejection and T1 are the same observation pointed at
two different claims, and both stand.
