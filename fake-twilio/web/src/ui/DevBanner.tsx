// DevBanner — a persistent, subtle top banner making it unmistakable that this
// surface is the FAKE Twilio (no real SMS goes out). Uses the warning token
// palette and a status role so assistive tech announces it.
import styles from './DevBanner.module.css';

export function DevBanner(): React.JSX.Element {
  return (
    <div className={styles.banner} role="status">
      <span className={styles.tag}>DEV</span>
      <span className={styles.text}>fake Twilio — no real messages are sent</span>
    </div>
  );
}
