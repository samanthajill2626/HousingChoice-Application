export function profilerOwnerToken(value: string | undefined): string | null;

export function assertProfilerPingIdentity(input: {
  expectedCommit: string | null;
  expectedOwnerToken: string;
  body: unknown;
  allowUnverifiedRevision?: boolean;
}): {
  expectedCommit: string | null;
  targetAppCommit: string | null;
  targetVersionStatus: 'verified' | 'unverified';
};

export function sendProfilerReady(
  ownerToken: string | null,
  send: ((message: { type: 'e2e-session-ready' }) => void) | undefined,
): void;

export function sendProfilerFailure(
  ownerToken: string | null,
  error: unknown,
  send: ((message: { type: 'e2e-session-failed'; reason: string }) => void) | undefined,
): void;
