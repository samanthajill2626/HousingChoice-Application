# Code review round 4 - adjudications (no further fix wave)

Orchestrator adjudication of `r4-review.md` over FW5 (ddd3e134..52220729).
Round 4 found nothing BLOCKING, HIGH or MEDIUM: FW5-1 and FW5-2 are REAL, and
the final verdict table of `lookup()` has no wrong cell - never_sent is
reachable only from a complete walk at the last check, and a partial read (cut
at the bound, or ended by a list error) adopts only what a complete walk could.

The rule set before dispatch (ledger): only a CONFIRMED MEDIUM or worse, or a
confirmed double-send or lost-send path, would open a sixth fix wave; a LOW
logging item goes to the registry. None qualifies, so the code is final at
52220729.

## Rulings

- F-1 - LOW, CONFIRMED, RESIDUE (filed by FW3 beside FW5's page-count
  residue): a list error mid-walk that precedes an adoption (or the judging's
  own sid_held_elsewhere) is logged nowhere - the found INFO carries no error.
  Walks that adopt nothing still log it, so a systematic next-page failure is
  undercounted, not hidden. The designed fix is log-only (put `pages` and the
  list error on the found line, the sid_held_elsewhere line and the error
  verdicts' extra); left for the registry rather than another code wave.
- Deviation 2 unpinned - NOTE: on an error-ended walk the judging's own
  sid_held_elsewhere outranks the error (held at HEAD by the reviewer's probe
  P8); no committed test pins that order, and the flip would be harmless (the
  next check meets the same candidate). Stated in the handback; filed with F-1.
- Wording corrections to `r3-adjudications.md`, recorded here and in the
  handback: (a) section 2's "an added call can only ADD evidence" holds for
  VERDICTS, not for logs (F-1); (b) section 2's "NOT a behavior change against
  the spec or main" - main has no reconcile; the ground is spec D13 ("a walk
  that exhausts the bound is unresolved", design.md:589) and D16's "page bound
  exceeded" cause.

## Verdicts

FW5-1 REAL (pinned by sendReconcile.test.ts T1 :1054, T2 :1081, T3 :1123 and
test 12 :1232). FW5-2 REAL (pinned by broadcastFanOut.test.ts :1791, :2274,
:2277, :2295, :2314, :2336, :2339).
