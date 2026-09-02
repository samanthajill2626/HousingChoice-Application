import { describe, expect, it } from 'vitest';
import { castItems } from '../src/lib/seed/cast.js';

describe('cast message transport declarations', () => {
  it('records MMS and media scenarios with explicit MMS actual transport', () => {
    const messages = castItems()['messages'] ?? [];
    const mmsOrMedia = messages.filter((message) =>
      message['type'] === 'mms' || (Array.isArray(message['media_attachments']) && message['media_attachments'].length > 0),
    );

    expect(mmsOrMedia.length).toBeGreaterThan(0);
    for (const message of mmsOrMedia) {
      expect(message).toMatchObject({ transport_schema_version: 1, actual_transport: 'mms' });
    }
  });
});
