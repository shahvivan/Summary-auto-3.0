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
  // 1. Explicit academic label: "Topic 3", "Week 5", "Session 2", "Class 4", etc.
  const labeled = input.match(
    /\b(?:topic|week|unit|chapter|lecture|session|part|class|module|seminar|tutorial)\s*#?\s*(\d+)\b/i,
  );
  if (labeled) return Number(labeled[1]);

  // 2. Ordinal before a label: "3rd session", "5th lecture"
  const ordinal = input.match(/\b(\d+)(?:st|nd|rd|th)\s+(?:topic|week|session|lecture|class|unit|seminar)\b/i);
  if (ordinal) return Number(ordinal[1]);

  // 3. Bracketed number: "[3]", "[ 5 ]"  — common in ESADE/Outlook event titles
  const bracketed = input.match(/\[\s*(\d+)\s*\]/);
  if (bracketed) return Number(bracketed[1]);

  // 4. Hash/pound prefix: "#5"
  const hashed = input.match(/\B#(\d+)\b/);
  if (hashed) return Number(hashed[1]);

  return null;
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
