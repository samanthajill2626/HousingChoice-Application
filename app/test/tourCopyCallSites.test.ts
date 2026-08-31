// The structural defense for W1. Nothing at the TYPE level ties "this catalog id
// declares tokens" to "this call site supplies them" - resolveMessage(id) is valid
// TypeScript for every id - so a new call site that forgets the composer fails
// OPEN into a runtime 500 rather than a typecheck error.
//
// That is not hypothetical: the contact-timeline site was missed during design and
// would have 500'd GET /api/contacts/:id/timeline for any tenant with an upcoming
// tour rung.
//
// KNOWN LIMITS - do not mistake a green run here for proof:
//  1. This match is TEXTUAL. It catches `resolveMessage('tour.x')` and
//     ``resolveMessage(`tour.${kind}`)``, which is how both missed sites were
//     actually written, but an id routed through a variable or a helper first
//     slips past it. Accepted: closing that needs real type-level work, and the
//     literal forms are the ones people write.
//  2. It enforces "route through the composer", NOT "contain what the composer
//     throws" and NOT "the composer can resolve every ReminderKind". The second
//     is held by the containment tests; the third is currently held by nothing -
//     see docs/issues/tourcopy-messageid-cast-unguarded.md.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// path.dirname(fileURLToPath(...)), NOT new URL(...).pathname - on win32 the
// latter yields "/W:/tmp/..." with a leading slash and readdirSync throws ENOENT.
// This is the idiom every tree-walking test in this repo already uses
// (lane.test.ts:27, otel.test.ts:18, scaffold.test.ts:9).
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
/** The ONE module allowed to resolve a tokenized tour.* id. */
const COMPOSER = join('messages', 'tourCopy.ts');
// NO EXCEPTIONS ANY MORE. `tour.no_show_checkin` used to be whitelisted here as
// "token-free by design (spec D2)", which let the no-show DRAFT route resolve it
// directly. The 2026-08-26 founder rewrite reversed that justification: the copy
// now greets by first name, so a bare resolveMessage would throw a strict-mode
// missing-var Error and 500 the route. Both paths go through the composer.

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('only tourCopy.ts may resolve a tokenized tour.* message', () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    if (file.endsWith(COMPOSER)) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/resolveMessage\(\s*[`'"]?(tour\.[A-Za-z_.${}]*)/g)) {
      const id = m[1] ?? '';
      offenders.push(`${file}: ${id}`);
    }
  }

  it('has no direct tour.* resolution outside the composer', () => {
    expect(offenders, `use composeTourReminderBody instead:\n${offenders.join('\n')}`).toEqual([]);
  });
});
