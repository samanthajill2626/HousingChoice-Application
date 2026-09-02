# Orchestrator adjudications - review round 1

Reviewers: A (spec conformance, plan-aware) and B (adversarial, PLAN-BLIND by
mandate). Reports: `review-a-conformance.md`, `review-b-adversarial.md`.

Gate state at adjudication: all five GREEN on the synced base
(typecheck 0, npm test 0, smoke 0, e2e 259 passed exit 0, lint zero-new).

Review A: no VIOLATED rulings; all seventeen load-bearing spec rulings conform;
two PARTIALs (one real docs defect, one "T11 not finished yet, by schedule").
Review B: seven findings, none BLOCKING - one HIGH, one MEDIUM, five LOW.

---

## B1 - HIGH, CONFIRMED - a `booked_too_late` rung still supersedes the confirmation

**ADJUDICATION: FINDING UPHELD ON THE FACTS. Machinery NOT fixed (spec 8.1
forbids it in Phase A). The JUSTIFICATION in the Phase B ledger IS corrected,
because the plan's stated reason is FALSE and would mislead Phase B.**

`supersededBySlot` asks only whether a later rung's CLAMPED dueAt equals mine and
lands before the tour. It cannot see that the later rung was itself retired by
the new rule (e), so a confirmation can be retired citing a `booked_too_late`
corpse.

The plan (SPEC CONCERNS item 4) and the shipped Phase B ledger item 8 both call
this PRE-EXISTING, justified by "`seedLive.test.ts` already pinned a
`confirmation` superseded by a silently-dropped `morning_of`". **I checked that
claim at the merge base and it is WRONG.** At `440dc75e`, seedLive's TOUR-A pins
`pending == ['en_route', 'morning_of']` with `morningOf.skippedAt` explicitly
`toBeUndefined()` - the superseder was ALIVE and would have fired.

Worse, the general case cannot arise at the base either: confirmation's raw dueAt
is `now` and clamping only moves it forward, so its clamped dueAt is always
`>= now`; a rung dropped by past-dueAt has `dueAt < now`; the two can never be
equal. And `supersededBySlot` already excludes `past_event`. So at the merge base
a confirmation retired `quiet_hours_superseded` ALWAYS cited a rung that really
armed. Rule (e) is what introduced the corpse. Reviewer B is right and the plan
was wrong.

WHY IT IS STILL NOT FIXED HERE:
- Spec 8.1 rules the precedence SAME-RUNG only and puts the cross-rung
  supersession machinery out of scope for Phase A, in terms.
- The blast radius is narrow: booking inside the quiet window, on the tour's own
  local date, tour roughly 08:00-12:00 local, under six hours out.
- The ladder is PAUSED, so nothing auto-sends. The observable effect is a panel
  chip and the loss of a force-sendable `confirmation` rung - and `confirmation`
  is the one rung the founder asked to receive NO text on at all (spec 2).
- A fix means requiring the superseder to be genuinely armable, which reorders
  rule evaluation - exactly the change spec 8.1 warns reopens the vanishing-row
  problem. That belongs with Phase B's own review, not bolted on at handback.

ACTION: rewrite Phase B ledger item 8 with the correct account - it is
INTRODUCED by rule (e) for the confirmation case, not pre-existing - and quote
the merge-base evidence so nobody re-derives it. Raise its prominence in the
item ordering. State it in the handback as a known, accepted, filed consequence.

## B2 - MEDIUM - a `{token}` inside a contact's first name is expanded into the SMS

**ADJUDICATION: UPHELD. Fixed NARROWLY, inside this feature's own module. The
shared interpolator is NOT touched; that gets its own issue.**

`interpolate` (`app/src/messages/resolve.ts`) substitutes declared tokens in
sequence with successive `split().join()` passes, so a VALUE substituted early
that itself contains `{anotherDeclaredToken}` is re-expanded by a later pass.
Confirmed mechanism.

It is genuinely NEW on this path: the two pre-existing entries carrying a
contact-supplied name (`welcome.sms` `{firstName}`, `notification.attachment`
`{name}`) each declare exactly ONE token, so there is no second token for a value
to leak into. The tour entries declare seven.

Real-world severity is low - the leakable values (`{when}`, `{time}`, `{where}`,
`{addressLine}`) are facts about the same tour, going to that tour's own
participants. The one genuine cross-boundary leak is a tenant naming themselves
`{propertyContactFirstName}` to learn the landlord's first name.

ACTION: strip `{` and `}` from resolved names in `app/src/lib/tourContacts.ts`'s
own first/full-name helpers. One line each, no shared-module blast radius, closes
the tour path completely. Separately FILE the general weakness against
`resolve.ts` - fixing `interpolate` to be single-pass touches every message in
the app and deserves its own change and its own review.

## B3 - LOW, PLAUSIBLE - `{where}` still declared on the twin-less entries

**ADJUDICATION: UPHELD AS A FUTURE HAZARD. Declaration is spec-mandated
(section 6: declare the full set so a wording change stays a pure string edit),
so the declaration STAYS. FILE the hazard.**

The composer passes `where` only when a street exists, so re-adding `{where}` to
one of those defaults would throw a bare `Error` past every containment block for
an addressless unit. ACTION: file it, and reference it from the Phase B ledger's
override item (9), which is the same class of hazard.

## B4 - LOW, CONFIRMED - the label is false on reschedule/revival, and a comment misquotes it

**ADJUDICATION: the BEHAVIOUR is spec-accepted (spec 11 says so explicitly and
rules the wording must not accuse). The MISQUOTED COMMENT is a real defect.**
ACTION: fix the comment so it quotes the shipped label verbatim.

## B5 - LOW, CONFIRMED - three comments assert timings the retiming removed

**ADJUDICATION: UPHELD. Same class as the prose sweeps A7-1 and A10-1..A10-8
already did; these three were simply missed.** ACTION: fix all three.

## B6 - LOW, PLAUSIBLE - the resolver names the unit's contact, not the tour's roster

**ADJUDICATION: REJECTED as a defect.** Spec 6.1 specifies the UNIT's primary
contact (roster `primaryContact` flag, else landlord of record) by name, and
forbids inventing a second resolver. The build implements exactly that. The
missing tenant de-dupe is a real difference from `rosterResolution`'s default-rung
rule, but that rule answers a different question (who receives) than this one
(whose name the copy says). No action; recorded here so it is not re-raised.

## B7 - LOW, CONFIRMED - each re-arm appends two permanent skipped rows

**ADJUDICATION: UPHELD, and it is INHERENT to spec 8.1's ruling** that both new
rules write VISIBLE skipped rows so a founder who booked late sees WHY. Re-arming
a short-horizon tour repeatedly accumulates them. No action on the branch; state
it in the handback as a consequence of the ruling.

## A-G1 - the flake issue's comment nesting

**ADJUDICATION: UPHELD, real docs defect introduced by this branch.** The
frontmatter-delimiter fix (worklist A10-3) landed, but the new explanatory HTML
comment's closing `-->` swallowed the pre-existing comment's opener, so a
deliberately-hidden note now renders as body prose followed by an orphaned `-->`.
ACTION: fix.

## A-G2 - T11 incomplete

Not a defect - it is the phase in progress. Gate 4 has since completed GREEN.
The handback obligations A-G2 enumerates are tracked and will be met.
