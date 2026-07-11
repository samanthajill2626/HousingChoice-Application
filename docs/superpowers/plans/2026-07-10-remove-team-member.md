# Remove Team Member Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-only "remove team member" capability to Settings > Team, end to end (repo delete method, DELETE API route with lockout/routing guards, client, hook action, and a confirm-dialog UI).

**Architecture:** Hard-delete the DynamoDB user row. A new `usersRepo.remove(userId)` (DeleteCommand) is called by a new `DELETE /api/users/:userId` route that runs three 409 guards (last-admin, self, voice-line-holder) before deleting and writing a `user_removed` audit event. The frontend adds a `removeUser` client fn, a `useTeam.remove` action that drops the row on success, and a per-row Remove button that opens a shared confirm dialog. Session revocation is automatic (existing auth middleware clears the cookie within <=60s once the row is gone).

**Tech Stack:** TypeScript, Node 24, Express, DynamoDB (@aws-sdk/lib-dynamodb), Vitest + Supertest (backend), React + Vitest + Testing Library (dashboard), Playwright (e2e).

## Global Constraints

- Roles are `'admin' | 'va'` (`UserRole`); `isUserRole()` is the guard.
- `userId` is DETERMINISTIC from the normalized email (`userIdForEmail`), so a removed email re-invites to the SAME key.
- Every route under `app/src/routes/adminUsers.ts` is already behind `requireRole('admin')` (mounted router-wide) -- do NOT add per-route auth.
- Guard error responses use HTTP 409 with `{ error: '<stable_code>' }` (mirror the existing role-change convention).
- Audit events: `audit.append('users#<userId>', '<event_type>', { ..., actor: req.user?.userId })`.
- Never log PII (email/name/cell). IDs + role only in `log.*`.
- New spec/plan/doc text and operational log strings are plain ASCII. UI copy uses straight ASCII apostrophes (matches the existing `useTeam` messages).
- Backend tests use the `makeWebhookHarness()` + `authSession` helpers; the in-memory `makeFakeUsersRepo` MUST implement the full `UsersRepo` interface (add `remove` there whenever it is added to the interface, or the app-workspace typecheck breaks).
- Run the REQUIRED gate `npm run typecheck` (from repo root) before every commit -- the runtime suites strip types without checking them.

---

### Task 1: Repo hard-delete -- `usersRepo.remove()` + fake parity

**Files:**
- Modify: `app/src/repos/usersRepo.ts` (import `DeleteCommand`; add `remove` to the `UsersRepo` interface and to the repo implementation)
- Modify: `app/test/helpers/authSession.ts` (add `remove` to `makeFakeUsersRepo`)
- Test: `app/test/m14.integration.test.ts` (new describe block -- real DynamoDB Local)

**Interfaces:**
- Consumes: nothing new.
- Produces: `UsersRepo.remove(userId: string): Promise<void>` -- hard-delete a user row; idempotent (deleting an absent id is a no-op). Callers enforce guards before calling.

- [ ] **Step 1: Write the failing integration test**

Append this describe block to `app/test/m14.integration.test.ts` (inside the top-level `describe.skipIf(!reachable)(...)`, after the `usersRepo push-subscription array writes` block):

```ts
  describe('usersRepo remove (hard delete)', () => {
    it('deletes the row and frees the key for a clean re-invite of the same email', async () => {
      const email = `remove-${randomUUID()}@housingchoice.org`;
      const { user, created } = await users.invite({ email, role: 'va' });
      expect(created).toBe(true);
      expect(await users.findById(user.userId)).toBeDefined();

      // Hard delete -> the row is gone.
      await users.remove(user.userId);
      expect(await users.findById(user.userId)).toBeUndefined();

      // Re-invite the SAME email -> same deterministic key, created:true again.
      const again = await users.invite({ email, role: 'admin' });
      expect(again.created).toBe(true);
      expect(again.user.userId).toBe(user.userId);
      expect(again.user.role).toBe('admin');

      // remove is idempotent -- deleting an absent id is a no-op (does not throw).
      await users.remove('usr_doesnotexist000000000');
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Requires DynamoDB Local (`npm run db:start`). Run from repo root:

Run: `npm test -w app -- m14.integration`
Expected: FAIL -- `users.remove is not a function` (the method does not exist yet). (If Docker is not running the suite SKIPS instead of failing; start it with `npm run db:start` so this test actually executes.)

- [ ] **Step 3: Add `DeleteCommand` to the imports**

In `app/src/repos/usersRepo.ts`, update the `@aws-sdk/lib-dynamodb` import (currently `GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand`) to include `DeleteCommand`:

```ts
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
```

- [ ] **Step 4: Add `remove` to the `UsersRepo` interface**

In `app/src/repos/usersRepo.ts`, in the `export interface UsersRepo {` block, add this method immediately after the `invite(...)` declaration (create + destroy adjacency):

```ts
  /**
   * Hard-delete a user row (DeleteCommand). IDEMPOTENT: deleting an absent
   * userId is a no-op. Because userId is deterministic from the email, the key
   * is freed for a clean re-invite of the same email afterward. The CALLER
   * enforces the self / last-admin / voice-line-holder guards BEFORE calling
   * this -- the repo just deletes.
   */
  remove(userId: string): Promise<void>;
```

- [ ] **Step 5: Implement `remove` in the repo**

In `app/src/repos/usersRepo.ts`, inside the `const repo: UsersRepo = { ... }` object, add this method immediately after the `async invite(...)` implementation (right after its closing `},`):

```ts
    async remove(userId) {
      // Hard delete. Unconditional so it is idempotent (deleting an absent id
      // is a no-op, not an error) -- the route has already run the guards.
      await doc.send(new DeleteCommand({ TableName: table, Key: { userId } }));
      log.info({ userId }, 'user removed');
    },
```

- [ ] **Step 6: Add `remove` to the in-memory fake repo (interface parity)**

In `app/test/helpers/authSession.ts`, inside `makeFakeUsersRepo`'s `const repo: UsersRepo = { ... }`, add this method immediately after the `async invite(...)` implementation:

```ts
    async remove(userId) {
      users.delete(userId);
    },
```

- [ ] **Step 7: Run the integration test to verify it passes**

Run: `npm test -w app -- m14.integration`
Expected: PASS (with `npm run db:start` running).

- [ ] **Step 8: Typecheck the app workspace**

Run: `npm run typecheck -w app`
Expected: PASS (0 errors -- proves the interface, real repo, and fake repo all agree).

- [ ] **Step 9: Commit**

```bash
git add app/src/repos/usersRepo.ts app/test/helpers/authSession.ts app/test/m14.integration.test.ts
git commit -m "feat(users): usersRepo.remove() hard-delete + fake parity"
```

---

### Task 2: `DELETE /api/users/:userId` route + guards

**Files:**
- Modify: `app/src/routes/adminUsers.ts` (add the DELETE handler)
- Test: `app/test/adminUsers.test.ts` (new describe block)

**Interfaces:**
- Consumes: `UsersRepo.remove` (Task 1); `usersRepo.findById`, `usersRepo.listAll`, `usersRepo.getInboundVoiceLineHolder` (existing); `audit.append` (existing).
- Produces: `DELETE /api/users/:userId` -> `200 { removed: true }` on success; `404 { error: 'user_not_found' }`; `409 { error: 'cannot_remove_last_admin' | 'cannot_remove_self' | 'voice_line_assigned' }`. Writes a `user_removed` audit event `{ email, role, actor }`.

Guard order (mirrors the role-change path: last-admin is the more fundamental invariant, checked first; then self; then voice-line):
1. `cannot_remove_last_admin` -- target is an admin AND the only admin. (Because every caller is an admin, this fires when the sole admin removes themselves.)
2. `cannot_remove_self` -- `req.user?.userId === userId` (a non-last admin removing their own account).
3. `voice_line_assigned` -- target is the current inbound-voice-line holder.

- [ ] **Step 1: Write the failing route tests**

Append this describe block to `app/test/adminUsers.test.ts` (after the existing `describe('PATCH /api/users/:userId/role', ...)` block, before the `Task 3` name-projection block). The imports it needs (`request`, `describe/it/expect`, `adminUserItem`, `sessionCookieFor`, `TEST_ADMIN_COOKIE`, `TEST_ADMIN_USER`, `TEST_SESSION_COOKIE`, `TEST_SESSION_USER`, `makeWebhookHarness`, `SECRET`) are already imported at the top of the file.

```ts
describe('DELETE /api/users/:userId', () => {
  it('removes a VA target (200), deletes the row, audits user_removed with actor + email', async () => {
    const { app, world, fakeUsers } = makeWebhookHarness();
    // The harness seeds the VA (TEST_SESSION_USER) and the admin (TEST_ADMIN_USER).
    const res = await request(app)
      .delete(`/api/users/${TEST_SESSION_USER.userId}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: true });
    // Row is gone.
    expect(fakeUsers.users.has(TEST_SESSION_USER.userId)).toBe(false);
    // Audit event with the acting admin + the target's email/role.
    const audit = world.auditEvents.find((e) => e.event_type === 'user_removed');
    expect(audit?.payload).toMatchObject({
      email: TEST_SESSION_USER.email,
      role: 'va',
      actor: TEST_ADMIN_USER.userId,
    });
  });

  it('refuses removing the LAST admin (409 cannot_remove_last_admin)', async () => {
    // Harness seeds exactly ONE admin (TEST_ADMIN_USER). Removing them (self)
    // would leave zero admins -> the last-admin guard fires first.
    const { app, fakeUsers } = makeWebhookHarness();
    const res = await request(app)
      .delete(`/api/users/${TEST_ADMIN_USER.userId}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'cannot_remove_last_admin' });
    // The admin is still there.
    expect(fakeUsers.users.has(TEST_ADMIN_USER.userId)).toBe(true);
  });

  it('a non-last admin removing THEMSELVES is refused (409 cannot_remove_self)', async () => {
    // Two admins present, so the last-admin guard does NOT fire -- the self
    // guard is what catches an admin removing their own account.
    const { app, fakeUsers } = makeWebhookHarness();
    fakeUsers.users.set(
      'usr_secondadmin',
      adminUserItem({ userId: 'usr_secondadmin', email: 'a2@housingchoice.org' }),
    );
    const res = await request(app)
      .delete(`/api/users/${TEST_ADMIN_USER.userId}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE); // self
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'cannot_remove_self' });
    // Still present (not removed).
    expect(fakeUsers.users.has(TEST_ADMIN_USER.userId)).toBe(true);
  });

  it('removing one of TWO admins (a distinct target) is allowed (200)', async () => {
    const { app, fakeUsers } = makeWebhookHarness();
    fakeUsers.users.set(
      'usr_secondadmin',
      adminUserItem({ userId: 'usr_secondadmin', email: 'a2@housingchoice.org' }),
    );
    const res = await request(app)
      .delete('/api/users/usr_secondadmin')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE); // distinct actor
    expect(res.status).toBe(200);
    expect(fakeUsers.users.has('usr_secondadmin')).toBe(false);
  });

  it('refuses removing the inbound-voice-line holder (409 voice_line_assigned)', async () => {
    const { app, fakeUsers } = makeWebhookHarness();
    // Make the VA target the current inbound-voice-line holder.
    await fakeUsers.repo.assignInboundVoiceLine(TEST_SESSION_USER.userId);
    const res = await request(app)
      .delete(`/api/users/${TEST_SESSION_USER.userId}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'voice_line_assigned' });
    // Still present (not removed).
    expect(fakeUsers.users.has(TEST_SESSION_USER.userId)).toBe(true);
  });

  it('404s an unknown target user', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .delete('/api/users/usr_does_not_exist')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE);
    expect(res.status).toBe(404);
  });

  it('VA is forbidden (403)', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .delete(`/api/users/${TEST_ADMIN_USER.userId}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE); // VA
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w app -- adminUsers`
Expected: FAIL -- the DELETE route does not exist yet, so requests 404 (route falls through) rather than returning the asserted statuses.

- [ ] **Step 3: Implement the DELETE route**

In `app/src/routes/adminUsers.ts`, add this handler immediately after the `router.patch('/:userId/role', ...)` block closes (before the `POST /:userId/inbound-voice-line` route):

```ts
  // DELETE /api/users/:userId -- remove a team member (HARD delete). GUARDS
  // (lockout + routing safety), each 409 with a stable code, in this order:
  //   1. cannot_remove_last_admin -- the table must never reach zero admins.
  //      (Every caller is an admin, so this fires when the sole admin removes
  //      themselves -- the more fundamental invariant, checked first, exactly
  //      like the PATCH-role path.)
  //   2. cannot_remove_self       -- a non-last admin can't remove their own
  //      account (a foot-gun even when other admins remain).
  //   3. voice_line_assigned      -- the target holds the single inbound voice
  //      line; it must be reassigned before removal (removal must not silently
  //      drop inbound call routing).
  // On success the row is deleted; sessionMiddleware revokes the removed user's
  // sessions within the epoch-cache TTL (<=60s). Re-inviting the same email
  // later lands on the same deterministic key cleanly.
  router.delete('/:userId', async (req: AuthedRequest, res) => {
    const userId = String(req.params['userId'] ?? '');

    const target = await users.findById(userId);
    if (!target) {
      res.status(404).json({ error: 'user_not_found' });
      return;
    }

    // 1. LAST-ADMIN guard (checked first -- the fundamental invariant).
    if (target.role === 'admin') {
      const admins = (await users.listAll()).filter((u) => u.role === 'admin');
      if (admins.length <= 1) {
        res.status(409).json({ error: 'cannot_remove_last_admin' });
        return;
      }
    }

    // 2. SELF guard.
    if (req.user?.userId === userId) {
      res.status(409).json({ error: 'cannot_remove_self' });
      return;
    }

    // 3. VOICE-LINE guard -- the single inbound-voice-line holder must be
    // reassigned first (removal doesn't silently drop inbound routing).
    const holder = await users.getInboundVoiceLineHolder();
    if (holder?.userId === userId) {
      res.status(409).json({ error: 'voice_line_assigned' });
      return;
    }

    await users.remove(userId);
    // Audit records the removed user's email + role (an audit-relevant operator
    // action, like user_invited); actor = the acting admin.
    await audit.append(`users#${userId}`, 'user_removed', {
      email: target.email,
      role: target.role,
      actor: req.user?.userId,
    });
    log.info({ userId, actor: req.user?.userId }, 'user removed via API');
    res.json({ removed: true });
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w app -- adminUsers`
Expected: PASS (all cases in the new describe block, plus the existing ones).

- [ ] **Step 5: Typecheck the app workspace**

Run: `npm run typecheck -w app`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/routes/adminUsers.ts app/test/adminUsers.test.ts
git commit -m "feat(users): DELETE /api/users/:userId with last-admin/self/voice-line guards"
```

---

### Task 3: Frontend data layer -- `removeUser` client + `useTeam.remove`

**Files:**
- Modify: `dashboard/src/api/endpoints.ts` (add `removeUser`)
- Modify: `dashboard/src/routes/settings/useTeam.ts` (add `RemoveResult`, `removeMessage`, `remove` action)

**Interfaces:**
- Consumes: `DELETE /api/users/:userId` (Task 2); `request`, `ApiError` (existing).
- Produces:
  - `removeUser(userId: string): Promise<{ removed: true }>` (exported from the api barrel automatically via `export * from './endpoints.js'`).
  - `TeamState.remove(userId: string): Promise<RemoveResult>` where `RemoveResult = { ok: true } | { ok: false; error: string }`. On success the row is dropped from local roster state; never throws.

- [ ] **Step 1: Add the `removeUser` client function**

In `dashboard/src/api/endpoints.ts`, add this immediately after the `setUserRole(...)` function (before the `// --- Voice: inbound-voice-line assignment ...` comment):

```ts
/** DELETE /api/users/:userId (admin) -- remove a team member (hard delete). 409
 *  cannot_remove_last_admin / cannot_remove_self / voice_line_assigned on a
 *  guard (surfaced inline). 200 { removed:true } on success. */
export function removeUser(userId: string): Promise<{ removed: true }> {
  return request<{ removed: true }>(`/api/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  });
}
```

- [ ] **Step 2: Extend the `useTeam` imports + add the result type and message map**

In `dashboard/src/routes/settings/useTeam.ts`, add `removeUser` to the import from `../../api/index.js`:

```ts
import {
  ApiError,
  assignInboundVoiceLine,
  clearInboundVoiceLine,
  inviteUser,
  listUsers,
  removeUser,
  setUserRole,
  type AdminUserView,
  type UserRole,
} from '../../api/index.js';
```

Add the result type next to `RoleChangeResult` / `VoiceLineResult`:

```ts
/** The result of a remove: ok (row dropped from the roster), or a per-row error
 *  to show in the confirm dialog (e.g. a 409 guard). Never throws. */
export type RemoveResult = { ok: true } | { ok: false; error: string };
```

Add the message map next to `lockoutMessage`:

```ts
/** Map the server's remove-guard `error` codes to a friendly message. */
function removeMessage(code: string): string | undefined {
  if (code === 'cannot_remove_last_admin') return 'The team must keep at least one admin.';
  if (code === 'cannot_remove_self') return "You can't remove your own account.";
  if (code === 'voice_line_assigned')
    return 'Reassign the inbound voice line before removing this teammate.';
  return undefined;
}
```

- [ ] **Step 3: Add `remove` to `TeamState` and implement it**

In `dashboard/src/routes/settings/useTeam.ts`, add to the `TeamState` interface (after `clearVoiceLine`):

```ts
  /** Remove a teammate (hard delete). On success the row is dropped from the
   *  roster; on a 409 guard returns a friendly error. Never throws. */
  remove: (userId: string) => Promise<RemoveResult>;
```

Add the implementation inside `useTeam`, after the `clearVoiceLine` callback and before the `return { ... }`:

```ts
  const remove = useCallback(async (userId: string): Promise<RemoveResult> => {
    try {
      await removeUser(userId);
      // Drop the row locally so the roster reflects the removal without a reload.
      setUsers((prev) => prev.filter((u) => u.userId !== userId));
      return { ok: true };
    } catch (err) {
      if (err instanceof ApiError) {
        const msg = removeMessage(err.code);
        return { ok: false, error: msg ?? "Couldn't remove the teammate. Please try again." };
      }
      return { ok: false, error: "Couldn't remove the teammate. Please try again." };
    }
  }, []);
```

Update the final `return` to include `remove`:

```ts
  return { status, users, retry, invite, changeRole, assignVoiceLine, clearVoiceLine, remove };
```

- [ ] **Step 4: Typecheck the dashboard workspace**

Run: `npm run typecheck -w dashboard`
Expected: PASS (the hook, its type, and the client fn all agree). The existing `TeamSection.test.tsx` still compiles because `remove` is additive.

- [ ] **Step 5: Run the existing team tests (still green -- additive change)**

Run: `npm test -w dashboard -- TeamSection`
Expected: PASS (unchanged behavior).

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/api/endpoints.ts dashboard/src/routes/settings/useTeam.ts
git commit -m "feat(team): removeUser client + useTeam.remove action"
```

---

### Task 4: UI -- Remove button + confirm dialog + wiring

**Files:**
- Create: `dashboard/src/routes/settings/ConfirmRemoveDialog.tsx`
- Modify: `dashboard/src/routes/settings/UserRow.tsx` (Remove control in the table + card variants; error-row colSpan 6 -> 7)
- Modify: `dashboard/src/routes/settings/TeamSection.tsx` (actions column header; compute disabled reason; render the dialog; drop the stale FUTURE comment)
- Modify: `dashboard/src/routes/settings/TeamSection.module.css` (`.removeBtn`, `.cardActions`, `.dialogText`)
- Test: `dashboard/src/routes/settings/TeamSection.test.tsx` (new cases)

**Interfaces:**
- Consumes: `TeamState.remove` / `RemoveResult` (Task 3); the existing `Modal` component (`../contact/Modal.js`); `Button` (`../../ui/index.js`); `useAuth().me` (has `userId`).
- Produces:
  - `ConfirmRemoveDialog` component: props `{ user: AdminUserView; onClose: () => void; onConfirm: (userId: string) => Promise<RemoveResult> }`. Renders a `Modal` titled "Remove teammate"; footer Cancel/Remove; shows an inline `role="alert"` error on a failed confirm and stays open; on success calls `onClose()` (the roster has already dropped the row).
  - `UserRow` gains props `onRequestRemove: (user: AdminUserView) => void` and `removeDisabledReason?: string`. It renders a Remove button (disabled with `title={removeDisabledReason}` when a reason is set; otherwise it calls `onRequestRemove(user)`), with `aria-label={`Remove ${user.email}`}`.
  - `TeamSection` computes `removeDisabledReason` per row, owns the single dialog instance, and passes `onRequestRemove` + `remove`.

- [ ] **Step 1: Write the failing UI tests**

In `dashboard/src/routes/settings/TeamSection.test.tsx`:

(a) Add `removeUser` to the mocked api module. Update the top-of-file mock block to declare and wire it:

```ts
const listUsers = vi.fn();
const inviteUser = vi.fn();
const setUserRole = vi.fn();
const assignInboundVoiceLine = vi.fn();
const clearInboundVoiceLine = vi.fn();
const removeUser = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    listUsers: (...a: unknown[]) => listUsers(...a),
    inviteUser: (...a: unknown[]) => inviteUser(...a),
    setUserRole: (...a: unknown[]) => setUserRole(...a),
    assignInboundVoiceLine: (...a: unknown[]) => assignInboundVoiceLine(...a),
    clearInboundVoiceLine: (...a: unknown[]) => clearInboundVoiceLine(...a),
    removeUser: (...a: unknown[]) => removeUser(...a),
  };
});
```

(b) Append this describe block at the end of the file. Note: the mocked `useAuth` (already at the top of the file) returns `me.userId === 'viewer'`, so a row with `userId: 'viewer'` is the viewer's own row.

```ts
describe('TeamSection -- remove teammate', () => {
  it('removes a member after confirming in the dialog', async () => {
    const u = userEvent.setup();
    listUsers.mockResolvedValue([
      user({ userId: 'admin1', email: 'admin@example.com', role: 'admin' }),
      user({ userId: 'bob', email: 'bob@example.com', role: 'va' }),
    ]);
    removeUser.mockResolvedValue({ removed: true });
    render(<TeamSection />);
    await screen.findByText('bob@example.com');

    // Open the confirm dialog for Bob (a removable VA).
    await u.click(screen.getByRole('button', { name: 'Remove bob@example.com' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove teammate' });

    // Confirm.
    await u.click(within(dialog).getByRole('button', { name: 'Remove' }));

    expect(removeUser).toHaveBeenCalledWith('bob');
    // The row is dropped from the roster.
    await waitFor(() => expect(screen.queryByText('bob@example.com')).not.toBeInTheDocument());
  });

  it('disables Remove for your own row (self)', async () => {
    listUsers.mockResolvedValue([
      user({ userId: 'admin1', email: 'admin@example.com', role: 'admin' }),
      user({ userId: 'viewer', email: 'viewer@example.com', role: 'va' }),
    ]);
    render(<TeamSection />);
    await screen.findByText('viewer@example.com');
    const btn = screen.getByRole('button', { name: 'Remove viewer@example.com' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', "You can't remove your own account.");
  });

  it('disables Remove for the last admin', async () => {
    // Exactly one admin (not the viewer) -> that admin can't be removed.
    listUsers.mockResolvedValue([
      user({ userId: 'onlyadmin', email: 'onlyadmin@example.com', role: 'admin' }),
      user({ userId: 'bob', email: 'bob@example.com', role: 'va' }),
    ]);
    render(<TeamSection />);
    await screen.findByText('onlyadmin@example.com');
    const btn = screen.getByRole('button', { name: 'Remove onlyadmin@example.com' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'The team must keep at least one admin.');
  });

  it('disables Remove for the inbound-voice-line holder', async () => {
    listUsers.mockResolvedValue([
      user({ userId: 'admin1', email: 'admin@example.com', role: 'admin' }),
      user({
        userId: 'holder',
        email: 'holder@example.com',
        role: 'va',
        cell: '+14040100001',
        cell_verified_at: '2026-06-01T00:00:00.000Z',
        inbound_voice_line: true,
      }),
    ]);
    render(<TeamSection />);
    await screen.findByText('holder@example.com');
    const btn = screen.getByRole('button', { name: 'Remove holder@example.com' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Reassign the inbound voice line first.');
  });

  it('keeps the row and shows the error in the dialog on a 409', async () => {
    const u = userEvent.setup();
    listUsers.mockResolvedValue([
      user({ userId: 'admin1', email: 'admin@example.com', role: 'admin' }),
      user({ userId: 'bob', email: 'bob@example.com', role: 'va' }),
    ]);
    // The button is enabled (Bob looks removable), but the server rejects (race).
    removeUser.mockRejectedValue(
      new ApiError(409, 'voice_line_assigned', 'holds the inbound line'),
    );
    render(<TeamSection />);
    await screen.findByText('bob@example.com');

    await u.click(screen.getByRole('button', { name: 'Remove bob@example.com' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove teammate' });
    await u.click(within(dialog).getByRole('button', { name: 'Remove' }));

    // Error shown in the dialog; the row is still present.
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/Reassign the inbound voice line/i);
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w dashboard -- TeamSection`
Expected: FAIL -- no `Remove ...` buttons exist yet (`getByRole('button', { name: 'Remove ...' })` throws).

- [ ] **Step 3: Create the `ConfirmRemoveDialog` component**

Create `dashboard/src/routes/settings/ConfirmRemoveDialog.tsx`:

```tsx
// ConfirmRemoveDialog -- the "Remove teammate" confirmation. Renders the shared
// accessible Modal (role="dialog", aria-modal, Esc/backdrop close). Confirming
// calls onConfirm; on a 409 guard it shows the message inline and stays open;
// on success onClose() runs (the roster has already dropped the row). While the
// request is in flight the dialog can't be dismissed and both buttons disable.
import { useState } from 'react';
import type { AdminUserView } from '../../api/index.js';
import type { RemoveResult } from './useTeam.js';
import { Modal } from '../contact/Modal.js';
import { Button } from '../../ui/index.js';
import styles from './TeamSection.module.css';

export interface ConfirmRemoveDialogProps {
  user: AdminUserView;
  onClose: () => void;
  onConfirm: (userId: string) => Promise<RemoveResult>;
}

export function ConfirmRemoveDialog({
  user,
  onClose,
  onConfirm,
}: ConfirmRemoveDialogProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await onConfirm(user.userId);
    if (!result.ok) {
      setError(result.error);
      setBusy(false);
      return;
    }
    onClose(); // success -- the row is already gone from the roster
  }

  return (
    <Modal
      title="Remove teammate"
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={() => void confirm()} disabled={busy}>
            {busy ? 'Removing...' : 'Remove'}
          </Button>
        </>
      }
    >
      <p className={styles.dialogText}>
        Remove <strong>{user.name}</strong> ({user.email})? They'll lose dashboard access
        immediately.
      </p>
      {error !== null ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
```

- [ ] **Step 4: Add the Remove control to `UserRow`**

In `dashboard/src/routes/settings/UserRow.tsx`:

(a) Extend `UserRowProps` (after `viewerIsAdmin?`):

```ts
  /** Open the remove-confirmation for this user. */
  onRequestRemove: (user: AdminUserView) => void;
  /** When set, the Remove button is DISABLED and this string is its tooltip
   *  (self / last-admin / voice-line-holder). Undefined = removable. */
  removeDisabledReason?: string;
```

(b) Destructure the new props in the component signature:

```tsx
export function UserRow({
  user,
  onChangeRole,
  onAssignVoiceLine,
  onClearVoiceLine,
  variant,
  viewerIsAdmin = true,
  onRequestRemove,
  removeDisabledReason,
}: UserRowProps): React.JSX.Element {
```

(c) Build the control (place it just before the `if (variant === 'card')` block, after `const statusText = ...`):

```tsx
  const removeControl = (
    <button
      type="button"
      className={styles.removeBtn}
      disabled={removeDisabledReason !== undefined}
      title={removeDisabledReason}
      onClick={() => onRequestRemove(user)}
      aria-label={`Remove ${user.email}`}
    >
      Remove
    </button>
  );
```

(d) Card variant: add a Remove action after the `</dl>` and before the `{error !== null ...}` block:

```tsx
        <div className={styles.cardActions}>{removeControl}</div>
```

(e) Table variant: add an actions cell as the LAST `<td>` in the `<tr>` (after the `last login` cell):

```tsx
        <td className={styles.cell}>{removeControl}</td>
```

(f) Table variant: bump the error row `colSpan` from `6` to `7`:

```tsx
          <td className={styles.cellError} colSpan={7}>
```

- [ ] **Step 5: Wire `TeamSection` -- header column, disabled-reason, dialog, drop stale comment**

In `dashboard/src/routes/settings/TeamSection.tsx`:

(a) Remove the stale comment lines (the `// FUTURE: no delete/deactivate in v1 ...` line in the header block).

(b) Update imports -- add `useState`, the dialog, the `AdminUserView` type:

```tsx
import { useState } from 'react';
import { useAuth } from '../../app/AuthContext.js';
import { useTeam } from './useTeam.js';
import { UserRow } from './UserRow.js';
import { InviteForm } from './InviteForm.js';
import { ConfirmRemoveDialog } from './ConfirmRemoveDialog.js';
import { useIsMobile } from './useIsMobile.js';
import { Button, Spinner } from '../../ui/index.js';
import type { AdminUserView } from '../../api/index.js';
import styles from './TeamSection.module.css';
```

(c) Add a module-level helper (above the `export function TeamSection`):

```tsx
/** Why this member's Remove is disabled, or undefined when removable. Order
 *  mirrors the server guards: last-admin (fundamental invariant) -> self ->
 *  voice-line-holder. */
function removeDisabledReason(
  u: AdminUserView,
  meUserId: string | undefined,
  adminCount: number,
): string | undefined {
  if (u.role === 'admin' && adminCount <= 1) return 'The team must keep at least one admin.';
  if (u.userId === meUserId) return "You can't remove your own account.";
  if (u.inbound_voice_line === true) return 'Reassign the inbound voice line first.';
  return undefined;
}
```

(d) In the component, pull `me` + `remove`, add dialog state + derived count:

```tsx
  const { status, users, retry, invite, changeRole, assignVoiceLine, clearVoiceLine, remove } =
    useTeam();
  const { isAdmin, me } = useAuth();
  const isMobile = useIsMobile();
  const [removing, setRemoving] = useState<AdminUserView | null>(null);
  const adminCount = users.filter((u) => u.role === 'admin').length;
```

(e) Add the actions column header -- a new `<th>` after the `Last login` header:

```tsx
                  <th className={styles.th} scope="col">
                    <span className={styles.srOnly}>Actions</span>
                  </th>
```

(f) Pass the new props on BOTH `<UserRow>` usages (card and table). For each, add:

```tsx
                  onRequestRemove={setRemoving}
                  removeDisabledReason={removeDisabledReason(u, me?.userId, adminCount)}
```

(g) Render the dialog once, just before the closing `</section>` (after the `{status === ... : (...)}` block):

```tsx
      {removing !== null ? (
        <ConfirmRemoveDialog
          user={removing}
          onClose={() => setRemoving(null)}
          onConfirm={remove}
        />
      ) : null}
```

- [ ] **Step 6: Add the CSS**

Append to `dashboard/src/routes/settings/TeamSection.module.css`:

```css
/* --- Remove control + confirm dialog ------------------------------------- */
.removeBtn {
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-danger);
  font: inherit;
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  padding: var(--sp-1) var(--sp-2);
  cursor: pointer;
}

.removeBtn:hover:not(:disabled) {
  background: var(--c-surface-2);
}

.removeBtn:focus-visible {
  outline: 2px solid var(--c-focus-ring);
  outline-offset: 1px;
}

.removeBtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  color: var(--c-text-muted);
}

.cardActions {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--sp-2);
}

.dialogText {
  margin: 0;
  color: var(--c-text);
  font-size: var(--fs-sm);
}
```

- [ ] **Step 7: Run the UI tests to verify they pass**

Run: `npm test -w dashboard -- TeamSection`
Expected: PASS (the new remove cases + all existing cases).

- [ ] **Step 8: Typecheck the dashboard workspace**

Run: `npm run typecheck -w dashboard`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add dashboard/src/routes/settings/ConfirmRemoveDialog.tsx dashboard/src/routes/settings/UserRow.tsx dashboard/src/routes/settings/TeamSection.tsx dashboard/src/routes/settings/TeamSection.module.css dashboard/src/routes/settings/TeamSection.test.tsx
git commit -m "feat(team): Remove button + confirm dialog on Settings > Team"
```

---

### Task 5: e2e coverage -- admin removes an invited teammate

**Files:**
- Modify: `e2e/tests/dashboard-next/settings.spec.ts` (new test in the admin describe)

**Interfaces:**
- Consumes: the full stack (real backend + dashboard) via the e2e harness; the existing `devLoginAs` helper.
- Produces: an end-to-end proof that an admin can invite then remove a teammate and the row disappears.

- [ ] **Step 1: Write the e2e test**

In `e2e/tests/dashboard-next/settings.spec.ts`, add this test inside `test.describe('Settings -- admin path', ...)` (after the existing admin test):

```ts
  test('admin can remove an invited teammate', async ({ page }) => {
    await devLoginAs(page, 'founder@example.com');
    await page.goto(`${NEXT}/settings/team`);
    await expect(page.getByRole('heading', { name: 'Team', level: 2 })).toBeVisible();

    // Invite a throwaway VA (default role) -- not self, not an admin, no voice
    // line, so it is removable.
    const email = `removeme-${Date.now()}@example.com`;
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Invite' }).click();
    await expect(page.getByRole('status')).toContainText(/Invited/i);
    await expect(page.getByLabel(`Role for ${email}`)).toBeVisible();

    // Remove -> confirm in the dialog -> the row disappears.
    await page.getByRole('button', { name: `Remove ${email}` }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove teammate' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Remove' }).click();

    // The teammate's row (identified by its per-row role control) is gone.
    await expect(page.getByLabel(`Role for ${email}`)).toHaveCount(0);
    await expect(dialog).not.toBeVisible();
  });
```

- [ ] **Step 2: Run the e2e suite**

Run (from repo root; boots a hermetic stack): `npm run e2e`
Expected: PASS -- including the new "admin can remove an invited teammate" test. (Requires Docker per the e2e README.)

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/dashboard-next/settings.spec.ts
git commit -m "test(e2e): admin removes an invited teammate on Settings > Team"
```

---

## Final Verification (before declaring done)

- [ ] **Sync with main** -- `git merge main` in the worktree; resolve conflicts keeping both intents.
- [ ] **Full gates green on the updated base** (from repo root, run BARE -- never piped to tail/grep):
  - `npm run typecheck`
  - `npm test`
  - `npm run e2e`
- [ ] **Self-QA the UI** with the Playwright MCP against `npm run e2e:session`: dev-login as `founder@example.com`, open Settings > Team, confirm the Remove button appears, is disabled with the right tooltip on your own row / the last admin / a voice-line holder, and that removing an invited teammate drops the row after confirming.

## Notes for the implementer

- The `Modal` component currently lives at `dashboard/src/routes/contact/Modal.tsx` with a comment "kept local to the contact route for now". Reusing it cross-route (importing from settings) is intentional and fine -- it is the app's accessible dialog primitive. Do NOT duplicate it.
- Do NOT add per-route auth to the DELETE handler -- `router.use(requireRole('admin'))` at the top of `adminUsers.ts` already guards every route.
- Session revocation after removal is automatic (the auth middleware detects the missing row) -- do NOT add any explicit logout call.
- `broadcasts.created_by` and audit `actor` remain plain attribution strings after a user is removed; they degrade gracefully via `displayNameOf`. No cascade cleanup is needed or wanted.
- This is code + tests + docs only. Do NOT run any infra/deploy/secrets/Terraform commands.
