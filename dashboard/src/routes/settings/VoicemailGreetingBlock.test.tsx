// VoicemailGreetingBlock tests - Settings > Voice > "Voicemail greeting"
// (voicemail-greeting spec 4.7). The API layer (getSettings /
// uploadVoicemailGreeting / removeVoicemailGreeting) and the session
// (useOptionalAuth, with a flippable admin flag) are MOCKED, so nothing here
// touches the backend. A LOAD failure is a status line, never an alert;
// user-action failures are alerts; a failed Remove reports inside its dialog.
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { OrgSettings, SettingsResponse, VoicemailGreeting } from '../../api/index.js';

const getSettings = vi.fn();
const uploadVoicemailGreeting = vi.fn();
const removeVoicemailGreeting = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getSettings: (...a: unknown[]) => getSettings(...a),
    uploadVoicemailGreeting: (...a: unknown[]) => uploadVoicemailGreeting(...a),
    removeVoicemailGreeting: (...a: unknown[]) => removeVoicemailGreeting(...a),
  };
});

let isAdmin = true;
vi.mock('../../app/AuthContext.js', () => ({
  useOptionalAuth: () => ({
    status: 'authenticated',
    me: { userId: 'u1', email: 'x@example.com', role: isAdmin ? 'admin' : 'va' },
    isAdmin,
    refresh: vi.fn(),
  }),
}));

import { VoicemailGreetingBlock } from './VoicemailGreetingBlock.js';
import {
  GREETING_EMPTY_MESSAGE,
  GREETING_FORBIDDEN_MESSAGE,
  GREETING_REJECT_MESSAGE,
  GREETING_TOO_LARGE_MESSAGE,
  greetingContentTypeFor,
} from './useVoicemailGreeting.js';

const BASE: OrgSettings = {
  missedCallAutoText: 'Sorry I missed you.',
  missedCallAutoTextEnabled: true,
  quickReplies: ['Please text me'],
  preRingPauseSeconds: 2,
  quietHoursEnabled: true,
  quietHoursStart: '21:00',
  quietHoursEnd: '08:00',
  timezone: 'America/New_York',
};
const GREETING: VoicemailGreeting = {
  s3Key: 'settings/voicemail-greeting',
  contentType: 'audio/mpeg',
  fileName: 'sam-greeting.mp3',
  sizeBytes: 427,
  uploadedAt: '2026-09-26T12:00:00.000Z',
  uploadedByUserId: 'u1',
  uploadedByEmail: 'founder@example.com',
};
const wrap = (settings: OrgSettings): SettingsResponse => ({ settings, welcomeTextDefault: 'Welcome' });
const mp3 = (name = 'g.mp3', type = 'audio/mpeg', size = 3) => new File([new Uint8Array(size)], name, { type });
// applyAccept: false - user-event 14 otherwise DROPS a file whose type is not in
// the input's `accept` list (no change event, no alert), which would make the
// M4A-reject test time out for a reason unrelated to the code under test.
const user = userEvent.setup({ applyAccept: false });

beforeEach(() => {
  vi.clearAllMocks();
  isAdmin = true;
  getSettings.mockResolvedValue(wrap(BASE));
});

describe('VoicemailGreetingBlock', () => {
  it('admin, no greeting: status line + Upload button, no alert', async () => {
    render(<VoicemailGreetingBlock />);
    expect(await screen.findByText('No greeting uploaded - callers hear the built-in prompt.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Voicemail greeting', level: 3 })).toBeInTheDocument();
    // Spec 4.7 copy, verbatim (the JSX spans three source lines).
    expect(screen.getByText(/^When a call to the business line/).textContent).toBe(
      "When a call to the business line isn't answered, callers hear this greeting before the beep. " +
        'Upload an MP3 or WAV file up to 5 MB. iPhone voice memos are M4A; export or convert the ' +
        'recording first. Without a greeting, callers hear the built-in spoken prompt.',
    );
    expect(screen.getByRole('button', { name: 'Upload greeting' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('VA sees the block without any action buttons', async () => {
    isAdmin = false;
    getSettings.mockResolvedValue(wrap({ ...BASE, voicemailGreeting: GREETING }));
    render(<VoicemailGreetingBlock />);
    expect(await screen.findByText('sam-greeting.mp3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /greeting/i })).not.toBeInTheDocument();
    expect(screen.getByText(/An admin can upload or change it/)).toBeInTheDocument();
    expect(screen.getByText(/^When a call to the business line/).textContent).toMatch(
      /built-in spoken prompt\. An admin can upload or change it\.$/,
    );
  });

  it('a load failure renders a status line with Retry and NO alert', async () => {
    getSettings.mockRejectedValueOnce(new ApiError(0, 'network_error', 'x'));
    render(<VoicemailGreetingBlock />);
    expect(await screen.findByText("Couldn't load the voicemail greeting.")).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    getSettings.mockResolvedValue(wrap(BASE));
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No greeting uploaded - callers hear the built-in prompt.')).toBeInTheDocument();
  });

  // Drift worklist F8: the file input exists only once the greeting has LOADED.
  // The repo's sr-only file inputs stay in the tab order, so an input rendered
  // during the initial GET would let a keyboard user start an upload that the
  // GET's stale response then overwrites.
  it('renders no file input while the initial load is pending, then renders it once loaded', async () => {
    let resolveLoad: (res: SettingsResponse) => void = () => {};
    getSettings.mockReturnValue(
      new Promise<SettingsResponse>((resolve) => {
        resolveLoad = resolve;
      }),
    );
    render(<VoicemailGreetingBlock />);
    expect(screen.getByRole('heading', { name: 'Voicemail greeting', level: 3 })).toBeInTheDocument();
    expect(screen.queryByLabelText('Greeting audio file')).toBeNull();
    resolveLoad(wrap(BASE));
    expect(await screen.findByLabelText('Greeting audio file')).toBeInTheDocument();
  });

  it('while an upload is in flight the button reads Uploading... and the file input is disabled', async () => {
    let resolveUpload: (g: VoicemailGreeting) => void = () => {};
    uploadVoicemailGreeting.mockReturnValue(
      new Promise<VoicemailGreeting>((resolve) => {
        resolveUpload = resolve;
      }),
    );
    render(<VoicemailGreetingBlock />);
    await screen.findByRole('button', { name: 'Upload greeting' });
    await user.upload(screen.getByLabelText('Greeting audio file'), mp3());
    expect(screen.getByRole('button', { name: 'Uploading...' })).toBeDisabled();
    expect(screen.getByLabelText('Greeting audio file')).toBeDisabled();
    resolveUpload(GREETING);
    expect(await screen.findByText('Greeting uploaded.')).toBeInTheDocument();
    expect(screen.getByLabelText('Greeting audio file')).toBeEnabled();
  });

  it('an audio/mp4 file shows the reject message WITHOUT calling the endpoint', async () => {
    render(<VoicemailGreetingBlock />);
    await screen.findByRole('button', { name: 'Upload greeting' });
    await user.upload(screen.getByLabelText('Greeting audio file'), mp3('memo.m4a', 'audio/mp4'));
    expect(await screen.findByRole('alert')).toHaveTextContent(GREETING_REJECT_MESSAGE);
    expect(uploadVoicemailGreeting).not.toHaveBeenCalled();
  });

  it('an EMPTY type with a .mp3 name is sent as audio/mpeg (the server decides by header)', async () => {
    uploadVoicemailGreeting.mockResolvedValue(GREETING);
    render(<VoicemailGreetingBlock />);
    await screen.findByRole('button', { name: 'Upload greeting' });
    await user.upload(screen.getByLabelText('Greeting audio file'), mp3('sam-greeting.mp3', ''));
    await waitFor(() => expect(uploadVoicemailGreeting).toHaveBeenCalledWith(expect.any(File), 'audio/mpeg'));
  });

  it('a 6 MB file shows the size message without a call; an empty file shows the empty message', async () => {
    render(<VoicemailGreetingBlock />);
    await screen.findByRole('button', { name: 'Upload greeting' });
    const big = new File([new Uint8Array(6 * 1024 * 1024)], 'big.mp3', { type: 'audio/mpeg' });
    await user.upload(screen.getByLabelText('Greeting audio file'), big);
    expect(await screen.findByRole('alert')).toHaveTextContent(GREETING_TOO_LARGE_MESSAGE);
    await user.upload(screen.getByLabelText('Greeting audio file'), mp3('empty.mp3', 'audio/mpeg', 0));
    expect(await screen.findByRole('alert')).toHaveTextContent(GREETING_EMPTY_MESSAGE);
    expect(uploadVoicemailGreeting).not.toHaveBeenCalled();
  });

  it('a valid file uploads and renders name, date, player and Replace/Remove', async () => {
    uploadVoicemailGreeting.mockResolvedValue(GREETING);
    render(<VoicemailGreetingBlock />);
    await screen.findByRole('button', { name: 'Upload greeting' });
    await user.upload(screen.getByLabelText('Greeting audio file'), mp3());
    expect(await screen.findByText('Greeting uploaded.')).toBeInTheDocument();
    expect(screen.getByText('sam-greeting.mp3')).toBeInTheDocument();
    expect(screen.getByText(/Uploaded .* by founder@example.com/)).toBeInTheDocument();
    const audio = screen.getByLabelText('Voicemail greeting') as HTMLAudioElement;
    expect(audio.tagName).toBe('AUDIO');
    expect(audio.getAttribute('src')).toContain('/api/settings/voicemail-greeting/audio?v=');
    expect(audio.getAttribute('preload')).toBe('metadata');
    expect(screen.getByRole('button', { name: 'Replace greeting' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove greeting' })).toBeInTheDocument();
  });

  it("the player's error event renders the missing-file status line", async () => {
    getSettings.mockResolvedValue(wrap({ ...BASE, voicemailGreeting: GREETING }));
    render(<VoicemailGreetingBlock />);
    const audio = await screen.findByLabelText('Voicemail greeting');
    fireEvent.error(audio);
    expect(await screen.findByText("The greeting file is missing or can't be played. Upload it again.")).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('Remove: dialog, Cancel makes no call; Remove calls the endpoint and returns to the empty state', async () => {
    getSettings.mockResolvedValue(wrap({ ...BASE, voicemailGreeting: GREETING }));
    removeVoicemailGreeting.mockResolvedValue(undefined);
    render(<VoicemailGreetingBlock />);
    await user.click(await screen.findByRole('button', { name: 'Remove greeting' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove voicemail greeting?' });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(removeVoicemailGreeting).not.toHaveBeenCalled();
    expect(dialog).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove greeting' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Greeting removed.')).toBeInTheDocument();
    expect(screen.getByText('No greeting uploaded - callers hear the built-in prompt.')).toBeInTheDocument();
    expect(removeVoicemailGreeting).toHaveBeenCalledTimes(1);
  });

  it('a forbidden upload renders the admin-only message as an alert', async () => {
    uploadVoicemailGreeting.mockRejectedValue(new ApiError(403, 'forbidden', 'forbidden'));
    render(<VoicemailGreetingBlock />);
    await screen.findByRole('button', { name: 'Upload greeting' });
    await user.upload(screen.getByLabelText('Greeting audio file'), mp3());
    expect(await screen.findByRole('alert')).toHaveTextContent(GREETING_FORBIDDEN_MESSAGE);
  });

  it('a failed Remove keeps the dialog open and shows the error INSIDE it (exactly one alert)', async () => {
    getSettings.mockResolvedValue(wrap({ ...BASE, voicemailGreeting: GREETING }));
    removeVoicemailGreeting.mockRejectedValue(new ApiError(500, 'http_500', 'boom'));
    render(<VoicemailGreetingBlock />);
    await user.click(await screen.findByRole('button', { name: 'Remove greeting' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove voicemail greeting?' });
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    const alerts = await screen.findAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(dialog).toContainElement(alerts[0]!);
    expect(alerts[0]).toHaveTextContent("Couldn't remove the greeting. Try again.");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('sam-greeting.mp3')).toBeInTheDocument();
  });

  it('a stale upload rejection is NOT shown inside the Remove dialog', async () => {
    getSettings.mockResolvedValue(wrap({ ...BASE, voicemailGreeting: GREETING }));
    render(<VoicemailGreetingBlock />);
    await screen.findByRole('button', { name: 'Replace greeting' });
    await user.upload(screen.getByLabelText('Greeting audio file'), mp3('memo.m4a', 'audio/mp4'));
    expect(await screen.findByRole('alert')).toHaveTextContent(GREETING_REJECT_MESSAGE);
    await user.click(screen.getByRole('button', { name: 'Remove greeting' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove voicemail greeting?' });
    expect(dialog).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('greetingContentTypeFor (browser MIME aliases, spec 4.7)', () => {
  const file = (name: string, type: string) => new File([new Uint8Array(3)], name, { type });
  it('canonicalizes the aliases browsers report', () => {
    expect(greetingContentTypeFor(file('a.mp3', 'audio/mpeg'))).toBe('audio/mpeg');
    expect(greetingContentTypeFor(file('a.mp3', 'audio/mp3'))).toBe('audio/mpeg');
    expect(greetingContentTypeFor(file('a.wav', 'audio/wav'))).toBe('audio/wav');
    expect(greetingContentTypeFor(file('a.wav', 'audio/x-wav'))).toBe('audio/wav');
    expect(greetingContentTypeFor(file('a.wav', 'audio/wave'))).toBe('audio/wav');
    expect(greetingContentTypeFor(file('a.wav', 'audio/vnd.wave'))).toBe('audio/wav');
  });
  it('infers from the extension only when the type is EMPTY, else rejects', () => {
    expect(greetingContentTypeFor(file('memo.MP3', ''))).toBe('audio/mpeg');
    expect(greetingContentTypeFor(file('memo.wav', ''))).toBe('audio/wav');
    expect(greetingContentTypeFor(file('memo.m4a', ''))).toBeUndefined();
    expect(greetingContentTypeFor(file('memo.mp3', 'audio/mp4'))).toBeUndefined();
    expect(greetingContentTypeFor(file('memo.mp3', 'video/mp4'))).toBeUndefined();
  });
});
