import { z } from "zod";
import type { SummaryOutput } from "../../types/domain.js";

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
