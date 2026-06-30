// HousingFairIntake (/join) — the standalone, unauthenticated housing-fair
// signup. No unit of interest: it submits the IntakeForm WITHOUT a unitId (so
// the backend stamps capture_source:'housing_fair'), then shows a generic
// thank-you. There is NO reveal here (no home to reveal). Tenant-facing copy.
import { useState } from 'react';
import { submitHousingFair, type HousingFairInput } from './publicApi.js';
import { IntakeForm } from './IntakeForm.js';
import styles from './FlyerFunnel.module.css';

export function HousingFairIntake(): React.JSX.Element {
  const [done, setDone] = useState(false);

  async function handleSubmit(input: Omit<HousingFairInput, 'unitId'>): Promise<void> {
    await submitHousingFair(input); // no unitId — a plain housing-fair signup
    setDone(true);
  }

  if (done) {
    return (
      <section className={styles.card}>
        <h1 className={styles.title}>Thanks — you&apos;re signed up!</h1>
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
      <IntakeForm onSubmit={handleSubmit} submitLabel="Sign me up" />
    </section>
  );
}
