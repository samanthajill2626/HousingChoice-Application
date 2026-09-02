# Slice 7 - the e2e spec and the branch's closure

Branch `feat/retry-counter-durable`, worktree `W:\tmp\retry-counter-durable`.
Base for this step: `b3817fcf` (slice 6's sweep; main already merged at
`8c8b7100`, no further sync performed).

Commits:

- `59f3f9ad` test(e2e): prove a relay 30003 leg promises no retry, at all three
  positions
- `d9365a68` docs(issues): resolve the anchor, record the rail partial, file
  M5's four residues
- `e50ae4f7` docs: carry M5's lineage knowledge forward, amend the M5 cluster,
  sharpen D8
- (this report, committed separately)

---

## 1. The e2e spec

New file, one test:
`e2e/tests/dashboard-next/relay-30003-no-retry-promise.spec.ts`.

### Host: the LEAN lane, `createGroupOpen`

The worklist's preferred host was taken; the `relay-group-view.spec.ts` fallback
(full profile) was NOT needed and was not touched. **No honest attempt was
spent on the fallback because the lean settle worked on the first run** - the
create-time intro settles on both members inside the 15s poll, and the armed
profile survived to the team send, which is exactly what the run proves (a
consumed-too-early profile would have produced a fully green send and a red
test).

Shape, in order:

1. lean reseed (`beforeEach`) + `devLogin`;
2. two contactless `{phone, name}` members on run-unique `+1555 8XX XXXX`
   numbers, `uid` seeded at 40 so a same-second run of `relay-open-stop.spec.ts`
   (which seeds at 1) cannot mint the same handset - the fake's thread store is
   reset once per suite, so a collision would cross-contaminate proof-of-send;
3. `createGroupOpen`, which drives the connect-when-ready handshake and returns
   the group OPEN on a pool number;
4. **SETTLE the create-time intro on BOTH members** against the fake's thread
   store, FROM the pool number, before anything is armed;
5. `setDeliveryOutcome({ partyNumber: <member A>, profile: { kind: 'fail',
   failState: 'undelivered', errorCode: '30003' } })` - one leg only, so the
   rollup has a real mixed state and the reason is provably attached to the
   FAILED legs rather than to the bubble;
6. team send into the group through the conversation view's composer.

### The four assertions the slice-5a report demanded

Every assertion is SCOPED to the bubble under test (`getByText(token)` then
`locator('xpath=..')`), so the create-time intro's own bubble cannot satisfy
one of them.

| # | position | assertion |
|---|---|---|
| 1 | rollup chip (visible text) | `toContainText('delivered 1/2 - 1 failed - Phone unreachable (error 30003)')`, then `not.toContainText('will retry')` |
| 2 | that chip's accessible name | `toHaveAccessibleName(/<member>: Undelivered, Phone unreachable \(error 30003\)/)`, then `not.toHaveAccessibleName(/will retry/)` |
| 3 | per-recipient row | `toContainText('Undelivered - Phone unreachable (error 30003)')`, then `not.toContainText('will retry')` |

Plus the control (the OTHER member's row reads `Delivered`, proving the
override is scoped to a failed leg's reason) and one bubble-wide
`not.toContainText('will retry')` taken after all three positions are rendered
at once.

Two guards are load-bearing and are commented as such in the file:

- **The reveal.** `toHaveCount(0)` on `getByRole('list', { name: 'Delivery by
  recipient' })` BEFORE the bubble-body click. The list is conditionally
  rendered on bubble-local state, so an absence assertion written without the
  click passes on a completely broken build (`selectors.md:48-49`).
- **Positive before negative.** The `(error 30003)` presence assertion carries
  the 60s SSE headroom and runs FIRST; asserting `not.toContainText('will
  retry')` before the receipt has landed would pass against any build at all.
  The tail is asserted PRESENT at all three positions for the reason slice 5a
  gave: half this change is that the carrier code survives.

NOT RELOADED anywhere - the receipt has to arrive over SSE on its own, matching
every other rollup poll in that directory.

### The run

Preflight: the lane resolver hashes this worktree's gitdir to **lane 3**
(9301 / 9311 / 9321 / 9331). `Get-NetTCPConnection` on all four ports returned
NOTHING before the run, and `e2e/.artifacts/` did not exist - so no orphaned
listener could be adopted by `reuseExistingServer` on a commit match. Ports
5174/8080 were never touched.

Run, through the e2e WORKSPACE, one spec, output redirected and the exit code
read afterwards:

    cd W:\tmp\retry-counter-durable\e2e
    npx playwright test tests/dashboard-next/relay-30003-no-retry-promise.spec.ts
    -> exit 0        .superpowers/gates/s7-e2e-spec.log

From the log:

    ok 1 [chromium] > tests\dashboard-next\relay-30003-no-retry-promise.spec.ts:103:1
       > a relay leg that failed 30003 promises no retry: chip, accessible name
       and row (11.7s)

    1 passed (30.9s)

The launcher's own line confirms the lane: `[e2e-session] resolved lane 3:
app=http://127.0.0.1:9301 dashboard=http://127.0.0.1:9311 ...`,
`tablePrefix=hc-local-3-`. The stack cold-booted and tore down inside the one
command; no session was left running. The full suite was NOT run - the
orchestrator owns that gate.

**Why this is not vacuous on `main`.** The positive at position 1 is the whole
proof: `main` renders `Phone unreachable <em dash> will retry (error 30003)`, so
the exact-substring `toContainText` fails there. A separate RED run was not
performed - the slice-5a unit RED (`.superpowers/gates/s5a-red.log`) already
captured that exact rendered string, and re-reverting the presenter to produce
it in a browser would have bought a second copy of the same evidence.

## 2. Issues resolved, amended and filed

**Resolved.**

- `docs/issues/retry-counter-in-envelope-makes-caps-unreachable.md` - status
  `resolved`, `resolved: 2026-09-01`, refs refreshed to the current claim sites.
  The Resolution names the durable scalar, both claim sites with their commits
  (`c7d3b5f0`, `58764d87`), all three closes with current line anchors, and the
  D10 reason split. It states plainly that **`retrySend.ts:74` needed NO change
  and was not touched** (already handled at `twilio.ts:2727-2731`) and that
  `groupRail.ts:101` is untouched, so neither can be read as swept up. The
  "Sites still carrying the shape" line numbers are marked as-filed and stale
  rather than silently rewritten. The "also worth auditing" paragraph is marked
  DONE, points at `provider-status-sweep.md` and
  `provider-status-unenumerated-defaults`, and records that the suggested
  `!== 'success'` grep has ZERO hits so nobody re-runs it and concludes the
  sweep was empty. Closes with what is still open: the D12 throw.

**Partial, status deliberately still `open`.**

- `docs/issues/rail-binding-propagation-retry.md` - `updated: 2026-09-01`, refs
  refreshed. Names what shipped (both ladder points, its own catch at point 1,
  the three opted-in callers), what is DELIBERATELY LIVE
  (`groupSend.ts:381` and `:425`), what is excluded and filed (adopt, refusal
  noise), that **rail-verify's opt-in is inert except on delete-and-recreate**,
  and the compounded cost (bounded per POINT, not per call). `partial` is not a
  legal status in `docs/issues/README.md`'s taxonomy, so the file stays `open` -
  which is also correct, since two callers are still exposed.

**Refs refreshed only (argument untouched).**

- `docs/issues/throw-for-redelivery-defeated-by-job-marker.md` - the quoted
  comment no longer exists in the tree (corrected by `8cebbebf`), so the quote
  is kept as the historical text and labelled as such; the throws are re-derived
  by reading and are now `broadcastFanOut.ts:545` / `relayFanOut.ts:1002`;
  `messagesRepo.ts:2630` -> `:2653`. Front-matter refs updated to match.

**Filed (four new files).**

| slug | sev | what it records |
|---|---|---|
| `rail-adopt-path-binding-propagation` | low | D17. The adopt read-back faces the same propagation window; excluded because for an adopted rail that read is the only source of roster truth. Names the three things a fix needs first: evidence the window is hit, an age signal the adapter ref does not carry today, and a latency budget. |
| `rail-repair-refusal-log-noise` | low | D18. The 178 50386/50437 WARN lines originate at `adapters/groupConversations.ts:563-566`, a file this branch does not edit; `groupRail.ts:613-622` collects the failures and DISCARDS them, so handling them changes no behavior. The fix is log classification in the adapter, and the file says so rather than shipping an inert no-op that reads like a fix. |
| `relay-hub-message-delivery-status-never-terminal` | med | Slice-3 F9, verified not assumed. A team-send hub row is appended `'queued'` (`routes/api.ts:1794`) and no relay path ever advances it; there is NO relay rollup. `ALLOWED_PRIOR.failed = ['queued','sent']` makes a forward transition legal. Carries the WARNING: taking it lights up a FIFTH render position (`Timeline.tsx:862`, the message-level chip, currently excluded by a decision comment), so a carrier code there would print the retry promise back onto a relay message. |
| `relay-30003-classified-transient-retrying` | low | Dashboard F8. `twilio.ts:286` still holds 30003 in `TRANSIENT_RETRYING_DELIVERY_CODES`, and the relay-leg marker at `:2377` uses it to log WARN not ERROR "because it retries" - false for relay after D19. `twilio.ts` is fenced in its entirety, so file-not-fix; the file also notes the set is shared with 1:1/group text where the retry is real, which is why it needs a decision rather than a one-line edit. |

## 3. The deferred-mission knowledge transfer

`docs/issues/relay-30003-retry-lineage.md` gains a
`## Design knowledge from M5 (2026-09-01)` section carrying the five facts spec
Sec 8 obligation 5 names, each re-derived against the live tree rather than
restated from the spec:

1. forward-only `ALLOWED_PRIOR` (`messagesRepo.ts:121-130`) omits `undelivered`
   from `delivered`'s prior list, so a delivered retry needs an explicit scoped
   transition and the effective status must be DERIVED from lineage;
2. gating the retry claim on the slot transition caps the ladder at ONE retry
   invisibly - the gate belongs on the attempt record;
3. `relayAnnouncements.ts` writes the same `relaysid` pointers (`:289`, `:312`)
   and `sendRelayAnnouncement` is imported by **`jobs/tourReminders.ts:61`**, so
   a pointer-keyed retry has blast radius into a fenced file;
4. a two-level lineage map hits the parent-path seeding problem the scalar
   avoided; the in-repo answer to copy is `conversationsRepo.ts:2189-2214`
   (conditional child write, catch, seed the map with this one entry, still
   guarding the item's existence);
5. the relay chip copy must become CLAIM-aware when a retry becomes real, at all
   three positions together, and the new e2e spec is the checklist for what has
   to change.

Plus the substrate note the spec's Sec 2.1 requires: `MessageItem.fanout_attempt`
+ `claimFanoutPass` are available and are the PATTERN to reuse, but the COUNTER
must NOT be shared - a continuation would silently consume the retry budget.

## 4. Cluster amendment and the spec precision note

- `docs/issues/_CLUSTERS.md`, M5 section: a dated `AMENDED 2026-09-01` paragraph
  after the conflicts line. It states that the branch did the OPPOSITE of the
  recorded routing on both counts - the lineage was deferred to its own mission
  rather than landed here, and the dashboard copy landed here rather than in
  T-DELIVERY-CHIPS (Cameron's `Timeline.tsx` authorization) - and records the
  anchor as resolved, the sweep as run, and the rail issue as an open partial.
- `docs/superpowers/specs/2026-08-31-retry-counter-durable-design.md`, D8: one
  added clause, labelled in the text and in the commit message as a **recorded
  adjudication, not a design change** - every exit EXCEPT the D12 unknown-error
  throw, which is a fourth exit and is filed rather than fixed. No behavior
  claim in the document changed.

## 5. Gates

Run from the worktree; never piped; output redirected and the exit code read
afterwards.

| gate | result | log |
|---|---|---|
| `npm run typecheck` (worktree root) | **exit 0**, all six workspaces, no diagnostics | `.superpowers/gates/s7-typecheck.log` |
| `npx playwright test tests/dashboard-next/relay-30003-no-retry-promise.spec.ts` (from `e2e/`) | **exit 0**, `1 passed (30.9s)`, lane 3 | `.superpowers/gates/s7-e2e-spec.log` |
| `npm run issues` (worktree root, bare) | **exit 0** - `281 open, 159 closed, 440 total`; `11 high` | `.superpowers/gates/s7-issues.log` |

`npm test`, `npm run smoke`, the full `npm run e2e` and gate 5 (eslint) were
deliberately NOT run - they are the orchestrator's branch-level gates.

`npm run issues` emitted ONE warning, pre-existing and not this slice's:
`perf-selfqa-route-contract-drift.md: unknown severity "medium"`. All four new
files use a legal `severity`. `INDEX.md` is gitignored and was not committed.

ASCII: the new spec file was byte-scanned whole (0 non-ASCII bytes) and every
`+` line of both docs commits was scanned against the same rule (0 hits). All
edits went through the Edit/Write tools; no PowerShell rewrite pipeline was used
on any file.

## 6. Deviations

1. **`resolveMemberName` naming was verified before relying on it.** The row
   locators filter by the member's NAME, which only works because a relay
   participant created with `{phone, name}` keeps that name
   (`services/relayMembers.ts:49-60`) and `groupMemberLabel` prefers a name over
   the formatted number. Had it fallen back to the number the spec would have
   needed the `formatPhoneDisplay` mirror that
   `group-text-per-recipient-delivery.spec.ts` carries; it does not.
2. **The rollup chip is addressed as `bubble.getByRole('img')`, not
   page-scoped.** The message-level chip only takes `role="img"` on a branch-0
   bubble (a non-empty map whose legs ALL opted out), which this fixture cannot
   produce, so the rollup is the only named leaf inside the bubble. Scoping also
   keeps the create-time intro's bubble out of every assertion.
3. **No separate browser-level RED run.** Reasoning in section 1; the exact
   pre-fix rendered string is already captured in `.superpowers/gates/s5a-red.log`
   and the spec's position-1 assertion is a strict substring of the post-fix
   copy that `main` cannot satisfy.
4. **`selectors.md` was NOT edited by this slice.** Slice 5a already added the
   product-dependent 30003 row string and the note that the proving assertion is
   the negative at all three positions; this spec is written against that entry
   and had nothing to add to it.

Nothing in the worklist's S7 section had to be departed from, and no contract
mismatch was found: `setDeliveryOutcome`'s one-shot destination keying, the
`createGroupOpen` intro settle, the reveal gate and the three render positions
all matched the live tree exactly.
