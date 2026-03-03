import { z } from "zod";
import type { SummaryOutput } from "../../types/domain.js";

// ---------------------------------------------------------------------------
// New single-layer SummaryOutput schema
// ---------------------------------------------------------------------------
export const summarySchema = z
  .object({
    overview: z.string().min(1),
    keyConcepts: z.array(z.string().min(1)).min(1),
    topicSections: z
      .array(z.object({ heading: z.string().min(1), points: z.array(z.string().min(1)).min(1) }))
      .min(1),
    keyDefinitions: z.array(z.string()).default([]),
  })
  .strict();

// ---------------------------------------------------------------------------
// Multi-material schema — one summary block per PDF/PPT in a single LLM call.
// ---------------------------------------------------------------------------
const perMaterialSchema = z.object({
  resourceId: z.string().min(1),
  title: z.string().min(1),
  overview: z.string().min(1),
  keyConcepts: z.array(z.string().min(1)).min(1),
  topicSections: z
    .array(z.object({ heading: z.string().min(1), points: z.array(z.string().min(1)).min(1) }))
    .min(1),
  keyDefinitions: z.array(z.string()).default([]),
});

export const multiMaterialSchema = z.object({
  materials: z.array(perMaterialSchema).min(1),
});

export interface PerMaterialSummaryItem {
  resourceId: string;
  title: string;
  url: string;
  summary: SummaryOutput;
}

export function parseMultiMaterialFromText(
  raw: string,
  /** URL look-up map — keyed by resourceId — to attach URLs to each item. */
  urlByResourceId: Map<string, string>,
): PerMaterialSummaryItem[] {
  const json = extractJsonFromText(raw);
  const parsed = multiMaterialSchema.parse(json);
  return parsed.materials.map((item) => ({
    resourceId: item.resourceId,
    title: item.title,
    url: urlByResourceId.get(item.resourceId) ?? "",
    summary: normalizeSummaryOutput({
      overview: item.overview,
      keyConcepts: item.keyConcepts,
      topicSections: item.topicSections,
      keyDefinitions: item.keyDefinitions,
    }),
  }));
}

/**
 * Compose a merged SummaryOutput from multiple per-material summaries.
 * Used to populate the backwards-compat `summaries` table row (Latest Brief, Export).
 */
export function composeMergedSummary(items: PerMaterialSummaryItem[]): SummaryOutput {
  const overviews = items.map((m) => m.summary.overview).filter(Boolean);
  return {
    overview: overviews.join(" "),
    keyConcepts: items.flatMap((m) => m.summary.keyConcepts),
    topicSections: items.flatMap((m) => m.summary.topicSections),
    keyDefinitions: items.flatMap((m) => m.summary.keyDefinitions),
  };
}

function compactStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of values) {
    const clean = item.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    if (seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
  }
  return out;
}

export function normalizeSummaryOutput(input: SummaryOutput): SummaryOutput {
  return {
    overview: (input.overview ?? "").replace(/\s+/g, " ").trim(),
    keyConcepts: compactStrings(input.keyConcepts ?? []),
    topicSections: (input.topicSections ?? [])
      .map((section) => ({
        heading: section.heading.replace(/\s+/g, " ").trim(),
        points: compactStrings(section.points),
      }))
      .filter((section) => section.heading.length > 0 && section.points.length > 0),
    keyDefinitions: compactStrings(input.keyDefinitions ?? []),
  };
}

export function extractJsonFromText(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Empty provider response");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const candidate = trimmed.slice(start, end + 1);
      return JSON.parse(candidate);
    }
    throw new Error("Provider output did not contain valid JSON");
  }
}

export function parseSummaryFromUnknown(value: unknown): SummaryOutput {
  const parsed = summarySchema.parse(value);
  return normalizeSummaryOutput(parsed);
}

export function validateSummaryText(raw: string): SummaryOutput {
  const parsed = extractJsonFromText(raw);
  return parseSummaryFromUnknown(parsed);
}
