import { readFileSync, rmSync } from 'node:fs';

export function removeOwnedSessionState({ pidFile, laneFile, launcherPid }) {
  try {
    if (readFileSync(pidFile, 'utf8').trim() === String(launcherPid)) rmSync(pidFile);
  } catch {
    // A replacement or prior cleanup wins.
  }
  // lane.json intentionally survives ordinary launcher shutdown. e2e:stop uses
  // it to reap orphaned app and public-base listeners after the launcher exits.
  void laneFile;
}
