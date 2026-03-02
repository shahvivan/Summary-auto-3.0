import type { SummaryProviderMode, TextChunk } from "../../types/domain.js";
import { summarizeChunks } from "../../core/ai/summarizer.js";

export interface SummaryProvider {
  summarize(
    chunks: TextChunk[],
    courseName: string,
    provider?: SummaryProviderMode,
  ): ReturnType<typeof summarizeChunks>;
}

class RoutedProvider implements SummaryProvider {
  summarize(chunks: TextChunk[], courseName: string, provider?: SummaryProviderMode) {
    return summarizeChunks({ chunks, courseName, provider });
  }
}

export function createSummaryProvider(): SummaryProvider {
  return new RoutedProvider();
}
