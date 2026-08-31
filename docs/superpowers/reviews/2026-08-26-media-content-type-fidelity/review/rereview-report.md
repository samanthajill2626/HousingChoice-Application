# Re-review - feat/media-content-type-fidelity @b31281a1 (fix wave 8842bdfb..HEAD)

Read-only. No source edits, no suites run. Method: read the fix diff line by
line against the live tree; then deliberately swept the state the first pass
covered lightly (the e2e spec, the fake-twilio signer/registry, the dashboard's
accessible names, the adapter error paths, the Scan/worker interaction, and the
CLI's whole config surface against the RUNBOOK as now shipped); then re-derived
each claimed fix and asked whether the named finding actually dies. Confirmed
independently that the supplied fix diff equals `git diff 8842bdfb..b31281a1`
(13 files, nothing omitted) and that the branch's entire added-line set is
ASCII-clean (0 non-ASCII added lines outside `docs/superpowers/`).

**Verdict.** The three code fixes (M1 abort, P1 re-read/merge, N1-N3 filename
hardening) are real, correctly placed, and non-vacuously tested - I could not
break any of them. But the wave was audited against the previous reviewers'
questions rather than against the branch's untouched surface, and that is where
the four biggest defects live: **the new e2e cannot detect the exact regression
it was written to catch (NF1), cannot detect a missing fixture (NF2), the
RUNBOOK's env list omits two variables `loadConfig` hard-requires - one of which
the wave's own new refusal made mandatory (NF3) - and the RUNBOOK's stated
justification for the M1 guard is factually false for this deployment, which
also makes the guard inert (NF4).** I challenge two adjudications.

---

## 1. What the first pass missed

### NF1 (must-fix) - the new e2e's headline claim is untestable as written: `getByRole('link')` matches the `<img>` branch too

`e2e/tests/dashboard-next/inbound-media-type.spec.ts:63-73` claims:

> (a) A LINK carrying the kind word, **never an `<img>`**

and proves it with

```
const link = timeline.getByRole('link', { name: /Contact card - Attachment 1/i }).first();
```

Both branches of `AttachmentGallery` render an `<a>` with the SAME accessible
name:

- inline branch, `dashboard/src/routes/contact/Timeline.tsx:648-664` - the `<a>`
  wraps `<img alt={attachmentLabel(att.filename, att.contentType, false, i)}>`.
  For `text/vcard` that alt is literally `Contact card - Attachment 1`, and a
  link's accessible name is computed from its contents.
- file branch, `Timeline.tsx:669-676` - text content
  `<clip glyph> Contact card - Attachment 1`.

**Walk.** Add `text/vcard` to `INLINE_RENDERABLE_TYPES`
(`dashboard/src/routes/contact/media.ts:69`), or otherwise widen
`isInlineRenderable` (`:102`). Every vCard now renders as a broken `<img>`. Part
(a) still matches the `<a>` by name. Part (b) is unaffected - Content-Type and
disposition come from `resolveMediaTier` on the server
(`app/src/routes/api.ts:2296-2302`), independent of the dashboard's branch. The
spec goes GREEN on precisely the broken-`<img>` regression this whole feature
exists to fix.

The branch's own unit test knows this:
`dashboard/src/routes/contact/Timeline.test.tsx:582-587` asserts BOTH
`queryByRole('img', ...)` ABSENT and `getByRole('link', ...)` present. The e2e
dropped the negative half - the only half that discriminates.

Fix: one line after `:73` - `await expect(link.locator('img')).toHaveCount(0);`

### NF2 (must-fix) - a missing canned fixture returns HTTP 200 (the SPA shell), and the spec still passes

`fake-twilio/src/server.ts:248-259`: the SPA fallback's reserved list is
`['/control','/health','/2010-04-01','/webhooks','/recordings','/v1','/v2']`.
`/canned/...` is NOT reserved, so a GET that `express.static` misses falls
through to `res.sendFile(index.html)` - **200, `text/html`, the SPA shell** -
never a 404.

The mirror types the stored object from the WEBHOOK PARAM, never the fetched
response: `app/src/services/mediaMirror.ts:109` normalizes `target.contentType`,
fed from `params['MediaContentType0']`
(`app/src/routes/webhooks/twilio.ts:486-490`), which the fake derives from the
URL's extension (`fake-twilio/src/engine/signer.ts:42`). The signer's own new
comment says it outright: "the app reads THIS param, never that header."

So if `contact-card.vcf` is absent from the built dist, HTML bytes land in S3
tagged `text/vcard` and BOTH e2e assertions (`:85` content-type, `:88`
disposition) pass unchanged.

**Reachable, not hypothetical.** `scripts/e2e-session.mjs` builds the fake UI
only in `main()` (`:461/:696`); `restartBackend()` (`:570`) reuses the existing
dist by design (`:454-456`). A developer on a live `e2e:session` who adds or
edits a canned asset and runs `npm run e2e:restart` gets a dist without the
file, a 200 index.html, and a green spec.

Not a live vulnerability - the serve route still emits nosniff +
`default-src 'none'; sandbox` + `attachment` - but it is a fidelity hole in the
one spec whose job is to prove end-to-end fidelity. Fix: the body is 78 bytes -
`expect(await res.text()).toContain('BEGIN:VCARD');` after `:88`, which also
upgrades the spec into a real round trip.

### NF3 (must-fix) - the RUNBOOK env list omits two variables `loadConfig` HARD-REQUIRES, and the wave's own new refusal is what makes the second one mandatory

`RUNBOOK.md:277` lists five Twilio variables under the promise at `:274`
("The script refuses to scan and exits 1 rather than run half-configured"), and
`HOW_TO_FIX` (`app/scripts/backfill-media-content-types.ts:593-594`) repeats the
same five. `loadConfig` requires more:

- `app/src/lib/config.ts:623-641`: the `MESSAGING_DRIVER=twilio` required set is
  **six** - the five listed PLUS `TWILIO_CONVERSATIONS_SERVICE_SID`, required
  since the account's default Conversations service was deleted on 2026-08-15.
  Throw at `:642-647`.
- `app/src/lib/config.ts:658-666`: `TWILIO_EVENTS_WEBHOOK_SECRET` is required on
  every REAL twilio config, and **the only exemption is `isMockTwilio`, i.e.
  `TWILIO_API_BASE_URL` being set** - which this wave now REFUSES
  (`:587-589`). The two requirements are mutually pinned: after this wave, every
  shell that can pass `messagingMisconfiguration` must carry the events secret.

**Walk.** The operator follows `RUNBOOK.md:274-280` literally: exports the five
Twilio vars, `MEDIA_BUCKET`, `TABLE_PREFIX`; unsets `TWILIO_API_BASE_URL` as
`:278` instructs; runs the dry run. `loadConfig()` throws at
`backfill-media-content-types.ts:601`; the log reads
`config REJECTED, nothing scanned. <HOW_TO_FIX>` - and `HOW_TO_FIX` repeats the
same incomplete list. The vendor error names the missing key but directs them to
`npm run secrets:push`, an infra action `RUNBOOK.md:264` explicitly says is NOT
owed here.

The omission's origin is visible in the code: the docblock at
`backfill-media-content-types.ts:558-559` cites `lib/config.ts:623-629` for the
credential fail-fast; line 629 is `TWILIO_MESSAGING_SERVICE_SID`. The citation
stops one line short of the conversations SID (`:641`) and 30 lines short of the
events secret (`:659`).

Fix all three: `RUNBOOK.md:277`, `HOW_TO_FIX` (`:593-594`), and the anchor at
`:558-559`.

### NF4 (must-fix) - the wave wrote a FALSE fact into the RUNBOOK, and the guard it justifies is inert here

`RUNBOOK.md:277` (pre-existing, but now load-bearing for the new `:278` bullet):

> for the account that RECEIVED the media. **Dev and prod are different
> accounts**, and the wrong one 404s on everything, which reads as retention
> loss.

Dev and prod share **ONE Twilio account**. Two independent sources:

- `docs/superpowers/specs/2026-08-06-business-number-config-design.md:18-20` -
  after the port, "the 404 number serves DEV and the ported 678 number serves
  PROD, under **SEPARATE Messaging Services and SEPARATE A2P campaigns**":
  services and campaigns per env, not accounts.
- The project memory topic `twilio-shared-account-services` records the
  2026-08-15 verification against prod SSM: prod carries dev's account SID and
  that is EXPECTED. `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are the
  account-scoped values that are the SAME in both environments;
  `TWILIO_MESSAGING_SERVICE_SID` and `BUSINESS_PHONE_NUMBER` are what differ.

Three consequences:

1. **M1's walk cannot happen.** Its step 4 ("every prod `ME...` media SID 404s
   on the dev account") is false when there is one account.
2. **The shipped guard is inert.** `expectedAccountSid` (`:449-456`) compares the
   stored URL's account against `config.twilioAccountSid`; both are the same SID
   in both environments, so the abort can never fire on a real ops run. It still
   catches a typo'd SID and future-proofs an account split, so it is not
   harmful - but it is not the environment guard the RUNBOOK now says it is.
3. **The wave reproduced the exact flaw M1 correctly diagnosed, one layer along.**
   M1's own step 3 says `assertHousingChoiceAccount` "proves the right *company*,
   never the right *environment*" because `scripts/lib/hcAws.mjs:14` pins one AWS
   account for dev AND prod. `expectedAccountSid` proves the right Twilio
   *account*, never the right *environment*, for exactly the same reason. Both
   guards now pass unconditionally in both environments.

**And the run emits no environment fingerprint at all.** The only identity
logged is `{ profile, account: identity.Account }` (`:626-629`) - identical in
dev and prod. `:647` logs `{ dryRun }`; the report at `:660-663` logs only
counters. Neither the resolved `table`, nor `config.mediaBucket`, nor
`config.appEnv` (which `resolveAppEnv` at `config.ts:499-507` already derives
from `TABLE_PREFIX`) appears anywhere. `RUNBOOK.md:266` says "take dev all the
way through before starting prod" - and a run that scanned dev twice is
indistinguishable in the logs from dev-then-prod, reporting `recovered: {}` and
the WARN, which `RUNBOOK.md:268` explicitly teaches is "the correct steady state
for an already-repaired environment". That is the M1-shaped green exit, and it
survives the fix.

Cheapest closes: (a) correct `RUNBOOK.md:277`; (b) add
`{ table, mediaBucket: config.mediaBucket, appEnv: config.appEnv }` to the
account-guard line and the done line.

### NF5 (plausible) - `TABLE_PREFIX` has no guard and silently defaults to a LOCAL prefix, under a RUNBOOK sentence promising a refusal

`config.ts:512-514` - `` `${env.TABLE_PREFIX ?? DEFAULT_TABLE_PREFIX}${base}` `` with
`DEFAULT_TABLE_PREFIX = 'hc-local-'` (`:488`). `RUNBOOK.md:279` lists
`TABLE_PREFIX` under `:274`'s "refuses to scan and exits 1 rather than run
half-configured". Nothing refuses it.

Unset: every guard passes, then `doc.send` scans `hc-local-messages` in account
938565869261 -> `ResourceNotFoundException`, surfaced through the generic
`main().catch` (`:684-687`) as "FAILED", with no `HOW_TO_FIX` and no mention of
`TABLE_PREFIX`. Loud, but neither the promised refusal nor a guided one. A
one-line refusal alongside the existing `MEDIA_BUCKET` check (`:639-643`) would
match the RUNBOOK's claim.

### NF6 (plausible) - `MEDIA_S3_ENDPOINT` is `TWILIO_API_BASE_URL`'s exact twin, and the wave refused one and not the other

Same shape, same carrier, same prod-only fail-close - and it redirects the only
call that mutates production data:

| | `TWILIO_API_BASE_URL` | `MEDIA_S3_ENDPOINT` |
|---|---|---|
| prod-only rejection | `config.ts:543-546` | `config.ts:576-583` ("same posture as TWILIO_API_BASE_URL") |
| set by the dev/e2e harness | `scripts/e2e-session.mjs`, `scripts/dev.mjs` | `scripts/e2e-session.mjs:130`, `scripts/dev.mjs:162` |
| refused by the backfill | YES (`:587-589`) | NO |
| in the RUNBOOK env list | YES (`:278`) | NO |

The script hand-builds its DynamoDB client precisely so it cannot pick up
ambient config (`:619-637`; `DYNAMODB_ENDPOINT` is therefore correctly ignored),
then reaches for `createMediaStore({ config, credentials })`, which routes
through `buildS3Client` (`app/src/adapters/mediaStore.ts:374-397`) and DOES
honour `mediaS3Endpoint` whenever `NODE_ENV !== 'production'` - which the
script's own docblock argues an operator `tsx` shell is not. The explicit
`credentials` are then spread LAST (`:395`), so real HousingChoice credentials
get pointed at local MinIO.

Outcome is LOUD, not silent (`CopyObject` -> `NoSuchBucket`/`InvalidAccessKeyId`/
`ECONNREFUSED`, propagates by design at `:341-346`, aborts before the first row
write) - hence plausible, not must-fix. The point is the asymmetry: adversarial
M1's secondary explicitly named "arms the `mediaS3Endpoint` fail-closed at
`mediaStore.ts:377-379`" as a reason to set `NODE_ENV=production`; the wave took
the narrower refusal route for the Twilio variable and silently dropped the
protection M1 had flagged. One more line in `messagingMisconfiguration` closes
it. (Related, unpinned: `AWS_ENDPOINT_URL` / `AWS_ENDPOINT_URL_S3` /
`AWS_ENDPOINT_URL_DYNAMODB`, which the v3 SDK honours from the environment -
though those would also redirect STS, so `assertHousingChoiceAccount` catches
them.)

### NF7 (plausible) - the BiDi/reserved-name sanitizing is one-sided: the spoof is still live in the label the operator actually reads

The wave closed the RLO extension spoof in `Content-Disposition`
(`app/src/lib/mediaFilename.ts:66`). It did not close it in the dashboard.

1. `app/src/services/inboundEmail.ts:683-686` persists the sender-supplied MIME
   `filename` VERBATIM onto `media_attachments` - byte-capped
   (`truncateToBytes`), never character-sanitized.
2. `dashboard/src/api/types.ts:2116` surfaces it raw.
3. `dashboard/src/routes/contact/Timeline.tsx:611-625` `attachmentLabel` returns
   it verbatim as the link's visible text (and as the `<img alt>` inline).

**Walk.** An attacker emails the intake address a part with
`Content-Type: text/csv` and `filename="invoice<U+202E>fdp.csv"`. The operator
sees `invoicevsc.pdf` in the timeline - which is where they decide whether to
click. Clicking downloads `invoice_fdp.csv` (clean, thanks to this wave). The
two surfaces now DISAGREE, which is arguably worse than both being wrong.

The wave's own rationale ("a CSV wearing a PDF's face",
`mediaFilename.ts:58-65`) applies more directly to the UI label than to the
header. Fix: strip the same class in `attachmentLabel`, or sanitize once at
persist time.

### NF8 (plausible) - one foreign-account row wedges the whole backfill permanently, with no counter and no opt-out

`:449-456` throws on the FIRST mismatch, with no `--allow-foreign-account`, no
skip counter, and - per NF9 - the counters for everything already repaired in
that run are discarded. Any row whose stored media URL names a different account
(a pre-migration account, anything the Quo/Airtable-era import left behind) makes
the remaining population unrepairable forever. The docstring's rationale ("the
same semantics as an auth failure") is right for a UNIFORM mismatch; for a MIXED
population an abort is the wrong shape. Consider aborting only when the first K
candidates are 100% mismatched, or keeping the throw plus a documented loud
opt-out.

### NF9 (plausible) - any propagated error discards the entire report, including the failure the RUNBOOK's IAM bullet is about

On any throw out of `backfillMediaContentTypes`, `main` never reaches the report
at `:660-663`, so the operator gets ZERO counters - no `recovered`, no
`written`, nothing about what already committed. This lands on `RUNBOOK.md:280`:
a `housingchoice` profile missing `s3:PutObject` aborts on the FIRST attachment,
and the dry run cannot pre-detect it because `dryRun` skips both write halves
(`:347`, `:474`). So "dry run first, read the report" gives no confidence about
the write half at all.

Second, `drain` (`:356-370`) is `Promise.all` over the workers: it rejects on
the first rejection but CANCELS NOTHING, so up to three other workers keep
pulling from `cursor` and completing `setContentType` after `main` has logged
FAILED and set `exitCode = 1`. Those extra mutations are idempotent and
re-runnable, so the damage is bounded - but "An S3 failure PROPAGATES and aborts
the run" (`:341-346`) is stronger than what happens. (No `unhandledRejection`
risk: `Promise.all` subscribes to every worker promise.)

Fix: wrap the call in try/finally that logs `result` before rethrowing, and one
RUNBOOK sentence saying the dry run exercises neither S3 nor DynamoDB writes.

### NF10 (plausible) - the adapter's 20404 test is strict where the branch's own 20429 test is string-tolerant

`app/src/adapters/messaging.ts:951-954`:

```ts
const e = err as { status?: number; code?: number };
if (e.status === 404 || e.code === 20404) return undefined;
throw err;
```

The branch's OWN `fetchMediaType` (`backfill-media-content-types.ts:299-311`)
does the opposite for the sibling code, citing the precedent:

> COMPARE THE CODE STRING-TOLERANTLY: Twilio delivers `code` as a number OR a
> string depending on the path, which is the whole reason
> adapters/groupConversations.ts:322-329 exists.

`app/src/adapters/groupConversations.ts:321-328` confirms the hazard is real
here (a dedicated `twilioErrorCode` accepting both shapes).

**Walk.** A retention-aged media resource errors with `code: '20404'` (string) on
a path that does not also set `status`. The strict compare fails, the adapter
rethrows, `fetchMediaType` classifies it as not-throttled and re-throws, `drain`
rejects, the whole ops run exits 1 (and per NF9 with no report) - on the one
condition the script built a counter for (`skippedTwilio404`, documented as a
steady state). `status === 404` covers the common `RestException` path, which is
why this is plausible rather than must-fix; the point is that the branch applied
a lesson to one code and not its sibling inside the same feature.

Same file, same class, two smaller ones: `messaging.ts:940` returns `undefined`
when `this.client.messages` is not a function with NO log - the same green-exit
signal (`undefined` == "aged out") the script's entire docblock is organised
around, and the one instance `messagingMisconfiguration` cannot see; and
`:942-943` maps a present-but-`null` `contentType` to `undefined`, so a media
resource Twilio still HOLDS is counted as retention loss.

### NF11 (plausible) - MediaGallery's accessible names got WORSE on this branch, and the fix is already imported next door

`dashboard/src/routes/contact/MediaGallery.tsx:47-59`: the non-renderable tile is
an `<a>` with no text, an `aria-hidden` glyph, and `title={m.contentType}`. Per
accname, `title` is the last-resort fallback, so the link's accessible name IS
the raw MIME string.

Before this branch (`git show 3c2962a4:dashboard/.../MediaGallery.tsx:36`) the
predicate was `startsWith('image/')`: every non-image was
`application/octet-stream` - one uniform string - and `image/heic` took the
`<img>` branch (`alt="Attachment"`). After the branch plus the backfill, a
screen reader announces `video/mp4`, `image/heic`, and the 80-character
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.

The dashboard already has `mediaKindWord` (`media.ts:108`) and uses it in the
Timeline; `MediaGallery.tsx:9` imports only `isInlineRenderable`. One line makes
the gallery say "Contact card" the way the timeline does.

### NF12 (plausible) - the new e2e's serial worst case exceeds its own budget

`e2e/playwright.config.ts:115` `DEFAULT_TEST_TIMEOUT_MS = 60_000`, `:135`
`expect.timeout: 15_000`, `:170` `navigationTimeout: 15_000`, `:143`
`retries: 0`, `:167` `trace: 'on-first-retry'`.

Serial path: `goto('/')` 15 + `expectTodayReady` 15 + `goto(contact)` 15 + the
explicit 30s attachment wait (`spec:72`) + a default API GET = **~105s against a
60s cap**, with the single 30s wait consuming half the budget. Idle p95 is ~14s
so it will not bite at rest, but the config is explicitly sized for 2-3x load,
and with `retries: 0` + `on-first-retry` a cap failure collects NO trace. Either
trim `:72` to ~15s (the SSE-driven refetch makes 30s generous - see section 5)
or add `test.slow()`.

---

## 2. Cold read of the fix diff

### Sound as written

- **Account-abort placement.** The throw at `:449-456` sits inside candidate
  assembly, after the `mediaSid`/`url`/`provider_sid` guard and before
  `drain()`, so within a page it genuinely precedes every vendor call, S3 copy
  and row write. A mismatch cannot slip past candidate assembly for any
  attachment that would have produced a vendor call: the only attachments that
  skip the check are ones already excluded (already repaired, unparseable key,
  no usable URL), plus URLs with no `/Accounts/<x>/` segment, which is
  documented. **It leaves no partial S3 write within a page.**
- **`parseAccountSid` is correct against real data.** `mediaUrls` stores Twilio's
  `MediaUrl{i}` verbatim (`app/src/routes/webhooks/twilio.ts:439-447`) -
  `https://api.twilio.com/2010-04-01/Accounts/<AccountSid>/Messages/<sid>/Media/<ME...>` -
  and the SDK client is built with `{ accountSid: deps.accountSid }`
  (`app/src/adapters/messaging.ts:606-614`), so `config.twilioAccountSid` really
  is the account segment the fetch would use. The loose `[^/]+` is the right
  call and its docblock says why.
- **`config.twilioApiBaseUrl !== undefined` is the right test**, not a truthiness
  test: `config.ts:1301` maps `''` to `undefined`, so `TWILIO_API_BASE_URL=`
  (this repo's "every var uncommented" env convention) cannot false-refuse. This
  was the likeliest false positive and it is handled.
- **The re-read reads the right shape.** `getByTsMsgId` returns the RAW item
  (`app/src/repos/messagesRepo.ts:2695-2700`, `return Item as MessageItem`), so
  `current.media_attachments` is the stored snake_case array. This is the one
  place the fix could have been silently inert in production while green in the
  suite (a mapped return would make `base` always `undefined` and write
  nothing). It is not.
- **Order preservation and the staged-position -> s3Key mapping are right.**
  `stagedByKey` is built from the SNAPSHOT (position -> s3Key) and applied to the
  RE-READ by key - the correct direction. `base.map(...)` never filters,
  reorders or appends, so `mediaPointerSk` positions and `/media/:idx` keep
  addressing the same bytes. Writing pointers from the merged (possibly longer)
  list is strictly better than before, and `mediaPointerItems`
  (`messagesRepo.ts:228-246`) is deterministic and idempotent - and it carries
  `content_type`, which is what makes the pointer rewrite load-bearing rather
  than redundant.
- **Undefined handling.** `current === undefined` -> `base` undefined ->
  `!Array.isArray` -> `continue` (no write, nothing counted). `applied === 0` ->
  `continue`. Both inside the try; both correct. A re-read whose array DIFFERS in
  order is handled correctly by construction, because the merge is key-based and
  the re-read's own order is the one written.
- **`isUnusableStem` / `RESERVED_DEVICE`.** `/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i`
  catches `con` lowercase (the `i` flag); catches `CON ` with a trailing space
  (`sanitizeName:68` collapses `\s+` and trims, then `trimEnd` at `:146-147`);
  and does NOT catch `console` or `COM10` (whole-stem anchor). Applied to BOTH
  decisions - ascii at `:160`, utf8 at `:166`.
- **The `utf8Usable` substitution is safe.** The new `/^[_\s]+$/` arm can only
  fire on a stem for which `stem !== asciiStem` is already false, because
  `sanitizeName:68` collapses every `\s` (including NBSP and the other non-ASCII
  spaces JS `\s` matches) to a plain ASCII space and trims. The fixwave report's
  justification ("can only match a pure-ASCII stem") reaches the right answer for
  the wrong reason - `\s` is not ASCII-only; the sanitizer is what makes it true.
- **`dropLoneHighSurrogate` is correct at every boundary.** Empty string ->
  `charCodeAt(-1)` is NaN -> both comparisons false -> returns `''`. A trailing
  LOW surrogate is correctly NOT dropped: the cap cannot manufacture one (a
  pair's low half is only reachable when its high half is inside the slice), so
  a trailing low surrogate implies hostile input, which the `rfc5987` catch
  already handles. A trailing complete PAIR is untouched (`last` is the low
  half). The drop runs BEFORE the outer `trimEnd`, so a dot or space it exposes
  is still stripped - the composition at `:147` is right.
- **BiDi strip placement.** `:66` sits after the Windows-character rule and
  BEFORE the `\.\.` removal, which matters: `.<U+202E>.` collapses to `..` and is
  then removed. Reversing the two would leak a `..`.
- **The drift-pin test cannot silently match nothing.** It is a real ESM import,
  not a `readFileSync` parse, so a moved or renamed module is an import error
  (red) and a renamed export makes `[...undefined]` throw. The "does not compare
  two empty sets" case is the vacuity floor. It RUNS in the gate: root
  `package.json:39` `"test": "npm run test --workspaces --if-present"`, dashboard
  `"test": "vitest run"`, `dashboard/vite.config.ts` includes
  `src/**/*.test.{ts,tsx}`. The imported app module is a genuine near-leaf
  (`mediaTypes.ts:22` -> `outboundMediaLimits.ts`, pure constants, no Node
  built-ins), so it loads cleanly under `environment: 'jsdom'`.
- **The upload-gate route test is non-vacuous.** `app/src/routes/mmsMedia.ts:78`
  is the ONLY producer of `400 unsupported_media_type` on that route, and the
  rate limiter is constructed per router, so a third `harness({})` call cannot
  trip it.
- **Anchors re-verified independently.** `mediaTypes.ts` DECLARABLE at 65-87
  (matches the new issue's `refs:`), `TWILIO_DELIVERABLE_MMS_TYPES` at 216-220
  inside 211-225, `planMmsMedia` at 240 inside 230-249, `api.ts:2252` is the
  media-serve route registration, `mediaFilename.ts:1-13` is the header docblock.
  All correct.

### Defects in the fix diff itself

- **(nit) "hard stop before the first write" is unqualified and false once the
  Scan pages.** `:653-655` and `RUNBOOK.md:278`. The throw is inside per-page
  candidate assembly within the `do {...} while (exclusiveStartKey !== undefined)`
  loop (`:373-536`); page N's S3 copies and row writes commit at `:471-533`
  before page N+1 is fetched. The `ScanCommand` (`:375-383`) carries no `Limit`
  and DynamoDB's 1 MB cap applies BEFORE the FilterExpression, so multi-page is
  the expected shape on a real environment. Calibration: for a UNIFORMLY wrong
  shell the mismatch fires on the first page that has any candidate, which is
  also the first page that could write - so the claim holds for the scenario it
  was written for; it breaks for a mixed population (NF8). Coverage is
  single-page only: the test's `doc.send` is
  `mockResolvedValue({ Items: opts.rows })` with no `LastEvaluatedKey`
  (`app/test/backfillMediaContentTypes.test.ts:92`), so
  `:274` ("before any vendor call") proves nothing about paging.
- **(nit) The P1 fix creates a new silent outcome with no warning.** `applied === 0`
  (`:514`) is a new skip path, so a run can now report
  `recovered: {video/mp4: 5}` with `written: 0` and exit green with NO warning -
  the only WARN (`:664-677`) fires on `recovered` being EMPTY, and
  `RUNBOOK.md:268` teaches the operator to read `recovered` as the go/no-go. A
  sibling `written === 0 && recovered > 0` warn is one line.
- **(nit) The RUNBOOK's step-4 hedge names the wrong survivor.** The re-read/merge
  guarantees a MIRROR-APPENDED attachment survives the BACKFILL's write. It does
  not guarantee the REPAIR survives the MIRROR's write:
  `app/src/jobs/mediaMirror.ts:151-160` is itself a read-modify-write, so a
  mirror job that read before the backfill wrote will re-`SET` the row from its
  stale list and revert `contentType` to octet-stream - leaving `written: N`
  asserting a commit that no longer holds. Self-heals on a re-run. One clause in
  `RUNBOOK.md:271` naming the reverse direction closes it.
- **(nit) `RUNBOOK.md:270`'s counter description contradicts the docstrings.**
  "the `skipped*` counters say why each declined attachment was declined" - but
  `BackfillResult:111-113` says every skip counter is a subset of `eligible`
  EXCEPT the two ROW-level ones, and `skippedEmailRow`/`skippedLegacyRow`
  (`:145-155`) are per-row, are not subsets, and never shrink. An operator
  reconciling `eligible` against the skip counters will not balance. Relatedly,
  `skippedThrottled` was deliberately kept out of `skippedTwilio404` so that
  throttling reads as "run it again" (`:135-140`) - and no RUNBOOK step tells the
  operator that `skippedThrottled > 0` requires a re-run.
- **(nit) `result.written += applied` can over-count** if a re-read list ever
  carries the same `s3Key` twice. Not reachable today (the mirror dedupes by
  s3Key at `jobs/mediaMirror.ts:153-158`); noted only because `written` is a
  reported number.
- **(nit) `rowsScanned`'s docstring is wrong.** `:109-110` says "Message rows
  returned by the scan, before ANY filtering"; it counts items surviving the
  server-side `FilterExpression` (`:381`). The cross-page accumulation is
  correct; only the wording is.
- **(nit) Region split.** The doc client is pinned to `HC_REGION = 'us-east-1'`
  (`scripts/lib/hcAws.mjs:19`, used at `:633`) while the S3 client takes
  `config.awsRegion = env.AWS_REGION ?? 'us-east-1'` (`config.ts:1275` ->
  `mediaStore.ts:381`). A leftover `AWS_REGION` splits the two clients and
  `CopyObject` fails mid-run with `PermanentRedirect`. `AWS_REGION` is not in
  `RUNBOOK.md:274-280`.
- **(nit) Latent seam split.** `backfillMediaContentTypes` resolves the SCAN
  table from `opts.env` (`:267`) while `main`'s `createMessagesRepo({ doc })`
  (`:645`) resolves the WRITE table from `process.env`
  (`messagesRepo.ts:1668`). Identical today because `main` never passes `env` -
  but the sibling script does (`app/scripts/backfill-media-pointers.ts:50`), and
  a future caller using the seam with a real repo would scan one table and write
  another.
- **(nit) The BiDi class omits U+061C** (ARABIC LETTER MARK), the 12th member of
  Unicode's `Bidi_Control` property; the other eleven are covered. ALM cannot
  reproduce the extension spoof - but neither can U+200F RLM, which IS stripped,
  so this is an inconsistency rather than a gap.
- **(nit) `RESERVED_DEVICE` omits `COM0`/`LPT0`** (both reserved in current
  Microsoft naming rules) and `CONIN$`/`CONOUT$`.
- **(nit) The M2 pin's failure message will mislead.**
  `INLINE_RENDERABLE_TYPES` is pinned to `IMAGE_MEDIA_TYPES`, whose docblock
  (`mediaTypes.ts:24-27`) says it is ALSO the source of truth for the
  property-photo upload gate (`routes/units.ts`). Widening property-photo uploads
  now reddens a contact-gallery drift test whose message says the dashboard
  drifted. One comment line in the test prevents the mis-diagnosis.
- **(nit) The M2 pin covers the READ path only; four more copies of the same
  server-side sets remain un-pinned dashboard-side**: `Timeline.tsx:117-123`
  `MMS_ALLOWED_TYPES` (an exact rendering of the app's `INLINE_MEDIA_TYPES`),
  `Timeline.tsx:126` `MMS_ACCEPT` (the same as a string),
  `EmailComposer.tsx:27-36` `EMAIL_ALLOWED_TYPES`, and `ListingDetail.tsx:130`
  `PHOTO_ACCEPT` (an exact rendering of `IMAGE_MEDIA_TYPES`). The new test
  header's claim that the pin is "the only thing that makes the source of truth
  claim true rather than aspirational" holds for the two collections it names,
  and overreaches for the file's claim as a whole.

---

## 3. Adjudications I challenge

### Challenge 1 - M1 "fixed as expectedAccountSid abort + TWILIO_API_BASE_URL refusal"

See **NF3** and **NF4**. The account half cannot fire in this deployment (one
shared Twilio account); the RUNBOOK sentence the wave leaned on is false; the
residual - a run that repairs the wrong ENVIRONMENT and exits green - is
untouched and invisible, because the script logs neither `TABLE_PREFIX` nor
`MEDIA_BUCKET`; and the new refusal introduced a config requirement
(`TWILIO_EVENTS_WEBHOOK_SECRET`) the RUNBOOK does not list, so the very first
command an operator runs will now fail on a message about a webhook secret.

The `TWILIO_API_BASE_URL` half IS a real, correctly-placed fix. Its twin
`MEDIA_S3_ENDPOINT` (NF6) was left open.

I would accept the code as shipped and require: fix `RUNBOOK.md:277` (both the
env list and the "different accounts" claim), fix `HOW_TO_FIX`, and log
table + bucket + appEnv.

### Challenge 2 - P3 "issue reworded + refs fixed"

The refs are correct now and the rewording is honest about being unverified. But
it still grounds its expectation in the wrong evidence
(`docs/issues/relay-forwards-undeliverable-media.md`):

> the EXPECTED outcome is unchanged, since video, audio, HEIC and documents all
> remain outside `TWILIO_DELIVERABLE_MMS_TYPES`

`TWILIO_DELIVERABLE_MMS_TYPES` (`app/src/lib/mediaTypes.ts:210-220`) is OUR
self-imposed send-side rule - jpeg/png/gif - whose own docblock says
"Everything sent to Twilio must be in THIS set". It is not Twilio's
accepted-media list, and `relayFanOut.ts:490-509` does not consult it at all: it
presigns every stored attachment and hands the URLs straight to
`adapter.sendMessage`. Twilio's own accepted MMS media list is materially
broader than jpeg/png/gif.

So the outcome the rewrite does not consider is that **the leg now SUCCEEDS**.
Before the branch Twilio fetched an `application/octet-stream` object; after it
(and, retroactively, after the backfill) it fetches `text/vcard`,
`application/pdf`, `image/heic` or `video/mp4`. If Twilio accepts any of those,
this branch silently starts DELIVERING relayed inbound media to the other
members of a relay group - media the repo elsewhere describes as potentially
"ID photos, benefit letters, and other PII"
(`docs/issues/mms-forward-received-media.md:20-24`, which parks staff-initiated
forwarding on exactly that ground). The issue frames the delta as "the ERROR
CODE may move"; the delta that matters is "there may be no error".

This is not a code change on this branch. It is a one-leg check on dev before
the prod deploy - send one inbound PDF into a relay group, read the leg status -
and it deserves its own line item rather than a sentence inside an unrelated
issue.

### Adjudications I agree with

- **P2 not changed in code + tracking issue filed.** Sound. I verified the
  issue's factual claim about pre-feature behavior:
  `git show 3c2962a4:app/src/routes/api.ts:2294-2296` emitted
  `attachment; filename="attachment-${idx}"` - extensionless and zero-based -
  exactly as the issue states. Frontmatter conforms to `docs/issues/README.md`
  (`type: security`, `severity: low`, `status: open` all valid) and its `refs:`
  anchors are correct on the final tree. The residual genuinely belongs to the
  human.
- **N10 rejected as scope creep.** Agreed - and NF1/NF2 are the e2e work that IS
  worth doing, which is a different point from adding tier coverage.

---

## 4. Are the claimed fixes real?

Reasoned through, not run.

| Finding | Dies with this diff? | Would the test fail if the fix were reverted? |
|---|---|---|
| M1 (account) | Mechanically yes; see NF4 for why it is inert here | **Yes.** `String(undefined)` fails `toContain('AC1')`, and `getMediaContentType` would have been called, failing the second assertion. |
| M1 (`TWILIO_API_BASE_URL`) | Yes | Yes - `messagingMisconfiguration` is exported and unit-tested directly; removing the branch returns `undefined` and `toMatch(/TWILIO_API_BASE_URL/)` fails. |
| P1 (lost update) | **Window shrunk, not closed** - stated honestly in the docblock (`:38-42`) and `RUNBOOK.md` step 4 | **Yes.** Under the old `row.attachments.map(...)`, the "PRESERVES an attachment the mirror appended" test receives a ONE-element array where it asserts two; the "matches by s3Key" test receives `video/mp4` stamped on the moved entry. Both fail on their first assertion. |
| N1 (device names) | Yes | Yes - `'CON'` -> `'CON.mp4'` vs expected `'attachment-1.mp4'`. |
| N2 (BiDi) | In the header only - see NF7 | Yes - `parts.ascii` would be `'rep__fdp.csv'` (two underscores) vs expected `'rep_fdp.csv'`. |
| N3 (surrogate) | Yes | Yes - the ascii stem would carry 50 underscores instead of 49 AND `rfc5987` would throw so `filename*` would be absent; both assertions fail. I re-derived the fixture arithmetic end to end (99 code units + astral + tail, cap 100, drop 1) and it is exact. |
| N8 (`provider_sid`) | Yes | Yes - `skippedNoUrl` would be 0 and `getMediaContentType` would have been called. (`MessageItem.provider_sid` is typed `string`, so the guard is invisible to the type system; the test is the only thing proving it.) |
| M2 (drift pin) | Yes - non-vacuous, and it runs in the gate | Yes; the author also proved it empirically by adding `image/avif` and watching it fail. |
| Upload-gate route test | Yes | Yes - a widened `isInlineMediaType` makes the route return 200. |
| N4/N5/N7/N9 + comment truth | Yes - all anchors independently re-verified | n/a (documentation) |
| P3 | Reworded; see Challenge 2 | n/a |

---

## 5. Verified sound (so the next reader does not re-derive it)

Beyond the fix-diff items in section 2:

- The whole branch's added lines are ASCII-clean (0 hits outside
  `docs/superpowers/`), independently scanned. Conformance N3 is closed.
- The supplied fix diff is exactly `git diff 8842bdfb..b31281a1`.
- **Paging.** Items-without-`LastEvaluatedKey` exits cleanly after processing;
  `LastEvaluatedKey`-with-zero-Items is handled (`page.Items ?? []` -> `drain([])`
  -> `workerCount = min(4,0) = 0` -> `Promise.all([])`) with no infinite loop and
  no counter drift. A message row cannot appear on two pages, and DynamoDB never
  splits one item, so a row's `media_attachments` cannot be split across pages -
  per-page `rows`/`candidates` therefore cannot half-process a row.
- **`drain`'s cursor claim holds.** `const index = cursor; cursor += 1;` is
  synchronous before the first `await`, and `Array.from`'s mapper starts each
  worker only to its first suspension, so no two workers claim the same index.
- **Guard order.** `loadConfig` -> `messagingMisconfiguration` ->
  `assertHousingChoiceAccount` -> clients -> `MEDIA_BUCKET` -> scan. Nothing is
  checked after an irreversible action; the STS call is read-only and client
  construction is inert.
- **Write order and idempotency.** S3 -> explicit `putMediaPointers` ->
  `annotateMessage` matches the docblock; `annotateMessage` genuinely swallows
  pointer failures (`messagesRepo.ts:2544-2550`) and carries
  `ConditionExpression: attribute_exists(tsMsgId)` (`:2524`), so a vanished row
  surfaces as a caught row-write failure rather than a resurrection. The explicit
  pointer write really is load-bearing, not dead code.
- **`mediaStore.setContentType` loses nothing.** `MetadataDirective: 'REPLACE'`
  drops unspecified system metadata, and `put` (`mediaStore.ts:162-171`) only
  ever sets `ContentType` - there is no Cache-Control / Content-Disposition /
  user metadata to lose. `createMediaStore` returning `undefined` on an unset
  `MEDIA_BUCKET` IS guarded in `main()` (`:639-643`).
- **Attribute names / row classification.** `mediaUrls`, `media_attachments`,
  `media_s3_keys`, `provider_sid`, `direction` all match `MessageItem`
  (`messagesRepo.ts:817-840`). `skippedEmailRow` really does name only inbound
  email (`services/inboundEmail.ts:730` is the sole writer of that shape); call
  recordings use `recording_s3_key` and never enter the scan.
- **Type normalization.** `normalizeStoredMediaType` essence-matches, lowercases
  and strips parameters (`mediaTypes.ts:176-208`), so `video/3gpp; codecs=...`
  is recovered and `text/html` / `image/svg+xml` can never be written. An
  empty-string answer falls to the opaque tier. The script cannot store a type
  the serve route would refuse.
- **`DYNAMODB_ENDPOINT` cannot redirect the backfill:** it builds its own
  `DynamoDBClient` rather than using `lib/dynamo.ts`'s factory.
- **`main()` does not run under vitest** (`:680-682`): `process.argv[1]` is the
  vitest binary, so the suite cannot touch real AWS.
- **Typecheck coverage of `app/scripts`** is real (`app/tsconfig.scripts.json`,
  `app/package.json:13`), and the directory is deliberately outside the `dist`
  build - so `npm run smoke` never seeing it is correct, not a gap.
- **RUNBOOK facts that DO check out:** the deploy-first rationale (the old bundle
  used `contentType.startsWith('image/')` - confirmed at `22ae6981`); the dry-run
  claims ("writes NOTHING", "still reads live Twilio", `vendorCalls`);
  `written`'s meaning; "recovering nothing WARNs and still exits 0"
  (`:664-677`); the IAM claim (CopyObject needs GetObject + PutObject, and the
  bucket is SSE-S3/AES256 with no KMS, so no `kms:*` is missing -
  `infra/modules/s3_media/main.tf:19-26`); versioning enabled with no lifecycle
  rule, so "every repair leaves a spare copy behind" is accurate; the dashboard
  strings "Video" / "Contact card"; and "no npm script, matching every other
  backfill".
- **The e2e's part (b) has no 302/401 vacuity:** `app/src/middleware/auth.ts:219-227`
  returns a 401 JSON, never a redirect, so an auth miss fails the `status === 200`
  assertion cleanly. `page.request` shares the browser's cookie jar and the
  relative href resolves through the Vite proxy, which injects
  `x-origin-verify`.
- **The e2e's 30s wait is a real poll, not dead time:**
  `useContactTimeline.ts:540-544` subscribes to
  `onMessagePersisted`/`onConversationUpdated` with a debounced refetch, and
  `webhooks/twilio.ts:2238-2267` runs the mirror BEFORE emitting
  `message.persisted`, so a late-landing mirror does surface. No fixed waits
  anywhere in the spec.
- **The e2e DOES catch a write-side regression:** if the mirror collapsed the
  vCard back to octet-stream, `mediaKindWord` returns undefined, the label
  degrades to a bare `Attachment 1`, and `:70` fails.
- **`cannedAssets` append is safe:** all eight references use `cannedAssets[0]`
  or map the whole list; nothing asserts a length beyond `toBeGreaterThan(0)` and
  nothing uses `.at(-1)`.
- **`inferMediaContentType`** (`signer.ts:27-45`) lowercases and strips `?`/`#`
  before the suffix test, so the new `.vcf` branch inherits correct handling of
  `.VCF` and query strings; it has exactly one call site (`:60`), reached by both
  `sendAsParty` and `sendGroupAsParty`.

### Smaller e2e / fake-twilio notes

- **(nit)** `fake-twilio/test/signer.test.ts:40-64` enumerates every other
  extension mapping and was NOT extended for `.vcf`. Delete `signer.ts:42` and
  `npm test` stays fully green; only a ~20-minute Docker e2e catches it, and it
  surfaces as "the dashboard did not name the attachment", pointing at the app
  rather than the fixture. One list entry closes it.
- **(nit)** Two mechanisms in the fake disagree on the token: the signer says
  `text/vcard`, `express.static` (`server.ts:247`, mime-types) serves the same
  file as `text/x-vcard`. Inert today and honestly documented at
  `signer.ts:38-41` - but the e2e asserts `toBe('text/vcard')` exactly, so the
  day anyone hardens the mirror to prefer the FETCHED type (a natural next step
  for this very feature) the spec fails with a misleading diff. A `setHeaders`
  on `express.static` would make the fake speak with one voice.
- **(nit)** `fake-twilio/web/public/canned/contact-card.vcf` omits the `N`
  property, mandatory for `VERSION:3.0` under RFC 2426. Nothing parses it, so
  cosmetic - but the fixture's whole job is to be a vCard.
- **(nit)** The e2e's `token` (`spec:48`) is computed, put in the body, and never
  used to scope anything; `.first()` (`:70`) is justified at `:65-69` by a
  premise that is false - `e2e/support/preflight.ts:143` POSTs `/__dev/reseed` in
  `globalSetup` on every invocation, so there is exactly one vCard bubble by
  construction. And if the premise WERE true, `.first()` resolves the OLDEST
  match (`Timeline.tsx:2` renders oldest->newest), i.e. the stale bubble, so the
  spec would assert against a prior run. Every neighbouring spec scopes by token.
  `sendAsParty` returns the provider SID and `messageMediaSrc` embeds it, so
  `expect(href).toContain(sid)` is the strongest available scope.
- **(nit)** Two weak assertions: `:80` `not.toBeNull()` passes on `''`; `:88`'s
  `.*\.vcf` matches `filename=".vcf"` (a lost stem), and its `$` anchor breaks
  the day this route emits a `filename*` companion.
  `/^attachment; filename="attachment-1\.vcf"/` is stronger and more durable.
- **(nit)** `e2e/support/selectors.md` gained no row for this surface, though it
  carries a trap worth recording (NF1: the `<img>` branch shares the link's
  accessible name) and a naming rule (`<Kind> - Attachment N`, bare on the opaque
  tier).

---

## 6. Gate state (context, not my verification)

The wave re-ran `npm run typecheck` (all workspaces, exit 0), targeted vitest in
both workspaces, and eslint on the touched files. It did NOT re-run `npm test`
in full, `npm run smoke`, or `npm run e2e`; the recorded gate logs in
`.superpowers/sdd/` all predate the three fix commits.

I assessed the blast radius rather than assuming:

- **smoke: no risk.** No fix commit adds an import edge in `app/src`; the
  changes are logic inside existing modules plus comments. `app/scripts` is
  outside the `dist` build by design.
- **`npm test` full: low risk.** The only behavioural source changes are in
  `mediaFilename.ts` (`mediaTypes.ts` and `mediaMirror.ts` are comments only).
  Every app test file touching filenames or `Content-Disposition`
  (`apiRoutes`, `emailMime`, `inboundEmail`, `mediaFilename`, `mmsMedia`,
  `unitMediaServe`) is inside the batch the wave ran, except `emailMime.test.ts`
  and `unitMediaServe.test.ts`, neither of which imports `mediaFilename`.
- **e2e: safe by construction.** The e2e's filename assertion exercises
  `buildMediaFilenameParts(undefined, ...)` - inbound MMS attachments carry no
  stored `filename` (`messagesRepo.ts:808-814`) - so the reserved-name, BiDi and
  surrogate changes cannot reach it.

Gates 2-4 should still be re-run once before merge; I would not expect them to
move.

---

## Summary

| # | Severity | Item |
|---|---|---|
| NF1 | must-fix | e2e cannot distinguish a file link from a broken `<img>` - its headline claim is untested |
| NF2 | must-fix | a missing canned fixture returns 200 (SPA shell); the spec passes on HTML bytes tagged `text/vcard` |
| NF3 | must-fix | RUNBOOK + `HOW_TO_FIX` omit `TWILIO_CONVERSATIONS_SERVICE_SID` and `TWILIO_EVENTS_WEBHOOK_SECRET`; the wave's own `TWILIO_API_BASE_URL` refusal is what makes the second mandatory |
| NF4 | must-fix | `RUNBOOK.md:277` "dev and prod are different accounts" is FALSE; the M1 guard is inert here and the environment residual is unlogged |
| NF5 | plausible | `TABLE_PREFIX` unguarded, silently defaults to `hc-local-`, under a promise of refusal |
| NF6 | plausible | `MEDIA_S3_ENDPOINT` is `TWILIO_API_BASE_URL`'s twin and was not refused |
| NF7 | plausible | BiDi spoof still live in the dashboard label, which now disagrees with the (fixed) header |
| NF8 | plausible | one foreign-account row wedges the backfill permanently, no counter, no opt-out |
| NF9 | plausible | any propagated error discards the whole report; `Promise.all` cancels nothing |
| NF10 | plausible | adapter's 20404 test is strict where the branch's own 20429 test is string-tolerant |
| NF11 | plausible | MediaGallery's non-image tiles announce raw MIME strings, and the branch widened that population |
| NF12 | plausible | the new e2e's serial worst case (~105s) exceeds its 60s cap |
| C1 | challenge | M1 adjudication - guard inert, RUNBOOK claim false, new config requirement undocumented |
| C2 | challenge | P3 adjudication - the unconsidered outcome is that the relay leg now SUCCEEDS |
| - | nits | 17 listed in sections 2 and 5 |

Nothing in the fix diff is wrong in a way that corrupts data or regresses
runtime behavior; the three code fixes hold up under a cold read. NF1 and NF2
are about the branch's PROOF rather than its code, NF3 and NF4 are RUNBOOK/log
lines, and the two challenges are decisions for the human rather than edits to
this branch.
