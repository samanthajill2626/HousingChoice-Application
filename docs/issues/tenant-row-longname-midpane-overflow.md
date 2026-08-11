---
id: tenant-row-longname-midpane-overflow
title: A long tenant name in the 561-700px pane band exhausts the facts span and clips the trailing chips
type: bug
severity: low
status: open
area: dashboard
created: 2026-08-10
refs: dashboard/src/routes/contacts/ContactsList.module.css:199,dashboard/src/routes/contacts/ContactsList.module.css:243,dashboard/src/routes/contacts/ContactsList.module.css:280
---

**Problem.** The tenant row's wide-pane sacrifice order (spec section 6 of
`docs/superpowers/specs/2026-08-06-tenant-list-visibility-design.md`) makes the facts span the
only compressible child: `.factsRow .name` is `flex: 1 0 auto` with `max-width: 55cqw`, and
`.factsRow .meta` is `flex: 0 1 auto; min-width: 0`. That delivers the intended order - the
facts truncate first and fully, the name gives nothing - but it has no give left AFTER the facts
span reaches zero. An item frozen at its `max-width` is removed from flex distribution
(CSS Flexbox 9.7), so the name cannot absorb any remainder even in principle, and the remaining
chips are all `flex: 0 0 auto`.

Measured live on a hermetic lane (full profile, 2026-08-10), content pane **612px** - inside the
561-to-~700px band, which the `@container (max-width: 560px)` stacking rule deliberately does
not cover:

| Name length | facts span | row scrollWidth vs clientWidth | Porting chip right edge vs row card |
| --- | --- | --- | --- |
| 32 chars (the spec's stated worst case) | 41px, visible | 610 vs 610 - fits | 859 vs 876 - inside |
| 41 chars | collapsed to 0 | 634 vs 610 - OVERFLOWS | 899 vs 876 - OUTSIDE the card |
| 56 chars | collapsed to 0 | 653 vs 610 - OVERFLOWS | 918 vs 876 - OUTSIDE the card |

The arithmetic: the four unshrinkable chips plus their gaps need a fixed ~288px regardless of
pane width, so the name's percentage cap and the chips' fixed cost collide at the bottom of the
band.

Both of the spec's acceptance criteria PASS as written (a 32-character name is clean at 375px
and at a ~697px pane), so this is the tail beyond them, not a regression against them.

**Mitigation already shipped.** `.factsRow .meta` carries `overflow: hidden`, so the trailing
chips are now CLIPPED AT THE CARD EDGE instead of rendering outside the row's rounded border.
That contains the visual break; it does not cure it - the failure mode is now "the Porting chip
is silently cut off" rather than "the Porting chip escapes the card".

**Suggested fix.** Two candidates, both deliberately NOT taken during the feature build because
each is a judgement call rather than a defect repair:

1. Lower the name cap. Measured: `48cqw` removes the overflow at 612px but still overflows by
   ~8px at 561px; `45cqw` is clean across the whole band with today's chip set. The cost is that
   names ellipsize earlier at every width, and the value is only safe as long as the chip set's
   fixed width does not grow (a longer status word or phone format re-breaks it).
2. Make a second chip compressible - the phone chip is the natural candidate - so the deficit
   has somewhere to go after the facts span. Preserves the name's width at all pane widths and
   is robust to chip-set changes, but adds a second truncation point to reason about.

Whichever is chosen, verify by measurement in the 561-700px band with a 40+ character name;
jsdom does no layout, so a component test cannot assert any of this.

Found by the adversarial reviewer (round 2, finding R2-2) during the tenant-list-visibility
mission and confirmed by orchestrator measurement.
