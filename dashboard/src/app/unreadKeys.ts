// unreadKeys - the nav badge's KIND-FREE clear-key vocabulary (spec 4.7.3).
//
// ONE logical inbox row = ONE key on EVERY surface, so two surfaces clearing the
// same row inside one TTL window (an inbox row click plus the tour tab's tab-open
// mark-read) DEDUPE in the pending-clears Map instead of double-decrementing the
// badge.
//
// Deliberately NOT useInbox's `rowKey` vocabulary (`g:` / `gt:` / `c:` / `u:`):
// the channel hooks never know a row's KIND, only that they are holding a
// contactId or a conversationId. Both group kinds (relay_group and group_text)
// therefore collapse to `cv:`, which is what makes the cross-surface dedupe work
// at all. `c:` and `u:` happen to coincide with rowKey's strings; that is a
// coincidence, not a contract - never pass a rowKey here or vice versa.
export function contactClearKey(contactId: string): string {
  return `c:${contactId}`;
}

export function phoneClearKey(phone: string): string {
  return `u:${phone}`;
}

export function conversationClearKey(conversationId: string): string {
  return `cv:${conversationId}`;
}
