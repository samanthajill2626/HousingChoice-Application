export interface LaneSessionState {
  launcherPid?: number;
  lane?: number;
  tablePrefix?: string;
  urls?: { app?: string };
}

export interface LaneOwnerProbe {
  confirmed: boolean;
  reason: 'confirmed' | 'malformed' | 'mismatch' | 'unreachable';
}

export function probeLaneOwner(options: {
  laneState: LaneSessionState;
  fetchImpl?: typeof fetch;
}): Promise<LaneOwnerProbe>;

export function inspectSessionLiveness(options: {
  laneState: LaneSessionState;
  pidText: string | null;
  isAliveFn?: (pid: number) => boolean;
  fetchImpl?: typeof fetch;
}): Promise<{ launcherAlive: boolean; ownerConfirmed: boolean; live: boolean }>;

export function removeOwnedSessionState(options: {
  pidFile: string;
  launcherPid: number;
}): void;
