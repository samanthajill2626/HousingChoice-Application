// Boot smoke child (spawned by app/test/otel.test.ts). Runs the REAL
// startOtel() — including sdk.start(), which patches http/express — in an
// isolated process so the vitest process stays unpatched. Awaits startOtel(),
// prints a marker, and exits 0. A bad/unreachable OTEL_EXPORTER_OTLP_ENDPOINT
// must fail async inside the exporter (never crash boot), so we still exit 0.
import { startOtel } from '../../src/lib/otel.js';

await startOtel();
console.log('OTEL_BOOT_OK');
// The periodic metric reader (when the endpoint is set) holds an open timer;
// exit explicitly so the child does not linger. Boot succeeded → exit 0.
process.exit(0);
