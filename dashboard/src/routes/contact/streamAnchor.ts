/** Scroll anchoring for the message stream, as a pure function of two numbers.
 *
 *  The stream used to end at the newest message, so ONE boolean ("is the
 *  scroller within 48px of its true bottom?") could drive both the stick-to-
 *  bottom pin and the "New messages" pill. Once the Upcoming block moved INSIDE
 *  the scroller there is content BELOW the newest message, and those two gates
 *  want opposite answers for an operator standing on that block: the strict
 *  reading lights the pill forever, the loose reading fires the pin and yanks
 *  them off it.
 *
 *  So the boolean becomes three values, derived from a zero-height SENTINEL
 *  rendered between the last message cluster and the Upcoming block:
 *
 *  | anchor     | when                                                   |
 *  | ---------- | ------------------------------------------------------ |
 *  | 'sentinel' | the sentinel's bottom is at or below the viewport
 *                 bottom, within STREAM_ANCHOR_SLACK_PX                  |
 *  | 'below'    | the sentinel's bottom is ABOVE the viewport bottom by
 *                 ANY amount - the operator is on the block              |
 *  | null       | the sentinel is more than the slack below the viewport
 *                 bottom - the operator scrolled up to read history      |
 *
 *  `below` is defined by DIRECTION, not by slack, which is what keeps it
 *  reachable when the block is shorter than the slack band. The pill lights only
 *  on `null`; the pin never fires on `null`.
 *
 *  Pure by construction (plain numbers, no elements): jsdom performs no layout,
 *  so this is the only half of the anchoring a unit test can prove. The
 *  measurement itself - and therefore the anchoring - is an e2e assertion.
 */

export type StreamAnchor = 'sentinel' | 'below' | null;

/** Slack for sub-pixel rounding and a partially-visible last row. Carried over
 *  verbatim from the `isAtBottom` closure this function replaces, so a thread
 *  with no Upcoming block behaves exactly as it did before. */
export const STREAM_ANCHOR_SLACK_PX = 48;

export interface StreamAnchorInput {
  /** The sentinel's bottom edge, in viewport coordinates. */
  sentinelBottom: number;
  /** The scroll container's bottom edge, in the SAME coordinate space. */
  viewportBottom: number;
  /** Whether an Upcoming block is rendered below the sentinel. With no block
   *  `below` is unreachable by construction and the two remaining bands
   *  reproduce the old `isAtBottom` semantics exactly. */
  hasBlock: boolean;
}

export function deriveStreamAnchor({
  sentinelBottom,
  viewportBottom,
  hasBlock,
}: StreamAnchorInput): StreamAnchor {
  const delta = sentinelBottom - viewportBottom;
  if (delta > STREAM_ANCHOR_SLACK_PX) return null;
  // Above the fold by any amount and there IS something under the sentinel: the
  // operator scrolled past the newest message onto the block deliberately.
  if (delta < 0 && hasBlock) return 'below';
  // Everything else is "at the newest message". Note this includes a NEGATIVE
  // delta with no block, which is a fractional over-scroll and was `true` under
  // `scrollHeight - scrollTop - clientHeight <= 48` too.
  return 'sentinel';
}
