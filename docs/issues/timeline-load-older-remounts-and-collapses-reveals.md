---
id: timeline-load-older-remounts-and-collapses-reveals
title: Load older remounts every timeline card (index in the list key), collapsing a call card's revealed phone number
type: bug
severity: low
status: open
area: dashboard/contact-timeline
refs: dashboard/src/routes/contact/Timeline.tsx:1499, dashboard/src/routes/contact/Timeline.tsx:754, dashboard/src/routes/contact/useContactTimeline.ts:427
---

**Problem.** The contact timeline keys every stream item by its kind, its id, AND
its position in the cluster array:

```tsx
// dashboard/src/routes/contact/Timeline.tsx:1499
key={`${item.kind}:${item.id}:${ii}`}
```

`loadOlder` (`dashboard/src/routes/contact/useContactTimeline.ts:427`) PREPENDS an
older page to the item list. Every item after the prepend therefore shifts index,
every key changes, and React unmounts and remounts each card rather than moving
it. All local component state dies with the old instance.

The call card holds its detail disclosure in local state
(`dashboard/src/routes/contact/Timeline.tsx:754`, `const [revealed, setRevealed] =
useState(false)`), so the remount snaps every opened card shut. The staff flow
that hits it: open a call card's `Details` to read the party phone number, then
click `Load older messages` to find the earlier context for that call - and the
number they just revealed is gone, with no indication why.

The remount behavior PREDATES the directional-call-card work (the key has carried
the index for as long as paging has existed). What that work changed is
visibility: it moved the party phone number from the card face behind the
disclosure, so a collapse now costs the operator information that used to be on
screen. Other item kinds lose cheaper state (a `<details>` transcript toggle),
which is why this went unnoticed.

**Suggested fix.** Drop `:${ii}` from the key so identity is `kind:id`, which is
stable across a prepend and lets React preserve the instances.

Deliberately NOT done in the originating change: that key governs EVERY item kind
on a shared surface (messages, calls, milestones, scheduled), and dropping the
index rests on the premise that item ids are unique across merged pages - which
needs verifying first, because a duplicate id would turn a cosmetic collapse into
a React duplicate-key warning and dropped rows. Too wide a blast radius to land
after review on a calls-scoped branch. Verify id uniqueness across the merged
first page + older pages + the optimistic-append path, then make the change with
a prepend-preserves-reveal test.
