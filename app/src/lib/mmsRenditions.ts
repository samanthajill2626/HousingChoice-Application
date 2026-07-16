// renditionFor -- the seam that picks which stored key to send for a channel
// (spec Sec 5, RCS-forward). Today the only channel is 'mms', which sends the
// deliverable rendition (s3Key). When RCS ships it adds a branch here that returns
// the originalKey (or an rcs rendition) -- an additive change, not a rewrite.
import type { MediaAttachment } from '../repos/messagesRepo.js';

export type SendChannel = 'mms';

// TODO(mms-originalkey-unvalidated-pre-rcs): before an 'rcs' channel returns
// attachment.originalKey here, HeadObject-validate it (existence + own-prefix) -
// today only s3Key is validated/presigned, so originalKey is persisted but inert.
export function renditionFor(channel: SendChannel, attachment: MediaAttachment): { s3Key: string } {
  switch (channel) {
    case 'mms':
      return { s3Key: attachment.s3Key };
    default: {
      const exhaustive: never = channel;
      return exhaustive;
    }
  }
}
