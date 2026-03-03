import { z } from "zod";
import { config } from "../config.js";
import { readJsonFile } from "./fs.js";
import { normalizeText, tokenize } from "./text.js";

const entrySchema = z.object({
  courseName: z.string(),
  aliases: z.array(z.string()).optional(),
  url: z.string().url(),
  /** Only include PDFs/PPTs whose subsectionLabel contains this string (case-insensitive). */
  subsectionFilter: z.string().optional(),
  /** The current session number for this course (auto-incremented after each run). */
  startingSession: z.number().int().optional(),
});

const mapSchema = z.array(entrySchema);

export type CourseMapEntry = z.infer<typeof entrySchema>;

function scoreMatch(query: string, entry: CourseMapEntry): number {
  const normalizedQuery = normalizeText(query);
  const names = [entry.courseName, ...(entry.aliases ?? [])];
  let best = -1;

  for (const name of names) {
    const normalizedName = normalizeText(name);
    if (normalizedName === normalizedQuery) {
      return 1000;
    }
    if (normalizedName.includes(normalizedQuery) || normalizedQuery.includes(normalizedName)) {
      best = Math.max(best, 200);
    }

    const queryTokens = tokenize(normalizedQuery);
    const nameTokens = new Set(tokenize(normalizedName));
    let tokenHits = 0;
    for (const token of queryTokens) {
      if (nameTokens.has(token)) {
        tokenHits += 1;
      }
    }
    best = Math.max(best, tokenHits * 10);
  }

  return best;
}

export async function loadCourseMap(): Promise<CourseMapEntry[]> {
  const raw = await readJsonFile<unknown>(config.courseMapPath, []);
  const parsed = mapSchema.safeParse(raw);
  if (!parsed.success) {
    return [];
  }
  return parsed.data;
}

export async function findCourseMapEntry(courseName: string): Promise<CourseMapEntry | null> {
  const entries = await loadCourseMap();
  if (entries.length === 0) {
    return null;
  }

  let best: CourseMapEntry | null = null;
  let bestScore = -1;
  for (const entry of entries) {
    const score = scoreMatch(courseName, entry);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }

  return bestScore > 0 ? best : null;
}
