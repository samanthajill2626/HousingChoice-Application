// Unit test for the pure container-args staleness check in scripts/db.mjs.
// (The docker lifecycle itself is exercised by the boot verification gates.)
import { describe, expect, it } from 'vitest';
import { containerArgsAreStale } from '../../scripts/db.mjs';

describe('containerArgsAreStale', () => {
  // Each stale shape must force a recreate: docker start resurrects the args a
  // container was CREATED with, so an old container silently keeps old
  // behaviour forever unless this check catches it.

  it('flags the legacy -sharedDb container (one write lock for every lane)', () => {
    expect(containerArgsAreStale(['-jar', 'DynamoDBLocal.jar', '-sharedDb', '-inMemory'])).toBe(true);
  });

  it('flags the legacy -inMemory container (the JVM-heap ratchet behind the 2026-08-24 GC-spiral stall)', () => {
    // This was the ACCEPTED shape until 2026-08-24. A dual-suite soak caught
    // both lanes failing the same test at the same instant on 30s hangs; the
    // container was at 5.9GiB RSS / 124% CPU while idle. Disk-backed (-dbPath)
    // is the fix, so any container still carrying -inMemory must be recreated.
    expect(containerArgsAreStale(['-jar', 'DynamoDBLocal.jar', '-inMemory'])).toBe(true);
  });

  it('flags a container with neither backing flag, and empty args (unknown provenance)', () => {
    expect(containerArgsAreStale(['-jar', 'DynamoDBLocal.jar'])).toBe(true);
    expect(containerArgsAreStale([])).toBe(true);
  });

  it('flags the interim sh-wrapper plain-disk shape (~5x slower; measured 405s vs ~80s)', () => {
    // Lived for about an hour on 2026-08-24 between the -inMemory era and the
    // tmpfs shape. Its flags hide inside ONE '-c' string element, so the
    // element-exact half of the check catches it for upgrade.
    expect(
      containerArgsAreStale(['-c', 'mkdir -p /home/dynamodblocal/data && exec java -Xmx2g -jar DynamoDBLocal.jar -dbPath /home/dynamodblocal/data']),
    ).toBe(true);
  });

  it('accepts the canonical tmpfs shape (flags as real argv elements)', () => {
    expect(
      containerArgsAreStale(['-Xmx2g', '-jar', 'DynamoDBLocal.jar', '-dbPath', '/home/dynamodblocal/data']),
    ).toBe(false);
  });
});
