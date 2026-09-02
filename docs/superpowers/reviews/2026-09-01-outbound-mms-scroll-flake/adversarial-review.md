# Outbound MMS Scroll Diagnostic Adversarial Review

Date: 2026-09-01
Commit reviewed: `86db0010eebf9614bc86357e0857a7623babdcdd`
Lane: authorized small diagnostic fix

## Verdict

Keep the issue open and keep the change diagnostic-only. The traced full run did
not reproduce the target failure, so it does not authorize a product change or
removal of the while-open assertion. It did produce stronger evidence that the
newer `509 -> 797` failure was a snap to the Timeline's maximum offset after
background mutations. That mechanism still does not explain the older
AppFrame `20 -> 0`, Timeline `509 -> 421` failure.

## Findings

### R1 - Mutation identity was too weak - fixed

The first recorder measured the right scroll geometry, but its mutation detail
usually named only a generic `div` and node counts. A future failure could show a
height change and bottom repin without identifying whether a delivery chip,
scheduled-message panel, load-older control, or timeline item changed.

Fix: retain the same trace gate and observers, but add compact class/ARIA/text
descriptions for changed nodes plus Timeline header height, upcoming-panel height,
load-older presence, new-messages-pill presence, and child counts. The recorder
still does not write product state, dispatch input, add a wait, or change an
assertion.

### R2 - A passing control cannot establish the root cause - accepted

The full control began at Timeline `top=509`, `maximumTop=809`. Three mutations
changed `scrollHeight` from `989` to `997`, then `975`, and finally `977`, leaving
`maximumTop=797`. The historical red run's received value was exactly `797`.
That is strong evidence for a bottom repin, but the control emitted no scroll
event and stayed at `509`; it therefore does not prove which state transition made
`atBottomRef` true in the red run. The recorder remains necessary until a red run
captures the first write.

### R3 - The recorder begins immediately after expected-offset capture - accepted

The arrangement write and its native scroll event occur before the recorder is
installed. This is deliberate: the diagnostic question is what changes the already
captured offsets while the viewer is open, and moving the recorder across the
arrangement would split the arrangement into extra browser tasks and alter the race
being investigated. If an offset changes in the short capture-to-recorder gap, the
recorder's initial phase will already disagree with the assertion's expected value,
which localizes the gap even though it cannot name the write. No new wait or event
dispatch is added.

### R4 - Full-suite failures outside the target are unattributed - accepted

The full traced run had four other failures. They are different specs and signatures
from the changed assertion, but this run alone cannot label them flakes or prove
that tracing had no effect. Their complete browser artifacts are preserved and the
diagnostic report names them without assigning causation.

## Adversarial checks

- The trace flag is the sole activation path for the new observers and attachments.
- The recorder caps retained events at 800.
- The page observer and phase samples are read-only.
- No viewer or Timeline production file changed.
- The historical failures remain unresolved because neither original artifact set
  survived and the new run was green for all six outbound-MMS cases.
- The duplicate issue is retained as a resolved pointer, so old references continue
  to resolve while only one open tracker remains.

## Required post-review proof

Rerun diff hygiene, the E2E workspace typecheck, the traced outbound-MMS spec, and
the touched-file lint comparison. Do not rerun the 41-minute full suite solely for
the richer read-only event payload.
