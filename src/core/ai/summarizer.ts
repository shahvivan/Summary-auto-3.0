import { config } from "../../config.js";
import type { ParsedPdf, SummaryProviderMode, TextChunk } from "../../types/domain.js";
import { summarizeMultiMaterialWithProviderRouter, summarizeWithProviderRouter } from "./provider-router.js";

export async function summarizeChunks(params: {
  chunks: TextChunk[];
  courseName: string;
  provider?: SummaryProviderMode;
}) {
  const requestedProvider = (params.provider ?? (config.summaryProviderDefault as SummaryProviderMode)) || "auto";
  return summarizeWithProviderRouter({
    chunks: params.chunks,
    courseName: params.courseName,
    provider: requestedProvider,
    fallbackEnabled: config.summaryFallbackEnabled,
  });
}

/**
 * Single LLM call that produces one summary block per PDF/PPT document.
 * Returns per-material summaries AND a composed merged summary (no extra call).
 */
export async function summarizeMultiMaterial(params: {
  parsedPdfs: ParsedPdf[];
  chunks: TextChunk[]; // used only if falling back to deterministic
  courseName: string;
  provider?: SummaryProviderMode;
}) {
  const requestedProvider = (params.provider ?? (config.summaryProviderDefault as SummaryProviderMode)) || "auto";
  return summarizeMultiMaterialWithProviderRouter({
    parsedPdfs: params.parsedPdfs,
    chunks: params.chunks,
    courseName: params.courseName,
    provider: requestedProvider,
    fallbackEnabled: config.summaryFallbackEnabled,
  });
}
