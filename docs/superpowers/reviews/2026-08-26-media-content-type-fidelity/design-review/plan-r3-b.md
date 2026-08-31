# Plan review R3-B - delta only

Delta: `8b047888` (272+/100-) on `docs/superpowers/plans/2026-08-26-media-content-type-fidelity.md`.
Scope: the delta, three questions. No re-sweep.

---

## Q1. Did any fix break something that worked? NO.

I re-traced every case the coordinator named plus every neighbouring assertion
the two behaviour changes could reach. All pass.

### `buildMediaFilenameParts` - independent ascii / utf8 decisions

New logic: `ascii` falls back on `isUnusableStem(asciiStem)`;
`utf8Usable = stem.length > 0 && !SYNTHESIZED.test(stem) && stem !== asciiStem`.

| Case | ascii | utf8 | Asserted | OK |
|---|---|---|---|---|
| `<4f60><597d>`, XLSX | `asciiStem='__'` -> `/^[_\s]+$/` -> `attachment-1.xlsx` | stem non-empty, not SYNTHESIZED, `!== '__'` -> `<4f60><597d>.xlsx` | new test, exact | yes |
| same, via `buildMediaFilename` | `.ascii` only | - | old test `attachment-1.xlsx` | yes, unchanged |
| `attachment-0`, XLSX | SYNTHESIZED -> `attachment-1.xlsx` | **blocked by `!SYNTHESIZED.test(stem)`** | old test | yes - that clause is load-bearing and present |
| `undefined` / `.env` / `///` / `'   '` | empty stem -> `attachment-N.ext` | `stem.length > 0` false | old tests | yes |
| `budget.xlsx`, XLSX (plain ASCII) | `budget.xlsx` | `stem === asciiStem` -> **no utf8 key** | `toEqual({ascii, utf8: undefined})` - vitest `toEqual` ignores undefined props | yes |
| `bud<e9>get`, XLSX | `bud_get.xlsx` | `bud<e9>get.xlsx` | Parts test, exact | yes |

I also hunted the reverse direction - a case where the old code emitted no
`utf8` and the new one emits a harmful one. The only new emissions are when
`asciiStem` is unusable but `stem` is not, which is exactly the intended fix. A
stem carrying a raw C0 control character (`\x01`, `\x7f` - `sanitizeName` only
maps `\r\n\t\0`) now reaches `utf8`, but `encodeURIComponent` percent-encodes it,
so nothing escapes the header. `contentDispositionHeader`'s
`name.utf8 === name.ascii` branch is now unreachable, which is harmless.

### `trimEnd` - whitespace as well as dots, before and after the cap

`const trimEnd = (s) => s.replace(/[\s.]+$/, '')`, applied as
`trimEnd(trimEnd(stem).slice(0, MAX_STEM))`.

- Cannot eat something it should keep: it only strips from the END, and only
  whitespace/dots. `data.tar` (ends `r`), `a b` (ends `b`), `he said hi`,
  `etcpasswd`, `CUsersxsecret` - all untouched. A stem consisting *entirely* of
  whitespace/dots has nothing worth keeping.
- New test `'report .txt' -> 'report.mp4'`: split gives stem `report `, inner
  `trimEnd` -> `report`. Passes.
- **Cap arithmetic unchanged.** 120 a's + `.xlsx`: inner trim is a no-op (ends
  `a`), `slice(0,100)` -> 100 a's, outer trim no-op -> `${'a'.repeat(100)}.xlsx`.
  Exactly as asserted.
- Cap-exposed-dot test: stem = 99 a's + `.` + 10 c's (110), inner trim no-op,
  `slice(0,100)` -> 99 a's + `.`, outer trim strips it -> `${'a'.repeat(99)}.mp4`.
  Exactly as asserted. The inner trim moving from dots-only to dots+whitespace
  can only ever preserve MORE real characters before the cap, never fewer.

### `rfc5987` try/catch

Return type widened to `string | undefined`; the caller checks
`if (encoded === undefined) return base;`. Correct.

New test: `x\uD800y` -> `sanitizeName` leaves it (a lone surrogate matches none
of its classes), stem `x\uD800y`, `asciiStem` `x_y` (usable), `utf8`
`x\uD800y.mp4`; `encodeURIComponent` throws `URIError`, caught, header degrades
to `attachment; filename="x_y.mp4"`. Exactly as asserted, and it is built with
`String.fromCharCode` per the ASCII rule.

### 429 rethrow test and the positional `S3MediaStore`

- `'rethrows anything that is not a 404'` throws `{status: 429}`; the adapter's
  guard is `status === 404 || code === 20404`, neither matches, so it rethrows.
  Passes. (But see finding 5 on the `code` shape.)
- `new S3MediaStore('b', client as unknown as S3Client)` matches
  `constructor(private readonly bucket: string, private readonly client: S3Client)`
  (`app/src/adapters/mediaStore.ts:138-142`). Correct.
- `driverWith(client)` / `callableClient(fetchImpl)` are local to the new
  describe and no longer touch the zero-arg `makeDriver` at
  `app/test/messaging.test.ts:293`. Correct. The constructor arg list matches
  `:294-302` minus `logger`, which is optional
  (`TwilioMessagingDriverDeps.logger?`, `messaging.ts:555`).
- `setContentType` is now a properly annotated class method on `this.*`.
  Correct.

---

## Q2. Are the two new mechanisms sound?

**429 detection: the shape is right, two gaps.** Four attempts with three sleeps
(1s/2s/4s), catch-at-the-call-site because the adapter rethrows non-404s, other
errors propagate. That is all correct and it closes the "counter with no
detection" gap. Gaps are findings 4 (no test seam) and 5 (numeric-only `code`).

**Misconfiguration guard: right problem, wrong predicate, ambiguous placement.**
See findings 2 and 3. Direct answers to the three questions asked:

- *Is `recovered` empty the right predicate?* No. It is a statistical proxy for a
  condition that is directly observable before any vendor call.
- *Can it false-positive on a tiny or fully-aged-out dataset?* Yes, and worse -
  it false-positives on the steady state the spec designs for. Detail in 3.
- *Does exiting non-zero on a dry run cause a problem?* Yes, in combination with
  the above: the RUNBOOK sequence is "`--dry-run` -> read the histogram -> apply",
  and the guard converts "the histogram is all-skips, so there is nothing to
  apply" - a legitimate, informative result - into a failed command. Repeatedly,
  which is how an operator learns to ignore an exit code.

---

## Findings

### 1. [HIGH] Task 3 Step 5's grep returns FOUR hits; the plan says three, and the fourth is a route this change does not touch

The fix for my R2 finding 8 replaced stale line numbers with:

```
grep -rn "content-disposition'\]).toBeUndefined" app/test
```

> That returns one hit in `app/test/mmsMedia.test.ts` and two in
> `app/test/apiRoutes.test.ts`. ... Change **each** from absent to: ...

I ran it. It returns **four**:

```
app/test/apiRoutes.test.ts:648
app/test/apiRoutes.test.ts:661
app/test/mmsMedia.test.ts:229
app/test/unitMediaServe.test.ts:77
```

`unitMediaServe.test.ts:77` covers `GET /unit-media/...`
(`app/src/routes/unitMediaServe.ts:63`), a **different route with its own
inline/octet-stream branch** that this change does not modify. Spec 12 lists
`routes/unitMediaServe.ts:65` as "noted, not fixed here". A builder told to
change "each" hit turns a passing test for an untouched route red, and the
natural repair - making it match `/^inline; filename="/` - would then be a
permanently failing assertion, because that route still sends no disposition.

The plan does name the two files, so a careful builder narrows it. But the fix
swapped a stale line number for a grep whose stated output does not match its
actual output, in the one step whose entire job is "find these three by content".

**Fix:** add `--include` scoping or name the two tests -
`'serves an image attachment INLINE (no attachment disposition)'` and
`'serves a PDF attachment INLINE (application/pdf, no attachment disposition)'` -
and say explicitly that the `unitMediaServe` hit is a different route and must
NOT be touched.

### 2. [MEDIUM] The misconfiguration guard is specified inside the module, where it breaks two of Task 6's own tests

Item **9b** sits in the numbered "Create `app/scripts/backfill-media-content-types.ts`.
Structure, in order" list, between item 9 (the worker pool) and item 10 (the CLI
wrapper), and says "log an ERROR and **exit non-zero**". Exiting can only happen
in the CLI wrapper or by throwing, so the placement reads as "in the function"
while the action reads as "in the wrapper".

If it lands in `backfillMediaContentTypes`, two tests from the same task's Step 1
break, because both produce `vendorCalls === 1` with an empty `recovered`:

- `'skips an attachment whose media Twilio no longer has'` (`contentType: null`
  -> the adapter resolves `undefined`), and
- `'never writes a type the runtime would refuse'` (`contentType: 'text/html'`
  -> normalizes to opaque, so item 7 never touches the histogram).

Both assert a returned `result` object. Neither Step 2 nor Step 4 predicts a red
here, so the builder meets it as a surprise in a step whose expected outcome is
PASS.

**Fix:** state that the guard lives in the CLI wrapper, reading the returned
`BackfillResult`, so the exported function stays a pure reporter.

### 3. [MEDIUM] `recovered`-is-empty false-positives on the exact population spec 6.6 accepts forever

Spec 6.6's IDEMPOTENCY section, third bullet:

> A row carrying a permanently unrepairable attachment: re-selected and
> re-queried EVERY run, because the predicate is row-granular. That is the cost
> of not writing a "tried and failed" marker; it is bounded and visible in the
> skip counts, and **it is accepted deliberately rather than overlooked**.

So the designed steady state after a successful campaign is: every candidate is
repaired and stops being selected, except the unrepairable ones, which are
re-queried on every run and recover nothing. That is `vendorCalls > 0` with
`recovered` empty - the guard's exact trigger. The script's normal end state
becomes a permanent ERROR and a non-zero exit.

Two further false positives:

- **No floor on `vendorCalls`.** One aged-out attachment is enough. Spec 11 risk
  1 names total retention loss as an anticipated outcome the dry-run histogram
  exists to measure, and the guard refuses to let that measurement stand.
- **An all-opaque recovery.** If every recovered type normalizes to opaque
  (`skippedStillOpaque`), `recovered` is empty even though every lookup
  succeeded - a working client reported as misconfigured.

The condition the guard actually wants - "this adapter cannot read media at all"
- is observable **before the scan and with zero false positives**, which was one
of the two options in my R2 finding 12: have the CLI wrapper probe the adapter
once (or assert it is a real Twilio driver) and refuse to start. The plan took
the statistical proxy instead and inherited three false-positive modes.

If the proxy is kept anyway, it needs at minimum
`recovered` empty **AND** `skippedTwilio404 === vendorCalls` **AND** a
`vendorCalls` floor, plus an explicit carve-out for the spec 6.6 steady state.

### 4. [MEDIUM] The 429 mechanism has no test seam - the harness cannot express either case it demands

Item 9's "TEST IT" asks for a fake that throws `{status: 429}` twice then
resolves, one that always throttles, and an injected sleep. None of the three is
possible against the plan's own harness:

- `run()`'s option bag is `{ rows, contentType?, dryRun?, annotateFails? }` and
  `getMediaContentType` is `vi.fn().mockResolvedValue(...)` - it can never
  reject. (Plan Task 6 Step 1.)
- `backfillMediaContentTypes({ doc, adapter, mediaStore, messagesRepo, dryRun })`
  has **no `sleep` parameter**, and `sleep` appears nowhere else in the plan
  except Task 1's mirror tests. Without it the "always throttles" test really
  does wait 7 seconds per attachment.
- The two tests are described in prose inside the **implementation** step, not
  added to Step 1's test block, so the TDD red state does not cover the
  mechanism at all.

**Fix:** add `sleep?: (ms: number) => Promise<void>` to the function's options,
add `throttleTimes?: number` to `run()`, and move the two cases into Step 1.

### 5. [MEDIUM] `code === 20429` / `code === 20404` compare numerically; the repo normalizes Twilio's `code` because it is a number OR a string

Task 5: `const e = err as { status?: number; code?: number }; if (e.status === 404 || e.code === 20404)`.
Task 6 item 9: `const s = (err as {status?: number; code?: number}); if (s.status === 429 || s.code === 20429)`.

The repo already wrote the normalizer, and its body is the evidence for why
(`app/src/adapters/groupConversations.ts:322-329`):

```ts
function twilioErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'number') return String(code);
  if (typeof code === 'string' && code.length > 0) return code;
  ...
```

It handles both shapes and compares as a string (`=== '20404'`, `:591,611,644`).
A strict `=== 20429` against a string `'20429'` is false. The `status` half saves
the common case, but if it ever does not, item 9's own rule - "Any other thrown
error propagates - an auth failure must stop the run" - **aborts a production ops
run on a transient rate limit**. The plan's justification for adding the `code`
check is "the repo has already been bitten by assuming one shape"; it then
assumes one shape.

**Fix:** compare `String(code) === '20429'` / `'20404'`, or lift
`twilioErrorCode`/`twilioStatus` out of `groupConversations.ts` (they are
module-private today) - though lifting is a wider change than this branch needs.

### 6. [MEDIUM] Task 6 assigns a `createMediaStore` change to Task 5, and Task 5 says nothing about it

The credentials fix (plan `:2033-2041`) now correctly rejects the script-side
`client` seam on adapter-rule grounds and says:

> Add an optional `credentials` passthrough to `createMediaStore` in **Task 5**
> (it is already editing that file) and forward it to the `S3Client` it
> constructs.

Task 5 has not been updated. Its Files block, its Interfaces "Produces" list and
all six of its Steps mention only `setContentType` and `getMediaContentType`;
"credentials" appears nowhere in Task 5. The plan's header mandates
task-by-task execution, so a builder finishes and **commits** Task 5, then meets
the requirement in Task 6 and has to reopen a committed adapter file.

Verified the change itself is sound and small: `CreateMediaStoreDeps`
(`app/src/adapters/mediaStore.ts:281-285`) would gain
`credentials?: AwsCredentialIdentityProvider`, forwarded through
`buildS3Client(config, caller)` (`:317-332`) into the `S3Client` options; and
`hcCredentials(): AwsCredentialIdentityProvider`
(`scripts/lib/hcAws.d.mts`) is exactly that type. Just put it in Task 5.

### 7. [LOW] Task 5's Files block and `git add` line still name the file Step 1 replaced

Step 1 now says **create** `app/test/mediaStore.setContentType.test.ts` and to
add a describe block to `app/test/messaging.test.ts`. But:

- Files still reads "Test: `app/test/mediaStore.test.ts`, and whichever
  messaging-adapter test file the repo already has (find it with
  `ls app/test | grep -i messaging`)";
- Step 6 still reads
  `git add ... app/test/mediaStore.test.ts <each-touched-test-file>` (plan
  `:1667`), which stages an unmodified file and does not name either file the
  task actually creates or edits.

### 8. [LOW] "Add FOUR symbols" includes one that is already imported

The corrected instruction names `resolveMediaTier`, `isAcceptedExtension`,
`DECLARABLE_MEDIA_TYPES` and `INLINE_MEDIA_TYPES`. `INLINE_MEDIA_TYPES` is
already in that import (`app/test/mediaTypes.test.ts:4-8`, used at `:12`), so a
literal reading produces a duplicate specifier. It is three symbols, one of
which is already there.

### 9. [LOW] Task 4's new `isDeclarableMediaType` test repeats the missing-import omission

The delta adds `it('isDeclarableMediaType agrees with it - one map, two views')`
to `media.test.ts`, but Task 4 Step 1 still carries no import instruction, and
`media.test.ts:2` imports only
`{ messageMediaSrc, messageSid, toCommsMediaItem }`. Three symbols are now used
without being imported (`isInlineRenderable`, `mediaKindWord`,
`isDeclarableMediaType`). Same class as my R2 finding 1, which was fixed in Task
2 and not in Task 4.

### 10. [LOW] `20429` is UNVERIFIED from this repo

Nothing in the repo references `20429`; the only Twilio numeric codes present are
`20404`, `50353` and `12300`. It is consistent with Twilio's 20xxx family and I
believe it is correct, but I could not confirm it from the codebase and did not
have a source to check. Flagging so it is not treated as verified.

---

## Verdict

**No fix broke anything - all 25-plus affected assertions still hold, including
both behaviour changes, the cap arithmetic and the surrogate degrade.** Finding
1 is the one thing in the delta that is actively wrong (a grep whose real output
does not match the count the plan states, pointing at a route this change must
not touch); findings 2-5 are the two brand-new mechanisms needing a correct
predicate, an unambiguous home, a test seam and a string-tolerant code check.
Everything else is small. Still buildable.
