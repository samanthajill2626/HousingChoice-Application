// The ONE definition of "is this phone number one of ours?" (spec
// docs/superpowers/specs/2026-08-06-business-number-config-design.md D3).
//
// Two arms, because we own numbers from two sources: the STATIC business
// number (config) and the DYNAMIC relay pool (bought at runtime, resolved
// through the byPoolNumber GSI). Both webhook echo/author defenses funnel
// through here so the definition cannot drift between the SMS and voice paths.
//
// Returns WHICH arm matched rather than a boolean: each caller logs a
// different drop line ("From is our number" vs "From is a pool number") and
// collapsing them would lose that distinction in production logs.
//
// Uses getByPoolNumber (a single Query) and NOT getAllByPoolNumber (which
// pages the whole partition). For a MEMBERSHIP test the two are equivalent -
// both are truthy exactly when the GSI holds any item - and the voice guard
// runs on an inbound-call webhook where paging would be wasted work.
import type { AppConfig } from '../lib/config.js';
import type { ConversationsRepo } from '../repos/conversationsRepo.js';

export type OurNumberKind = 'business' | 'pool' | undefined;

export interface OurNumberKindDeps {
  config: Pick<AppConfig, 'businessPhoneNumber'>;
  conversations: Pick<ConversationsRepo, 'getByPoolNumber'>;
}

export function createOurNumberKind(
  deps: OurNumberKindDeps,
): (number: string) => Promise<OurNumberKind> {
  return async (number: string): Promise<OurNumberKind> => {
    const { businessPhoneNumber } = deps.config;
    if (businessPhoneNumber !== undefined && number === businessPhoneNumber) {
      return 'business';
    }
    return (await deps.conversations.getByPoolNumber(number)) ? 'pool' : undefined;
  };
}
