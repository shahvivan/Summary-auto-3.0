/**
 * Backtest injector: reads the uploaded Accounting Session 6 PDF, summarises it
 * with Gemini, and stores the result directly in SQLite so the UI can render it.
 *
 * Usage:  npx tsx --env-file=.env scripts/backtest-inject.ts
 */
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

async function main() {
  const pdfPath = "/sessions/epic-ecstatic-sagan/mnt/uploads/Slides Session 6 .pdf";

  // 1. Boot storage
  const { initStorage, upsertSession, createRun, completeRun, saveSummary, saveMaterialSummaries, replaceMaterials, updateRunStage } =
    await import("../src/storage/sqlite.js");
  await initStorage();

  // 2. Read the PDF
  console.log(`📄 Reading PDF: ${pdfPath}`);
  const pdfBytes = await fs.readFile(pdfPath);
  console.log(`   Size: ${(pdfBytes.length / 1024).toFixed(1)} KB`);

  // 3. Extract text
  console.log("\n🔍 Extracting text with pdf-parse...");
  const pdfParse = (await import("pdf-parse")).default;
  const parsed = await pdfParse(pdfBytes);
  const text = parsed.text.trim();
  console.log(`   Extracted ${text.length} chars`);

  // 4. Build ParsedPdf + chunks
  const { chunkParsedPdfs } = await import("../src/core/pdf/chunker.js");
  const { config } = await import("../src/config.js");

  const resourceId = "session-6-slides";
  const parsedPdfs = [
    {
      resourceId,
      sourceTitle: "Slides Session 6",
      sourceUrl: "file://local/Slides Session 6 .pdf",
      text,
      rawBytes: text.length < 100 ? pdfBytes : undefined, // only use rawBytes if text extraction failed
    },
  ];
  const chunks = chunkParsedPdfs(parsedPdfs, config.maxChunkChars);
  console.log(`   Chunks: ${chunks.length}`);

  // 5. Summarise with Gemini
  console.log("\n🤖 Summarising with Gemini (gemini-2.5-flash)...");
  const { summarizeMultiMaterial } = await import("../src/core/ai/summarizer.js");
  const summarized = await summarizeMultiMaterial({
    parsedPdfs,
    chunks,
    courseName: "Accounting I BBA & DBAI & GBL",
    provider: "gemini",
  });
  console.log("   ✅ Summary generated");
  console.log(`   Overview: ${summarized.mergedSummary.overview.slice(0, 120)}...`);
  console.log(`   Key concepts: ${summarized.mergedSummary.keyConcepts.length}`);
  console.log(`   Topic sections: ${summarized.mergedSummary.topicSections.length}`);

  // 6. Persist to SQLite under today's Accounting session
  const sessionId = "2026-03-03-accounting-i-bba-dbai-gbl-cdc3be48";
  const courseKey = "accounting-i-bba-dbai-gbl";
  const runId = randomUUID();

  console.log(`\n💾 Saving to SQLite (sessionId: ${sessionId})...`);

  upsertSession({
    sessionId,
    courseKey,
    courseName: "Accounting I BBA & DBAI & GBL",
    date: "2026-03-03",
    eventTitle: "Accounting I [Camps Ullastre, Roger]",
  });

  createRun({ runId, sessionId, courseKey, override: undefined });
  updateRunStage(runId, "writing", "Persisting summary from backtest injector");

  replaceMaterials({
    runId,
    sessionId,
    courseKey,
    sectionId: "backtest-section",
    sectionTitle: "Session 6: Inventories",
    materials: [
      {
        resourceId,
        title: "Slides Session 6",
        url: "file://local/Slides Session 6 .pdf",
        extractedText: text.slice(0, 500),
      },
    ],
  });

  const resolverResult = {
    selectedSectionId: "backtest-section",
    selectedSectionTitle: "Session 6: Inventories",
    pdfLinks: [
      {
        id: resourceId,
        title: "Slides Session 6",
        url: "file://local/Slides Session 6 .pdf",
        mimeType: "application/pdf",
      },
    ],
    allSections: [],
  };

  saveSummary({
    runId,
    sessionId,
    courseKey,
    resolverResult,
    summary: summarized.mergedSummary,
  });

  if (summarized.materialSummaries.length > 0) {
    saveMaterialSummaries({
      runId,
      sessionId,
      items: summarized.materialSummaries,
    });
  }

  completeRun(runId);

  console.log(`\n✅ Done! Open: http://localhost:3100\n`);
  console.log(`   → Click on "Accounting I" session to see the summary`);
  console.log(`   → Run ID: ${runId}`);
}

main().catch((err) => {
  console.error("\n❌ BACKTEST FAILED:", err.message);
  console.error(err.stack);
  process.exit(1);
});
