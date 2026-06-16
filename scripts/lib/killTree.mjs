// Cross-platform "kill a process and all its descendants".
import { spawnSync } from 'node:child_process';

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killTree(pid) {
  if (!pid || !isAlive(pid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

// Return the PIDs of every process LISTENING on a TCP port. Used to reap an
// orphan that survived a previous session and still holds a stack port — on
// Windows a second `app.listen()` on an already-held port does NOT raise
// EADDRINUSE (the listen callback fires, then the process exits 0 without ever
// owning the socket), so a launcher that only tracks its own children can never
// reach the real port-holder. Freeing the port first guarantees the child we
// spawn is the process that actually owns it.
export function pidsOnPort(port) {
  const found = new Set();
  if (process.platform === 'win32') {
    const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
    for (const line of (out.stdout ?? '').split(/\r?\n/)) {
      // e.g.  TCP    0.0.0.0:8889    0.0.0.0:0    LISTENING    51884
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
      if (m && Number(m[1]) === Number(port)) found.add(Number(m[2]));
    }
  } else {
    const out = spawnSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    for (const tok of (out.stdout ?? '').split(/\s+/)) {
      const n = Number(tok.trim());
      if (n) found.add(n);
    }
  }
  return [...found];
}

// Kill whatever process(es) currently LISTEN on `port`, with their trees.
// Returns the PIDs that were reaped (for logging).
export function killPort(port) {
  const pids = pidsOnPort(port);
  for (const pid of pids) killTree(pid);
  return pids;
}
