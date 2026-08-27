---
id: broadcast-audience-truncation-drops-searching-tenants
title: A truncated broadcast audience drops `searching` tenants first and keeps `inactive` ones
type: bug
severity: med
status: open
area: app
created: 2026-08-26
refs: app/src/services/audienceResolution.ts:129-136, app/src/services/audienceResolution.ts:78-79, app/src/services/audienceResolution.ts:170-179, app/src/repos/contactsRepo.ts, app/src/lib/statusModel.ts:140-148
---

**Problem.** `createAudienceResolutionService` resolves a no-housing-authority
broadcast audience (i.e. "all tenants") by walking `contacts.listByType('tenant')`
under a page bound - `DEFAULT_MAX_PAGES` 50 x `DEFAULT_PAGE_SIZE` 200
(`audienceResolution.ts:78-79`), the walk at `:129-136`. That read carries an
UNSTATED assumption about the order the rows arrive in, and the assumption is
wrong in a way that inverts the product intent.

`byTypeStatus` is `(hash: type, range: status)` and `contactsRepo.listByType`
sets **no `ScanIndexForward`**, so the Query ascends the range key. Sorted
ascending, `TENANT_STATUSES` (`lib/statusModel.ts:140-148`) is:

```
inactive, needs_review, on_hold, onboarding, placed, placing, searching
```

`searching` sorts LAST. So when the page bound cuts the walk, it cuts
STATUS-FIRST and deterministically: it keeps `inactive` tenants and drops
**`searching` tenants first** - precisely the population a property-match
broadcast exists to reach. The order is stable, so the same tenants are dropped
on every send, not a rotating sample.

**Why this is worse than the same defect on a triage tab.** The sibling
occurrence of this sort assumption is
[`unknown-queue-cap-starves-needs-review`](unknown-queue-cap-starves-needs-review.md),
where a truncated unknown queue starves `needs_review`. There the cost is
a delayed triage: the rows are still in the database, still reachable, and the
operator sees a WARN-backed short list on a tab they will reload. Here the cost
is an outbound SEND that silently did not reach the people it was for. There is
no second render, no operator review of the omission, and the tenants who most
need the listing are the exact ones excluded. The truncation WARN at `:170-179`
names `maxPages` and `resolved` and says "audience may be truncated"; it does
NOT say WHICH tenants were dropped, and which is the entire non-obvious part.

**Live impact today: NONE. This is latent, not live.** The bound is
50 x 200 = 10,000 candidate rows against roughly 641 tenants (the figure the
2026-08-21 pagination sweep measured), so the walk exhausts the partition on
every run and `truncated` is false. That is about 15x more headroom than the
unknown queue has. Nothing an operator sends today is affected. The defect is
the unwritten assumption plus the shape it takes if the tenant count ever grows
past the bound - or if anyone lowers `maxPages` / `pageSize` believing the cut
to be arbitrary.

The `byHousingAuthority` path in the same function is CLEAN: that GSI is
hash-only with no range key, so it carries no ordering at all.

**Suggested fix.** Three options, in ascending cost. None was taken when this
was found (2026-08-25, round-2 adversarial review of `feat/inbox-unread-cluster`)
because it is another feature's service file and that branch was chartered not
to move behaviour.

1. **Record it and make the WARN honest.** One clause at `:129` naming the sort
   (a `TODO(broadcast-audience-truncation-drops-searching-tenants):` marker is
   already there), and one clause in the truncation WARN saying the drop is
   status-ascending so `searching` goes first. Costs nothing, changes no
   behaviour, and stops the next reader assuming a random slice.
2. **Make the cut status-aware.** Query the statuses a send actually targets
   explicitly and interleave them, so a bound cannot silently prefer `inactive`
   over `searching`.
3. **`ScanIndexForward: false` as an option on the repo read.** This is the same
   mitigation named for `inbox-filter-tabs-full-walk`'s reopen point, and it is
   the reason these two issues have to be considered TOGETHER: `listByType` is a
   SHARED read (`today.ts`'s triage block, `GET /api/contacts?type=`, the
   importer, this service, and the unknown queue all use it), so reversing its
   direction - even behind an option - is a repo-wide change with its own
   review. Note that reversing it helps the unknown queue and this walk in
   OPPOSITE senses only by coincidence: here descending puts `searching` first,
   which is what a send wants; there descending puts `needs_review` first, which
   is what triage wants. Verify both before flipping either.

**Reopen / escalate** when the tenant count approaches the 10,000 bound, when
anyone lowers `maxPages` or `pageSize`, or the moment a broadcast is reported as
having missed tenants who should have received it.
