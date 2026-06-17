// Pure core of the user-role ops script (scripts/lib/userRoleCore.mjs):
// argv validation, email normalization, audit-item shape. No AWS anywhere —
// the CLI shell (scripts/userRole.mjs) is account-guarded and untested here,
// the secretsCore.mjs pattern.
import { describe, expect, it } from 'vitest';
import {
  buildRoleChangedAuditItem,
  buildRoleUpdate,
  normalizeEmail,
  parseUserRoleArgs,
  STACK_ENVS,
  USER_ROLES,
} from '../../scripts/lib/userRoleCore.mjs';

describe('constants', () => {
  it('roles are exactly admin|va (README deviations)', () => {
    expect([...USER_ROLES]).toEqual(['admin', 'va']);
    expect(Object.isFrozen(USER_ROLES)).toBe(true);
  });

  it('envs are exactly dev|prod', () => {
    expect([...STACK_ENVS]).toEqual(['dev', 'prod']);
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims (matches usersRepo storage)', () => {
    expect(normalizeEmail('  Cameron@ABT-Industries.com ')).toBe('cameron@abt-industries.com');
  });
});

describe('parseUserRoleArgs', () => {
  it('accepts <env> <email> <role> and normalizes the email', () => {
    expect(parseUserRoleArgs(['dev', ' VA@HousingChoice.org ', 'admin'])).toEqual({
      env: 'dev',
      email: 'va@housingchoice.org',
      role: 'admin',
    });
    expect(parseUserRoleArgs(['prod', 'x@y.org', 'va']).role).toBe('va');
  });

  it('rejects bad envs, emails, roles, and extra arguments — naming the problem', () => {
    expect(() => parseUserRoleArgs(['staging', 'a@b.org', 'va'])).toThrow(/dev, prod/);
    expect(() => parseUserRoleArgs([])).toThrow(/dev, prod/);
    expect(() => parseUserRoleArgs(['dev', 'not-an-email', 'va'])).toThrow(/email/);
    expect(() => parseUserRoleArgs(['dev', 'a@b', 'va'])).toThrow(/email/);
    expect(() => parseUserRoleArgs(['dev', 'a@b.org', 'manager'])).toThrow(/admin, va/);
    expect(() => parseUserRoleArgs(['dev', 'a@b.org', 'va', 'extra'])).toThrow(/extra/);
  });
});

describe('buildRoleUpdate (one atomic write: role flip + session-epoch bump)', () => {
  it('flips #role AND bumps session_epoch with the legacy-safe if_not_exists base', () => {
    expect(buildRoleUpdate('admin')).toEqual({
      updateExpression:
        'SET #role = :role, session_epoch = if_not_exists(session_epoch, :base) + :one',
      conditionExpression: 'attribute_exists(userId)',
      expressionAttributeNames: { '#role': 'role' },
      expressionAttributeValues: {
        ':role': { S: 'admin' },
        // base 1 (NOT ADD semantics): legacy items read as epoch 1 in the
        // app, so their first bump must land on 2 — usersRepo.bumpSessionEpoch
        // uses the identical expression.
        ':base': { N: '1' },
        ':one': { N: '1' },
      },
    });
    expect(buildRoleUpdate('va').expressionAttributeValues[':role']).toEqual({ S: 'va' });
  });
});

describe('buildRoleChangedAuditItem (auditRepo conventions)', () => {
  it('builds entityKey users#<userId>, SK `<ISO ts>#<suffix>`, event_type role_changed', () => {
    expect(
      buildRoleChangedAuditItem({
        userId: 'usr_abc',
        email: 'va@housingchoice.org',
        from: 'va',
        to: 'admin',
        changedBy: 'arn:aws:iam::938565869261:user/cameron',
        nowIso: '2026-06-12T10:00:00.000Z',
        suffix: 'deadbeef',
      }),
    ).toEqual({
      entityKey: 'users#usr_abc',
      ts: '2026-06-12T10:00:00.000Z#deadbeef',
      event_type: 'role_changed',
      payload: {
        from: 'va',
        to: 'admin',
        email: 'va@housingchoice.org',
        changed_by: 'arn:aws:iam::938565869261:user/cameron',
      },
    });
  });
});
