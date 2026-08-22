// Tests for the service worker's notification DISPLAY building.
//
// The regression this locks (observed live on prod, 2026-08-16): pre_ring,
// missed_call and voicemail for one call all used the bare CallSid as their
// notification tag, so each later push REPLACED the earlier one in the shade.
// A pre-ring that arrived fine looked like it never came, and a deferred-push
// flush collapsed a whole call into one entry. Tags are now per-kind
// ("<kind>:<id>"), so one call's alerts coexist like a native phone app's
// incoming-call / missed-call / voicemail entries.
//
// public/sw.js inlines a VERBATIM copy of these functions (a classic worker
// cannot import an ES module). If you change one, change both - the copy in
// sw.js is what actually runs in the browser; this module is what is tested.
import { describe, it, expect } from 'vitest';
import { notificationTag, buildNotificationOptions, staleTagsFor } from './display.js';

describe('notificationTag', () => {
  it('gives each push kind for one call its OWN tag - the shade must not collapse them', () => {
    const preRing = notificationTag({ kind: 'pre_ring', callId: 'CA123', conversationId: 'conv-1' });
    const missed = notificationTag({ kind: 'missed_call', callId: 'CA123', conversationId: 'conv-1' });
    const voicemail = notificationTag({ kind: 'voicemail', callId: 'CA123', conversationId: 'conv-1' });
    expect(preRing).toBe('pre_ring:CA123');
    expect(missed).toBe('missed_call:CA123');
    expect(voicemail).toBe('voicemail:CA123');
    expect(new Set([preRing, missed, voicemail]).size).toBe(3);
  });

  it('coalesces message pushes per conversation, like a native SMS thread', () => {
    expect(notificationTag({ kind: 'message', conversationId: 'conv-7' })).toBe('message:conv-7');
  });

  it('prefers callId over conversationId as the id half', () => {
    expect(notificationTag({ kind: 'missed_call', callId: 'CA9', conversationId: 'conv-9' })).toBe(
      'missed_call:CA9',
    );
  });

  it('falls back to the bare id when kind is missing, and to undefined when no id exists', () => {
    expect(notificationTag({ callId: 'CA5' })).toBe('CA5');
    expect(notificationTag({ kind: 'test' })).toBeUndefined();
    expect(notificationTag({})).toBeUndefined();
    expect(notificationTag(undefined)).toBeUndefined();
  });

  it('gives unmatched_email a QUEUE-level tag - one shade entry for the whole triage queue', () => {
    // No unmatchedId travels in the payload (the C1 data allowlist is
    // {kind, callId, conversationId}), and the entry represents the QUEUE,
    // not one item: each new arrival replaces it in place.
    expect(notificationTag({ kind: 'unmatched_email' })).toBe('unmatched_email');
  });

  it('unmatched_email tag ignores stray ids (queue-level, always)', () => {
    expect(notificationTag({ kind: 'unmatched_email', conversationId: 'conv-9' })).toBe(
      'unmatched_email',
    );
    expect(notificationTag({ kind: 'unmatched_email', callId: 'CA9' })).toBe('unmatched_email');
  });
});

describe('buildNotificationOptions', () => {
  it('uses runtime identity for the main icon and preserves the monochrome badge', () => {
    const built = buildNotificationOptions({ kind: 'message', conversationId: 'conv-1' });
    expect(built.options.icon).toBe('/app-identity/icon-192.png');
    expect(built.options.badge).toBe('/icons/badge-72.png');
  });

  it('marks pre_ring and missed_call time-sensitive (renotify + requireInteraction), voicemail not', () => {
    const preRing = buildNotificationOptions({ kind: 'pre_ring', callId: 'CA1' });
    const missed = buildNotificationOptions({ kind: 'missed_call', callId: 'CA1' });
    const voicemail = buildNotificationOptions({ kind: 'voicemail', callId: 'CA1' });
    expect(preRing.options.renotify).toBe(true);
    expect(preRing.options.requireInteraction).toBe(true);
    expect(missed.options.renotify).toBe(true);
    expect(missed.options.requireInteraction).toBe(true);
    expect(voicemail.options.renotify).toBe(false);
    expect(voicemail.options.requireInteraction).toBe(false);
  });

  it('never sets renotify without a tag - setting it tagless throws in the browser', () => {
    const tagless = buildNotificationOptions({ kind: 'pre_ring' });
    expect(tagless.options.tag).toBeUndefined();
    expect(tagless.options.renotify).toBe(false);
  });

  it('carries ONLY the known routing fields into options.data (C1: no payload url)', () => {
    const built = buildNotificationOptions({
      kind: 'missed_call',
      callId: 'CA2',
      conversationId: 'conv-2',
      // @ts-expect-error - a hostile payload can carry anything
      url: 'https://evil.example/phish',
    });
    expect(built.options.data).toEqual({ kind: 'missed_call', callId: 'CA2', conversationId: 'conv-2' });
  });

  it('message pushes renotify (alert per message) while staying non-time-sensitive', () => {
    // D2: without renotify a same-tag replacement is SILENT, so every message
    // after the first in a thread would land without a peep - the opposite of
    // native messaging. It still must NOT pin itself to the shade.
    const built = buildNotificationOptions({ kind: 'message', conversationId: 'conv-1' });
    expect(built.options.renotify).toBe(true);
    expect(built.options.requireInteraction).toBe(false);
    expect(built.options.tag).toBe('message:conv-1');
  });

  it('unmatched_email pushes use the queue-level tag and renotify', () => {
    const built = buildNotificationOptions({ kind: 'unmatched_email', title: 'Vendor' });
    expect(built.options.tag).toBe('unmatched_email');
    expect(built.options.renotify).toBe(true);
    expect(built.options.requireInteraction).toBe(false);
  });

  it('requireInteraction remains exactly missed_call/pre_ring', () => {
    for (const kind of ['message', 'unmatched_email', 'voicemail', 'test']) {
      expect(
        buildNotificationOptions({ kind, callId: 'x', conversationId: 'y' }).options
          .requireInteraction,
      ).toBe(false);
    }
    expect(buildNotificationOptions({ kind: 'missed_call', callId: 'x' }).options.requireInteraction).toBe(
      true,
    );
    expect(buildNotificationOptions({ kind: 'pre_ring', callId: 'x' }).options.requireInteraction).toBe(
      true,
    );
  });

  it('never sets renotify without a tag, for an ALERTING kind either', () => {
    // `renotify` REQUIRES a tag - setting it tagless throws in the browser.
    // A message push with no conversationId has no tag, so it must not renotify.
    const tagless = buildNotificationOptions({ kind: 'message' });
    expect(tagless.options.tag).toBeUndefined();
    expect(tagless.options.renotify).toBe(false);
  });

  it('falls back to the app title, always vibrates, and caps actions at two', () => {
    const built = buildNotificationOptions({
      actions: [
        { action: 'a', title: 'A' },
        { action: 'b', title: 'B' },
        { action: 'c', title: 'C' },
      ],
    });
    expect(built.title).toBe('HousingChoice');
    expect(built.options.vibrate).toEqual([200, 100, 200]);
    expect(built.options.actions).toHaveLength(2);
  });
});

describe('staleTagsFor', () => {
  it('closes the incoming-call alert once the call has resolved to missed/voicemail', () => {
    // Native-phone semantics: "Incoming call" is transient; once the call is
    // over it is stale (and requireInteraction would pin it forever).
    expect(staleTagsFor({ kind: 'missed_call', callId: 'CA3' })).toEqual(['pre_ring:CA3']);
    expect(staleTagsFor({ kind: 'voicemail', callId: 'CA3' })).toEqual(['pre_ring:CA3']);
  });

  it('closes nothing for pre_ring, message, test, or a resolve push missing its callId', () => {
    expect(staleTagsFor({ kind: 'pre_ring', callId: 'CA4' })).toEqual([]);
    expect(staleTagsFor({ kind: 'message', conversationId: 'conv-4' })).toEqual([]);
    expect(staleTagsFor({ kind: 'test' })).toEqual([]);
    expect(staleTagsFor({ kind: 'missed_call' })).toEqual([]);
    expect(staleTagsFor(undefined)).toEqual([]);
  });
});
