import { randomUUID } from "node:crypto";
import path from "node:path";
import { createSummaryProvider } from "../../adapters/llm/provider.js";
import { config } from "../../config.js";
import { processPdfLinks } from "../pdf/pipeline.js";
import { resolveSessionMaterials } from "../resolver/resolver.js";
import {
  completeRun,
  createRun,
  failRun,
  replaceMaterials,
  saveAnchor,
  saveResolverDebug,
  saveSummary,
  updateRunStage,
  updateRunTraces,
  upsertSession,
} from "../../storage/sqlite.js";
import type { Session, SessionOverride, SummaryProviderMode } from "../../types/domain.js";
import { writeJsonFile } from "../../utils/fs.js";

const summaryProvider = createSummaryProvider();

export async function executeRun(
  session: Session,
  override?: SessionOverride,
  runId = randomUUID(),
  options?: { provider?: SummaryProviderMode; moodleDebug?: boolean; requireAuth?: boolean },
): Promise<string> {
  upsertSession(session);
  createRun({
    runId,
    sessionId: session.sessionId,
    courseKey: session.courseKey,
    override,
  });

  try {
    updateRunStage(runId, "resolving", "Resolving Moodle section and PDF links");
    const resolved = await resolveSessionMaterials(session, override, {
      moodleDebug: options?.moodleDebug,
      requireAuth: options?.requireAuth,
    });

    saveResolverDebug(runId, session.sessionId, session.courseKey, {
      courseId: resolved.courseId,
      courseName: resolved.courseName,
      resolver: resolved.result,
    });

    updateRunStage(runId, "downloading", "Downloading PDF/PPT materials");
    updateRunStage(runId, "parsing", "Extracting and chunking text");
    const processed = await processPdfLinks({
      courseKey: session.courseKey,
      materialLinks: resolved.result.pdfLinks,
    });

    if (processed.chunks.length === 0) {
      throw new Error("No text chunks were extracted from selected materials");
    }

    updateRunStage(runId, "summarizing", "Generating structured summary");
    const summarized = await summaryProvider.summarize(processed.chunks, session.courseName, options?.provider);

    updateRunStage(runId, "writing", "Persisting materials, summary and debug traces");
    updateRunTraces(runId, summarized.providerTrace, summarized.schemaValidationTrace);

    replaceMaterials({
      runId,
      sessionId: session.sessionId,
      courseKey: session.courseKey,
      sectionId: resolved.result.selectedSectionId,
      sectionTitle: resolved.result.selectedSectionTitle,
      materials: processed.materialRecords,
    });

    saveSummary({
      runId,
      sessionId: session.sessionId,
      courseKey: session.courseKey,
      resolverResult: resolved.result,
      summary: summarized.summary,
    });

    await writeJsonFile(path.join(config.runDebugDir, `${runId}.json`), {
      runId,
      sessionId: session.sessionId,
      courseKey: session.courseKey,
      resolver: resolved.result,
      providerTrace: summarized.providerTrace,
      schemaValidationTrace: summarized.schemaValidationTrace,
      writtenAt: new Date().toISOString(),
    });

    const persistAnchor = override?.persistAsAnchor ?? true;
    if (persistAnchor) {
      saveAnchor(session.courseKey, resolved.result.selectedSectionId, resolved.result.selectedSectionTitle);
    }

    completeRun(runId);
    return runId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failRun(runId, message);
    throw error;
  }
}

export function queueRun(
  session: Session,
  override?: SessionOverride,
  options?: { provider?: SummaryProviderMode; moodleDebug?: boolean; requireAuth?: boolean },
): { runId: string } {
  const runId = randomUUID();
  void executeRun(session, override, runId, options).catch(() => {
    // run status is already persisted as failed inside executeRun.
  });
  return { runId };
}
