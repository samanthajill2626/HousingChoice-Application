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
  GREETING_STORAGE_MESSAGE,
  GREETING_TOO_LARGE_MESSAGE,
  GREETING_UPLOAD_FAILED_MESSAGE,
  greetingContentTypeFor,
} from './useVoicemailGreeting.js';

const MISSING_FILE = "The greeting file is missing or can't be played. Upload it again.";

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

  // Fix wave R1, FW3 (spec 4.3 Concurrency: the record-without-object state is
  // rendered visibly "so it is repaired by a re-upload rather than found by a
  // caller"). A REFUSED Replace leaves the same broken player mounted, and its
  // <audio> never re-fires error because its src did not change - so the line
  // may clear only when the src changes (a successful upload or replace).
  it('after the player errors, a CLIENT-refused Replace (audio/mp4) keeps the missing-file line', async () => {
    getSettings.mockResolvedValue(wrap({ ...BASE, voicemailGreeting: GREETING }));
    render(<VoicemailGreetingBlock />);
    fireEvent.error(await screen.findByLabelText('Voicemail greeting'));
    expect(await screen.findByText(MISSING_FILE)).toBeInTheDocument();
    await user.upload(screen.getByLabelText('Greeting audio file'), mp3('memo.m4a', 'audio/mp4'));
    expect(await screen.findByRole('alert')).toHaveTextContent(GREETING_REJECT_MESSAGE);
    expect(uploadVoicemailGreeting).not.toHaveBeenCalled();
    expect(screen.getByText(MISSING_FILE)).toBeInTheDocument();
  });

  it('after the player errors, a SERVER-refused Replace (unsupported_media_type) keeps the missing-file line', async () => {
    getSettings.mockResolvedValue(wrap({ ...BASE, voicemailGreeting: GREETING }));
    uploadVoicemailGreeting.mockRejectedValue(new ApiError(400, 'unsupported_media_type', 'unsupported_media_type'));
    render(<VoicemailGreetingBlock />);
    fireEvent.error(await screen.findByLabelText('Voicemail greeting'));
    expect(await screen.findByText(MISSING_FILE)).toBeInTheDocument();
    await user.upload(screen.getByLabelText('Greeting audio file'), mp3());
    expect(await screen.findByRole('alert')).toHaveTextContent(GREETING_REJECT_MESSAGE);
    expect(uploadVoicemailGreeting).toHaveBeenCalledTimes(1);
    expect(screen.getByText(MISSING_FILE)).toBeInTheDocument();
  });

  it('after the player errors, a SUCCESSFUL Replace (new uploadedAt, so a new src) clears the line; an error on the new src shows it again', async () => {
    getSettings.mockResolvedValue(wrap({ ...BASE, voicemailGreeting: GREETING }));
    uploadVoicemailGreeting.mockResolvedValue({ ...GREETING, fileName: 'new.mp3', uploadedAt: '2026-09-27T09:00:00.000Z' });
    render(<VoicemailGreetingBlock />);
    const audio = await screen.findByLabelText('Voicemail greeting');
    const oldSrc = audio.getAttribute('src');
    fireEvent.error(audio);
    expect(await screen.findByText(MISSING_FILE)).toBeInTheDocument();
    await user.upload(screen.getByLabelText('Greeting audio file'), mp3('new.mp3'));
    expect(await screen.findByText('Greeting replaced.')).toBeInTheDocument();
    const replaced = screen.getByLabelText('Voicemail greeting');
    expect(replaced.getAttribute('src')).not.toBe(oldSrc);
    expect(screen.queryByText(MISSING_FILE)).not.toBeInTheDocument();
    fireEvent.error(replaced);
    expect(await screen.findByText(MISSING_FILE)).toBeInTheDocument();
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

  // Fix wave R1, FW5 (plan Review Focus 1; spec 4.7 server error map). The M4A
  // and 6 MB cases above are CLIENT pre-checks that never reach the endpoint;
  // these are the SERVER's refusal codes, each rendered as exactly its spec
  // message after exactly one call.
  it.each([
    ['unsupported_media_type', 400, GREETING_REJECT_MESSAGE],
    ['file_too_large', 413, GREETING_TOO_LARGE_MESSAGE],
    ['empty_file', 400, GREETING_EMPTY_MESSAGE],
    ['media_storage_unavailable', 503, GREETING_STORAGE_MESSAGE],
    ['forbidden', 403, GREETING_FORBIDDEN_MESSAGE],
    ['http_500', 500, GREETING_UPLOAD_FAILED_MESSAGE], // any other code: the fallback
  ])('a server %s (HTTP %i) upload refusal renders exactly its spec 4.7 message', async (code, status, message) => {
    uploadVoicemailGreeting.mockRejectedValue(new ApiError(status, code, code));
    render(<VoicemailGreetingBlock />);
    await screen.findByRole('button', { name: 'Upload greeting' });
    await user.upload(screen.getByLabelText('Greeting audio file'), mp3());
    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(uploadVoicemailGreeting).toHaveBeenCalledTimes(1);
    expect(uploadVoicemailGreeting).toHaveBeenCalledWith(expect.any(File), 'audio/mpeg');
  });

  it('the upload messages are the spec 4.7 copy verbatim', () => {
    expect(GREETING_REJECT_MESSAGE).toBe(
      'Upload an MP3 or WAV file. iPhone voice memos are M4A; export or convert the recording first.',
    );
    expect(GREETING_TOO_LARGE_MESSAGE).toBe('That file is over 5 MB. Trim or re-export it at a lower bitrate.');
    expect(GREETING_EMPTY_MESSAGE).toBe('That file is empty.');
    expect(GREETING_STORAGE_MESSAGE).toBe("Media storage isn't available right now. Try again in a minute.");
    expect(GREETING_FORBIDDEN_MESSAGE).toBe('Only an admin can change the greeting.');
    expect(GREETING_UPLOAD_FAILED_MESSAGE).toBe("Couldn't upload the greeting. Try again.");
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
