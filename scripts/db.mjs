// DynamoDB Local container lifecycle (the ONLY local container — arch doc §8.1).
//
//   npm run db:start  -> ensure the container exists + is running, wait for port
//   npm run db:stop   -> stop it (container is kept; db:start restarts it)
//
// DISK-BACKED, NOT -inMemory (changed 2026-08-24). -inMemory kept every table
// in the JVM HEAP, deletes never returned memory (measured: DeleteTable
// reclaimed ~nothing; a heavy multi-run day ratcheted RSS 2.5GiB -> 5.9GiB),
// and the endgame was a GC spiral whose stop-the-world pauses stalled EVERY
// lane at once - the 2026-08-24 dual-suite soak caught both lanes failing the
// same test at the same instant on a raw 30s API hang. With -dbPath the data
// lives in per-database SQLite FILES on a tmpfs mount: the JVM heap stays
// small (capped -Xmx2g, so pressure fails LOUDLY as an OOM rather than as a
// silent slow-motion spiral), writes run at memory speed (plain disk measured
// ~5x slower from fsync alone), and a database is finally something that can
// be DELETED - freed files return RAM instantly, unlike the old heap.
//
// Consequences of the tmpfs-backed shape:
//   - stop/start still WIPES data (tmpfs dies with the container), exactly the
//     semantics this file always documented;
//   - the "restart to reclaim memory" operator chore is gone BY CONSTRUCTION:
//     the JVM heap is capped, freed database files return RAM instantly, and
//     SQLite reuses freed pages so a file never grows past its peak working
//     set - the cumulative ratchet cannot form;
//   - orphaned per-key databases (deleted worktrees, dead lanes) are pruned
//     in place on db:start - see pruneOrphanedDatabases - not by restarting.
//
// NO -sharedDb: each (accessKeyId, region) pair gets its OWN database and its
// own SQLite write lock, so concurrent suites don't serialize through one lock
// (docs/issues/dynamodb-local-cross-worktree-test-contention.md). The e2e
// launcher injects hclane<L> per lane, app vitest injects hctest<hash> per
// worktree, and the dev loop rides the 'local' fallback in app/src/lib/dynamo.ts.
//
// Also imported by scripts/dev.mjs (ensureDbStarted).
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const CONTAINER_NAME = 'hc-dynamodb-local';
export const LOCAL_ENDPOINT = 'http://localhost:8000';

async function docker(...args) {
  // docker.exe resolves via PATH on Windows without a shell.
  return execFileAsync('docker', args);
}

/**
 * Did `docker run` fail because a CONCURRENT starter got there first, rather
 * than for a real reason? Both messages mean "the thing you asked for now
 * exists" - which is success for our purposes.
 */
function isStartRaceError(err) {
  const text = `${err?.stderr ?? ''}${err?.message ?? ''}`.toLowerCase();
  return (
    text.includes('is already in use by container')
    || text.includes('conflict. the container name')
    || text.includes('port is already allocated')
    || text.includes('address already in use')
  );
}

/** `docker start`, tolerating a racing starter that already started it. */
async function startExisting() {
  try {
    await docker('start', CONTAINER_NAME);
  } catch (err) {
    if (!isStartRaceError(err)) throw err;
  }
}

async function assertDaemonUp() {
  try {
    await docker('version', '--format', '{{.Server.Version}}');
  } catch {
    console.error(
      'Docker daemon is not reachable. Start Docker Desktop, wait for "Engine running", then retry.',
    );
    process.exit(1);
  }
}

/** 'running' | 'stopped' | 'absent' */
async function containerState() {
  try {
    const { stdout } = await docker('inspect', '--format', '{{.State.Running}}', CONTAINER_NAME);
    return stdout.trim() === 'true' ? 'running' : 'stopped';
  } catch {
    return 'absent';
  }
}

async function waitForEndpoint(endpoint, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // DynamoDB Local answers any HTTP request (400 for a bare GET) once up.
      await fetch(endpoint, { signal: AbortSignal.timeout(1_000) });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`DynamoDB Local did not answer at ${endpoint} within ${timeoutMs}ms`);
}

/**
 * True when an existing container was created with args this repo has since
 * moved off - docker start would resurrect the old args, so such a container
 * must be recreated (same rollout shape as the 2026-07-02 -sharedDb
 * migration):
 *   - `-sharedDb`: one SQLite database + ONE write lock shared by every lane
 *     (docs/issues/dynamodb-local-cross-worktree-test-contention.md);
 *   - `-inMemory`: every table in JVM heap, never reclaimed, ending in the
 *     GC-spiral stall the 2026-08-24 soak caught (see the header).
 * @param {string[]} args
 */
export function containerArgsAreStale(args) {
  // Two match modes, both load-bearing:
  //   - SUBSTRING for the legacy markers, so they are caught even inside an
  //     sh-wrapper string (an interim 2026-08-24 shape ran the whole command
  //     as ONE '-c' element);
  //   - ELEMENT-EXACT for the required flags, so that same sh-wrapper interim
  //     shape (plain-disk, ~5x slower) is ALSO flagged and upgraded to the
  //     canonical tmpfs shape, whose flags are real argv elements.
  const joined = args.join(' ');
  if (joined.includes('-sharedDb') || joined.includes('-inMemory')) return true;
  return !(args.includes('-dbPath') && args.includes('-Xmx2g'));
}

/** JVM args the container was created with (docker inspect .Args). */
async function containerArgs() {
  const { stdout } = await docker('inspect', '--format', '{{json .Args}}', CONTAINER_NAME);
  return JSON.parse(stdout.trim());
}

/**
 * Days a per-key database FILE may go unmodified before db:start prunes it.
 * Disk-backed, an orphaned database (deleted worktree, dead lane) is just an
 * untouched .db file - the API still cannot enumerate or drop a DATABASE, but
 * the filesystem can, which retires the old "only a restart frees them" chore.
 * 7 days is far beyond any live lane's idle time (every run touches its files)
 * and short enough that orphans never pile up.
 */
const PRUNE_UNTOUCHED_DAYS = 7;

/** In-container directory holding the per-database SQLite files (-dbPath). */
const DB_DATA_DIR = '/home/dynamodblocal/data';

/**
 * Delete per-key database files nothing has touched in PRUNE_UNTOUCHED_DAYS.
 *
 * SAFE BY MTIME, not by name: a LIVE lane's files are written by every run, so
 * only genuinely orphaned databases (deleted worktrees, dead lanes) age past
 * the threshold. Runs inside the container (busybox find is in the image's
 * base), and is BEST-EFFORT - pruning is hygiene, and a failure here must
 * never block a boot.
 */
async function pruneOrphanedDatabases() {
  try {
    const { stdout } = await docker(
      'exec', CONTAINER_NAME, 'find', DB_DATA_DIR, '-maxdepth', '1', '-name', '*.db',
      '-mtime', `+${PRUNE_UNTOUCHED_DAYS}`, '-print', '-delete',
    );
    const pruned = stdout.split('\n').filter((line) => line.trim().length > 0);
    if (pruned.length > 0) {
      console.log(
        `db:start — pruned ${pruned.length} orphaned database file(s) untouched for ` +
          `${PRUNE_UNTOUCHED_DAYS}+ days (deleted worktrees / dead lanes)`,
      );
    }
  } catch {
    // Best-effort: an exec failure (container mid-restart, old image without
    // find) costs only disk hygiene, never a boot.
  }
}

/** Idempotent start: running -> no-op; stopped -> start; absent -> run.
 *  A container created with STALE args (-sharedDb, or the pre-2026-08-24
 *  -inMemory shape) is removed + recreated - that wipes its data and every
 *  lane/dev stack must reseed, the same rollout shape as the 2026-07-02
 *  -sharedDb migration. */
export async function ensureDbStarted() {
  await assertDaemonUp();
  let state = await containerState();
  if (state !== 'absent' && containerArgsAreStale(await containerArgs())) {
    console.warn(
      `db:start — ${CONTAINER_NAME} was created with stale args (legacy -sharedDb, or ` +
        'the pre-2026-08-24 -inMemory shape whose JVM-heap ratchet ended in GC-spiral ' +
        'stalls); recreating it disk-backed. ALL existing tables are wiped — every ' +
        'lane/dev stack must reseed.',
    );
    await docker('rm', '-f', CONTAINER_NAME);
    state = 'absent';
  }
  if (state === 'running') {
    console.log(`db:start — ${CONTAINER_NAME} already running`);
    await pruneOrphanedDatabases();
  } else if (state === 'stopped') {
    console.log(`db:start — starting existing container ${CONTAINER_NAME}`);
    await startExisting();
  } else {
    console.log(
      `db:start — creating container ${CONTAINER_NAME} (SQLite on tmpfs: memory-speed, ` +
        'heap-capped, data resets on stop)',
    );
    try {
      // THE SHAPE, and why every piece is load-bearing (2026-08-24):
      //   --mount tmpfs: the SQLite files live in RAM-backed tmpfs, so writes
      //     run at memory speed - plain disk measured ~5x slower on the full
      //     app suite (405s vs a ~65-90s baseline) from fsync cost alone.
      //     tmpfs memory is KERNEL memory, not JVM heap: freed files return
      //     RAM instantly, SQLite reuses freed pages inside a file (size
      //     stabilises at peak working set, never cumulative), and the
      //     GC-spiral stall of the -inMemory era cannot rebuild. size=6g is a
      //     hard, LOUD ceiling (writes fail) far above any observed data set.
      //     tmpfs-mode=1777 lets the image's non-root dynamodblocal user write.
      //   -Xmx2g: with data out of the heap, 2g is generous headroom, and a
      //     hard cap turns heap pressure into a visible OOM rather than a
      //     silent slowdown that stalls every lane at once.
      //   JVM flags precede -jar; the mount point is created by docker, so no
      //   entrypoint override is needed.
      // Tmpfs dies with the container: stop/start now WIPES data again, same
      // operational semantics the repo always documented for this container.
      await docker(
        'run', '-d', '--name', CONTAINER_NAME, '-p', '8000:8000',
        '--mount', `type=tmpfs,destination=${DB_DATA_DIR},tmpfs-size=6g,tmpfs-mode=1777`,
        'amazon/dynamodb-local',
        '-Xmx2g', '-jar', 'DynamoDBLocal.jar', '-dbPath', DB_DATA_DIR,
      );
    } catch (err) {
      // ANOTHER STARTER WON. Two e2e sessions starting from COLD at the same
      // instant both see 'absent' and both `docker run` the same container
      // name; the loser used to fail its whole boot on a name/port conflict
      // (observed: one lane hung at "ensuring MinIO" while the other was
      // mid-run). The container the winner created is exactly what we wanted,
      // so treat the conflict as success and fall through to waitForEndpoint -
      // the same posture as the 'already running' branch above, extended to
      // cover the in-flight-start window.
      // See docs/issues/e2e-lane-cold-start-container-race.md.
      if (!isStartRaceError(err)) throw err;
      console.log(`db:start — another starter created ${CONTAINER_NAME} first; waiting for it`);
      if ((await containerState()) === 'stopped') await startExisting();
    }
  }
  await waitForEndpoint(LOCAL_ENDPOINT);
  console.log(`db:start — DynamoDB Local ready at ${LOCAL_ENDPOINT}`);
}

export async function stopDb() {
  await assertDaemonUp();
  const state = await containerState();
  if (state !== 'running') {
    console.log(`db:stop — ${CONTAINER_NAME} is not running (${state})`);
    return;
  }
  await docker('stop', CONTAINER_NAME);
  console.log(`db:stop — ${CONTAINER_NAME} stopped (tmpfs-backed: data discarded, as before)`);
}

// CLI dispatch (node scripts/db.mjs start|stop) — skipped when imported.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const command = process.argv[2];
  if (command === 'start') {
    await ensureDbStarted();
  } else if (command === 'stop') {
    await stopDb();
  } else {
    console.error(`Usage: node scripts/db.mjs <start|stop> (got: ${command ?? 'nothing'})`);
    process.exit(1);
  }
}
