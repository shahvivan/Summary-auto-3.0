import { randomUUID } from "node:crypto";
import path from "node:path";
import { config } from "../../config.js";
import { summarizeMultiMaterial } from "../ai/summarizer.js";
import { processPdfLinks } from "../pdf/pipeline.js";
import { resolveSessionMaterials } from "../resolver/resolver.js";
import {
  completeRun,
  createRun,
  failRun,
  incrementSessionTracker,
  replaceMaterials,
  saveAnchor,
  saveMaterialSummaries,
  saveResolverDebug,
  saveSummary,
  updateRunStage,
  updateRunTraces,
  upsertSession,
} from "../../storage/sqlite.js";
import type { Session, SessionOverride, SummaryProviderMode } from "../../types/domain.js";
import { writeJsonFile } from "../../utils/fs.js";

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

    const pdfLinks = resolved.result.pdfLinks;
    const preKeys = Object.keys(resolved.preDownloadedFiles ?? {});
    console.log(`[pipeline] pdfLinks=${pdfLinks.length}, preDownloadedFiles=${preKeys.length}`);

    // Save materials early — right after resolution — so sources panel populates
    // even when downloads or summarisation later fail.
    if (pdfLinks.length > 0) {
      replaceMaterials({
        runId,
        sessionId: session.sessionId,
        courseKey: session.courseKey,
        sectionId: resolved.result.selectedSectionId,
        sectionTitle: resolved.result.selectedSectionTitle,
        materials: pdfLinks.map((link) => ({
          resourceId: link.id,
          title: link.title,
          url: link.url,
        })),
      });
    }

    const processed = await processPdfLinks({
      courseKey: session.courseKey,
      materialLinks: pdfLinks,
      cookieHeader: resolved.cookieHeader,
      preDownloadedFiles: resolved.preDownloadedFiles,
    });

    // Check for download failure BEFORE advancing the stage to "parsing".
    // This ensures the UI stepper correctly shows "downloading" as the failed step,
    // not "parsing". (If we set "parsing" first and then throw, the UI shows parsing failed.)
    const hasPdfBytes = processed.parsedPdfs.some((pdf) => pdf.rawBytes && pdf.rawBytes.length > 0);
    if (processed.chunks.length === 0 && !hasPdfBytes) {
      // Build a detailed error that shows in the UI red banner
      const diagLines = [
        `pdfLinks found: ${pdfLinks.length}`,
        pdfLinks.length > 0 ? `first link: "${pdfLinks[0]!.title}" | url: ${pdfLinks[0]!.url.slice(0, 120)}` : "no links found",
        `preDownloaded files: ${preKeys.length}`,
        preKeys.length > 0 && pdfLinks.length > 0
          ? `URL match: ${pdfLinks[0]!.url === preKeys[0] ? "YES" : `NO — link="${pdfLinks[0]!.url.slice(0, 80)}" vs pre="${preKeys[0]!.slice(0, 80)}"`}`
          : "",
        processed.skipReasons.length > 0 ? `skip reasons: ${processed.skipReasons.join(" | ")}` : "",
      ].filter(Boolean);
      throw new Error(`Download failed — ${diagLines.join(" · ")}`);
    }

    updateRunStage(runId, "parsing", "Extracting and chunking text");
    updateRunStage(runId, "summarizing", "Generating structured summary");

    // Single LLM call: Gemini returns one summary block per PDF in one JSON response.
    // This replaces the old N+1 pattern (one call per PDF + one merged call).
    const summarized = await summarizeMultiMaterial({
      parsedPdfs: processed.parsedPdfs,
      chunks: processed.chunks,
      courseName: session.courseName,
      provider: options?.provider,
    });

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

    // Save the composed merged summary (used by Latest Brief preview + export fallback).
    saveSummary({
      runId,
      sessionId: session.sessionId,
      courseKey: session.courseKey,
      resolverResult: resolved.result,
      summary: summarized.mergedSummary,
    });

    // Save per-material summaries (one row per PDF/PPT — drives the per-PDF UI panels).
    if (summarized.materialSummaries.length > 0) {
      saveMaterialSummaries({
        runId,
        sessionId: session.sessionId,
        items: summarized.materialSummaries,
      });
    }

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
    // Auto-increment the session tracker so next class uses the next session number.
    incrementSessionTracker(session.courseKey);
    return runId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failRun(runId, message);
    throw error;
  }
}

// Sequential run queue — ensures only one Playwright instance runs at a time.
// launchPersistentContext() with the same --user-data-dir crashes if called
// concurrently; serialising all runs here prevents the ProfileSingleton error.
let _runQueue: Promise<unknown> = Promise.resolve();

export function queueRun(
  session: Session,
  override?: SessionOverride,
  options?: { provider?: SummaryProviderMode; moodleDebug?: boolean; requireAuth?: boolean },
): { runId: string } {
  const runId = randomUUID();
  _runQueue = _runQueue.then(() =>
    executeRun(session, override, runId, options).catch(() => {
      // run status is already persisted as failed inside executeRun.
    }),
  );
  return { runId };
}
