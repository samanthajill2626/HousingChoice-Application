import type { CSSProperties } from 'react';

const styles = {
  wrapper: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    padding: '2rem',
  },
  heading: {
    fontSize: '2rem',
    fontWeight: 700,
    margin: 0,
  },
  subtitle: {
    fontSize: '1.1rem',
    margin: '0.5rem 0 0',
  },
  muted: {
    fontSize: '0.9rem',
    color: '#6b7280',
    margin: '1rem 0 0',
  },
} satisfies Record<string, CSSProperties>;

export default function App() {
  return (
    <main style={styles.wrapper}>
      <h1 style={styles.heading}>HousingChoice</h1>
      <p style={styles.subtitle}>Dashboard shell &mdash; Phase 0</p>
      <p style={styles.muted}>
        Conversation hub, placements, and case views arrive in Phase 1+.
      </p>
    </main>
  );
}
