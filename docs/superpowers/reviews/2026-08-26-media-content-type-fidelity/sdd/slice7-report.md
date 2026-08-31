# Slice 7 report - Task 8 (docs)

Branch `feat/media-content-type-fidelity`, worktree `W:\tmp\media-content-type-fidelity`.
Base for this slice: `dc3ed0e5` (end of slice 6). Working tree clean at handback.

## Commit

| Hash | Message |
|---|---|
| `8842bdfb` | `docs: backfill runbook + amend the stored-XSS parameter claim` |

2 files changed, 64 insertions(+), 1 deletion(-). Staged by explicit path (no
`git add -A`), bare `git status` read before the commit (it listed exactly the
two intended files; the regenerated `docs/issues/INDEX.md` never appeared -
gitignored, as expected and as instructed), `MERGE_HEAD` confirmed absent in the
worktree's REAL git dir
(`W:\AI Projects\Housing Choice\HC Application\.git\worktrees\media-content-type-fidelity\`).
Carries the `Co-Authored-By: Claude Opus 5 (1M context)` trailer.

| File | Change |
|---|---|
| `RUNBOOK.md` | +21 lines - one new `###` section |
| `docs/issues/media-serve-stored-xss.md` | +43 / -1 - frontmatter refs rewritten, amendment appended |

## The RUNBOOK section: where it is and why

`### Media content-type backfill (2026-08-26): NO schema change, ONE backfill, DEPLOY FIRST`
at **RUNBOOK.md:262-281**, inserted between the `Media pointer index (2026-08-18)`
paragraph (`:260`) and `### Unit photos: direct-upload CORS` (now `:283`).

That slot is deliberate. `:260` is this section's closest sibling in KIND - the
only other "no schema change, one backfill, deploy must come first" entry - and
it is the last paragraph of the owed-post-merge-operations run, so a new `###`
heading there begins cleanly rather than splitting a block. The heading form
matches the `###` siblings immediately below it (e.g. `### Outbound MMS media
transcoding (2026-07-16): npm install owed; NO new infra`): a dated, named,
post-merge obligation.

Contents, in the plan's Step 1 order:

1. What it repairs, the three-stage write order and WHY the message row goes
   last, one-time + idempotent, and the deliberate exception (Twilio-aged-out
   attachments re-queried every run, `skippedTwilio404`).
2. Per-environment numbered walk: deploy -> `--dry-run` -> read the histogram ->
   apply -> verify one repaired attachment in that dashboard, dev fully through
   before prod.
3. `npx tsx app/scripts/backfill-media-content-types.ts --dry-run` then the same
   without the flag; states explicitly that there is deliberately NO npm script.
4. The hard ordering as step 1, with the MECHANISM rather than the rule alone -
   the old bundle's predicate is `att.contentType.startsWith('image/')`
   (verified against `main`'s `Timeline.tsx`), so a repaired `image/heic` lands
   in an `<img>` and renders BROKEN until the new bundle's `isInlineRenderable`
   ships.
5. Operator env (C7 + slice 5's shipped guard): `MESSAGING_DRIVER=twilio` FIRST
   with the console-driver-exits-green rationale, the five `TWILIO_*` vars for
   the target account, `MEDIA_BUCKET`, `TABLE_PREFIX`, the `housingchoice`
   profile, `assertHousingChoiceAccount` running first, and `s3:GetObject` AND
   `s3:PutObject` because the rewrite is a self-directed `CopyObject`.
6. `--dry-run` writes nothing but reads the live Twilio account once per
   candidate; the count is the report's `vendorCalls`.
7. Versioned bucket, no lifecycle rule -> one retained old version per repair,
   recoverable, one extra full copy each.
8. Scale: prod held 11 media-bearing messages on 2026-08-18 (the `:260`
   precedent), dev similar.

Two facts were verified against the tree rather than taken from the plan:
`infra/modules/s3_media/main.tf:12-17` sets versioning `Enabled`, and the only
`aws_s3_bucket_lifecycle_configuration` in `infra/` is on `inbound_mail`, not
media - so "versioned, no lifecycle rule" holds as written.

## The amendment: what it covers BEYOND the plan's three claims

The plan's Step 2 block is present VERBATIM (intro sentence + its three
bullets + the `See docs/superpowers/specs/...` line), appended after the
historical record at `docs/issues/media-serve-stored-xss.md:50-90`. Nothing in
the 2026-06-18 Resolution, Not-affected, Tests or audit text was rewritten.
Placement at the end of the file matches the repo's own convention for dated
follow-on blocks (`contacts-batchget-amplified-reads.md:105`,
`dashboard-api-client-has-no-request-timeout.md:27`, and others).

**A FOURTH claim was contradicted and the plan did not cover it.** The
Resolution's WRITE-SIDE bullet (`:33-35`) says the mirror stores through
`normalizeStoredMediaType(...)`, "collapsing anything off the allowlist to
`application/octet-stream` at rest". On this branch
`normalizeStoredMediaType` is now `resolveMediaTier(raw).canonical`
(`app/src/lib/mediaTypes.ts`), so a DECLARABLE type is PRESERVED at rest - the
sentence is false as written unless "the allowlist" is read as both tiers. The
plan's three bullets are all read-side (the gate, the matching, the serve
behavior); none of them says anything about what is stored. One added bullet,
same voice and ASCII, records that the normalizer both MOVED
(`webhooks/twilio.ts` -> `app/src/services/mediaMirror.ts:104`) and WIDENED,
that "off the allowlist" now means off BOTH tiers, and that nothing
script-capable gained ground - `app/test/mmsMedia.test.ts:159-168` still pins
`text/html` collapsing to octet-stream AT STORE time. The bullet opens "A FOURTH
detail..." so it does not silently contradict the verbatim intro's "Three
details".

The other candidate claims were CHECKED and are NOT contradicted, so they got no
bullet:

- `:44-45` **Tests** - both named files still exist and still carry the cited
  cases (`mmsMedia.test.ts:236-267` still asserts `text/html` and
  `image/svg+xml` -> octet-stream + attachment).
- `:47-48` **"Adversarially re-audited ... no residual inline path, including
  the legacy fallback"** - still true. The declarable tier is never inline (it
  is always `Content-Disposition: attachment`), and `mediaAttachmentsOf`
  (`messagesRepo.ts:1001`) still folds legacy `media_s3_keys` to
  `application/octet-stream`, unchanged by this branch.
- `:29-30` **"Runs on the actual S3 object's type"** - still true; the serve
  route resolves on `object.contentType`.
- `:36-38` **Headers** - `nosniff` + `default-src 'none'; sandbox` are still set
  on the media response (`api.ts:2303-2304`).
- `:40-42` **Not affected (call recording)** - unchanged by this branch.

## C6 (stale anchors)

Frontmatter `refs` rewritten to current locations:

```
refs: app/src/routes/api.ts:2284-2304, app/src/lib/mediaTypes.ts, app/src/services/mediaMirror.ts:104, app/test/mmsMedia.test.ts
```

The stale numbers INSIDE the dated Resolution body were left exactly as written.
The amendment closes with an explicit current-anchor line instead, and its
numbers were re-verified on THIS tree rather than copied from the worklist -
two of C6's suggestions had moved again since it was written:

| Anchor | Worklist C6 | Written (verified on this tree) |
|---|---|---|
| app-wide nosniff | `app.ts:113-118` | `app/src/app.ts:118` (the `setHeader` line; the middleware block is :117-120) |
| call-recording endpoint | `api.ts:2220` | `app/src/routes/api.ts:2168` (the `router.get('/calls/:callId/recording')` line - the historical text cited the ROUTE line, not a line inside the handler) |
| serve block | `api.ts:2291-2296` (C2) | `app/src/routes/api.ts:2284-2304` (slice 2's shipped block, comment through CSP) |
| legacy fold | `messagesRepo.ts ~:1001` | `app/src/repos/messagesRepo.ts:1001` (exact) |

## Verification

| Check | Result |
|---|---|
| Both files re-read after editing | Amendment renders as ONE coherent block (intro, 4 bullets, spec reference, anchor note); RUNBOOK section sits between `:260` and the next `###` with no heading damage |
| `npm run issues` (worktree root) | `256 open, 152 closed, 408 total`; the ONE warning is pre-existing and unrelated (`perf-selfqa-route-contract-drift.md: unknown severity "medium"`). The issue file still parses - frontmatter intact |
| `docs/issues/INDEX.md` | Regenerated, gitignored, NOT committed (never appeared in `git status`) |
| ASCII scan of ADDED lines only (Node, over `git diff`) | RUNBOOK 21 added lines, issue file 43 added lines, **0 non-ASCII** in either |

Gates 1-5 were NOT run for this slice: docs-only, no `.ts`/`.tsx`/`.js`/`.mjs`
touched. Note for the final gate run - AGENTS.md's gate-5 trap applies at the
branch level, not here: `git diff --name-only --diff-filter=d main...HEAD --
'*.ts' '*.tsx' ...` on this branch returns a NON-empty list (slices 1-6), so
gate 5 must still be run with those paths.

## Deviations / judgement calls

1. **One extra amendment bullet** (the write-side widening) - required by the
   brief's "if a claim is contradicted by the new code and not covered by the
   amendment block, extend the amendment with one more bullet".
2. **A current-anchor paragraph** closing the amendment, beyond the plan's
   block. C6 says "the amendment notes current locations" and the plan's block
   names only `mediaTypes.ts`; without this the file would carry six stale
   numbers and no pointer to the real ones.
3. **`TABLE_PREFIX` named in the RUNBOOK env list** alongside the vars the brief
   enumerated. It is in the script's own `HOW_TO_FIX` string and its docblock,
   it is how the messages table resolves, and every sibling backfill entry in
   this RUNBOOK says the same thing. Omitting it would document an env that
   cannot actually run.
4. **`###` heading rather than a bold paragraph.** The nearest sibling by kind
   (`:260`) is a bold paragraph, but this entry carries a five-step procedure
   and a four-item env list; the `###` siblings directly below it are exactly
   that shape. Grep-discoverability in a 2670-line RUNBOOK also argues for a
   heading.

## What the mission needs to know

- The backfill is a POST-MERGE, POST-DEPLOY human obligation on dev AND prod,
  and the RUNBOOK now carries the whole procedure. Nothing else is owed (no
  Terraform, no secrets, no SSM), matching the plan's "Post-merge obligations".
- The stored-XSS issue keeps `status: resolved`. The amendment states the
  guarantee is unchanged; nothing here reopens it.
