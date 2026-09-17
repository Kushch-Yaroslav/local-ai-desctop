/** Display-only directory name; project roots and identities remain unchanged. */
export function projectDirectoryName(directory: string | null | undefined): string {
  const normalized = directory?.replace(/[\\/]+$/, '') ?? '';
  const name = normalized.split(/[\\/]/).filter(Boolean).at(-1);
  return name || 'Project';
}

/** Removes only the active @autocomplete span and leaves surrounding text intact. */
export function removeProjectReferenceQuery(value: string, start: number, end: number): { value: string; cursor: number } {
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  return { value: `${value.slice(0, from)}${value.slice(to)}`, cursor: from };
}
