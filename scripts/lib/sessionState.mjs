import { readFileSync, rmSync } from 'node:fs';
import { isAlive } from './killTree.mjs';

function parsePositivePid(value) {
  const pid = Number(String(value ?? '').trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export async function probeLaneOwner({ laneState, fetchImpl = fetch }) {
  const appUrl = laneState?.urls?.app;
  const lane = laneState?.lane;
  const tablePrefix = laneState?.tablePrefix;
  if (
    typeof appUrl !== 'string'
    || !Number.isSafeInteger(lane)
    || typeof tablePrefix !== 'string'
    || tablePrefix.length === 0
  ) {
    return { confirmed: false, reason: 'malformed' };
  }
  try {
    const response = await fetchImpl(`${appUrl}/__dev/ping`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return { confirmed: false, reason: 'unreachable' };
    const ping = await response.json();
    if (
      ping?.dev !== true
      || ping?.lane !== lane
      || ping?.tablePrefix !== tablePrefix
    ) {
      return { confirmed: false, reason: 'mismatch' };
    }
    return { confirmed: true, reason: 'confirmed' };
  } catch {
    return { confirmed: false, reason: 'unreachable' };
  }
}

export async function inspectSessionLiveness({
  laneState,
  pidText,
  isAliveFn = isAlive,
  fetchImpl = fetch,
}) {
  const statePid = parsePositivePid(laneState?.launcherPid);
  const filePid = parsePositivePid(pidText);
  const launcherAlive = statePid !== null && statePid === filePid && isAliveFn(statePid);
  const owner = await probeLaneOwner({ laneState, fetchImpl });
  return {
    launcherAlive,
    ownerConfirmed: owner.confirmed,
    live: launcherAlive || owner.confirmed,
  };
}

export function removeOwnedSessionState({ pidFile, launcherPid }) {
  try {
    if (readFileSync(pidFile, 'utf8').trim() === String(launcherPid)) rmSync(pidFile);
  } catch {
    // A replacement or prior cleanup wins.
  }
}
