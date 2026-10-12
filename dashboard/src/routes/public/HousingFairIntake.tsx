// HousingFairIntake (/join) - the standalone, unauthenticated housing-fair
// signup. No unit of interest: it submits the IntakeForm WITHOUT a unitId (so
// the backend stamps capture_source:'housing_fair'), then shows a generic
// thank-you. There is NO reveal here (no home to reveal). Tenant-facing copy.
//
// Housing authority (join-housing-authority spec D8). The page reads the
// public list (GET /public/housing-authorities) and hands IntakeForm a
// "Housing authority" select as its extraField. This component owns the list
// state and the chosen value; IntakeForm owns the person's fields.
// - Default: "Atlanta Housing Authority" when that exact name is listed, else
//   "Not sure". "Not sure" sends no housingAuthority.
// - While the list loads the select shows "Loading..." and send is blocked. A
//   read that fails (any error, a 429 included) or takes longer than 10 s
//   leaves only "Not sure" and a note; the sign-up still works.
// The read is aborted on unmount. React StrictMode (dev and every e2e lane)
// runs the effect twice: each run owns its own AbortController and timer, and
// a run that was cleaned up ignores whatever its request later returns, so the
// second run's read is the one that lands. State is set only from the
// request's callbacks and the timeout, never synchronously in the effect.
import { useEffect, useRef, useState } from 'react';
import { getHousingAuthorities, submitHousingFair, type HousingFairInput } from './publicApi.js';
import { IntakeForm } from './IntakeForm.js';
import {
  HousingAuthoritySelect,
  NOT_SURE_VALUE,
  authorityToSend,
  defaultAuthorityChoice,
  type AuthorityList,
} from './HousingAuthoritySelect.js';
import styles from './FlyerPage.module.css';

/** D8: the list read gives up after 10 seconds. */
const HOUSING_AUTHORITY_LIST_TIMEOUT_MS = 10_000;

export function HousingFairIntake(): React.JSX.Element {
  const [done, setDone] = useState(false);
  const [list, setList] = useState<AuthorityList>({ kind: 'loading' });
  const [choice, setChoice] = useState<string>(NOT_SURE_VALUE);
  const [sending, setSending] = useState(false);

  // On submit the form swaps to a thank-you with a new <h1>, but focus would stay
  // on the (removed) submit button - silent to screen readers. Move focus to the
  // done-state heading (tabIndex={-1}) so the conversion is announced.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (done) headingRef.current?.focus();
  }, [done]);

  // D8: read the list once on mount.
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      setList({ kind: 'failed' });
      setChoice(NOT_SURE_VALUE);
    }, HOUSING_AUTHORITY_LIST_TIMEOUT_MS);
    getHousingAuthorities(controller.signal).then(
      (names) => {
        if (controller.signal.aborted) return; // cleaned up, or timed out
        clearTimeout(timer);
        setList({ kind: 'ready', names });
        setChoice(defaultAuthorityChoice(names));
      },
      () => {
        if (controller.signal.aborted) return; // cleaned up, or timed out
        clearTimeout(timer);
        setList({ kind: 'failed' });
        setChoice(NOT_SURE_VALUE);
      },
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  async function handleSubmit(input: Omit<HousingFairInput, 'unitId' | 'housingAuthority'>): Promise<void> {
    // No unitId - a plain housing-fair signup. "Not sure" (or no list) sends
    // no housingAuthority key at all.
    const housingAuthority = authorityToSend(list, choice);
    setSending(true);
    try {
      await submitHousingFair(housingAuthority === undefined ? input : { ...input, housingAuthority });
    } finally {
      setSending(false);
    }
    setDone(true);
  }

  if (done) {
    return (
      <section className={styles.card}>
        <h1 className={styles.title} ref={headingRef} tabIndex={-1}>
          Thanks &mdash; you&apos;re signed up!
        </h1>
        <p className={styles.muted}>
          We&apos;ve got your info. A team member will text you about homes that fit your voucher.
        </p>
      </section>
    );
  }

  return (
    <section className={styles.card}>
      <h1 className={styles.title}>Find your next home</h1>
      <p className={styles.muted}>
        Sign up and we&apos;ll text you about homes that fit your voucher.
      </p>
      <IntakeForm
        onSubmit={handleSubmit}
        submitLabel="Sign me up"
        extraField={
          <HousingAuthoritySelect list={list} value={choice} onChange={setChoice} disabled={sending} />
        }
        submitBlocked={list.kind === 'loading'}
      />
    </section>
  );
}
