# Design review R4 - reviewer A (adversarial, hard cap)

- Spec: `docs/superpowers/specs/2026-08-31-npm-test-soundness-design.md` (v4, `e88f565c`)
- Repo read-only at `W:\tmp\npm-test-soundness` @ `5ce9912f`
- Method: static reading, grep, `git diff 58ee6871 e88f565c`, and pure
  path/regex computation. No suite, npm script or container was run.
  Third-party source from the main checkout's `node_modules`.
- Byte-exact quotation: `.superpowers/sdd/spec-r4-reviewer-a-code-reference.md`.

## Verdict: (A) TERMINAL

Nothing in v4 changes a decision. Every finding below is a **one-line
completion or correction the coordinator can apply before the build**, with no
judgement call left open and no further review round required. I found no
finding that a person has to settle rather than the spec author.

Three findings are graded MEDIUM rather than LOW because they are missing
CONSTRAINTS, not wording - a builder who does not receive them can produce a
defective implementation. But the missing sentence is determinate in every case,
which is what makes the round terminal. I am explicit about this rather than
downgrading them to LOW to make the verdict look cleaner.

Two of the six MEDIUMs (1 and 2) are **statements that existed in v2 and were
lost when v3 replaced the "Mechanism" section wholesale** - the same
did-not-survive-the-rewrite class the coordinator identified as valuable in R2.
I missed both in R3; they are mine to have caught earlier.

**Answers to the two questions asked**, in full, are findings 8 (a) and 2 (b).

---

## 1. [MEDIUM] The retry's BOUNDS were dropped from the spec and never restored - the shared helper now has no specified attempt count or backoff

**Evidence.** v2 (`cfd1a0b4`) carried:

> Bounds: at most 4 attempts, linear backoff (`attempt * 250ms`), matching the
> existing helper. A retry loop that can outlive a test budget trades one false
> red for another.

That paragraph lived in v2's "### Mechanism" section, which v3 replaced
wholesale with "### The verification hook must fail CLOSED". Grep over v4:
`backoff` 0 hits, `250` 0 hits, `4 attempts` 0 hits; the single `attempts` hit
is "RE-READ between attempts" in acceptance case 4.

**What it implies.** The item's central mechanism - a bounded retry on the
control-plane path every integration suite reaches, plus 23 `ensureTable` calls
in `globalSetup` before any test starts - ships with no bound stated anywhere in
the design. The builder would have to reverse-engineer `attempts = 4`
(`db-update-gsis.ts:109`) and `attempt * 250` (`:124`) from the code being
refactored. That is recoverable, but the justification that made the bound a
requirement ("a retry loop that can outlive a test budget trades one false red
for another") is exactly this mission's thesis, and v4 states it for the
`DescribeTable` poll (100ms/10s) while saying nothing for the retry itself.

**The missing sentence:** restore v2's Bounds paragraph verbatim into the
"ONE contract" section.

## 2. [MEDIUM] Whether the local-endpoint gate now applies to `ensureGsis` is unstated - and this is the honest answer to question (b)

**The question was:** does "one contract, always fail closed" leave
`db-update-gsis` behaviourally identical?

**On the hook contract, yes - verified.** `indexStatus`
(`db-update-gsis.ts:88-101`) catches everything and returns `undefined`
(`:97-100`), so it never throws, so the helper's fail-closed branch is never
taken for it; `undefined` maps to "not landed" and re-sends, exactly as today.
v4's placement of the tolerance inside `indexStatus`'s own `catch` is correct,
and acceptance case 8's new second sub-case ("a stub whose `DescribeTable` also
throws must still reach a re-send") pins it properly. That half is right.

**On the gate, no - and the spec no longer says so.** `ensureGsis` is ungated at
the function level today: `db-update-gsis.ts:200-242` contains no endpoint
check, and the only gate is in the CLI block at `:261-270`. Moving its retry
onto a shared helper that carries the local-endpoint gate makes `ensureGsis`
gated where it was not. v2 reconciled this explicitly -

> `ensureGsis`'s own behaviour is otherwise unchanged - its CLI is already
> hard-gated to a localhost endpoint (`db-update-gsis.ts:262-270`), so the new
> gate is additive there, never a loosening.

- and v3 dropped that sentence with the rest of the "Mechanism" section. Grep
over v4: `additive` 0, `262-270` 0, `loosening` 0.

**What it implies.** No live behaviour change today: both callers
(`db-update-gsis`'s CLI, and `unreadIndexRepo.integration.test.ts:764`/`:803`/
`:812`) build clients via `createDynamoClient({ endpoint })`. And acceptance
case 8 does protect against a predicate that refuses everything, because it
asserts a retry HAPPENS on a local-endpoint stub. So the risk is contained. But
the spec answers the coordinator's own question with silence, and a builder
reading "keeps its existing retry" alongside "the retry ACTIVATES only when the
endpoint is localhost" cannot tell whether gating `ensureGsis` is intended or an
accident.

**The missing sentence:** restore v2's reconciliation, updated - the gate does
now apply to `ensureGsis`, its callers all satisfy it, and case 8 is what proves
the gate has not disarmed it.

## 3. [MEDIUM] The verification hook's RETURN contract is still unspecified - three revisions in, only its THROW case is defined

**Spec section:** "the helper has exactly one contract - **if the verification
hook throws, rethrow the ORIGINAL error and do not re-send.**"

**Evidence.** That defines one of three outcomes. What a non-throwing hook
RETURNS, and how the helper reads it, is never stated. Today the decision is not
even in a hook: `db-update-gsis.ts:122` makes it inline -
`if (status === 'CREATING' || status === 'ACTIVE') return;` - against a hook that
returns `string | undefined` (`:88-92`). A generic shared helper cannot make a
GSI-status decision, so the hook's return type must change, and the spec does
not say to what.

**What it implies.** The shape is inferable from acceptance cases 4 and 8, but
"inferable" is how this document produced three tautological decoys. A builder
could reasonably implement "hook returns void and throws when NOT landed", which
inverts the fail-closed rule into a fail-open one while satisfying every
sentence in the section.

**The missing sentence:** the hook returns a boolean - `true` means attempt N
landed, so the helper returns success without re-sending; `false` means it did
not, so the helper backs off and re-sends; a throw means the hook could not tell,
so the helper rethrows the original error. `db-update-gsis` supplies
`async () => { const s = await indexStatus(...); return s === 'CREATING' || s === 'ACTIVE'; }`.

## 4. [MEDIUM] The positive control - the thing that replaced the decoy - can itself pass vacuously unless it asserts CONTENT

**Spec section:** Item 3(a) - "**What the fixture DOES need is a positive
control** ... a real asset written into the fixture dist and fetched
successfully."

**Evidence.** `app/src/app.ts:286-293`: `express.static(distDir)` is mounted with
no options, so `fallthrough` is true, and the next middleware answers any GET it
misses with `res.sendFile(path.join(distDir, 'index.html'))` - **200**. So a
request for `/probe.txt` returns 200 whether the static mount serves it or the
fallback does. "Fetched successfully" asserted as `status === 200` is satisfied
by the exact regression the control exists to detect.

The regression is not hypothetical: remove `app.use(express.static(distDir))`
and `GET /` still returns index.html (the fallback), every hardening-header and
CSP case still passes (that middleware is mounted above, `:280-285`), and every
traversal probe still returns 200 + the shell. Nothing in the file notices.

**What it implies.** This is the fourth control in this document specified in a
way that can pass for the wrong reason, and it is in brand-new v4 material
written to close the previous three. The Risks bullet the coordinator added
("When an assertion needs elaborate scaffolding to be meaningful, check first
whether the mechanism under test makes the scaffolding unreachable") applies to
the control itself.

**The missing sentence:** the positive control asserts the asset's BODY equals
what the fixture wrote (and ideally its `content-type`), not its status - a
status-only assertion is satisfied by the SPA fallback and proves nothing.

## 5. [MEDIUM] The fixture's NEGATIVE content constraint is missing, and dropping the decoy is what made it load-bearing

**Spec section:** Item 3(a) - "**Fixture contents are specified.** The fixture
`index.html` must carry `HousingChoice` and `<div id="root">`".

**Evidence.** Every traversal probe falls through to the SPA fallback, so
`res.text` at `app/test/staticSmoke.test.ts:161-163` is the served
`index.html` - the FIXTURE's, once (a) moves onto a fixture. Those three
assertions are `not.toContain('"version"')`, `not.toContain('"private"')` and
`not.toContain('root:')`. With the decoy gone, **the fixture's own content is
the only thing those assertions now test.**

The spec states only what the fixture must CARRY. Reviewer B raised the negative
half in round 1 (B20: "it must NOT contain `"version"` / `"private"` or the
traversal assertions self-fail"); the accept was recorded as "every existing
assertion is now assigned to (a), (b) or (c) explicitly", and the negative
constraint never reached the document.

**What it implies.** A builder who writes a fixture `index.html` containing a
JSON snippet, a version comment, or a CSS rule producing `root:` fails all six
traversal cases at once, with a failure that reads as a traversal regression.
Loud rather than silent - but avoidable with one clause.

**The missing clause:** and must NOT contain `"version"`, `"private"` or
`root:`, because the traversal assertions now read the fixture's own body.

Related precision slip in the same sentence: `:85` is cited as an assertion that
depends on the fixture carrying `<div id="root">`. It is a NEGATIVE assertion on
a different response (`app/test/staticSmoke.test.ts:83-85`, the
`/app-identity/not-a-real-asset` 404 JSON), as is `:99`. The positive
requirements are `:108` and `:165` only.

## 6. [MEDIUM] The newly specified poll-exhaustion path has no acceptance case

**Spec section:** "on exhaustion **rethrow the original
`ResourceInUseException` with the observed table status appended**" - new in v4 -
against acceptance cases 1-8, none of which exercises it.

**Evidence.** Case 2 covers the poll's success branch ("polled `DescribeTable`
until ACTIVE before returning"). No case drives a stub whose `DescribeTable`
answers non-ACTIVE past the ceiling, so nothing pins that the error is the
original `ResourceInUseException` rather than a generic timeout, that the status
is appended, or that the ceiling is honoured at all.

**What it implies.** This is the same gap that produced acceptance case 5 in the
first place: a newly specified path with no way to observe it. It is cheap to
close - the stub is already required to answer `DescribeTable`, so the case is
one more programmed response - and the mission's own standard ("this item MUST
be able to fail") demands it.

**The missing case:** case 9 - local, `CreateTable` throws
`ResourceInUseException`, `DescribeTable` answers `CREATING` forever -> throws a
`ResourceInUseException` naming the observed status, within roughly the 10s
ceiling.

## 7. [LOW] Two v4 rules meet on one line of code and give opposite answers

**Spec sections:** the disposition rule - "The one exception is
`DescribeTimeToLive` inside `enableTtlIfNeeded`, which is **covered** because it
is the guard for a mutation in the same function" - and the hook rule - "The
verification hook is called at most ONCE per failed attempt and is **never
itself retried**."

**Evidence.** `app/src/lib/dynamoAdmin.ts:128-131` is a single
`DescribeTimeToLive` send. Under the first rule it is retried (as the pre-send
guard); under the second it is not (as the verification hook). A builder writing
one `readTtlStatus()` helper and using it in both places must pick one regime,
and either choice violates a stated rule.

**What it implies.** The intended reading is forced once both rules are held
together - the guard read is retried, the hook read is not - so this needs
disambiguation rather than a decision. Worth one sentence because the spec has
twice been bitten by exactly this shape (a single call site living under two
regimes).

**The missing sentence:** `enableTtlIfNeeded` has two `DescribeTimeToLive` call
sites, not one - the pre-send guard, which is covered by the retry, and the
verification hook, which is not.

## 8. [LOW] What the traversal probes now pin is OURS, not `send`'s - and saying otherwise invites their deletion

**The question was:** does dropping the decoy leave the probes asserting
anything worth keeping, or should they be deleted as testing `send` rather than
us?

**Keep them. v4's decision is right; its stated reason undersells it and points
the other way.** The spec says: "the mechanism that delivers it is `send`'s, not
ours, and it is worth pinning precisely because a future static-serving change
could lose it." The first clause is the argument for deleting them, and it is
stated more prominently than the second.

**What they actually pin, empirically.** Every probe 403s inside `send`
(`send/index.js:431`), and `serve-static/index.js:115-120` then calls `next()`
because `403 < 500`, so the observable is **200 plus the SPA shell** - which is
why `staticSmoke.test.ts:164-166` has an `if (res.status === 200)` branch. The
surviving assertion is therefore about OUR middleware composition: *no encoded
traversal can produce anything except the SPA shell or a 4xx.* That catches
real, plausible changes to our code - a SPA fallback refactored to interpolate
`req.path` into `sendFile` (today it is a fixed
`path.join(distDir, 'index.html')`, `app/src/app.ts:292`) would return a 500 or a
file body and break the status list or the body assertions.

**Two corrections of fact in the same paragraph**, both minor and both worth
fixing because this paragraph is now the file's authority on the mechanism:

- "**Express decodes** `%2e%2e%2f` to `../` first" - `send` decodes, at
  `send/index.js:411`. `serve-static` passes the still-encoded pathname
  (`serve-static/index.js:87`). Express does not decode it.
- "answers **403** before joining the root" - true of `send` internally, false
  of the observable. The response is 200 with the SPA shell. A builder who
  reads this and asserts 403 will write a failing test.

**The missing sentence:** state what the probes pin in terms of our composition
("no encoded `..` can yield anything but the SPA shell or a 4xx"), and note the
403 is internal to `send` while the observable is a 200 fallthrough - otherwise
the next reader deletes them on the spec's own argument.

## 9. [LOW] The 10s poll ceiling is justified per-call; two callers loop

**Spec section:** "10s is chosen against the caller's 60s hook budget".

**Evidence.** `app/test/importApply.integration.test.ts:75-77` and
`app/test/groupConvert.integration.test.ts:122-124` both call `ensureTable`
inside a loop over table specs, under the default `hookTimeout: 60_000`
(`app/vitest.config.ts:71`). Six tables each reaching the ceiling is 60s, and
`app/test/globalSetup.ts:117` runs ~23 of them under no vitest budget at all.

**What it implies.** Little in practice - the ceiling is only reached when a
table genuinely never goes ACTIVE, which on DynamoDB Local is close to never,
and reaching it throws a named error rather than a hook timeout, which is the
better failure. But the stated justification is per-call while the callers are
per-loop, and this document's history is one of justifications that stop one
layer early. Note it as a watch item rather than changing the number.

## 10. [LOW] Residual precision

- Acceptance case 8 is now two cases sharing a number. Split it, so a handback
  reporting "8 passed" is unambiguous about which behaviour was proven.
- The Risks bullet correctly adds case 7 as the positive half of the inertness
  proof. Case 7 pins the PREDICATE (`[::1]`, `127.0.0.1`), not the integration -
  no real client reaches `[::1]` unless `DYNAMODB_ENDPOINT` is set that way
  (`e2e/support/urls.ts:9` records that `localhost` resolves to `::1` here). That
  is the right scope; it is just worth saying, so nobody later reads case 7 as
  end-to-end coverage.

---

## Adjudication audit - were R3's accepts implemented in substance?

Yes, in all ten cases, and two of them notably better than the finding asked for:

- **R3 #1** - the decoy was DROPPED rather than relocated a fourth time, and
  replaced with the control that was actually missing. That is the strongest
  possible response to the finding; my only remaining objection is that the
  replacement control needs the content assertion (finding 4), not that the
  decision was wrong.
- **R3 #2** - "one contract at the helper, tolerance inside `indexStatus`'s
  catch" is exactly right, and the added fail-open sub-case in case 8 pins the
  half I could not have asked for more precisely. Verified against
  `db-update-gsis.ts:97-100`.
- **R3 #3** - the `waitUntilTableNotExists` cost is correctly characterised as
  pre-existing, and "previously that case threw outright, which is strictly
  worse" is right: `deleteTableIfExists` at `:146-149` catches only
  `ResourceNotFoundException`, so a DELETING table throws today.
- **R3 #4** - the pattern now matches `waitUntilTableNotExists` and the spec
  directs the builder to the command's OUTPUT rather than a quoted count. That
  removes the class, not just the instance.
- **R3 #5, #6, #7, #8, #9, #10** - all implemented as meant. #7's promotion from
  label to USE RESTRICTION is the most consequential and is correctly worded:
  a mixed pair may support "no regression" and may not close the anchor.

No accept was implemented to the letter while missing its point this round. The
two regressions I found (findings 1 and 2) are older - both were v2 statements
lost in v3's rewrite, which I failed to catch in R3.

## The one thing worth telling the human - not a spec defect

Item 1A states plainly that "No record shows `dynamoAdmin.ts`'s sends failing by
name - the justification is the class, not a specific open sighting". Item 1D now
forbids a mixed contended/quiet pair from closing the anchor. The neighbouring
missions are expected to finish during the protocol. Put together, **the most
likely honest outcome of this mission is that the anchor issue stays OPEN**,
having hardened a surface with no recorded failure.

That is internally consistent and it is the spec being honest rather than
optimistic - it is not a finding. But locked decision 1 says "close on
evidence", and the human should know before the build that closure is the less
likely branch, so the handback does not read as a shortfall. This needs telling,
not revising, and it does not affect the terminal verdict.
