// Relative-time formatting for the admin user list ("last login"). Small,
// dependency-free (no date library — CSP/bundle discipline), good enough for a
// "3 days ago" / "just now" label. Returns 'Never' for a null timestamp.
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (iso === null) return 'Never';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'Never';
  const deltaMs = now - then;
  // Future / clock-skew: treat as just now rather than "-1 minutes ago".
  if (deltaMs < 0) return 'just now';

  const sec = Math.floor(deltaMs / 1000);
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month} month${month === 1 ? '' : 's'} ago`;
  const year = Math.floor(day / 365);
  return `${year} year${year === 1 ? '' : 's'} ago`;
}
