import { config } from "../../config.js";
import type { SummaryProviderMode, TextChunk } from "../../types/domain.js";
import { summarizeWithProviderRouter } from "./provider-router.js";

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
