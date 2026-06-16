// CallEntry tests (M1.9) — a voice-call timeline entry renders as metadata:
//   • a masked relay call shows the masked label + direction + outcome badge,
//     and NEVER a recording/transcript control (defensive),
//   • a founder-bridge call (masked:false) with a recording renders an <audio>
//     pointed at the auth-gated same-origin endpoint, and a collapsible
//     verbatim transcript,
//   • the duration shows (m:ss) only on an answered call.
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Message } from '../../api';
import { CallEntry, formatDuration } from './CallEntry';

/** A `type:'call'` message with sensible defaults; override per case. */
function call(over: Partial<Message> = {}): Message {
  return {
    conversationId: 'c1',
    tsMsgId: 'tc#CA1',
    type: 'call',
    direction: 'inbound',
    author: 'unknown',
    provider_sid: 'CA1',
    provider_ts: '2026-06-13T00:00:00.000Z',
    delivery_status: 'queued',
    created_at: '2026-06-13T00:00:00.000Z',
    ...over,
  };
}

/** CallEntry renders an <li>; wrap it in a <ul> for valid markup. */
function renderEntry(message: Message): HTMLElement {
  const { container } = render(
    <ul>
      <CallEntry message={message} />
    </ul>,
  );
  return container;
}

describe('formatDuration', () => {
  it('formats whole seconds as m:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9)).toBe('0:09');
    expect(formatDuration(75)).toBe('1:15');
    expect(formatDuration(600)).toBe('10:00');
  });
});

describe('<CallEntry> — masked relay call', () => {
  it('renders the masked label, direction, and outcome badge', () => {
    renderEntry(
      call({
        masked: true,
        direction: 'inbound',
        call_outcome: 'missed',
        call_party_label: 'Tenant',
      }),
    );
    expect(screen.getByText('Tenant')).toBeInTheDocument();
    expect(screen.getByText('Inbound call')).toBeInTheDocument();
    expect(screen.getByText('Missed')).toBeInTheDocument();
  });

  it('NEVER renders a recording or transcript control', () => {
    const { container } = render(
      <ul>
        <CallEntry
          message={call({ masked: true, call_outcome: 'missed', call_party_label: 'Landlord' })}
        />
      </ul>,
    );
    // No <audio>, no transcript toggle.
    expect(container.querySelector('audio')).toBeNull();
    expect(screen.queryByRole('button', { name: /transcript/i })).not.toBeInTheDocument();
  });

  it('shows the duration (m:ss) only on an answered call', () => {
    // Missed → no duration shown even if one were present.
    renderEntry(call({ masked: true, call_outcome: 'missed', call_duration: 30 }));
    expect(screen.queryByLabelText('Call duration')).not.toBeInTheDocument();

    // Answered → duration shown.
    renderEntry(
      call({ masked: true, call_outcome: 'answered', call_duration: 95, call_party_label: 'Tenant' }),
    );
    expect(screen.getByLabelText('Call duration')).toHaveTextContent('1:35');
  });
});

describe('<CallEntry> — founder-bridge call (masked:false)', () => {
  const founderCall = call({
    masked: false,
    direction: 'outbound',
    call_outcome: 'answered',
    call_duration: 123,
    call_party_label: 'Landlord',
    recording_s3_key: 'recordings/CA1.mp3',
    recording_duration: 123,
    transcript: 'Hi, this is a verbatim transcript of the call.',
  });

  it('renders an <audio> pointed at the auth-gated same-origin recording endpoint', () => {
    const { container } = render(
      <ul>
        <CallEntry message={founderCall} />
      </ul>,
    );
    const audio = container.querySelector('audio');
    expect(audio).not.toBeNull();
    // Same-origin, cookie-auth endpoint keyed by the CallSid (provider_sid).
    expect(audio?.getAttribute('src')).toBe('/api/calls/CA1/recording');
  });

  it('renders a collapsible transcript that reveals the verbatim text', () => {
    render(
      <ul>
        <CallEntry message={founderCall} />
      </ul>,
    );
    // Collapsed by default — the verbatim text is not shown yet.
    expect(
      screen.queryByText('Hi, this is a verbatim transcript of the call.'),
    ).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: 'Transcript' });
    fireEvent.click(toggle);

    expect(
      screen.getByText('Hi, this is a verbatim transcript of the call.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide transcript' })).toBeInTheDocument();
  });

  it('does not render the audio/transcript controls when those fields are absent', () => {
    // A founder-bridge call that simply has no recording/transcript yet.
    const { container } = render(
      <ul>
        <CallEntry message={call({ masked: false, call_outcome: 'answered', call_duration: 10 })} />
      </ul>,
    );
    expect(container.querySelector('audio')).toBeNull();
    expect(screen.queryByRole('button', { name: /transcript/i })).not.toBeInTheDocument();
  });
});
