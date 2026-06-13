// Pure core of the user-invite ops script (scripts/lib/userInviteCore.mjs):
// argv validation, email normalization, deterministic userId, item shapes.
// No AWS anywhere — the CLI shell (scripts/userInvite.mjs) is account-guarded
// and untested here, the secretsCore.mjs / userRoleCore.mjs pattern.
import { describe, expect, it } from 'vitest';
import {
  buildInvitedAuditItem,
  buildInvitedUserItem,
  normalizeEmail,
  parseUserInviteArgs,
  STACK_ENVS,
  userIdForEmail as scriptUserIdForEmail,
  USER_ROLES,
} from '../../scripts/lib/userInviteCore.mjs';
// The app's derivation — the script MUST match it byte-for-byte.
import { userIdForEmail as appUserIdForEmail } from '../src/repos/usersRepo.js';

describe('constants', () => {
  it('roles are exactly admin|va, envs exactly dev|prod (frozen)', () => {
    expect([...USER_ROLES]).toEqual(['admin', 'va']);
    expect([...STACK_ENVS]).toEqual(['dev', 'prod']);
    expect(Object.isFrozen(USER_ROLES)).toBe(true);
    expect(Object.isFrozen(STACK_ENVS)).toBe(true);
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims (matches usersRepo storage)', () => {
    expect(normalizeEmail('  Cameron@ABT-Industries.com ')).toBe('cameron@abt-industries.com');
  });
});

describe('userIdForEmail — MUST equal the app derivation', () => {
  it('produces the same usr_<24 hex> id the app computes (invite hits the login lookup key)', () => {
    for (const email of [
      'va@housingchoice.org',
      ' Admin@HousingChoice.org ',
      'cameron@abt-industries.com',
    ]) {
      expect(scriptUserIdForEmail(email)).toBe(appUserIdForEmail(email));
    }
    expect(scriptUserIdForEmail('a@x.org')).toMatch(/^usr_[0-9a-f]{24}$/);
  });
});

describe('parseUserInviteArgs', () => {
  it('accepts <env> <email> <role> and normalizes the email', () => {
    expect(parseUserInviteArgs(['dev', ' VA@HousingChoice.org ', 'admin'])).toEqual({
      env: 'dev',
      email: 'va@housingchoice.org',
      role: 'admin',
    });
    expect(parseUserInviteArgs(['prod', 'x@y.org', 'va']).role).toBe('va');
  });

  it('rejects bad envs, emails, roles, and extra arguments — naming the problem', () => {
    expect(() => parseUserInviteArgs(['staging', 'a@b.org', 'va'])).toThrow(/dev, prod/);
    expect(() => parseUserInviteArgs([])).toThrow(/dev, prod/);
    expect(() => parseUserInviteArgs(['dev', 'not-an-email', 'va'])).toThrow(/email/);
    expect(() => parseUserInviteArgs(['dev', 'a@b', 'va'])).toThrow(/email/);
    expect(() => parseUserInviteArgs(['dev', 'a@b.org', 'founder_admin'])).toThrow(/admin, va/);
    expect(() => parseUserInviteArgs(['dev', 'a@b.org', 'va', 'extra'])).toThrow(/extra/);
  });
});

describe('buildInvitedUserItem (DynamoDB-JSON; mirrors usersRepo.invite)', () => {
  it('writes status invited, session_epoch 1, NO google_sub', () => {
    expect(
      buildInvitedUserItem({
        userId: 'usr_abc',
        email: 'va@housingchoice.org',
        role: 'va',
        nowIso: '2026-06-12T10:00:00.000Z',
      }),
    ).toEqual({
      userId: { S: 'usr_abc' },
      email: { S: 'va@housingchoice.org' },
      role: { S: 'va' },
      status: { S: 'invited' },
      session_epoch: { N: '1' },
      created_at: { S: '2026-06-12T10:00:00.000Z' },
    });
  });

  it('has no google_sub key (written by the app on first login)', () => {
    const item = buildInvitedUserItem({
      userId: 'usr_abc',
      email: 'a@b.org',
      role: 'admin',
      nowIso: '2026-06-12T10:00:00.000Z',
    });
    expect(Object.hasOwn(item, 'google_sub')).toBe(false);
  });
});

describe('buildInvitedAuditItem (auditRepo conventions)', () => {
  it('builds entityKey users#<userId>, SK `<ISO ts>#<suffix>`, event_type user_invited', () => {
    expect(
      buildInvitedAuditItem({
        userId: 'usr_abc',
        email: 'va@housingchoice.org',
        role: 'va',
        invitedBy: 'arn:aws:iam::938565869261:user/cameron',
        nowIso: '2026-06-12T10:00:00.000Z',
        suffix: 'deadbeef',
      }),
    ).toEqual({
      entityKey: 'users#usr_abc',
      ts: '2026-06-12T10:00:00.000Z#deadbeef',
      event_type: 'user_invited',
      payload: {
        email: 'va@housingchoice.org',
        role: 'va',
        invited_by: 'arn:aws:iam::938565869261:user/cameron',
      },
    });
  });
});
