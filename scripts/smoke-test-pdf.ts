/**
 * Smoke test: read the uploaded Session 6 slides PDF, run it through the
 * complete parsing + Gemini summarisation pipeline and print the result.
 *
 * Usage:  npx tsx scripts/smoke-test-pdf.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// env loaded via --env-file flag

async function main() {
  // --- 1. Read the uploaded PDF ---
  const pdfPath = "/sessions/epic-ecstatic-sagan/mnt/uploads/Slides Session 6 .pdf";
  console.log(`\n📄 Reading PDF: ${pdfPath}`);
  const pdfBytes = await fs.readFile(pdfPath);
  console.log(`   Size: ${(pdfBytes.length / 1024).toFixed(1)} KB`);

  // --- 2. Try text extraction (expect it to fail / return empty for image-based slides) ---
  console.log("\n🔍 Attempting pdf-parse text extraction...");
  let extractedText = "";
  try {
    const pdfParse = (await import("pdf-parse")).default;
    const result = await pdfParse(pdfBytes);
    extractedText = result.text.trim();
    console.log(`   Extracted ${extractedText.length} chars`);
    if (extractedText.length === 0) {
      console.log("   ⚠️  Empty text — image-based PDF confirmed. Gemini Files API path will be used.");
    } else {
      console.log(`   Preview: "${extractedText.slice(0, 120)}..."`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`   ⚠️  pdf-parse failed: ${msg.slice(0, 120)}`);
    console.log("   → Gemini Files API path will be used.");
  }

  // --- 3. Import Gemini provider and upload PDF ---
  console.log("\n☁️  Uploading PDF to Gemini Files API...");
  const { GeminiProvider } = await import("../src/core/ai/gemini-provider.js");
  const gemini = new GeminiProvider();

  if (!gemini.isConfigured()) {
    console.error("❌ Gemini not configured — check GEMINI_API_KEY and GEMINI_MODEL in .env");
    process.exit(1);
  }

  const fileUri = await gemini.uploadFile(pdfBytes, "application/pdf", "Slides Session 6.pdf");
  console.log(`   ✅ Uploaded → ${fileUri}`);

  // --- 4. Generate summary ---
  console.log("\n🤖 Generating learning summary with Gemini...");
  const prompt = [
    "You are a university learning assistant. A student is preparing for an upcoming lecture.",
    "Course: Accounting I BBA & DBAI & GBL",
    "Document: Slides Session 6.pdf",
    "",
    "Carefully read ALL slides in this PDF and write a detailed study summary to help the student understand the material for the first time.",
    "",
    "Return JSON only. No markdown fences or extra text.",
    "Required JSON schema:",
    `{
  "overview": "2-3 sentences explaining what this session is about and why it matters",
  "keyConcepts": ["string — format each as 'Term: plain-language definition'"],
  "topicSections": [{ "heading": "string", "points": ["string — detailed, self-contained explanatory bullet"] }],
  "keyDefinitions": ["string — exact formula, equation, or formal textbook definition with notation"]
}`,
    "",
    "Guidelines:",
    "- overview: explain what this lecture is about in plain language (2-3 sentences)",
    "- keyConcepts: define every new concept or term introduced. Format: 'Term: definition'",
    "- topicSections: break the content into sections matching the slide structure, with 3-5 detailed bullet points per section",
    "- keyDefinitions: every important equation, formula, or precise definition with exact notation",
    "- Be thorough — the student should feel fully prepared after reading your summary",
  ].join("\n");

  const raw = await gemini.generateWithFileUri(fileUri, "application/pdf", prompt);

  // --- 5. Parse and validate the response ---
  console.log("\n📋 Validating JSON schema...");
  const { validateSummaryText } = await import("../src/core/ai/schema.js");
  const summary = validateSummaryText(raw);

  console.log("\n✅ SUCCESS — Summary produced:");
  console.log("─".repeat(60));
  console.log(`\n📌 OVERVIEW\n${summary.overview}`);

  console.log(`\n🔑 KEY CONCEPTS (${summary.keyConcepts.length})`);
  for (const c of summary.keyConcepts.slice(0, 6)) {
    console.log(`  • ${c}`);
  }

  console.log(`\n📚 TOPIC SECTIONS (${summary.topicSections.length})`);
  for (const section of summary.topicSections) {
    console.log(`\n  ▸ ${section.heading}`);
    for (const point of section.points.slice(0, 3)) {
      console.log(`    - ${point.slice(0, 100)}`);
    }
  }

  if (summary.keyDefinitions.length > 0) {
    console.log(`\n📐 KEY DEFINITIONS (${summary.keyDefinitions.length})`);
    for (const def of summary.keyDefinitions.slice(0, 5)) {
      console.log(`  • ${def.slice(0, 120)}`);
    }
  }

  console.log("\n" + "─".repeat(60));

  // --- 6. Clean up ---
  await gemini.deleteFile(fileUri).catch(() => {});
  console.log("🗑️  File deleted from Gemini.\n");
}

main().catch((err) => {
  console.error("\n❌ SMOKE TEST FAILED:", err.message);
  console.error(err.stack);
  process.exit(1);
});
