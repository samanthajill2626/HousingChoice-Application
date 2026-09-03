---
id: inbox-parselimit-empty-one-row
title: Inbox ?limit= (empty, zero, or negative) serves a one-row page instead of the default
type: bug
severity: low
status: resolved
area: app
created: 2026-08-09
resolved: 2026-09-02
refs: app/src/routes/inbox.ts, app/src/routes/aiRuns.ts, app/test/inboxApi.test.ts
---

**Resolution (2026-09-02).** Fixed on branch `feat/inbox-unknown-tab-paging`
(small-fix lane). `parseLimit` in `app/src/routes/inbox.ts` now takes the full
aiRuns predicate: a non-string, empty or whitespace value and a zero or
negative integer all fall back to `DEFAULT_INBOX_LIMIT`; the floor is replaced
by the fallback, not deleted, and the clamp to `MAX_INBOX_LIMIT` is unchanged.
The do-not-re-sync warning in `aiRuns.ts` is retired; the two copies now agree.
The other seven `parseLimit` copies (400 on an empty value) are untouched, per
the collateral note above. Tests in `app/test/inboxApi.test.ts`: `?limit=`,
`?limit=%20`, `?limit=0` and `?limit=-5` each serve a default-sized page, with
`limit=1` as the one-row control and `limit=1000` answering 200 (the clamp,
not a 400).

**Problem.** `parseLimit` in `app/src/routes/inbox.ts` (the module-private
function above `createInboxRouter`; line numbers in this file have moved three
times, so none is given) treats
an empty string as a number: `Number('') === 0`, which IS an integer, so the
clamp floor turns `?limit=` (and `?limit=%20`) into `Math.max(1, 0) = 1` - a
one-row inbox page where the caller plainly wanted the default.
`raw === undefined` is the only absent shape it recognizes.

That same floor does the same thing to two inputs this issue did not originally
name: `?limit=0` and `?limit=-5` also serve a one-row page. Any fix that stops
at the empty string leaves them standing.

**Severity: low, re-confirmed.** No product path can emit the bad value.
`dashboard/src/api/client.ts` builds the query string by SKIPPING undefined and
null values, so an omitted limit is dropped from the URL rather than emitted as
`limit=`, and `dashboard/src/routes/inbox/useInbox.ts` always sends an explicit
`PAGE_LIMIT = 30` on both the first page and the cursor page. That leaves a
hand-edited or bookmarked URL, a script, or a future non-dashboard client of
`/api/inbox`. The failure mode is a 200 carrying one row, which reads as a
nearly-empty inbox rather than as an error - confusing, not damaging.

**Pre-existing on main** - noticed during the ai-run-log follow-up wave's
re-review, when `app/src/routes/aiRuns.ts` adopted this function as its model
and then had to harden exactly this case (empty/whitespace/non-string now fall
back to the default there). The aiRuns copy carries a do-not-re-sync warning
pointing here. It has since hardened a SECOND time, for a zero or negative
limit (`|| n < 1`), which its own comment calls the same defect "left behind
for the explicit values". The two copies converge when this issue is fixed, so
retire the do-not-re-sync warning in `aiRuns.ts` in the same change.

**Fix direction.** Take the FULL current aiRuns predicate, not the single line
this issue used to quote. That quote -
`if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_INBOX_LIMIT;`
- was accurate when it was written and is now only half of the aiRuns function.
On its own it closes `?limit=` and `?limit=%20` and leaves `?limit=0` and
`?limit=-5` serving the one-row page, i.e. it closes the title and not the
defect. The shape to adopt:

```ts
function parseLimit(raw: unknown): number {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_INBOX_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_INBOX_LIMIT;
  return Math.min(MAX_INBOX_LIMIT, n);
}
```

**The floor is REPLACED BY A FALLBACK, never deleted.** `Math.max(1, n)` is what
stops a 0 from reaching the repo, and a repo's `opts.limit ?? DEFAULT` does not
replace a 0 - that is how `Limit: 0` once reached DynamoDB and answered a
ValidationException, as the aiRuns doc comment records. Inbox's own downstream
was not audited for a 0 here, which is precisely why the floor must be swapped
for the `n < 1` fallback rather than removed: dropping it without the fallback
would trade a one-row page for a 500.

Tests to add: `?limit=`, `?limit=%20`, `?limit=0` and `?limit=-5` each answer a
DEFAULT-sized page, and `?limit=1000` still clamps to `MAX_INBOX_LIMIT` (the
shipped contract is a clamp, not a 400). `app/test/inboxApi.test.ts` carries no
`limit` assertions today, so all of these are net-new; the existing `limit=1`
and `limit=2` paging walks pass explicit legal values and are unaffected.

**Collateral.** Verified by reading the code, 2026-08-25:

- `parseLimit` in `inbox.ts` is module-private with exactly ONE call site, the
  `GET /api/inbox` handler. The other inbox routes take no `limit`:
  `/unread-count` is path-only and the read/unread mutations are POSTs.
- Seven identically-named `parseLimit` functions live under `app/src/routes/`
  (`api.ts`, `broadcasts.ts`, `contacts.ts`, `contactTimeline.ts`,
  `placements.ts`, `units.ts`, `unmatchedEmail.ts`). They are separate
  declarations, not imports, so this fix does not reach them - and they do NOT
  have the one-row bug: an empty limit returns `undefined` there and the caller
  answers 400.
- So after this fix the repo holds THREE empty-limit policies across nine
  copies: inbox and aiRuns fall back to the default, the other seven 400.
  Converging them is separate work carrying a real API-contract question (400
  vs default) and is NOT this issue's scope.
- No perf contract moves. The inbox page is pinned on the exact query-key tuple
  `['filter', 'limit']`; this changes only server-side parsing of a value the
  dashboard already sends, adding and removing no param.

**Re-adjudicated 2026-08-25 against main @88ac7b36.** The defect still
reproduces - the function is unchanged since the commit that created it - but
the one-line remedy quoted here had gone stale against the very copy it points
at, so the fix direction now takes the whole aiRuns predicate and the
zero/negative inputs are named in the problem statement.

**Evidence.** `.superpowers/review/fixwave-rereview.md` (P3-6) on branch
feat/ai-run-log.
