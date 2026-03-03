import { z } from "zod";
import type { SummaryOutput } from "../../types/domain.js";

// ---------------------------------------------------------------------------
// Multi-material schema — used when a single LLM call produces one summary
// block per PDF/PPT document.
// ---------------------------------------------------------------------------
const perMaterialSchema = z.object({
  resourceId: z.string().min(1),
  title: z.string().min(1),
  layer1KeyConcepts: z.array(z.string().min(1)).min(1),
  layer2StructuredExplanation: z
    .array(z.object({ heading: z.string().min(1), points: z.array(z.string().min(1)).min(1) }))
    .min(1),
  layer3DetailedNotes: z.array(z.string().min(1)).min(1),
  preparationTips: z.array(z.string().min(1)).optional(),
  keyEquationsOrDefinitions: z.array(z.string().min(1)).optional(),
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
      layer1KeyConcepts: item.layer1KeyConcepts,
      layer2StructuredExplanation: item.layer2StructuredExplanation,
      layer3DetailedNotes: item.layer3DetailedNotes,
      preparationTips: item.preparationTips,
      keyEquationsOrDefinitions: item.keyEquationsOrDefinitions,
    }),
  }));
}

/**
 * Compose a merged SummaryOutput from multiple per-material summaries.
 * Used to populate the backwards-compat `summaries` table row so that
 * old code paths (Latest Brief preview, Export) still have something to show.
 */
export function composeMergedSummary(items: PerMaterialSummaryItem[]): SummaryOutput {
  return {
    layer1KeyConcepts: items.flatMap((m) => m.summary.layer1KeyConcepts),
    layer2StructuredExplanation: items.flatMap((m) => m.summary.layer2StructuredExplanation),
    layer3DetailedNotes: items.flatMap((m) => m.summary.layer3DetailedNotes),
    preparationTips: items.flatMap((m) => m.summary.preparationTips ?? []).filter(Boolean),
    keyEquationsOrDefinitions: items
      .flatMap((m) => m.summary.keyEquationsOrDefinitions ?? [])
      .filter(Boolean),
  };
}

export const summarySchema = z
  .object({
    layer1KeyConcepts: z.array(z.string().min(1)).min(1),
    layer2StructuredExplanation: z
      .array(
        z.object({
          heading: z.string().min(1),
          points: z.array(z.string().min(1)).min(1),
        }),
      )
      .min(1),
    layer3DetailedNotes: z.array(z.string().min(1)).min(1),
    preparationTips: z.array(z.string().min(1)).optional(),
    keyEquationsOrDefinitions: z.array(z.string().min(1)).optional(),
  })
  .strict();

function compactStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of values) {
    const clean = item.replace(/\s+/g, " ").trim();
    if (!clean) {
      continue;
    }
    if (seen.has(clean.toLowerCase())) {
      continue;
    }
    seen.add(clean.toLowerCase());
    out.push(clean);
  }
  return out;
}

export function normalizeSummaryOutput(input: SummaryOutput): SummaryOutput {
  return {
    layer1KeyConcepts: compactStrings(input.layer1KeyConcepts),
    layer2StructuredExplanation: input.layer2StructuredExplanation
      .map((section) => ({
        heading: section.heading.replace(/\s+/g, " ").trim(),
        points: compactStrings(section.points),
      }))
      .filter((section) => section.heading.length > 0 && section.points.length > 0),
    layer3DetailedNotes: compactStrings(input.layer3DetailedNotes),
    preparationTips: input.preparationTips ? compactStrings(input.preparationTips) : undefined,
    keyEquationsOrDefinitions: input.keyEquationsOrDefinitions
      ? compactStrings(input.keyEquationsOrDefinitions)
      : undefined,
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
