<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-08-04).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Deleted-Contact Resurfacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A soft-deleted contact who texts or emails us again resurfaces their ORIGINAL conversation in the inbox (with a "Deleted" chip) until the thread is read; replying requires restoring them (locked composer + 409 send guard).

**Architecture:** Read-time only on the surfacing side - the inbox aggregator's one deleted-contact filter line becomes a conditional (surface iff an unread inbound newer than `deleted_at` exists), stamping `deleted: true` on the wire row; no new writes or state. The send guard mirrors the existing opt-out refusal family in both send services (SMS + email), mapped to 409 `contact_deleted`. Dashboard renders a chip on the row and replaces the contact-page composer with a restore note when deleted.

**Tech Stack:** Node/TypeScript (Express 5, DynamoDB repos), Vitest, React + CSS modules, Playwright e2e.

Spec: `docs/superpowers/specs/2026-08-03-deleted-contact-resurfacing-design.md`.
Note: the spec's "Today board stays deleted-blind" decision requires NO code change (today.ts already filters deleted contacts) - there is deliberately no task for it.

## Global Constraints

- Branch `feat/deleted-contact-resurfacing` in a worktree at `w:/tmp/deleted-contact-resurfacing` (`git worktree add`). NEVER commit to main; never move HEAD in the shared checkout.
- Gates: `npm run typecheck` (REQUIRED - the test runners strip types without checking them), `npm test`, `npm run e2e`. Run gates BARE - never piped into head/grep/tee.
- Run `git status` as its OWN command before EVERY commit (never chained), and commit by explicit pathspec (`git commit -m "..." -- <paths>`).
- The `InboxRow` wire type exists twice and must stay verbatim-identical: `app/src/routes/inbox.ts` and `dashboard/src/api/types.ts` (the dashboard copy's doc comment says "Keep in sync with the backend contract").
- The refusal code literal is exactly `'contact_deleted'` in BOTH services' code unions and BOTH route status maps.
- Playwright runs ONLY from the `e2e/` workspace directory (a root-level run targets the human's live :5174 stack).
- E2e selectors are accessibility-first (`getByRole`/`getByLabel`) - see `e2e/support/selectors.md`. No data-testids.
- New UI copy may use the em-dash style the app already uses; any new doc prose stays ASCII.
- Domain naming: the entity is `contact` in code; no new domain nouns (GLOSSARY unaffected).

---

### Task 0: Worktree setup

**Files:** none (environment only)

- [ ] **Step 1: Create the worktree + branch** (from the shared checkout; do NOT switch its HEAD)

```powershell
git worktree add "w:/tmp/deleted-contact-resurfacing" -b feat/deleted-contact-resurfacing
```

- [ ] **Step 2: Install deps in the worktree**

```powershell
cd "w:/tmp/deleted-contact-resurfacing"; npm install
```

- [ ] **Step 3: Baseline gates** (must be green before any change)

Run (in the worktree root, separate bare commands): `npm run typecheck` then `npm test`
Expected: both exit 0. If not, STOP and report - the base is broken, not your work.

---

### Task 1: Backend - inbox aggregator resurfaces deleted contacts

**Files:**
- Modify: `app/src/routes/inbox.ts` (wire type ~line 72-93; `DerivedLatest`/`deriveLatest` ~lines 215-256; `rowForConversation` ~lines 408-455)
- Test: `app/test/inboxFeed.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: `isDeleted(contact)` from `app/src/repos/contactsRepo.js` (already imported in inbox.ts); `MessageItem.created_at: string` and `.direction: 'inbound' | 'outbound'` (both required fields).
- Produces: `InboxRow` gains optional `deleted?: boolean` (present and `true` only on resurfaced soft-deleted contact rows). `DerivedLatest` gains optional `createdAt?: string`. Tasks 4-6 rely on the field name `deleted` and the surfacing rule exactly as specified here.

- [ ] **Step 1: Write the failing tests**

Append to `app/test/inboxFeed.test.ts` (uses the file's existing `makeDeps`/`conv` helpers; note the fake messagesRepo returns whatever `latestMessage[conversationId]` holds, so each entry must carry `direction` and `created_at`):

```ts
describe('aggregateInbox — deleted-contact resurfacing (2026-08-03 spec)', () => {
  const DELETED_AT = '2026-08-01T00:00:00.000Z';
  const BEFORE = '2026-07-30T00:00:00.000Z';
  const AFTER = '2026-08-02T00:00:00.000Z';

  const deletedContact = (over: Partial<ContactItem> = {}): ContactItem => ({
    contactId: 'c-del',
    type: 'tenant',
    firstName: 'Dana',
    lastName: 'Doe',
    phone: '+15550000001',
    deleted_at: DELETED_AT,
    ...over,
  });

  it('surfaces a deleted contact with an unread inbound newer than deleted_at (deleted: true)', async () => {
    const deps = makeDeps({
      contacts: [deletedContact()],
      conversations: [
        conv({ conversationId: 'conv-1', participant_phone: '+15550000001', last_activity_at: AFTER, unread_count: 1 }),
      ],
      latestMessage: {
        'conv-1': { type: 'sms', direction: 'inbound', body: 'im back', created_at: AFTER },
      },
    });
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      kind: 'contact',
      contactId: 'c-del',
      deleted: true,
      unreadCount: 1,
      preview: 'im back',
    });
  });

  it('hides a deleted contact with zero unread (post-deletion inbound already read)', async () => {
    const deps = makeDeps({
      contacts: [deletedContact()],
      conversations: [
        conv({ conversationId: 'conv-1', participant_phone: '+15550000001', last_activity_at: AFTER, unread_count: 0 }),
      ],
      latestMessage: {
        'conv-1': { type: 'sms', direction: 'inbound', body: 'im back', created_at: AFTER },
      },
    });
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    expect(page.rows).toHaveLength(0);
  });

  it('hides a deleted contact whose unread inbound PREDATES the deletion', async () => {
    const deps = makeDeps({
      contacts: [deletedContact()],
      conversations: [
        conv({ conversationId: 'conv-1', participant_phone: '+15550000001', last_activity_at: BEFORE, unread_count: 2 }),
      ],
      latestMessage: {
        'conv-1': { type: 'sms', direction: 'inbound', body: 'old unread', created_at: BEFORE },
      },
    });
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    expect(page.rows).toHaveLength(0);
  });

  it('hides a deleted contact whose latest message is OUTBOUND (even post-deletion, even with unread)', async () => {
    const deps = makeDeps({
      contacts: [deletedContact()],
      conversations: [
        conv({ conversationId: 'conv-1', participant_phone: '+15550000001', last_activity_at: AFTER, unread_count: 1 }),
      ],
      latestMessage: {
        'conv-1': { type: 'sms', direction: 'outbound', body: 'scheduled nudge', created_at: AFTER },
      },
    });
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    expect(page.rows).toHaveLength(0);
  });

  it('a surfaced deleted row passes the unread filter', async () => {
    const deps = makeDeps({
      contacts: [deletedContact()],
      conversations: [
        conv({ conversationId: 'conv-1', participant_phone: '+15550000001', last_activity_at: AFTER, unread_count: 1 }),
      ],
      latestMessage: {
        'conv-1': { type: 'sms', direction: 'inbound', body: 'im back', created_at: AFTER },
      },
    });
    const page = await aggregateInbox({ filter: 'unread', limit: 25 }, deps);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ contactId: 'c-del', deleted: true });
  });

  it('a live (restored) contact row never carries the deleted field', async () => {
    const deps = makeDeps({
      contacts: [deletedContact({ deleted_at: undefined as unknown as string })],
      conversations: [
        conv({ conversationId: 'conv-1', participant_phone: '+15550000001', last_activity_at: AFTER, unread_count: 1 }),
      ],
      latestMessage: {
        'conv-1': { type: 'sms', direction: 'inbound', body: 'im back', created_at: AFTER },
      },
    });
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).not.toHaveProperty('deleted');
  });
});
```

(If `deleted_at: undefined as unknown as string` fights the linter, build the restored contact by object-destructuring the stub minus `deleted_at` instead - the point is a contact WITHOUT the stamp.)

- [ ] **Step 2: Run to verify the new tests fail**

Run (from `app/`): `npx vitest run test/inboxFeed.test.ts`
Expected: the six new tests FAIL (surfacing test gets 0 rows; the `deleted: true` matcher fails), pre-existing tests PASS.

- [ ] **Step 3: Implement**

Three edits in `app/src/routes/inbox.ts`:

(a) Wire type - add one field after `needsTriage` in `export interface InboxRow` (~line 88):

```ts
  needsTriage: boolean; // true for untriaged unknowns; ALWAYS false for relay_group
  /** Deleted-contact resurfacing (2026-08-03 spec): present/true ONLY on a
   *  soft-deleted contact row surfaced by an unread post-deletion inbound —
   *  the dashboard renders a "Deleted" chip. Absent on live contacts and
   *  non-contact rows. */
  deleted?: boolean;
```

(b) Carry the latest message's timestamp - extend `DerivedLatest` + `deriveLatest` (~lines 216-256):

```ts
interface DerivedLatest {
  channel: InboxChannel;
  direction: 'inbound' | 'outbound';
  preview: string;
  /** The latest message's created_at (ISO). Absent when no message row was
   *  readable (fallback preview) — callers needing recency must treat absent
   *  as "unknown", never as "new". */
  createdAt?: string;
}
```

In `deriveLatest`, widen the param type with `created_at?: unknown` and thread it through:

```ts
function deriveLatest(
  latest: { type?: unknown; direction?: unknown; body?: unknown; mediaUrls?: unknown; media_attachments?: unknown; created_at?: unknown } | undefined,
  conv: ConversationItem,
): DerivedLatest {
```

and change the two return statements: the `!latest` fallback stays as-is (no `createdAt`), and the final return becomes:

```ts
  const createdAt = typeof latest.created_at === 'string' ? latest.created_at : undefined;
  return { channel, direction, preview, ...(createdAt !== undefined && { createdAt }) };
```

(c) The surfacing rule - in `rowForConversation`, REPLACE the unconditional filter (~lines 408-410):

```ts
    // Soft-deleted contact → hidden from the inbox (record retained; restore
    // resurfaces it). findByPhone stays unfiltered for routing, so filter here.
    if (isDeleted(contact)) return undefined;
```

with a flag, and rework the body below it so the deleted check happens AFTER unread/latest are known. The full replacement region (from that comment down to the `return { kind: 'contact', ...}` object) becomes:

```ts
    // Soft-deleted contact → hidden from the inbox EXCEPT while an unread
    // post-deletion inbound exists (deleted-contact resurfacing, 2026-08-03
    // spec): the thread resurfaces with deleted:true until read or restored.
    // findByPhone stays unfiltered for routing, so the decision lives here.
    const deleted = isDeleted(contact);

    if (emittedContacts.has(contact.contactId)) return undefined; // one row per page
    const convs = await contactConversations(contact);
    const maxConv = newestOf(convs) ?? conv;
    // Represent the contact ONLY at its NEWEST conversation. An older one is
    // skipped — a newer conversation already (or will) emit the row. This is
    // what makes paging split-proof: a contact seen on page 1 (at its newest
    // conv) can never re-emit on page 2 via an older conv.
    if (maxConv.conversationId !== conv.conversationId) return undefined;

    const unreadSum = convs.reduce((sum, c) => sum + unreadOf(c), 0);
    // Deleted fast-path: nothing unread → hidden, no message read needed.
    if (deleted && unreadSum === 0) return undefined;
    const { channel, direction, preview, createdAt } = await latestMessageOf(maxConv.conversationId, maxConv);
    if (deleted) {
      // Surface ONLY when the newest message is an inbound from AFTER the
      // deletion. Pre-deletion unread stays hidden (deleting draws a line);
      // a post-deletion OUTBOUND (e.g. a straggler scheduled send) does not
      // resurface anyone. Absent createdAt (fallback preview) → stay hidden.
      const freshInbound =
        direction === 'inbound' &&
        typeof createdAt === 'string' &&
        typeof contact.deleted_at === 'string' &&
        createdAt > contact.deleted_at;
      if (!freshInbound) return undefined;
    }
```

and add the field to the returned row object (after `needsTriage`):

```ts
      needsTriage: role === 'unknown',
      ...(deleted && { deleted: true }),
```

Everything between (placementContext block, `emittedContacts.add`, role/fallbackLabel) stays byte-identical - only the filter moves and the destructure gains `createdAt`.

- [ ] **Step 4: Run the tests**

Run (from `app/`): `npx vitest run test/inboxFeed.test.ts`
Expected: ALL pass (new six + every pre-existing test - the pre-existing ones prove live-contact behavior is unchanged).

- [ ] **Step 5: Typecheck + commit**

Run (worktree root, bare, separate): `npm run typecheck`
Expected: exit 0.

```powershell
git status
git add app/src/routes/inbox.ts app/test/inboxFeed.test.ts
git commit -m "feat(inbox): resurface deleted contacts with unread post-deletion inbounds (deleted:true rows)" -- app/src/routes/inbox.ts app/test/inboxFeed.test.ts
```

---

### Task 2: Backend - SMS send guard (409 contact_deleted)

**Files:**
- Modify: `app/src/services/sendMessage.ts` (error union ~lines 41-83; gate after the opt-out check ~line 256)
- Modify: `app/src/routes/api.ts` (`REFUSAL_STATUS` map ~lines 127-141)
- Test: `app/test/sendMessage.test.ts`

**Interfaces:**
- Consumes: the contact already loaded at sendMessage.ts:245 (`const contact = await contacts.findByPhone(participantPhone);`); `isDeleted` from `../repos/contactsRepo.js` (ADD to that file's existing contactsRepo import).
- Produces: `export class ContactDeletedError extends SendRefusedError` with code `'contact_deleted'`; HTTP 409 `{ error: 'contact_deleted' }` from `POST /api/conversations/:id/messages`. Task 5's `sendFailureMessage` switch matches on this code.

- [ ] **Step 1: Write the failing tests**

In `app/test/sendMessage.test.ts`: add `ContactDeletedError` to the existing `from '../src/services/sendMessage.js'` import block, then append (the file's `makeFakes({ contact })` REPLACES the default contact wholesale, so supply the full contact):

```ts
describe('deleted-contact send guard (2026-08-03 spec)', () => {
  it('refuses sends to soft-deleted contacts with a typed error (nothing sent, nothing persisted)', async () => {
    const f = makeFakes({
      contact: {
        contactId: 'contact-1',
        type: 'tenant',
        phone: '+15550100001',
        consent_method: 'inbound_text',
        deleted_at: '2026-08-01T00:00:00.000Z',
      },
    });
    await expect(f.service({ conversationId: 'conv-1', body: 'x' })).rejects.toBeInstanceOf(
      ContactDeletedError,
    );
    expect(f.sent).toHaveLength(0);
    expect(f.appended).toHaveLength(0);
  });

  it('also refuses AUTOMATED sends to soft-deleted contacts (no straggler scheduled nudges)', async () => {
    const f = makeFakes({
      contact: {
        contactId: 'contact-1',
        type: 'tenant',
        phone: '+15550100001',
        consent_method: 'inbound_text',
        deleted_at: '2026-08-01T00:00:00.000Z',
      },
    });
    await expect(
      f.service({ conversationId: 'conv-1', body: 'x', automated: true }),
    ).rejects.toBeInstanceOf(ContactDeletedError);
    expect(f.sent).toHaveLength(0);
  });

  it('the opt-out gate still fires first on a contact that is BOTH opted out and deleted', async () => {
    const f = makeFakes({
      contact: {
        contactId: 'contact-1',
        type: 'tenant',
        phone: '+15550100001',
        sms_opt_out: true,
        deleted_at: '2026-08-01T00:00:00.000Z',
      },
    });
    await expect(f.service({ conversationId: 'conv-1', body: 'x' })).rejects.toBeInstanceOf(
      ContactOptedOutError,
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run (from `app/`): `npx vitest run test/sendMessage.test.ts`
Expected: first two new tests FAIL (`ContactDeletedError` is not exported yet → the import itself errors; that counts). Fix nothing else.

- [ ] **Step 3: Implement**

(a) `app/src/services/sendMessage.ts` - add `'contact_deleted'` to the `SendRefusedError` code union (~line 46-53), and the class beside `ContactOptedOutError`:

```ts
/** Soft-deleted contacts are unreachable (human OR automated) until restored
 *  (deleted-contact resurfacing spec 2026-08-03). */
export class ContactDeletedError extends SendRefusedError {
  constructor(conversationId: string) {
    super(`contact for conversation ${conversationId} is soft-deleted — send refused`, 'contact_deleted');
  }
}
```

(b) Add `isDeleted` to the file's contactsRepo import, then insert the gate directly AFTER the opt-out gate (after the `throw new ContactOptedOutError(conversationId);` block, ~line 256) and BEFORE the JIT-consent gate:

```ts
    // (1b) Deleted gate — a soft-deleted contact is unreachable until restored
    // (deleted-contact resurfacing spec 2026-08-03). Sits between opt-out and
    // consent: harder than no-consent (the dashboard must show "restore to
    // reply", never open the consent modal), softer than opt-out (TCPA wins).
    if (contact !== undefined && isDeleted(contact)) {
      log.warn({ conversationId, contactId: contact.contactId }, 'send refused: contact is soft-deleted');
      throw new ContactDeletedError(conversationId);
    }
```

(c) `app/src/routes/api.ts` - add to `REFUSAL_STATUS` (~line 128):

```ts
  contact_opted_out: 409,
  contact_deleted: 409,
```

- [ ] **Step 4: Run the tests**

Run (from `app/`): `npx vitest run test/sendMessage.test.ts`
Expected: ALL pass (including every pre-existing gate-order test).

- [ ] **Step 5: Typecheck + commit**

Run (worktree root, bare, separate): `npm run typecheck`
Expected: exit 0.

```powershell
git status
git add app/src/services/sendMessage.ts app/src/routes/api.ts app/test/sendMessage.test.ts
git commit -m "feat(send): refuse SMS sends to soft-deleted contacts (409 contact_deleted)" -- app/src/services/sendMessage.ts app/src/routes/api.ts app/test/sendMessage.test.ts
```

---

### Task 3: Backend - email send guard (409 contact_deleted)

**Files:**
- Modify: `app/src/services/sendEmailMessage.ts` (error union ~lines 48-64; gate after the suppression check ~line 286)
- Modify: `app/src/routes/api.ts` (`EMAIL_REFUSAL_STATUS` map ~lines 143-159)
- Test: `app/test/sendEmailMessage.test.ts`

**Interfaces:**
- Consumes: the contact loaded at sendEmailMessage.ts:266 (`const contact = await contacts.getById(contactId);`); `isDeleted` from `../repos/contactsRepo.js` (add to imports).
- Produces: `export class EmailContactDeletedError extends EmailSendRefusedError` with code `'contact_deleted'`; HTTP 409 `{ error: 'contact_deleted' }` from `POST /api/conversations/:id/email`. Task 5's EmailComposer copy matches on this code.

- [ ] **Step 1: Write the failing test**

In `app/test/sendEmailMessage.test.ts`: add `EmailContactDeletedError` to the `from '../src/services/sendEmailMessage.js'` import block, then append (this file's `makeFakes({ contact })` MERGES a `Partial<ContactItem>` over its default contact - same pattern as the suppression tests at lines 200-209):

```ts
describe('sendEmailMessage - deleted-contact guard (2026-08-03 spec)', () => {
  it('refuses contact_deleted when the contact is soft-deleted (nothing persisted, nothing sent)', async () => {
    const f = makeFakes({ contact: { deleted_at: '2026-08-01T00:00:00.000Z' } as Partial<ContactItem> });
    await expect(f.service(input())).rejects.toBeInstanceOf(EmailContactDeletedError);
    expect(f.append).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run (from `app/`): `npx vitest run test/sendEmailMessage.test.ts`
Expected: the new test FAILS (unexported class → import error). Pre-existing tests untouched.

- [ ] **Step 3: Implement**

(a) `app/src/services/sendEmailMessage.ts` - add `'contact_deleted'` to the `EmailSendRefusedError` code union, and the class beside `EmailSuppressedError` (~line 127; this file's copy style uses plain hyphens):

```ts
/** The contact is soft-deleted - restore them to reply (deleted-contact resurfacing spec 2026-08-03). */
export class EmailContactDeletedError extends EmailSendRefusedError {
  constructor() {
    super('contact is soft-deleted - email send refused', 'contact_deleted');
  }
}
```

(b) Add `isDeleted` to the contactsRepo import, then insert directly AFTER the suppression gate (`throw new EmailSuppressedError();` block, ~line 286):

```ts
    // (3b) Deleted gate (deleted-contact resurfacing spec 2026-08-03): a
    // soft-deleted contact is unreachable until restored.
    if (isDeleted(contact)) {
      log.warn({ conversationId, contactId }, 'email send refused: contact is soft-deleted');
      throw new EmailContactDeletedError();
    }
```

(c) `app/src/routes/api.ts` - add to `EMAIL_REFUSAL_STATUS`:

```ts
  email_suppressed: 409,
  contact_deleted: 409,
```

- [ ] **Step 4: Run the tests**

Run (from `app/`): `npx vitest run test/sendEmailMessage.test.ts`
Expected: ALL pass.

- [ ] **Step 5: Typecheck + commit**

Run (worktree root, bare, separate): `npm run typecheck`
Expected: exit 0.

```powershell
git status
git add app/src/services/sendEmailMessage.ts app/src/routes/api.ts app/test/sendEmailMessage.test.ts
git commit -m "feat(email): refuse email sends to soft-deleted contacts (409 contact_deleted)" -- app/src/services/sendEmailMessage.ts app/src/routes/api.ts app/test/sendEmailMessage.test.ts
```

---

### Task 4: Dashboard - wire type + "Deleted" chip on the inbox row

**Files:**
- Modify: `dashboard/src/api/types.ts` (`InboxRow` interface ~lines 2028-2048)
- Modify: `dashboard/src/routes/inbox/InboxRow.tsx` (chip strip ~lines 80-84)
- Modify: `dashboard/src/routes/inbox/InboxRow.module.css`
- Test (create): `dashboard/src/routes/inbox/InboxRow.test.tsx`

**Interfaces:**
- Consumes: `row.deleted?: boolean` from Task 1's wire contract; `InboxRow` component props `{ row, onOpen, onMarkRead }` (named export `InboxRow`, `InboxRowProps` at InboxRow.tsx:14-18).
- Produces: a chip `<span className={styles.deletedTag}>Deleted</span>` rendered iff `row.deleted`; Task 6 asserts the exact visible text `Deleted` inside the row link.

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/routes/inbox/InboxRow.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { InboxRow as InboxRowData } from '../../api/index.js';
import { InboxRow } from './InboxRow.js';

const baseRow: InboxRowData = {
  kind: 'contact',
  contactId: 'c-1',
  name: 'Dana Doe',
  role: 'tenant',
  unreadCount: 1,
  preview: 'im back',
  channel: 'sms',
  direction: 'inbound',
  lastActivityAt: '2026-08-02T00:00:00.000Z',
  needsTriage: false,
};

function renderRow(row: InboxRowData): void {
  render(
    <MemoryRouter>
      <InboxRow row={row} onOpen={vi.fn()} onMarkRead={vi.fn()} />
    </MemoryRouter>,
  );
}

describe('InboxRow — Deleted chip (deleted-contact resurfacing)', () => {
  it('renders the Deleted chip when row.deleted is true', () => {
    renderRow({ ...baseRow, deleted: true });
    expect(screen.getByText('Deleted')).toBeInTheDocument();
  });

  it('renders NO Deleted chip on a live contact row', () => {
    renderRow(baseRow);
    expect(screen.queryByText('Deleted')).toBeNull();
  });
});
```

(If `InboxRow` type import complains: the `deleted` field arrives in Step 3's types.ts edit — the FIRST test run fails on the missing field/chip, which is the point.)

- [ ] **Step 2: Run to verify failure**

Run (from `dashboard/`): `npx vitest run src/routes/inbox/InboxRow.test.tsx`
Expected: FAIL (`deleted` not on the type / chip not rendered).

- [ ] **Step 3: Implement**

(a) `dashboard/src/api/types.ts` - inside `export interface InboxRow`, after `needsTriage`, add VERBATIM the same field+comment as Task 1's app-side edit:

```ts
  needsTriage: boolean; // true for untriaged unknowns; ALWAYS false for relay_group
  /** Deleted-contact resurfacing (2026-08-03 spec): present/true ONLY on a
   *  soft-deleted contact row surfaced by an unread post-deletion inbound —
   *  the dashboard renders a "Deleted" chip. Absent on live contacts and
   *  non-contact rows. */
  deleted?: boolean;
```

(b) `dashboard/src/routes/inbox/InboxRow.tsx` - in the chip strip, after the `needsTriage` chip:

```tsx
            {row.needsTriage ? <span className={styles.triage}>Needs triage</span> : null}
            {row.deleted ? <span className={styles.deletedTag}>Deleted</span> : null}
```

(c) `dashboard/src/routes/inbox/InboxRow.module.css` - add beside `.triage` (danger-tinted, matching `.count`'s color-mix pattern):

```css
.deletedTag {
  padding: 1px var(--sp-2);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--c-danger) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--c-danger) 30%, transparent);
  color: var(--c-danger);
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  white-space: nowrap;
}
```

- [ ] **Step 4: Run the tests**

Run (from `dashboard/`): `npx vitest run src/routes/inbox/InboxRow.test.tsx`
Expected: PASS (both).

- [ ] **Step 5: Typecheck + commit**

Run (worktree root, bare, separate): `npm run typecheck`
Expected: exit 0.

```powershell
git status
git add dashboard/src/api/types.ts dashboard/src/routes/inbox/InboxRow.tsx dashboard/src/routes/inbox/InboxRow.module.css dashboard/src/routes/inbox/InboxRow.test.tsx
git commit -m "feat(dashboard): Deleted chip on resurfaced inbox rows" -- dashboard/src/api/types.ts dashboard/src/routes/inbox/InboxRow.tsx dashboard/src/routes/inbox/InboxRow.module.css dashboard/src/routes/inbox/InboxRow.test.tsx
```

---

### Task 5: Dashboard - composer lock + restore affordance + copy updates

**Files:**
- Modify: `dashboard/src/routes/contact/Timeline.tsx` (props ~line 157-250; composer area ~lines 1215-1401; `sendFailureMessage` ~lines 37-63)
- Modify: `dashboard/src/routes/contact/Timeline.module.css`
- Modify: `dashboard/src/routes/contact/ContactDetail.tsx` (`canSend` ~line 262; `deleted` const ~line 537; Timeline wiring ~line 692-715; banner copy ~651-661; confirm-modal copy ~939-942)
- Modify: `dashboard/src/routes/contact/EmailComposer.tsx` (`sendFailureMessage` ~lines 88-104)
- Test (create): `dashboard/src/routes/contact/TimelineDeletedLock.test.tsx`

**Interfaces:**
- Consumes: `ContactDetail`'s existing `onRestore: () => void` handler (line ~552) and `deleted` boolean; `TimelineProps.canSend` (existing).
- Produces: `TimelineProps` gains `deleted?: boolean` and `onRestore?: () => void`. When `deleted`, the ENTIRE composer area (channel toggle, EmailComposer, textarea, attachments, send row) is replaced by a note + a button with accessible name exactly `Restore contact` (Task 6 clicks it). `sendFailureMessage` maps `'contact_deleted'` in both composers.

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/routes/contact/TimelineDeletedLock.test.tsx` (match `Timeline`'s actual export - it is the component `ContactDetail.tsx` imports from `./Timeline.js`):

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { Timeline } from './Timeline.js';

const base = {
  status: 'ready' as const,
  items: [],
  source: 'server' as const,
  canSend: false,
};

describe('Timeline — deleted-contact composer lock', () => {
  it('deleted: composer is replaced by the restore note; Reply textbox absent; Restore fires onRestore', () => {
    const onRestore = vi.fn();
    render(
      <MemoryRouter>
        <Timeline {...base} deleted onRestore={onRestore} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/restore them to reply/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Reply message' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restore contact' }));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('not deleted: the Reply textbox renders as usual', () => {
    render(
      <MemoryRouter>
        <Timeline {...base} canSend />
      </MemoryRouter>,
    );
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run (from `dashboard/`): `npx vitest run src/routes/contact/TimelineDeletedLock.test.tsx`
Expected: FAIL (no `deleted` prop; note absent).

- [ ] **Step 3: Implement Timeline**

(a) `TimelineProps` - add after `optedOut` (~line 195):

```tsx
  /** Contact is soft-deleted (deleted-contact resurfacing, 2026-08-03): the
   *  composer is REPLACED by a standing note + a Restore action; the send is
   *  also refused server-side (409 contact_deleted). */
  deleted?: boolean;
  /** Restore the deleted contact (the note's button). */
  onRestore?: () => void;
```

Add `deleted` and `onRestore` to the component's prop destructuring.

(b) Composer area: inside `<div className={styles.reply}>` (~line 1215), wrap the ENTIRE existing contents (channel toggle through the send row, INCLUDING the optedOut/relayClosed/relayConnecting notes) in the falsy branch of a `deleted` conditional:

```tsx
        <div className={styles.reply}>
          {deleted ? (
            <>
              <p className={styles.optOutNote} role="note">
                🗑 This contact is deleted — restore them to reply.
              </p>
              <button type="button" className={styles.restoreBtn} onClick={onRestore}>
                Restore contact
              </button>
            </>
          ) : (
            <>
              {/* ...every existing child of styles.reply, byte-identical... */}
            </>
          )}
        </div>
```

(c) `sendFailureMessage` - add a case beside `contact_opted_out`:

```tsx
      case 'contact_deleted':
        return 'This contact is deleted — restore them to reply.';
```

(d) `Timeline.module.css` - add:

```css
.restoreBtn {
  align-self: flex-start;
  padding: var(--sp-1) var(--sp-3);
  border-radius: var(--radius-sm);
  border: 1px solid var(--c-border);
  background: var(--c-surface-2);
  font-size: var(--fs-sm);
  cursor: pointer;
}
```

(Use the file's existing spacing/color tokens if any of these names are absent from the dashboard's token set — check a neighboring rule in the same file.)

- [ ] **Step 4: Implement ContactDetail wiring + copy**

(a) Move the `deleted` computation ABOVE `canSend` and fold it in - replace (~line 262):

```tsx
  const canSend = sendConvId !== null || target !== undefined;
```

with:

```tsx
  // Soft-deleted contact: the composer is locked (restore to reply). canSend
  // gates the Send affordances; the server also refuses with 409
  // contact_deleted (belt and braces).
  const deleted = typeof contact.deleted_at === 'string' && contact.deleted_at.length > 0;
  const canSend = (sendConvId !== null || target !== undefined) && !deleted;
```

then DELETE the now-duplicate `const deleted = ...` line at ~537 (keep its comment block - it documents the delete/restore handlers that follow).

(b) Timeline wiring (~line 692-715) - add two props:

```tsx
            optedOut={optedOut}
            deleted={deleted}
            onRestore={onRestore}
```

(c) Banner copy (~lines 653-656) - the old copy claims the inbox NEVER shows deleted contacts, now false. Replace the `<span>` content with:

```tsx
            <span>
              This contact is <strong>deleted</strong> — hidden from the contact lists,
              inbox, and today. If they message again, the thread resurfaces in the
              inbox until read. Data is retained.
            </span>
```

(d) Confirm-delete modal copy (~lines 939-942) - replace the `<p>` content with:

```tsx
            <p>
              <strong>{name}</strong> will be hidden from the contact lists, inbox, and today.
              If they message you again, the conversation resurfaces in the inbox so you can
              review it. Nothing is erased — you can restore them from the Contacts{' '}
              <em>Deleted</em> view.
            </p>
```

(e) `EmailComposer.tsx` `sendFailureMessage` - add (this file uses plain hyphens):

```tsx
      case 'contact_deleted':
        return 'This contact is deleted - restore them to reply.';
```

- [ ] **Step 5: Run the tests**

Run (from `dashboard/`): `npx vitest run src/routes/contact/TimelineDeletedLock.test.tsx`
Expected: PASS (both). Then run the whole dashboard suite to catch regressions in existing ContactDetail/Timeline tests: `npx vitest run` (from `dashboard/`).
Expected: all pass.

- [ ] **Step 6: Typecheck + commit**

Run (worktree root, bare, separate): `npm run typecheck`
Expected: exit 0.

```powershell
git status
git add dashboard/src/routes/contact/Timeline.tsx dashboard/src/routes/contact/Timeline.module.css dashboard/src/routes/contact/ContactDetail.tsx dashboard/src/routes/contact/EmailComposer.tsx dashboard/src/routes/contact/TimelineDeletedLock.test.tsx
git commit -m "feat(dashboard): lock composer for deleted contacts with restore-to-reply note" -- dashboard/src/routes/contact/Timeline.tsx dashboard/src/routes/contact/Timeline.module.css dashboard/src/routes/contact/ContactDetail.tsx dashboard/src/routes/contact/EmailComposer.tsx dashboard/src/routes/contact/TimelineDeletedLock.test.tsx
```

---

### Task 6: E2E - the full resurfacing round-trip

**Files:**
- Create: `e2e/tests/dashboard-next/deleted-contact-resurfacing.spec.ts`

**Interfaces:**
- Consumes: fake-Twilio driver `sendAsParty(request, { from, body })` from `e2e/fixtures/fakeTwilio.js`; seeded tenant `contact-tenant-0001` (Tasha Nguyen, `+15550100001`, already a registered fake persona); the Task 4 chip text `Deleted`; the Task 5 button `Restore contact`; `POST /__dev/reseed` (lean).
- Produces: the merge-gate e2e proof for the whole feature.

- [ ] **Step 1: Write the spec**

Create `e2e/tests/dashboard-next/deleted-contact-resurfacing.spec.ts`:

```ts
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { sendAsParty } from '../../fixtures/fakeTwilio.js';

// Deleted-contact resurfacing (2026-08-03 spec): a soft-deleted contact who
// texts back resurfaces their ORIGINAL thread in the inbox (Deleted chip)
// until read; replying requires restoring them (locked composer + 409 guard).
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const TASHA = '+15550100001'; // contact-tenant-0001's primary number

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

async function reseedLean(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${NEXT}/__dev/reseed`);
  expect(res.ok(), `reseed failed: ${res.status()}`).toBeTruthy();
}

// Reseed BEFORE login (reseed wipes sessions), and leave the lane clean for
// later spec files even if this one dies mid-way with Tasha deleted.
test.beforeEach(async ({ request }) => {
  await reseedLean(request);
});
test.afterAll(async ({ request }) => {
  await reseedLean(request);
});

test('deleted contact texts back: resurfaces with Deleted chip, read-only until restore, restore re-enables reply', async ({
  page,
  request,
}) => {
  await devLogin(page);

  // 1) Delete Tasha (kebab menu -> confirm dialog); lands back on Contacts.
  await page.goto(`${NEXT}/contacts/contact-tenant-0001`);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete contact' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page).toHaveURL(/\/contacts$/);

  // 2) Her row is gone from the inbox.
  await page.goto(`${NEXT}/inbox`);
  await expect(page.getByRole('link', { name: /Tasha Nguyen/ })).toHaveCount(0);

  // 3) She texts back in; the thread resurfaces with the Deleted chip.
  const stamp = `${Date.now()}`.slice(-7);
  const inbound = `Hey, it's Tasha again ${stamp}`;
  await sendAsParty(request, { from: TASHA, body: inbound });
  await page.goto(`${NEXT}/inbox`);
  const row = page.getByRole('link', { name: /Tasha Nguyen/ });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row.getByText('Deleted', { exact: true })).toBeVisible();

  // 4) Open it: message + deleted banner visible; composer locked (no Reply
  //    textbox; the restore note shows instead). Seeing BEFORE restoring.
  await row.click();
  await expect(page).toHaveURL(/\/contacts\/contact-tenant-0001$/);
  await expect(page.getByText(inbound)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/This contact is deleted/).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Reply message' })).toHaveCount(0);

  // 5) Opening read the thread -> back in the inbox the row re-hides.
  await page.goto(`${NEXT}/inbox`);
  await expect(page.getByRole('link', { name: /Tasha Nguyen/ })).toHaveCount(0);

  // 6) A second text resurfaces it; this time restore via the composer note.
  const inbound2 = `One more thing ${stamp}`;
  await sendAsParty(request, { from: TASHA, body: inbound2 });
  await page.goto(`${NEXT}/inbox`);
  await page.getByRole('link', { name: /Tasha Nguyen/ }).click();
  await page.getByRole('button', { name: 'Restore contact' }).click();

  // 7) Restored: the composer returns and a reply goes out.
  const reply = `Welcome back! ${stamp}`;
  const box = page.getByRole('textbox', { name: 'Reply message' });
  await expect(box).toBeVisible({ timeout: 10_000 });
  await box.fill(reply);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(reply)).toBeVisible();

  // 8) The inbox row is back to normal — visible, no Deleted chip.
  await page.goto(`${NEXT}/inbox`);
  const restoredRow = page.getByRole('link', { name: /Tasha Nguyen/ });
  await expect(restoredRow).toBeVisible({ timeout: 10_000 });
  await expect(restoredRow.getByText('Deleted', { exact: true })).toHaveCount(0);
});
```

- [ ] **Step 2: Run the spec against a session stack**

Start the stack (worktree root): `npm run e2e:session` (leave it running).
Then run (from `e2e/` — NEVER from the repo root): `npx playwright test tests/dashboard-next/deleted-contact-resurfacing.spec.ts`
Expected: PASS. If a selector is strict-mode ambiguous or the SSE/read timing flakes, fix the spec (prefer scoping locators to the row/banner, and `page.goto` over waiting on live refresh), re-run until green twice in a row.

- [ ] **Step 3: Stop the session stack + commit**

Run: `npm run e2e:stop`

```powershell
git status
git add e2e/tests/dashboard-next/deleted-contact-resurfacing.spec.ts
git commit -m "test(e2e): deleted-contact resurfacing round-trip (chip, read-only, restore-to-reply)" -- e2e/tests/dashboard-next/deleted-contact-resurfacing.spec.ts
```

---

### Task 7: Full gates + main sync + handback

**Files:** none new (merge-readiness only)

- [ ] **Step 1: Sync with main ONCE**

```powershell
git fetch; git merge main
```

Resolve any conflicts keeping BOTH sides' intent. (One main sync per branch - do not repeat later without cause.)

- [ ] **Step 2: Full gates on the synced base** (bare, separate commands, worktree root)

Run: `npm run typecheck`
Expected: exit 0.
Run: `npm test`
Expected: all suites pass.
Run: `npm run e2e`
Expected: full suite green (the harness boots its own hermetic stack; requires Docker).

- [ ] **Step 3: Report**

Hand back: branch name, the list of commits, and the verbatim tail of each gate's output (pass counts / exit status). Do NOT merge into main - the human decides.
