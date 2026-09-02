# Task 11 fix wave 5 cold rereview

## Verdict

PASS / CONFORMS. No P1, P2, or P3 finding in `db825e08` against `3a89654e`.

## Evidence

- The one changed render guard at `dashboard/src/routes/contact/Timeline.tsx:1051-1053` mounts the hidden inbound Relay summary only when `revealed` is false. The recipient list remains the sole owner after reveal at `:1075-1118`; no duplicate named group remains in the revealed accessibility tree.
- Re-collapse restores the summary: the unchanged `toggleMeta` flips `revealed` at `:992-995`, and a recipient-row pointer click bubbles to that handler by the intentional contract at `:1069-1074`. Thus the next collapsed render satisfies the new guard again. Keyboard behavior is unchanged: the bubble remains a non-focusable click-only div, and the collapsed semantic group is the existing screen-reader alternative rather than a second keyboard disclosure control.
- Scope remains inbound Relay only: `inboundRecipientName` requires a non-empty filtered map, `!outbound`, and `rosterKind === 'relay'` at `:976-987`. Direct inbound messages fail `showRecipients` without `relay_sender_key`; outbound and native `group_text` messages fail their respective guards. Filtered entries are established once with `includedRecipientEntries` at `:885` and feed both the summary and revealed rows, so excluded legs cannot diverge between states.
- Versioned transport and time still use the same row facts in both states: the summary passes the version-1 recipient-transport flag at `:978-986`, while rows use it at `:1094-1106`; both use the row's own `deliveredAt`/`sentAt` derived at `:496-500`. The source meta line is still actual-only for every inbound v1 message because `presentMessageTransport` returns only `actualTransport` on its inbound branch (`dashboard/src/lib/messageTransport.ts:119-122`).
- The regression assertion in `dashboard/src/routes/contact/Timeline.test.tsx:1579-1591` confirms the collapsed semantic group is present, then absent after a pointer reveal while the named recipient list is present.

## Focused probe

`npm run test -w @housingchoice/dashboard -- src/routes/contact/Timeline.test.tsx`

Exit 0: 1 file passed, 137 tests passed (4.26s). The first sandboxed attempt could not create Vite's temporary config file (`EPERM`); the identical focused command completed successfully with the required worktree write permission.
