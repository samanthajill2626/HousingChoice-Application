// planMmsBatches - split one outbound send's attachments across as many MMS
// messages as it takes for EVERY message to fit the carrier budget.
//
// Why this exists: a 2.93 MB / 7-attachment MMS is accepted by Twilio, dropped
// by the carrier, and never reported back (docs/issues/
// outbound-mms-stalls-at-sent-with-no-receipt.md). The caps in
// outboundMediaLimits.ts keep a single message under budget; this module is what
// keeps a LARGE send working anyway instead of refusing it.
//
// Pure and synchronous on purpose: batching is a decision about sizes, and the
// send route stays the only thing that talks to the network.

import {
  OUTBOUND_MMS_MAX_MEDIA_PER_MESSAGE,
  OUTBOUND_MMS_MAX_TOTAL_BYTES,
} from './outboundMediaLimits.js';

/** One attachment's identity + the DELIVERABLE rendition's size in bytes. */
export interface SizedAttachment {
  sizeBytes: number;
}

export interface BatchLimits {
  maxBytes: number;
  maxCount: number;
}

export const DEFAULT_BATCH_LIMITS: BatchLimits = {
  maxBytes: OUTBOUND_MMS_MAX_TOTAL_BYTES,
  maxCount: OUTBOUND_MMS_MAX_MEDIA_PER_MESSAGE,
};

/**
 * Pack `items` into ordered batches, each within BOTH limits.
 *
 * ORDER IS PRESERVED. A greedy first-fit-by-position, not a bin-packing
 * optimum: the recipient sees the photos in the order the sender picked them,
 * and a tighter packing that reorders them would be a worse product for a few
 * saved bytes.
 *
 * An item bigger than `maxBytes` on its own CANNOT be made to fit by batching -
 * it gets a batch of its own and is reported in `oversized`. That is a real
 * possibility (a single 3 MB source that failed to transcode), and it is the
 * caller's business whether to refuse the send or let it through: this function
 * never silently drops an attachment.
 *
 * A zero-length input yields zero batches (a text-only send), never one empty
 * batch that would post a blank message.
 */
export function planMmsBatches<T extends SizedAttachment>(
  items: readonly T[],
  limits: BatchLimits = DEFAULT_BATCH_LIMITS,
): { batches: T[][]; oversized: T[] } {
  const batches: T[][] = [];
  const oversized: T[] = [];
  let current: T[] = [];
  let currentBytes = 0;

  const flush = (): void => {
    if (current.length > 0) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
  };

  for (const item of items) {
    const size = Number.isFinite(item.sizeBytes) && item.sizeBytes > 0 ? item.sizeBytes : 0;
    // Too big to EVER fit: give it its own message rather than wedging the
    // packer (an item that can never fit would otherwise flush forever).
    if (size > limits.maxBytes) {
      flush();
      batches.push([item]);
      oversized.push(item);
      continue;
    }
    const wouldExceedBytes = currentBytes + size > limits.maxBytes;
    const wouldExceedCount = current.length + 1 > limits.maxCount;
    if (current.length > 0 && (wouldExceedBytes || wouldExceedCount)) {
      flush();
    }
    current.push(item);
    currentBytes += size;
  }
  flush();

  return { batches, oversized };
}
