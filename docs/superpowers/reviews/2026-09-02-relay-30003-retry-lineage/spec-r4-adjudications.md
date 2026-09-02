# Spec review R4 - adjudications - TERMINAL ROUND

Round 4, one continued reviewer, 12 findings against revision 4. **The reviewer
marked every one WORDING and stated plainly that nothing changes a decision.** It
re-tested all seven load-bearing guarantees against revision 4's mechanisms and
found every one holding, including a fresh attack on the claim gate using the
`canceled`-maps-to-`failed`-with-no-code path (`adapters/messaging.ts:567-569`) -
which is real, and which produced finding 8 rather than a broken guarantee.

That satisfies the stop rule: a round of precision edits alone is the terminal
round. All twelve are folded into revision 5 and the design review ends here, at
four of a permitted four rounds.

All accepted:

1. `getMessageConsistent` is a PRIVATE closure (`messagesRepo.ts:1885-1897`, above
   the `return {` at `:2085`) and is not on the `MessagesRepo` interface, so
   round 3's blocking fix was not executable as written. The spec now says to
   expose it or route the claim through a repo method that reads consistently
   internally - and not to substitute `getByTsMsgId`.
2. D2 contradicted itself on schema after revision 4 added legacy mirroring:
   paragraph 1 mandated version 1, paragraph 4 mandated legacy for a legacy
   original. Paragraph 1 now states only the `requestedTransport` prohibition,
   which is what it was actually there for.
3. "The projection happens ONCE" invited a `useMemo(..., [items])` that would
   freeze the time-derived half and restore both failures D18's ticker clause
   exists to prevent. The projection is now stated to have TWO lifetimes:
   lineage memoized on items, horizons recomputed against `tickNow`.
4. D19's closing sentence still fed the row and recital from `{status, errorCode}`
   - the exact overload the `retryState` paragraph forbids forty lines earlier.
5. Mixed states in one bubble had no specified composition, though
   `presentRelayDelivery` already composes two categories
   (`deliveryStatus.ts:433-436`). Now specified: comma-joined, fixed order,
   zero-count categories omitted, with `on retry` as a suffix on the delivered
   count rather than a category.
6. D15 was titled "the close codes are enumerated" and enumerated none. Four gate
   codes and their operator copy are now listed. D14 needs NO new code: the
   reviewer is right that `enqueue_failed` and `transient_cap` already exist and
   already carry its rationale (`deliveryStatus.ts:671-681`), so inventing a third
   would split one meaning across two tokens.
7. **The founder-facing sign-off sentence contradicted the middle-case decision
   revision 4 added thirty lines above it** - it still described the increase as
   bounded to legs a ladder ran for. Corrected before the gate, deliberately: the
   founder must approve the set the design actually produces, not a smaller one.
8. Three of revision 4's own decisions had no test intention - D8's
   slot-code-ABSENT clause, D2's legacy mirroring, and the ticker's TERMINATION as
   distinct from `unconfirmed` appearing. Added as intentions 17-19.
9. "five places" listed four, and a sentence dangled off the wrong paragraph.
10. Test 4 still called the source-read miss "the fail-open case" after D7 made
    the fence fail closed.
11. A missing blank line rendered the whole E2E block inside list item 16.
12. Sec 8's "no environment work" contradicted the e2e lane's backoff override.
    Now stated as the single lane-local exception, never set in dev or prod.

## Design review closed

Four rounds, three reviewers, 82 findings, all adjudicated. Rounds 1-2 moved
architecture; round 3 specified inputs; round 4 changed no decision. Next gate is
the founder's, and the one question reserved for it is D23's alarm volume.
