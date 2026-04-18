export function containsGreek(text: string): boolean {
  return /[Ά-ώ]/.test(text);
}

function compactWhitespace(text: string): string {
  return text.trim().replace(/\s{2,}/g, ' ');
}

export function preferGreekEntityName(candidate: string | null | undefined, fallback: string): string {
  const normalizedFallback = compactWhitespace(fallback);
  const normalizedCandidate = compactWhitespace(candidate ?? '');

  if (!normalizedCandidate) {
    return normalizedFallback;
  }

  return containsGreek(normalizedCandidate) ? normalizedCandidate : normalizedFallback;
}