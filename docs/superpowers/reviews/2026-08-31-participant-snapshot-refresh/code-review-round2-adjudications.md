# Code review round 2 - adjudications (2026-09-01)

Input: `code-review-round2.md` (fresh reviewer; both wave-1 fixes judged REAL;
overall "needs another wave"). Adjudicated by the build orchestrator. Wave 2
follows - deliberately small: two pins, one audit counter, comments.

## The new must-fix

| id | finding | adjudication |
|---|---|---|
| R2-1 | Hydration flips `anyNamed`, so a tagged, snapshot-nameless roster whose contacts HAVE names now titles by member names, not the operator's `placement_tag` (inbox row + contact card); push title still shows the tag - measured divergence | ACCEPTED-BY-DESIGN, DECLARED AND PINNED (wave 2), not reverted. The precedence rung is untouched: main already prefers member labels over the tag whenever ANY member is named (`groupTitle.ts` carve-out) - the tag only ever beat RAW DIGITS. Resolve-on-read (spec decision 1) widens "named" to the contact record, which is the mission. The affected population is exactly the stale-snapshot rosters this branch exists to fix; after M1 the render equals what a freshly-created group would show, which is the spec's stated goal. WAVE 2: (a) one pin in inboxGroups.test.ts - tagged + snapshot-nameless + contact-named roster titles by NAMES; (b) one comment line at the carve-out noting hydrated callers feed it live names since 2026-09-01; (c) the handback names the visible push-vs-inbox divergence for Cameron. If Cameron wants tag-over-names, that is a one-line precedence change filed as its own issue - his call, stated in the handback. |

## Should-fix

| id | finding | adjudication |
|---|---|---|
| R2-2 | The RELAY arm of `pushSenderLabel` (twilio.ts:744) is unpinned for flip and guard; the two arms resolve `senderContact` differently | ACCEPTED, WAVE 2: one test on the relay push path - a renamed contact's live name wins the body prefix (and the same test seeds the roster's stored name so the assertion discriminates). |
| R2-3 | The guard shows a formatted phone where main showed a deleted contact's name (deleted + no stored roster name); wave-1 report claimed "restores main's outcome" | CORRECT BY CONSTRAINT, record corrected here: a soft-deleted contact supplies NO name is the binding rule; main's name-showing was the pre-M1 accident. The fix-wave report's restoration claim is WRONG for this sub-case and is superseded by this paragraph. No code change; handback notes the visible difference. |
| R2-4 | `rosterDriftTally` cannot count "roster stores a name, contact has none" - the population T5 made permanent (stopped deleting the stored name) | ACCEPTED, WAVE 2: add a `nameOnlyStored` counter (stored name present, readable non-deleted contact has no display name), test it, print it in the audit block. Lands BEFORE the P5 lane run so the recorded numbers include the branch's own cost. |
| R2-12 | The same hydrated-vs-stored docblock split exists at `groupThreadLabel`; the module header still argues the one-rule case without mentioning input | ACCEPTED, WAVE 2, COMMENTS ONLY: one sentence on `groupThreadLabel`'s docblock and one on the module header stating the input contract (callers choose the roster; hydrated callers get live names). |
| R2-17 | The e2e Today leg's 20s toPass cannot fail for rung-1 reasons | REJECTED as a change (stands as a recorded note): the leg CAN fail (name never renders -> 20s timeout); it cannot isolate rung 1 because the product's own PATCH write-through refreshes the snapshot - already adjudicated at A-5, unit pins carry rung 1. Not worth fighting the product in e2e. |

## Contested adjudications - record corrections

- A-3's outcome (no restructure of the unread arm) STANDS; the round-1 stated
  reason is corrected per the reviewer: the true grounds are "declared,
  adjudicated cost, bounded by MAX_INBOX_LIMIT", not stale-id impossibility (a
  two-phase batch over `fresh` would be sound - it is simply not owed).
- The round-1 conformance T9 record cited one `applyTriage` writer; there are
  three (`contacts.ts:1769`, `:1887`, `placementNudges.ts:556`). The T9
  CONFORMS verdict survives (it never rested on that count); the record is
  corrected here.
- A-1 execution: the human's ruling (no new issue; handback item) stands. The
  handback item now carries ALL the reviewer's facts: the resolved `high` is
  invisible to the documented open+high triage query; `_CLUSTERS.md:82` still
  lists it as an open high anchor; `_CLUSTERS.md:84` still says "six" copies.
  `_CLUSTERS.md` is planning-side and spans open work repo-wide; it is not
  edited from this feature branch.

## Notes carried to the handback (no action)

- A phone-shaped STORED roster name would pass `shortNameFromFull` into the
  persisted/spoken label semi-verbatim; main spoke it fully verbatim, so the
  exposure class is pre-existing and reduced, but the docblock's "NEVER the raw
  phone" is aspirational for that population (unknown if it exists).
- Two name rules on one inbox page (`inbox.ts:543` 1:1 rung vs the projection);
  tracked by the open consolidate issue.
- `resolveMemberName`'s write-time "explicit beats contact-derived" is now
  inverted at read time by design (decision 2).
- "One batch" means `ceil(K/100)` sequential chunks inside the repo - wording,
  not a defect.
- Lost per-member error context on GET /members (one request-level warn now);
  QuickReply mislabel note; both minor, recorded in round 2.

## Wave 2 (final wave)

1. inboxGroups.test.ts: PIN - tagged, snapshot-nameless, contact-named relay
   roster titles by member names (R2-1), comment at the carve-out.
2. inboundMessagePush.test.ts: PIN - relay-arm sender prefix prefers the live
   contact name (R2-2).
3. rosterDriftTally.ts + test + audit print: `nameOnlyStored` counter (R2-4).
4. groupTitle.ts comments (R2-12) - groupThreadLabel docblock + module header.

After wave 2: a narrow fresh verification (round-2 report + wave-2 diff), then
P5 self-QA (audit lane run with the new counter), then the single main sync and
the full gate battery on the synced commit.
