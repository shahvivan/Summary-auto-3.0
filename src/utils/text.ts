export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCourseKey(input: string): string {
  const stripped = input.replace(/\[[^\]]*\]/g, " ");
  return normalizeText(stripped).replace(/\s+/g, "-");
}

export function slugify(input: string): string {
  return normalizeText(input).replace(/\s+/g, "-");
}

export function tokenize(input: string): string[] {
  return normalizeText(input)
    .split(" ")
    .filter((token) => token.length >= 3);
}

export function extractTopicNumber(input: string): number | null {
  const match = input.match(/(?:topic|week|unit|chapter|lecture|session|part)\s*(\d+)/i);
  if (!match) {
    return null;
  }
  return Number(match[1]);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function shaLike(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return Math.abs(hash >>> 0).toString(16);
}
