# Fix wave 3 - permanent flyer links (Cameron's Q1 answer, PC-2, PA-3, PA-7)

Fix-wave child report. Worktree `W:\tmp\permanent-flyer-links`, branch
`feat/permanent-flyer-links`, started at 4b047f8b (main already merged in;
nothing merged or rebased here). Scope: the orchestrator's five items -
Cameron's Q1 answer (option c) as wording in spec D2, the public.ts
"learns nothing beyond holding the id" comments (PA-3), the abuse issue's
severity, the four "Shareable." field comments (PC-2) and the SHAREABLE
swap (PA-7). Line numbers below are at 595ca503.

Cameron's Q1 answer (intent.md decision 8), verbatim: "Imported properties
can have their links stay available. We don't need to update those, I
understand they'll go live with a deploy. i'm not sure which option that
is, i believe it would be C."

## Commits

| Hash | Subject |
|---|---|
| f6ee0a76 | refactor(public): the pin suffix and the flyer's listing link follow SHAREABLE, not a second 'available' literal |
| 595ca503 | docs: permanent flyer links fix wave 3 - D2's true premise (Cameron: option c), the public-learns comments, field comments, the abuse issue severity |
| (this report) | docs(records): permanent flyer links - fix wave 3 report |

Before each commit: bare `git status` (only my files, nothing staged by
anyone else), the MERGE_HEAD check printed nothing, explicit paths staged,
the added-line ASCII check printed nothing (grep exit 1), the commit message
grepped clean, and the Co-Authored-By trailer.

## Per item

1. Spec (`docs/superpowers/specs/2026-10-27-permanent-flyer-links-design.md`)
   - DONE.
   - D2's last bullet (:138-149) states the true premise: imported unitIds
     come from the address with a fixed namespace (`ids.ts:24`, `:84-86`,
     both re-read: the `NAMESPACE` constant and `unitIdForAddress`) that is
     in the PUBLIC GitHub repository (code review R2-1, 2026-10-28; rev 3's
     "private repository only" was false). So anyone who knows an imported
     property's address can compute its id and get its flyer in every status
     but Setup, Airtable "Placed" homes imported as Occupied included
     (`apply.ts:1619`), which go live with the deploy. Then Cameron's answer,
     verbatim and ASCII, and "Accepted."
   - The bullet's lead-in '"No existence oracle" now means: nothing beyond
     holding the id' is now "What the API tells the public: the 404 is one
     opaque body for every cause, and a 200 tells the holder of an id that
     its property is public" - the same words as the code comment.
   - Status header (:3-12): APPROVED revision 4 (2026-10-28), plus one bullet
     "Rev 4 (2026-10-28) corrects D2's premise only ... Cameron accepted the
     true premise (Q1, option c); no behavior change." The rev 3 and rev 2
     bullets are kept verbatim.
2. `app/src/routes/public.ts` comments - DONE (comments only; no other
   wording in the file changed).
   - Flyer route header (:863-874): "one opaque body for every cause. What
     the public can learn: a 200 tells the holder of an id that its property
     is public; an IMPORTED property's id is computable from its address
     (public import namespace - accepted, permanent-flyer-links D2 rev 4);
     and a served flyer's null listing_link tells a reader the home is not
     Available (D3a, accepted - planner review PA-3)."
   - sendNotFound (:469-473): "one IDENTICAL body for every cause" (the four
     causes listed), and "What a 200 does tell the public is under the flyer
     route below (permanent-flyer-links D2)."
   - Inline 404 (:879-880): "One opaque 404 body for every cause - missing,
     deleted, setup, or a stored status outside the listing statuses
     (sendNotFound)."
   - The phrase "beyond holding the id" is gone from public.ts and the spec
     (git grep); one test comment still has it (see Left over).
3. `docs/issues/public-signup-abuse-hardening.md` - DONE.
   - One dated paragraph (:42-50), placed right after the Problem paragraph,
     whose last sentence is the permanent-flyer-links widening. It reads
     "Severity, re-weighed 2026-10-28: stays `med`", cites R2-1 and Q1
     option c, then gives the orchestrator's reasoning:
     - anyone can compute an imported property's unitId (point 2 (d)), and
       since the branch an imported property is public in every status but
       Setup, the imported Placed homes included from the deploy;
     - unitIds were never the scarce input, because every Matching and
       broadcast text carries one;
     - the public namespace widens the pool of usable ids, not what one
       request can do (point 2 (a) to (c));
     - the per-IP `/public` limiter (`app/src/app.ts:185-191`, re-read)
       still bounds bursts (point 1).
   - Frontmatter is untouched: severity med, status open,
     `updated: 2026-10-28`, refs unchanged.
4. PC-2 - DONE.
   - `app/src/repos/unitsRepo.ts:481`, `:483` and `:485` (video_url,
     application_fee, same_day_rta) and `app/src/lib/unitFields.ts:418`
     (voucher_sizes) now end "On the public flyer." in place of
     "Shareable.", matching GLOSSARY's "public flyer statuses" bullet
     (`documentation/GLOSSARY.md:706-720`).
   - The three unitsRepo lines held U+00A7. Each edited line is now ASCII:
     "public-pages sec 3".
   - No other "Shareable." field tag remains in app, dashboard, e2e or
     scripts (git grep).
5. PA-7 - DONE (f6ee0a76).
   - `SHAREABLE_STATUSES` is imported beside `FLYER_PUBLIC_STATUSES` from
     '../repos/unitsRepo.js' (public.ts:77).
   - The pin suffix (:227) is now `SHAREABLE_STATUSES.has(status) ? '' : ...`.
   - The D3a listing link (:895) is now
     `SHAREABLE_STATUSES.has(unit.status) ? flyer.listing_link : null`.
   - Comments (:221-225, :889-894): Available is the one status open to
     apply, the one a property can be sent in (SHAREABLE), so the suffix
     (the link) follows that set - one rule, not a second copy of the
     literal.
   - Behavior is identical: `SHAREABLE` is `new Set(['available'])`
     (`app/src/lib/statusModel.ts:290`), and `SHAREABLE_STATUSES` is that set
     (`unitsRepo.ts:69`). No `'available'` literal is left in public.ts.

## RED evidence

None, by design. Item 5 is a refactor that keeps behavior identical, and
items 1-4 are wording only. No test could go red for the right reason, and
no test was added or changed. Existing assertions already pin both swapped
sites, and they stay green:
- the pin suffix: publicSignupLeads.test.ts `FLYER_LABEL` (:83, Available,
  no suffix), `OCCUPIED_FLYER_LABEL` (:87), and the On hold rows (:305,
  :330);
- the listing link: publicIntake.test.ts :635, which keeps the stored link
  for available and expects null in the other five public statuses (FW2's
  whole-payload assertion).

## Test counts and gates

| Check | Result |
|---|---|
| `cd app; npx vitest run test/publicIntake.test.ts test/publicSignupLeads.test.ts`, three runs: after the swap; on commit 1's final bytes; after the item 1-4 edits | 74 + 81 = 155 passed, EXIT=0 every run; counts unchanged; no `[dynamoAdmin]` line |
| root `npm run typecheck`, three runs at the same points | EXIT=0 each, 0 `error TS` |
| `npx eslint app/src/routes/public.ts` (commit 1); `npx eslint app/src/routes/public.ts app/src/repos/unitsRepo.ts app/src/lib/unitFields.ts` (commit 2) | EXIT=0, no output |
| `npm run issues` | EXIT=0, "452 open, 215 closed, 667 total"; the issue is still listed med / security / open |
| ASCII, the added lines of both commits and both commit messages | clean (grep exit 1) |
| `npm test`, smoke, e2e | not run (the brief: the coordinator runs every gate) |

Logs: `.superpowers/sdd/logs/FW3-c1*`, `FW3-c2*` (gitignored). Only the
issue doc changed after the last gate run on the source files. No `AWS_*`
variables were exported (`env | grep '^AWS_'` exit 1).

## Judgment calls

1. Item 2's four points are written in full once, in the flyer route header.
   sendNotFound and the inline 404 keep only the opaque-body point, and
   sendNotFound points to the header. This avoids the same paragraph three
   times within about 400 lines.
2. The spec's Status line now ties the rev 3 approval quote to rev 3 ("Rev 3
   passed the spec gate (2026-10-27) - Cameron: ..."), so it does not read
   as an approval of rev 4. Lines 3-7 are reflowed. The stale "Next: the
   plan" line is kept as it was (outside scope).
3. The abuse-issue paragraph sits at the top of the body, not inside point
   2, so a triager sees the severity call before reading the points.

## Left over (outside this wave's named scope)

- Line drift from f6ee0a76: signupPinLabel's comment grew by 3 lines, so
  every public.ts line cited past the old :221 in
  `docs/issues/public-signup-abuse-hardening.md` is now 3 lines low.
  Examples:
  - parseHousingFairBody :256 is now :259;
  - markSignupUnread :441 is now :444, so the cited guard :442-445 is now
    :445-448;
  - the hasEventSince call :717 is now :720;
  - applyFlyerShareEntry :792 is now :795;
  - signupPinLabel :209-226 is now :209-229.
  The issue cites nothing past :863, where the route header (+4) and the
  D3a comment (+2) add more lines. The fix is a mechanical +3 if wanted.
- `app/test/publicIntake.test.ts:654`, a test comment, still says "No
  existence oracle beyond holding the id". Its assertions check that the
  four 404 bodies are identical. A reword such as "One opaque body for every
  404 cause" would match public.ts. It was not named, so it is not touched.
- PA-7's dashboard literals (`BroadcastComposer.tsx:376`, `:545`;
  `RecipientPreview.tsx:391`) still compare to `'available'`. Item 5 named
  only the two server sites.
