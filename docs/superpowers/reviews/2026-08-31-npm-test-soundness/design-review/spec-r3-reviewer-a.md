# Design review R3 - reviewer A (adversarial)

- Spec: `docs/superpowers/specs/2026-08-31-npm-test-soundness-design.md` (v3, `58ee6871`)
- Repo read-only at `W:\tmp\npm-test-soundness` @ `5ce9912f`
- Method: static reading, grep, and pure path/regex computation. No suite, npm
  script or container was run. Third-party source read from the MAIN checkout's
  `node_modules` (`express` 5.2.1, `send` 1.2.1, `serve-static` 2.2.1,
  `@aws-sdk/client-dynamodb` 3.1070.0).
- Byte-exact quotation: `.superpowers/sdd/spec-r3-reviewer-a-code-reference.md`.

**This round is NOT terminal.** Findings 1, 2 and 3 each change a decision, and
finding 1 answers a question the coordinator asked with the opposite of the
expected answer.

Both questions I was asked to attack came back positive: the decoy requirement
is still tautological, provably and at every depth (finding 1), and the
asymmetric hook contract is stated at a layer where it cannot hold (finding 2).

---

## 1. [HIGH] No traversal probe reaches the filesystem at ANY depth. `send` rejects them on a string regex before resolving against the root, so the decoy is unreachable by construction - and v3's reachability check cannot detect that

**Spec section:** Item 3(a), "Traversal decoys are placed against the actual
probe strings" - "The builder places a decoy `package.json` ... at **each depth
the probe strings actually reach**, verified by asserting the decoy IS readable
from disk at that path before asserting the server does not serve it. A decoy
nobody can reach proves nothing." Plus the Risks bullet: "Verify the decoy is
reachable before asserting it is not served."

**Evidence - the mechanism, read rather than reasoned about.**
`node_modules/send/index.js:410-441`. `send` decodes the path, then, with a
`root` set (serve-static always sets one), does
`path = normalize('.' + sep + path)` at `:427`, tests
`UP_PATH_REGEXP = /(?:^|[\\/])\.\.(?:[\\/]|$)/` (`:61`) at `:431`, and on a match
calls `this.error(403)` and RETURNS at `:432-434`. The line that joins against
the root - `path = normalize(join(root, path))` at `:441` - is never reached.

Computed for all six probes at `app/test/staticSmoke.test.ts:148-154`, on both
`path.win32` and `path.posix`, with the installed Node (full table in the
reference file):

| probe | normalized | `UP_PATH_REGEXP` |
|---|---|---|
| `/%2e%2e%2f%2e%2e%2fpackage.json` | `..\..\package.json` | blocked |
| `/%2e%2e/%2e%2e/package.json` | `..\..\package.json` | blocked |
| `/..%2f..%2fpackage.json` | `..\..\package.json` | blocked |
| `/..%5c..%5cpackage.json` | `..\..\package.json` | blocked |
| `/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json` | `..\..\package.json` | blocked |
| `/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd` | `..\..\..\etc\passwd` | blocked |

`serve-static` then falls THROUGH rather than answering 403: `forwardError` is
false (`index.js:85`, fallthrough defaults true and the `file` event never
fires), `403 < 500`, so `index.js:115-120` calls `next()`. The next middleware
is the SPA fallback at `app/src/app.ts:287-293`, whose `res.sendFile` target is
`path.join(distDir, 'index.html')` - a fixed path carrying no user input. Hence
the 200 + `<div id="root">` branch the test already allows at
`staticSmoke.test.ts:164-166`.

**What it implies.** Three separate things, and the first is decision-changing:

- **"Each depth the probe strings actually reach" is the EMPTY SET.** There is
  no depth at which a decoy makes the assertion non-vacuous, because the
  filesystem is never consulted. v3 has produced the third tautological decoy in
  three revisions, and this time the reason is structural rather than
  arithmetic - so a fourth attempt at depth arithmetic will fail the same way.
- **The prescribed verification cannot detect this.** "Asserting the decoy IS
  readable from disk at that path" proves a file exists at a path. It says
  nothing about whether any probe designates that path. A decoy at the wrong
  depth, or at any depth at all, passes that check. The spec has specified a
  check that its own risk bullet's failure mode walks straight past.
- **The pre-existing test is vacuous in the same way**, against the real tree.
  The repo-root `package.json` at `dashboard/dist/../../package.json` was never
  why `expect(res.text).not.toContain('"version"')` passed; `send`'s regex was.
  So this is not a regression the fixture introduces - but the spec asserts the
  opposite in three places and mandates work premised on it.

**On the coordinator's specific claim about `/assets/`:** the arithmetic is
CORRECT - `normalize('.' + sep + '/assets/../../../package.json')` is
`..\..\package.json`, the same two levels as the other four, on win32 and posix
alike. It is also irrelevant, because the depth is never used.

**What would actually be provable**, in order of cost:

1. **Assert designation, not readability.** For each probe, compute
   `path.resolve(distDir, decodeURIComponent(probe))` and assert (a) it escapes
   `distDir` and (b) it names an existing file containing `"version"`. That
   proves the probe DESIGNATES a real out-of-root target - the only sense of
   "reachable" available without disabling the guard - and it is deterministic,
   server-free and cheap. It is what the spec's paragraph is reaching for.
2. **Say plainly what the probes test.** They pin `send`'s `UP_PATH_REGEXP`
   rejection plus serve-static's fallthrough, i.e. "an encoded `..` never
   escapes the mount". That is a real and worthwhile invariant. Assert THAT -
   including the 200-is-the-SPA-shell branch, which is the actual observable -
   and drop the "never leak file contents" framing the mechanism does not
   support.
3. **Optional, and a decision rather than a mandate:** if the resolve step is to
   be tested at all, it needs a probe class the regex does not reject - an
   in-root symlink pointing outside, or a Windows drive-absolute / UNC form.
   That is new scope; I raise it only because without it `:441` is untested.

## 2. [HIGH] The asymmetric hook contract is stated at the helper layer, where it cannot hold - the supplied hook structurally cannot throw

**Spec section:** "The verification hook must fail CLOSED" - "the shared
helper's contract is: **if the verification hook itself throws, rethrow the
ORIGINAL error rather than re-sending.** `db-update-gsis.ts` keeps its current
fail-open behaviour explicitly, as its own documented choice."

**Evidence.** `app/scripts/db-update-gsis.ts:88-101` - `indexStatus` wraps its
`DescribeTable` in `try { ... } catch { return undefined; }`. **It never
throws.** Its consumer at `:121-122` returns early only on `CREATING` /
`ACTIVE`, so `undefined` re-sends.

**Answering the question directly.** The asymmetry as written is not incoherent -
it is *inert*, which is worse, because it reads as a decision that was made.

- There are not two helper contracts. There is ONE helper contract (`hook
  throws` -> rethrow original) and TWO hook implementations, one of which
  swallows its own errors and therefore can never reach the contract's only
  branch. `db-update-gsis`'s "fail-open behaviour" is a property of
  `indexStatus`, not of the helper.
- Stated as a peer clause to "the shared helper's contract is", it invites
  exactly the defect the coordinator suspects: a builder reading "one helper,
  two behaviours" adds a `failOpen: boolean` parameter, and then there really
  are two contracts in one helper.
- **The load-bearing defect is the hook's return type.** The hook has three
  outcomes in practice - *landed*, *not landed*, *cannot tell* - and the
  contract distinguishes only *returned* from *threw*. `indexStatus` collapses
  *cannot tell* into `undefined`, which reads as *not landed*. If the new
  `UpdateTimeToLive` hook is written in `indexStatus`'s shape - and it will be,
  because the spec points at `indexStatus` as the model and the two live eight
  lines apart in the same refactor - **the fail-closed rule is silently inert
  and the `ValidationException` risk that motivated it returns in full.** The
  spec's own correction would be defeated by copying the pattern it is
  refactoring onto.

**What the spec must say instead**, none of which it does:

- the helper has ONE contract, and the divergence lives in the hooks;
- **a hook MUST NOT catch its own errors** - a hook that cannot distinguish
  "read failed" from "not landed" cannot satisfy any contract keyed on failure.
  Either the hook propagates, or it returns an explicit tri-state and the
  contract is keyed on that instead of on `throw`;
- `indexStatus`'s `catch` at `:97-100` keeps its swallow DELIBERATELY, and needs
  a comment saying so at that line - otherwise the next reader, holding a shared
  helper whose docstring says "fail closed", will "fix" it and silently change
  `db-update-gsis`'s behaviour. Acceptance case 8 proves `ensureGsis` still
  retries; nothing pins that it still fails OPEN.

## 3. [MEDIUM] The `DeleteTable` fix feeds `waitUntilTableNotExists`, which carries the identical 20-second first tick the spec just removed from the create path

**Spec section:** the per-command table's `DeleteTable` row ("tolerate it -
DELETING means the delete landed") and "**The wait must NOT be
`waitUntilTableExists`** ... Use a bounded `DescribeTable` poll".

**Evidence.** The replacement instruction names only the create path.
`app/scripts/db-create.ts:58-81` (`dropAllTables`) pairs `deleteTableIfExists`
with `waitUntilTableNotExists({ client, maxWaitTime: 60 }, ...)` at `:64` and
`:76`, once per table in `TABLES` plus the legacy dev-outbox name.
`app/test/globalTeardown.ts` imports `dropAllTables` for `dropKeyedLocalTables`,
so this runs at the end of every `npm test`, and `scripts/e2e-stop.mjs` reaches
it through `db:create --drop`.

`waitForTableNotExists` uses the SAME `serviceDefaults = { minDelay: 20, maxDelay: 120 }`
as `waitForTableExists` (reference file), so the R2 poller arithmetic is
unchanged: the second poll is a flat 20,000 ms, and `checkExceptions` throws a
`TimeoutError` at `maxWaitTime`.

**What it implies.** Today, a `DeleteTable` against a DELETING table throws
`ResourceInUseException` and `deleteTableIfExists` rethrows it (`:146-149`
catches only `ResourceNotFoundException`), so `dropAllTables` fails loudly and
immediately. After the accepted fix it returns successfully **while the table is
still DELETING** - and the very next line is a waiter whose first retry is 20
seconds. The fix therefore makes the 20s tick MORE likely on the teardown path,
which is the one path where the spec's own accepted reasoning ("fixing one false
red by arming another is this mission's own failure mode") applies unchanged.

The mission should either pass a short `minDelay` to those two waiter calls too,
or state explicitly that the teardown path is out of scope and why - noting the
cost is a silent multi-table stall after every `npm test`, not a red.

## 4. [MEDIUM] The reproducible enumeration command's stated result does not match its actual output, and it cannot see `db-create.ts` at all

**Spec section:** "Enumerated by this command, which is reproducible and which
the builder must re-run rather than trust this table ... It finds ~25 sends and
3 waiter sites across 11 files."

**Evidence.** Run verbatim from the worktree, the command returns **29 lines
across 9 files** (list in the reference file). Three are `waitUntilTableExists(`
sites, so 26 sends + 3 waiters. "~25 sends" and "3 waiter sites" are fair; **"11
files" is wrong - it is 9.**

More substantively, the pattern matches `waitUntilTableExists(` and
`waitUntilTableNotExists` is a different string, so `app/scripts/db-create.ts:64`
and `:76` are invisible - and because `db-create.ts` contains no other matching
line, **the file that owns `dropAllTables` appears in no row of the output at
all.** That is precisely where finding 3 lives.

**What it implies.** The command was introduced to stop the enumeration being
wrong for a third time, and its printed result is wrong on file count while its
pattern silently drops the sites that matter most to one of this mission's own
fixes. Either widen the pattern to `waitUntilTable\(Not\)\?Exists(` and correct
the counts, or drop the counts from the prose entirely and let the command be
the authority it claims to be - a stated result that disagrees with the command
teaches the builder to trust the table again.

## 5. [MEDIUM] `enableTtlIfNeeded` now nests one retry policy inside another - the reasoning the spec used to exclude the SDK waiter

**Spec section:** the disposition rule ("The one exception is
`DescribeTimeToLive` inside `enableTtlIfNeeded`, which is covered because it is
the guard for a mutation in the same function") together with the
`UpdateTimeToLive` row ("the status read becomes the retry's verification
hook").

**Evidence.** `app/src/lib/dynamoAdmin.ts:128-137`. The single
`DescribeTimeToLive` at `:129` is now simultaneously (a) a COVERED send, i.e.
wrapped in the bounded retry, and (b) the verification hook of the retried
`UpdateTimeToLive` at `:133`. So each outer retry attempt invokes a hook that is
itself a retry loop.

**What it implies.** Worst case is 4 outer x 4 inner sends with both backoff
ladders, and - more importantly - the failure semantics stop being decidable
from the spec. If the inner retry exhausts, does the hook THROW (triggering the
new fail-closed rethrow of the ORIGINAL error) or RETURN (re-sending the enable,
which is what fail-closed exists to prevent)? Both readings are available.

This is the same objection the spec itself used to exclude `waitUntilTableExists`
in v1 and v2 - "wrapping it would nest two retry policies" - which was retired
for a different reason, not because the principle stopped being true. Decide
one: either the `DescribeTimeToLive` is a plain read used as the hook (not
separately retried), or it is retried and the hook contract explicitly covers
exhaustion.

## 6. [MEDIUM] The bounded `DescribeTable` poll has a ceiling nobody can compute, no stated exhaustion behaviour, and no disposition under the new reads rule

**Spec section:** "Use a bounded `DescribeTable` poll with a short interval
(~100ms) and an explicit ceiling well inside the caller's budget."

**Evidence.** `dynamoAdmin.ts` has no knowledge of its caller's budget. Its
callers range from `app/test/importApply.integration.test.ts:77` and
`groupConvert.integration.test.ts:124` (60s hooks, calling `ensureTable` in a
LOOP over specs, so the per-call share is 60s/N) to
`seedProfile.integration.test.ts:71` (120s) to
`app/test/globalSetup.ts:117` via `createAllTables`, which runs ~23 tables under
no vitest budget at all. "Well inside the caller's budget" is not a value a
library function can derive.

Three further gaps: the spec does not say what happens on ceiling exhaustion
(throw what? a new error shape in ~40 suites); it does not say whether the poll
tolerates an `InternalFailure` on its own `DescribeTable`; and the new
disposition rule ("READS are NOT covered on their own", with a single stated
exception for `DescribeTimeToLive`) does not classify this poll, which is a
third case - a read that COMPLETES a mutation rather than guarding one.

**What it implies.** An unprotected poll re-introduces the failure at the site of
the fix; a fail-CLOSED poll (rethrow on a read error) turns a hiccup into a hard
red; the safe reading is "a failed `DescribeTable` is just another tick inside
the bounded loop, and exhaustion throws a named error", but that directly
contradicts the fail-closed section unless the spec says the two rules apply to
different things. Give the ceiling a number (a few seconds is ample against
DynamoDB Local, which reports tables ACTIVE essentially immediately) and state
the exhaustion behaviour.

## 7. [MEDIUM] The QUIET fallback permits a systematically biased comparison to close the anchor

**Spec section:** Item 1D - "If the post-fix arm can only be run QUIET, say so
plainly and report the comparison as baseline-contended vs post-fix-quiet -
clearly labelled as the weaker comparison it is."

**Evidence.** The same section states the durable signal: "**Wall clock and
failing FILE names are the durable signals; pass/fail on one run is not.**" And
Deliverable 2: "The anchor closes only if its measurements support it."

**What it implies.** Baseline-contended versus post-fix-quiet is not "weaker" on
the wall-clock axis; it is **biased in the direction of the fix, by an amount the
anchor itself measures as up to ~5x** (`npm-test-dynamodb-local-contention.md:293-301`).
A quiet post-fix arm will look dramatically better than a contended baseline no
matter what the fix does - including if it does nothing. Labelling it does not
make it admissible, and the spec's rule for reading results points the builder
straight at the wall clock.

The fallback needs a use restriction, not just a label: a QUIET post-fix arm may
support "no NEW failing files", and may not be used for any wall-clock claim or
to close the anchor. Say that, or the honest fallback is "report the baseline,
report that the post-fix arm could not be run contended, and leave the anchor
open".

## 8. [MEDIUM] Baseline-first ordering does not protect the baseline, and the fallback covers only the other arm

**Spec section:** Item 1D - "**Ordering is fixed: baseline FIRST**, while the
neighbouring missions are still live, because that is the only arm whose value
depends on the contention being real", preceded by step 1: "`npm install` in
this worktree BEFORE the baseline, plus one discarded warm-up run".

**Evidence.** The baseline is gated behind a cold `npm install` for a
five-workspace monorepo plus a discarded warm-up full run, then three full root
`npm test` runs. Using the anchor's own contended figures that is comfortably
over an hour before the third baseline run finishes.

**What it implies.** The premise "while the neighbouring missions are still
live" is an assumption, not something the ordering enforces, and the QUIET rule
applies to every run - so the baseline's own later runs can be labelled QUIET.
The fallback paragraph only contemplates the POST-FIX arm going quiet. If runs 2
and 3 of the baseline are QUIET the protocol has no stated answer, and the arm
that "is the only one whose value depends on the contention being real" is the
one that fails. State what to do: either accept a mixed-label baseline and
report per-run labels (which the snapshot rule already collects), or reduce the
baseline to whatever can be run inside the contended window and say how many
that was.

## 9. [LOW] The fixture has no positive control that `express.static` is serving anything

**Spec section:** Item 3(a), "Fixture contents are specified" - `HousingChoice`
and `<div id="root">`.

**Evidence.** Given finding 1, every traversal probe returns 200 + the SPA shell
via the fallback, not via `express.static`. The reserved-namespace, hardening-header
and CSP assertions are all satisfied by middleware mounted at
`app/src/app.ts:280-285`, above the static mount. The only request that
exercises `express.static` is `GET /`, and that is its directory-index path
(`index: 'index.html'` default), not its file path.

**What it implies.** A fixture whose `distDir` is mis-pointed - the single most
likely fixture defect - produces: `GET /` 500s (caught), and everything else
identical to a correct fixture. Once `GET /` is fixed, no assertion in the file
distinguishes a working static mount from a dead one. One extra file in the
fixture plus one request for it (`GET /probe.txt` returns its contents) closes
that, and it is the positive control the traversal cases lack.

## 10. [LOW] Three loose ends in the new material

- **`docs/issues/<slug>.md` is a literal placeholder** in the shipped SKIP
  message (spec line 478). Deliverable 3 creates the issue, so the slug will
  exist - but a `<slug>` shipping verbatim into a user-facing message is a
  classic, and the spec should say the message carries the real slug.
- **The Risks bullet undercounts the inertness proof.** "acceptance cases 5 and
  6 are the only things proving the gate is not inert" - case 7 (`[::1]` and
  `127.0.0.1` treated as local) is the POSITIVE half of that proof, and it is
  the half that catches the v2 defect it was added for. Cases 5/6 alone are
  satisfied by a gate that is inert in both directions.
- **Case 8 pins the wrong half of the `db-update-gsis` refactor.** It proves
  `ensureGsis` still retries. Nothing proves it still fails OPEN - see finding 2.

---

## Adjudication implementation check

I was asked whether any accept satisfied the letter and missed the point. One
did, and one is half-applied.

- **R2 #16 (decoy depth) - letter satisfied, point missed.** The accept moved
  from "one decoy, one level up" to "a decoy at each depth the probes actually
  reach, verified readable from disk". That is a better answer to the question I
  asked, and the question was the wrong one: the reachable set is empty and the
  readability check cannot see that. Finding 1.
- **R2 #7 (the 20s waiter) - half-applied.** The accept removed
  `waitUntilTableExists` from the create path and replaced it with a bounded
  poll. `waitUntilTableNotExists` on the delete path carries the identical
  schedule, is made more likely by this mission's own `DeleteTable` fix, and is
  invisible to the new enumeration command. Findings 3 and 4.

Everything else is implemented in substance, not just in form. In particular
#1's inversion, #11 (case 8), #13 (real exception instances), #5 (the filed
coverage gap plus the loop-proof SKIP message), #14 (no pre-committed
`buildProgram` remedy) and #6 (the eager `:97` checker call named as the real
cut) all say what the findings meant rather than what they literally asked for.
Deliverables 3 and 4 correctly turn two "recorded in a review" claims into
things that change files.

## Is this round terminal?

No. Finding 1 removes the justification for a mandated piece of fixture work and
should change what item 3(a) asserts; finding 2 changes the hook contract's
placement and adds a constraint the spec does not currently carry; finding 3
extends an already-accepted fix to a path the spec's own enumeration cannot see.
Findings 5, 6, 7 and 8 each leave a builder with a decision the spec was meant
to have made.

If the next revision resolves 1, 2, 3, 6 and 7, I would expect a round 4 to be
terminal - the remaining items are prose and scope statements rather than
mechanisms.
