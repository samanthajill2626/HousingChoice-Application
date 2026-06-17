// Placeholder — a B0 stub for a nav destination: just an <h1> title so the frame
// is fully navigable before the real page lands. Page phases (B1+) replace these
// route elements one at a time.
export function Placeholder({ title }: { title: string }): React.JSX.Element {
  return <h1>{title}</h1>;
}
