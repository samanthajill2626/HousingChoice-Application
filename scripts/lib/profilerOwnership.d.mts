export function profilerOwnerToken(value: string | undefined): string | null;

export function assertProfilerPingIdentity(input: {
  expectedCommit: string;
  expectedOwnerToken: string;
  body: unknown;
}): void;

export function sendProfilerReady(
  ownerToken: string | null,
  send: ((message: { type: 'e2e-session-ready' }) => void) | undefined,
): void;
