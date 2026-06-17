// Unit tests for usersRepo pure logic: displayNameOf resolver and the
// present-only #name SET in activateOnLogin / touchLastLogin.
// These tests use a fake DynamoDB document client (captures the UpdateCommand
// input) — no Docker/DynamoDB Local required. The integration tests in
// usersRepo.integration.test.ts cover the real conditional-write paths.
import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { createUsersRepo, displayNameOf } from '../src/repos/usersRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

// ---------------------------------------------------------------------------
// displayNameOf
// ---------------------------------------------------------------------------

describe('displayNameOf', () => {
  it('returns name when present and non-blank', () => {
    expect(displayNameOf({ name: 'Sam Rivera', email: 'sam@x.com', userId: 'u1' })).toBe(
      'Sam Rivera',
    );
  });

  it('trims leading/trailing whitespace from name', () => {
    expect(displayNameOf({ name: '  Sam  ', email: 'e', userId: 'u' })).toBe('Sam');
  });

  it('whitespace-only name falls through to email', () => {
    expect(displayNameOf({ name: '   ', email: 'sam@x.com', userId: 'u1' })).toBe('sam@x.com');
  });

  it('absent name falls through to email', () => {
    expect(displayNameOf({ email: 'sam@x.com', userId: 'u1' })).toBe('sam@x.com');
  });

  it('no name AND no email falls through to userId', () => {
    expect(displayNameOf({ userId: 'u1' })).toBe('u1');
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Capture the last UpdateCommand input sent through a fake doc client. */
function makeFakeDoc() {
  let lastInput: Record<string, unknown> | undefined;
  const fakeDoc = {
    send: async (cmd: unknown) => {
      if (cmd instanceof UpdateCommand) {
        lastInput = cmd.input as Record<string, unknown>;
        return {};
      }
      return {};
    },
  } as unknown as DynamoDBDocumentClient;

  return {
    doc: fakeDoc,
    getLastInput: () => lastInput,
  };
}

function makeRepo(fakeDoc: DynamoDBDocumentClient) {
  return createUsersRepo({
    doc: fakeDoc,
    env: { TABLE_PREFIX: 'hc-fake-' } as NodeJS.ProcessEnv,
    logger: createLogger({ destination: createLogCapture().stream }),
  });
}

// ---------------------------------------------------------------------------
// activateOnLogin — present-only #name SET
// ---------------------------------------------------------------------------

describe('activateOnLogin — present-only name refresh', () => {
  it('SETs #name when a non-blank name is provided', async () => {
    const { doc, getLastInput } = makeFakeDoc();
    const users = makeRepo(doc);

    await users.activateOnLogin('u1', 'sub-1', 'Sam Rivera', '2026-06-17T00:00:00.000Z');

    const input = getLastInput()!;
    expect(input.UpdateExpression as string).toContain('#name');
    expect(input.UpdateExpression as string).toContain(':name');
    expect((input.ExpressionAttributeNames as Record<string, string>)['#name']).toBe('name');
    expect((input.ExpressionAttributeValues as Record<string, unknown>)[':name']).toBe(
      'Sam Rivera',
    );
  });

  it('does NOT mention #name when name is undefined', async () => {
    const { doc, getLastInput } = makeFakeDoc();
    const users = makeRepo(doc);

    await users.activateOnLogin('u1', 'sub-1', undefined, '2026-06-17T00:00:00.000Z');

    const input = getLastInput()!;
    expect(input.UpdateExpression as string).not.toContain('#name');
    expect(input.UpdateExpression as string).not.toContain(':name');
    const attrNames = (input.ExpressionAttributeNames as Record<string, string> | undefined) ?? {};
    expect(Object.keys(attrNames)).not.toContain('#name');
    const attrValues = (input.ExpressionAttributeValues as Record<string, unknown> | undefined) ?? {};
    expect(Object.keys(attrValues)).not.toContain(':name');
  });

  it('does NOT mention #name when name is a blank string', async () => {
    const { doc, getLastInput } = makeFakeDoc();
    const users = makeRepo(doc);

    await users.activateOnLogin('u1', 'sub-1', '', '2026-06-17T00:00:00.000Z');

    const input = getLastInput()!;
    expect(input.UpdateExpression as string).not.toContain('#name');
    expect(input.UpdateExpression as string).not.toContain(':name');
  });

  it('still SETs google_sub, #status, and last_login_at regardless of name', async () => {
    const { doc, getLastInput } = makeFakeDoc();
    const users = makeRepo(doc);

    await users.activateOnLogin('u1', 'sub-1', undefined, '2026-06-17T00:00:00.000Z');

    const expr = getLastInput()!.UpdateExpression as string;
    expect(expr).toContain('google_sub');
    expect(expr).toContain('#status');
    expect(expr).toContain('last_login_at');
  });
});

// ---------------------------------------------------------------------------
// touchLastLogin — present-only #name SET
// ---------------------------------------------------------------------------

describe('touchLastLogin — present-only name refresh', () => {
  it('SETs #name when a non-blank name is provided', async () => {
    const { doc, getLastInput } = makeFakeDoc();
    const users = makeRepo(doc);

    await users.touchLastLogin('u1', 'Sam Rivera', '2026-06-17T00:00:00.000Z');

    const input = getLastInput()!;
    expect(input.UpdateExpression as string).toContain('#name');
    expect(input.UpdateExpression as string).toContain(':name');
    expect((input.ExpressionAttributeNames as Record<string, string>)['#name']).toBe('name');
    expect((input.ExpressionAttributeValues as Record<string, unknown>)[':name']).toBe(
      'Sam Rivera',
    );
  });

  it('does NOT mention #name when name is undefined', async () => {
    const { doc, getLastInput } = makeFakeDoc();
    const users = makeRepo(doc);

    await users.touchLastLogin('u1', undefined, '2026-06-17T00:00:00.000Z');

    const input = getLastInput()!;
    expect(input.UpdateExpression as string).not.toContain('#name');
    const attrNames = (input.ExpressionAttributeNames as Record<string, string> | undefined) ?? {};
    expect(Object.keys(attrNames)).not.toContain('#name');
  });

  it('does NOT mention #name when name is a blank string', async () => {
    const { doc, getLastInput } = makeFakeDoc();
    const users = makeRepo(doc);

    await users.touchLastLogin('u1', '   ', '2026-06-17T00:00:00.000Z');

    const input = getLastInput()!;
    expect(input.UpdateExpression as string).not.toContain('#name');
  });

  it('always SETs last_login_at', async () => {
    const { doc, getLastInput } = makeFakeDoc();
    const users = makeRepo(doc);

    await users.touchLastLogin('u1', undefined, '2026-06-17T00:00:00.000Z');

    expect(getLastInput()!.UpdateExpression as string).toContain('last_login_at');
  });
});
