// In-memory twin of app/src/repos/orgListRepo.ts for the service, job and
// route suites (plan 2026-10-06 S2, section 3.4b). It mirrors the CONTRACT,
// not the transport: get() creates the starting list on the first read;
// peek() never creates; putForSeed() overwrites; mutate() re-applies its
// change after a lost version race (interleaved mutates all land), writes
// nothing for a change that returns the item it was given, refuses past the
// same byte cap, and gives up with OrgListBusyError after
// ORG_LIST_MAX_ATTEMPTS lost races. Every read hands out a deep copy, as a
// DynamoDB read would. Deterministic: starting entries get ids org-1, org-2,
// ... and the timestamp below.
import { buildStartingEntries } from '../../src/lib/orgStartingList.js';
import {
  ORG_LIST_MAX_ATTEMPTS,
  ORG_LIST_MAX_BYTES,
  ORG_LIST_SETTING_ID,
  OrgListBusyError,
  OrgListFullError,
  orgListItemBytes,
  type OrgListItem,
  type OrgListRepo,
} from '../../src/repos/orgListRepo.js';

export const ORG_LIST_FAKE_NOW = '2026-10-06T00:00:00.000Z';

export function createOrgListFake(
  opts: { now?: () => string; newId?: () => string } = {},
): OrgListRepo {
  let stored: OrgListItem | null = null;
  let seq = 0;
  const now = opts.now ?? ((): string => ORG_LIST_FAKE_NOW);
  const newId = opts.newId ?? ((): string => `org-${(seq += 1)}`);
  const copy = (item: OrgListItem): OrgListItem => structuredClone(item);

  const get = async (): Promise<OrgListItem> => {
    stored ??= { settingId: ORG_LIST_SETTING_ID, version: 1, entries: buildStartingEntries(now(), newId) };
    return copy(stored);
  };

  return {
    get,
    async peek() {
      return stored === null ? null : copy(stored);
    },
    async putForSeed(item) {
      stored = copy({ ...item, settingId: ORG_LIST_SETTING_ID });
    },
    async mutate(change) {
      for (let attempt = 1; attempt <= ORG_LIST_MAX_ATTEMPTS; attempt += 1) {
        const current = await get();
        const { next, result } = change(current);
        if (next === current) return result;
        const candidate: OrgListItem = { ...next, settingId: ORG_LIST_SETTING_ID, version: current.version + 1 };
        if (orgListItemBytes(candidate) > ORG_LIST_MAX_BYTES) throw new OrgListFullError();
        // The conditional write: lost when another mutate landed after our read.
        if (stored !== null && stored.version !== current.version) continue;
        stored = copy(candidate);
        return result;
      }
      throw new OrgListBusyError();
    },
  };
}
