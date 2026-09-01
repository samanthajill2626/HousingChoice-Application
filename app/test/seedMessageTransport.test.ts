import { describe, expect, it } from 'vitest';
import { withSeedTransport } from '../src/lib/seed/messageTransport.js';

describe('seed transport declarations', () => {
  it('rejects versioned outbound declarations without requested transport', () => {
    expect(() => withSeedTransport({ direction: 'outbound' }, { kind: 'versioned' })).toThrow(
      'versioned outbound seed messages must request a transport',
    );
  });

  it('preserves intentionally unresolved inbound and legacy outbound declarations', () => {
    expect(withSeedTransport({ direction: 'inbound' }, { kind: 'versioned' })).toMatchObject({
      transport_schema_version: 1,
    });
    expect(withSeedTransport({ direction: 'outbound' }, { kind: 'legacy' })).not.toHaveProperty(
      'transport_schema_version',
    );
  });
});
