// initialsFrom — derive 1–2 uppercase initials from a name. PURE (unit-tested).
// An empty/absent name yields "?" (the honest-identity unknown marker — never
// a fabricated initial).
export function initialsFrom(name: string | undefined): string {
  if (name === undefined) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
