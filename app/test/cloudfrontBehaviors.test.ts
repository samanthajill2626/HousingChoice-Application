// CloudFront cache-behavior guard - keeps the edge's allowed methods in sync
// with this app's mounts.
//
// PROD BUG 2026-08-20: POST /public/housing-fair answered 403 in dev AND prod,
// on BOTH public pages - /join (HousingFairIntake) and the "I am interested"
// form on every flyer at /p/:unitId (FlyerPage), which share one endpoint. The
// cause was not in this codebase: infra/modules/cloudfront/main.tf carried
// all-methods ordered_cache_behavior entries for /api/*, /webhooks/*, and
// /auth/* only, so /public/* fell through to default_cache_behavior
// (GET/HEAD/OPTIONS) and CloudFront refused the POST with its OWN 403 error
// page. The request never reached the origin, so nothing appeared in our logs -
// no error, no warn, no request line. It was never a regression either: the
// public router shipped at M1.5 and nobody extended the M0.4b behavior list, so
// public intake had never once worked through CloudFront.
//
// SCOPE, stated plainly: these are STATIC assertions over the Terraform source.
// They prove the COMMITTED terraform matches the app's mounts. They say nothing
// about whether that terraform was ever APPLIED to the live distribution - a
// correct-but-unapplied .tf passes every test here.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EDGE_EXEMPT_PREFIXES, EDGE_MUTATING_PREFIXES, RESERVED_PREFIXES } from '../src/app.js';

const CLOUDFRONT_TF = fileURLToPath(new URL('../../infra/modules/cloudfront/main.tf', import.meta.url));
const APP_SOURCE = fileURLToPath(new URL('../src/app.ts', import.meta.url));

/** The verbs that CloudFront must be told to forward, or it answers 403 itself. */
const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

interface ParsedBehavior {
  pathPatterns: string[];
  allowedMethods: string[];
}

function quotedStrings(source: string): string[] {
  return [...source.matchAll(/"([^"]*)"/g)].map((m) => m[1] as string);
}

/** The `allowed_methods = [...]` nearest the start of `chunk`. */
function allowedMethodsOf(chunk: string): string[] {
  const match = /allowed_methods\s*=\s*\[([^\]]*)\]/.exec(chunk);
  return match ? quotedStrings(match[1] as string) : [];
}

/**
 * Parse every `dynamic "ordered_cache_behavior"` block out of the module.
 *
 * Each chunk starts exactly at its own block header, so the FIRST `for_each`
 * and `allowed_methods` inside a chunk are that block's own. `for_each` is read
 * as "every quoted string on the line" rather than as a bare list, because the
 * unit-media block uses a conditional (`local.media_enabled ? [...] : []`).
 */
export function parseOrderedCacheBehaviors(hcl: string): ParsedBehavior[] {
  const chunks = hcl.split(/dynamic\s+"ordered_cache_behavior"\s*\{/).slice(1);
  return chunks.map((chunk) => {
    const forEach = /for_each\s*=\s*(.*)/.exec(chunk);
    return {
      pathPatterns: forEach ? quotedStrings(forEach[1] as string) : [],
      allowedMethods: allowedMethodsOf(chunk),
    };
  });
}

/**
 * The single behavior block that forwards mutating methods to the app origin.
 *
 * Throws - rather than returning nothing - when it cannot be identified. This
 * guard reads HCL with regexes, so a restructure of that Terraform must FAIL
 * loudly here instead of quietly matching zero blocks and passing forever.
 */
export function findAllMethodsBehavior(hcl: string): ParsedBehavior {
  const mutating = parseOrderedCacheBehaviors(hcl).filter((b) => b.allowedMethods.includes('POST'));
  if (mutating.length !== 1) {
    throw new Error(
      `expected exactly ONE ordered_cache_behavior allowing POST, found ${mutating.length}. ` +
        'If infra/modules/cloudfront/main.tf was restructured, update this test to match - ' +
        'do NOT let the guard silently stop guarding.',
    );
  }
  return mutating[0] as ParsedBehavior;
}

/** Edge-mutating prefixes with no matching `<prefix>/*` behavior. */
export function unguardedPrefixes(hcl: string, prefixes: readonly string[]): string[] {
  const patterns = new Set(findAllMethodsBehavior(hcl).pathPatterns);
  return prefixes.filter((prefix) => !patterns.has(`${prefix}/*`));
}

/**
 * The `default_cache_behavior` fallback every unlisted path lands on.
 *
 * Anchored on the block HEADER (`default_cache_behavior {`), never on a bare
 * substring: the module's prose mentions the block by name well above it, and
 * matching that comment made this read the all-methods block's verbs instead.
 */
export function defaultBehaviorMethods(hcl: string): string[] {
  const header = /default_cache_behavior\s*\{/.exec(hcl);
  if (!header) throw new Error('default_cache_behavior block not found - update this test');
  return allowedMethodsOf(hcl.slice(header.index));
}

const tf = readFileSync(CLOUDFRONT_TF, 'utf8');

describe('CloudFront cache behaviors match the app mounts', () => {
  // THE 2026-08-20 BUG, in one assertion.
  it('every edge-mutating mount has an all-methods behavior', () => {
    expect(unguardedPrefixes(tf, EDGE_MUTATING_PREFIXES)).toEqual([]);
  });

  // Drift in the OTHER direction: a behavior for a prefix the app no longer
  // mounts is dead config, and usually means a rename landed half-done.
  it('the behavior list holds exactly the edge-mutating mounts, no more', () => {
    const expected = EDGE_MUTATING_PREFIXES.map((prefix) => `${prefix}/*`);
    expect(findAllMethodsBehavior(tf).pathPatterns.sort()).toEqual([...expected].sort());
  });

  it('that behavior forwards every mutating verb', () => {
    const { allowedMethods } = findAllMethodsBehavior(tf);
    for (const verb of MUTATING_METHODS) {
      expect(allowedMethods, `${verb} must reach the origin`).toContain(verb);
    }
  });

  // What makes the per-prefix list load-bearing at all. If someone ever "fixes"
  // a future edge 403 by opening the DEFAULT behavior instead, every unlisted
  // path silently becomes mutable and this whole guard stops meaning anything.
  it('the default behavior stays read-only', () => {
    const methods = defaultBehaviorMethods(tf);
    for (const verb of MUTATING_METHODS) {
      expect(methods, `default_cache_behavior must not allow ${verb}`).not.toContain(verb);
    }
  });

  // Forces a conscious edge decision on any NEW mount: a router mounted at a
  // path that is in neither list fails here rather than shipping dead.
  it('every path-mounted router in app.ts is classified for the edge', () => {
    const source = readFileSync(APP_SOURCE, 'utf8');
    const mounted = [...source.matchAll(/app\.use\(\s*'(\/[^']*)'/g)].map((m) => m[1] as string);
    expect(mounted.length, 'found no app.use() mounts - the match pattern went stale').toBeGreaterThan(0);
    for (const prefix of mounted) {
      expect(
        RESERVED_PREFIXES,
        `${prefix} is mounted but not classified: add it to EDGE_MUTATING_PREFIXES (it needs a ` +
          'CloudFront behavior) or to EDGE_EXEMPT_PREFIXES (with the reason it is safe without one)',
      ).toContain(prefix);
    }
  });

  it('classifies each prefix exactly once', () => {
    for (const prefix of EDGE_MUTATING_PREFIXES) {
      expect(EDGE_EXEMPT_PREFIXES, `${prefix} cannot be both mutating and exempt`).not.toHaveProperty(prefix);
    }
  });
});

// The guard's own guard: proof it actually bites. Without these, a parser that
// quietly matched nothing would pass every assertion above.
describe('the guard detects the failures it exists for', () => {
  it('reports the exact prefix when a behavior goes missing (the 2026-08-20 bug)', () => {
    const withoutPublic = tf.replace(', "/public/*"', '');
    expect(withoutPublic, 'fixture did not change - the tf list format moved').not.toEqual(tf);
    expect(unguardedPrefixes(withoutPublic, EDGE_MUTATING_PREFIXES)).toEqual(['/public']);
  });

  // Caught for real while writing this file: the module's prose names
  // default_cache_behavior above the block, and a bare indexOf matched the
  // COMMENT - so the read-only check was reading the all-methods verbs and
  // would have passed no matter what the real default behavior allowed.
  it('reads the default behavior block, not prose that names it', () => {
    const fixture = [
      '# falls through to default_cache_behavior (GET/HEAD/OPTIONS only)',
      'dynamic "ordered_cache_behavior" {',
      '  for_each = ["/api/*"]',
      '  content {',
      '    allowed_methods = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]',
      '  }',
      '}',
      'default_cache_behavior {',
      '  allowed_methods = ["GET", "HEAD", "OPTIONS"]',
      '}',
    ].join('\n');
    expect(defaultBehaviorMethods(fixture)).toEqual(['GET', 'HEAD', 'OPTIONS']);
  });

  it('throws instead of passing when the behavior block cannot be found', () => {
    expect(() => findAllMethodsBehavior('resource "aws_cloudfront_distribution" "this" {}')).toThrow(
      /exactly ONE ordered_cache_behavior/,
    );
  });
});
