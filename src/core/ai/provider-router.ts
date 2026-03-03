import { config } from "../../config.js";
import type {
  ParsedPdf,
  ProviderTrace,
  SchemaValidationTrace,
  SummaryOutput,
  SummaryProviderMode,
  TextChunk,
} from "../../types/domain.js";
import { logInfo, logWarn } from "../../utils/logger.js";
import { generateDeterministicSummary } from "./deterministic-summarizer.js";
import { ChatPdfProvider } from "./chatpdf-provider.js";
import { GeminiProvider } from "./gemini-provider.js";
import {
  composeMergedSummary,
  type PerMaterialSummaryItem,
  extractJsonFromText,
  normalizeSummaryOutput,
  parseMultiMaterialFromText,
  validateSummaryText,
  summarySchema,
} from "./schema.js";

interface LlmProvider {
  name: "gemini" | "chatpdf";
  isConfigured(): boolean;
  generate(prompt: string): Promise<string>;
}

interface ProviderAttemptSuccess {
  summary: SummaryOutput;
  schemaValidationTrace: SchemaValidationTrace;
}

let providerConfigLogged = false;

// ---------------------------------------------------------------------------
// Shared JSON schema description (used in all prompts)
// ---------------------------------------------------------------------------

const SUMMARY_SCHEMA_DOC = `{
  "overview": "2-3 sentences explaining what this session is about and why it matters",
  "keyConcepts": ["string — format each as 'Term: plain-language definition'"],
  "topicSections": [{ "heading": "string", "points": ["string — detailed, self-contained explanatory bullet"] }],
  "keyDefinitions": ["string — exact formula, equation, or formal textbook definition with notation"]
}`;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildSingleDocPrompt(chunks: TextChunk[], courseName: string): string {
  const context = chunks
    .slice(0, 28)
    .map((chunk, index) => `[[Chunk ${index + 1} | ${chunk.sourceTitle}]]\n${chunk.text.slice(0, 2200)}`)
    .join("\n\n");

  return [
    "You are a university learning assistant. A student is preparing for an upcoming lecture.",
    `Course: ${courseName}`,
    "Read the following material and write a detailed study summary to help the student understand it for the first time.",
    "",
    "Return JSON only. No markdown fences or extra text.",
    "Required JSON schema:",
    SUMMARY_SCHEMA_DOC,
    "",
    "Guidelines:",
    "- overview: explain the topic clearly in plain language — what will the student learn?",
    "- keyConcepts: define every new term. Format: 'Term: definition'",
    "- topicSections: break the content into logical sections with 3-5 detailed bullet points each",
    "- keyDefinitions: exact formulas, equations, or precise definitions with proper notation",
    "- Be thorough — a student reading this should feel prepared to attend the lecture",
    "",
    "Material:",
    context,
  ].join("\n");
}

function buildMultiMaterialPrompt(parsedPdfs: ParsedPdf[], courseName: string): string {
  const MAX_CHARS_PER_DOC = 5_000;
  const docBlocks = parsedPdfs
    .map((pdf, i) => {
      const truncated = pdf.text.replace(/\s+/g, " ").trim().slice(0, MAX_CHARS_PER_DOC);
      return `[[Document ${i + 1} | resourceId: "${pdf.resourceId}" | Title: "${pdf.sourceTitle}"]]\n${truncated}`;
    })
    .join("\n\n---\n\n");

  const expectedList = parsedPdfs
    .map((pdf) => `  - resourceId: "${pdf.resourceId}", title: "${pdf.sourceTitle}"`)
    .join("\n");

  const perMaterialSchemaDoc = `{
  "resourceId": "<exact resourceId from the document header>",
  "title": "<exact title from the document header>",
  "overview": "2-3 sentences — what is this document about and why it matters",
  "keyConcepts": ["Term: plain-language definition for each new concept"],
  "topicSections": [{ "heading": "string", "points": ["detailed explanatory bullet point"] }],
  "keyDefinitions": ["exact formula or formal definition with notation"]
}`;

  return [
    "You are a university learning assistant preparing study summaries for a student.",
    `Course: ${courseName}`,
    `You will receive content from ${parsedPdfs.length} document(s).`,
    "Write a SEPARATE detailed study summary for EACH document to help the student understand new material.",
    "",
    "Return JSON ONLY. No markdown fences or extra text. Use this exact schema:",
    `{ "materials": [ ${perMaterialSchemaDoc} ] }`,
    "",
    "Expected entries in the materials array (one per document):",
    expectedList,
    "",
    "Guidelines:",
    "- overview: plain-language explanation of what the document covers and why it matters",
    "- keyConcepts: define every new term. Format each as 'Term: definition'",
    "- topicSections: break content into logical sections with 3-5 detailed bullet points each",
    "- keyDefinitions: exact formulas, equations, precise definitions with proper notation",
    "- One entry per document — do NOT merge documents together",
    "- Use the exact resourceId from each document header",
    "",
    "Documents:",
    docBlocks,
  ].join("\n");
}

function buildNativePdfPrompt(courseName: string, docTitle: string): string {
  return [
    "You are a university learning assistant. A student is preparing for an upcoming lecture.",
    `Course: ${courseName}`,
    `Document: ${docTitle}`,
    "",
    "Carefully read ALL slides in this PDF and write a detailed study summary to help the student understand the material for the first time.",
    "",
    "Return JSON only. No markdown fences or extra text.",
    "Required JSON schema:",
    SUMMARY_SCHEMA_DOC,
    "",
    "Guidelines:",
    "- overview: explain what this lecture is about in plain language (2-3 sentences)",
    "- keyConcepts: define every new concept or term introduced. Format: 'Term: definition'",
    "- topicSections: break the content into sections matching the slide structure, with 3-5 detailed bullet points per section",
    "- keyDefinitions: every important equation, formula, or precise definition with exact notation",
    "- Be thorough — the student should feel fully prepared after reading your summary",
  ].join("\n");
}

function logProvidersConfigured(geminiConfigured: boolean, chatpdfConfigured: boolean): void {
  if (providerConfigLogged) return;
  providerConfigLogged = true;
  logInfo(`Providers configured: gemini=${geminiConfigured}, chatpdf=${chatpdfConfigured}, deterministic=${config.deterministicEnabled}`);
}

async function runProviderWithValidation(provider: LlmProvider, prompt: string): Promise<ProviderAttemptSuccess> {
  const payloadErrors: string[] = [];
  let repairedAttempts = 0;
  const maxAttempts = 2;
  let currentPrompt = prompt;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const raw = await provider.generate(currentPrompt);
    try {
      const summary = validateSummaryText(raw);
      return { summary, schemaValidationTrace: { attempts: attempt, repairedAttempts, providerPayloadErrors: payloadErrors } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      payloadErrors.push(`${provider.name}: ${message}`);
      if (attempt < maxAttempts) {
        repairedAttempts += 1;
        currentPrompt = [prompt, "", "Your previous output failed schema validation.", `Validation error: ${message}`, "Return corrected JSON only. Keep exact schema and required keys."].join("\n");
      }
    }
  }

  throw new Error(`schema_validation_failed:${provider.name}:${payloadErrors[payloadErrors.length - 1] ?? "unknown error"}`);
}

function createDeterministicResult(
  chunks: TextChunk[],
  courseName: string,
  requestedProvider: SummaryProviderMode,
  attempts: ProviderTrace["attempts"] = [{ provider: "deterministic", ok: true }],
  fallbackReason?: string,
): { summary: SummaryOutput; providerTrace: ProviderTrace; schemaValidationTrace: SchemaValidationTrace } {
  const summary = generateDeterministicSummary(chunks, courseName);
  return {
    summary,
    providerTrace: { requestedProvider, finalProvider: "deterministic", attempts, fallbackReason },
    schemaValidationTrace: { attempts: 1, repairedAttempts: 0, providerPayloadErrors: [] },
  };
}

function misconfiguredError(provider: "gemini" | "chatpdf"): Error {
  return new Error(`Provider misconfigured: ${provider} is not configured`);
}

// ---------------------------------------------------------------------------
// Native PDF summarisation via Gemini Files API
// ---------------------------------------------------------------------------

async function summarizeOnePdfNative(
  gemini: GeminiProvider,
  pdf: ParsedPdf,
  courseName: string,
): Promise<{ summary: SummaryOutput; schemaValidationTrace: SchemaValidationTrace }> {
  if (!pdf.rawBytes) throw new Error("No raw bytes available for native PDF summarisation");

  const fileUri = await gemini.uploadFile(pdf.rawBytes, "application/pdf", `${pdf.sourceTitle}.pdf`);

  try {
    const prompt = buildNativePdfPrompt(courseName, pdf.sourceTitle);
    const payloadErrors: string[] = [];

    for (let attempt = 1; attempt <= 2; attempt++) {
      const raw = await gemini.generateWithFileUri(fileUri, "application/pdf", prompt);
      try {
        const json = extractJsonFromText(raw);
        const parsed = summarySchema.parse(json);
        const summary = normalizeSummaryOutput(parsed);
        return { summary, schemaValidationTrace: { attempts: attempt, repairedAttempts: attempt - 1, providerPayloadErrors: payloadErrors } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        payloadErrors.push(msg);
      }
    }

    throw new Error(`Native PDF schema validation failed: ${payloadErrors.at(-1) ?? "unknown"}`);
  } finally {
    await gemini.deleteFile(fileUri).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Public: summarizeWithProviderRouter (single-doc, text-based)
// ---------------------------------------------------------------------------

export async function summarizeWithProviderRouter(params: {
  chunks: TextChunk[];
  courseName: string;
  provider: SummaryProviderMode;
  fallbackEnabled: boolean;
  providers?: { gemini?: LlmProvider; chatpdf?: LlmProvider };
}): Promise<{ summary: SummaryOutput; providerTrace: ProviderTrace; schemaValidationTrace: SchemaValidationTrace }> {
  const requested = params.provider;
  const gemini = params.providers?.gemini ?? new GeminiProvider();
  const chatpdf = params.providers?.chatpdf ?? new ChatPdfProvider();
  const geminiConfigured = gemini.isConfigured();
  const chatpdfConfigured = chatpdf.isConfigured();
  logProvidersConfigured(geminiConfigured, chatpdfConfigured);

  if (requested === "deterministic") return createDeterministicResult(params.chunks, params.courseName, requested);

  const prompt = buildSingleDocPrompt(params.chunks, params.courseName);
  const attempts: ProviderTrace["attempts"] = [];

  async function runGemini() { const out = await runProviderWithValidation(gemini, prompt); attempts.push({ provider: "gemini", ok: true }); return out; }
  async function runChatPdf() { const out = await runProviderWithValidation(chatpdf, prompt); attempts.push({ provider: "chatpdf", ok: true }); return out; }

  if (requested === "gemini") {
    if (!geminiConfigured) {
      attempts.push({ provider: "gemini", ok: false, reason: "gemini_not_configured" });
      if (!params.fallbackEnabled) throw misconfiguredError("gemini");
      if (chatpdfConfigured) { const out = await runChatPdf(); return { summary: out.summary, providerTrace: { requestedProvider: requested, finalProvider: "chatpdf", attempts, fallbackReason: "gemini_not_configured" }, schemaValidationTrace: out.schemaValidationTrace }; }
      return createDeterministicResult(params.chunks, params.courseName, requested, attempts, "gemini_not_configured");
    }
    try { const out = await runGemini(); return { summary: out.summary, providerTrace: { requestedProvider: requested, finalProvider: "gemini", attempts }, schemaValidationTrace: out.schemaValidationTrace }; }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      attempts.push({ provider: "gemini", ok: false, reason });
      if (!params.fallbackEnabled) throw new Error(`Provider failure (gemini): ${reason}`);
      if (chatpdfConfigured) { const out = await runChatPdf(); return { summary: out.summary, providerTrace: { requestedProvider: requested, finalProvider: "chatpdf", attempts, fallbackReason: reason }, schemaValidationTrace: out.schemaValidationTrace }; }
      return createDeterministicResult(params.chunks, params.courseName, requested, attempts, reason);
    }
  }

  if (requested === "chatpdf") {
    if (!chatpdfConfigured) {
      attempts.push({ provider: "chatpdf", ok: false, reason: "chatpdf_not_configured" });
      logWarn("Requested provider chatpdf is not configured; skipping ChatPDF");
      if (!params.fallbackEnabled) throw misconfiguredError("chatpdf");
      if (geminiConfigured) { const out = await runGemini(); return { summary: out.summary, providerTrace: { requestedProvider: requested, finalProvider: "gemini", attempts, fallbackReason: "chatpdf_not_configured" }, schemaValidationTrace: out.schemaValidationTrace }; }
      return createDeterministicResult(params.chunks, params.courseName, requested, attempts, "chatpdf_not_configured");
    }
    try { const out = await runChatPdf(); return { summary: out.summary, providerTrace: { requestedProvider: requested, finalProvider: "chatpdf", attempts }, schemaValidationTrace: out.schemaValidationTrace }; }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      attempts.push({ provider: "chatpdf", ok: false, reason });
      if (!params.fallbackEnabled) throw new Error(`Provider failure (chatpdf): ${reason}`);
      if (geminiConfigured) { const out = await runGemini(); return { summary: out.summary, providerTrace: { requestedProvider: requested, finalProvider: "gemini", attempts, fallbackReason: reason }, schemaValidationTrace: out.schemaValidationTrace }; }
      return createDeterministicResult(params.chunks, params.courseName, requested, attempts, reason);
    }
  }

  // auto
  if (geminiConfigured) {
    try { const out = await runGemini(); return { summary: out.summary, providerTrace: { requestedProvider: requested, finalProvider: "gemini", attempts }, schemaValidationTrace: out.schemaValidationTrace }; }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      attempts.push({ provider: "gemini", ok: false, reason });
      if (!params.fallbackEnabled) throw new Error(`Provider failure (gemini): ${reason}`);
      if (chatpdfConfigured) {
        try { const out = await runChatPdf(); return { summary: out.summary, providerTrace: { requestedProvider: requested, finalProvider: "chatpdf", attempts, fallbackReason: reason }, schemaValidationTrace: out.schemaValidationTrace }; }
        catch (chatError) {
          const chatReason = chatError instanceof Error ? chatError.message : String(chatError);
          attempts.push({ provider: "chatpdf", ok: false, reason: chatReason });
          return createDeterministicResult(params.chunks, params.courseName, requested, attempts, chatReason);
        }
      }
      return createDeterministicResult(params.chunks, params.courseName, requested, attempts, reason);
    }
  }

  if (chatpdfConfigured) {
    try { const out = await runChatPdf(); return { summary: out.summary, providerTrace: { requestedProvider: requested, finalProvider: "chatpdf", attempts }, schemaValidationTrace: out.schemaValidationTrace }; }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      attempts.push({ provider: "chatpdf", ok: false, reason });
      if (!params.fallbackEnabled) throw new Error(`Provider failure (chatpdf): ${reason}`);
      return createDeterministicResult(params.chunks, params.courseName, requested, attempts, reason);
    }
  }

  if (!params.fallbackEnabled) throw new Error("Provider misconfigured: no providers configured");
  return createDeterministicResult(params.chunks, params.courseName, requested, attempts, "no_provider_configured");
}

// ---------------------------------------------------------------------------
// Multi-material summarisation
// ---------------------------------------------------------------------------

async function runMultiMaterialWithValidation(
  provider: LlmProvider,
  prompt: string,
  urlByResourceId: Map<string, string>,
): Promise<{ items: PerMaterialSummaryItem[]; schemaValidationTrace: SchemaValidationTrace }> {
  const payloadErrors: string[] = [];
  let repairedAttempts = 0;
  const maxAttempts = 2;
  let currentPrompt = prompt;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const raw = await provider.generate(currentPrompt);
    try {
      const items = parseMultiMaterialFromText(raw, urlByResourceId);
      return { items, schemaValidationTrace: { attempts: attempt, repairedAttempts, providerPayloadErrors: payloadErrors } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      payloadErrors.push(`${provider.name}: ${message}`);
      if (attempt < maxAttempts) {
        repairedAttempts += 1;
        currentPrompt = [prompt, "", "Your previous output failed schema validation.", `Validation error: ${message}`, 'Return corrected JSON only. The root object MUST have a "materials" array with one entry per document.'].join("\n");
      }
    }
  }

  throw new Error(`multi_material_schema_failed:${provider.name}:${payloadErrors[payloadErrors.length - 1] ?? "unknown"}`);
}

export async function summarizeMultiMaterialWithProviderRouter(params: {
  parsedPdfs: ParsedPdf[];
  courseName: string;
  provider: SummaryProviderMode;
  fallbackEnabled: boolean;
  chunks: TextChunk[];
  providers?: { gemini?: LlmProvider; chatpdf?: LlmProvider };
}): Promise<{
  materialSummaries: PerMaterialSummaryItem[];
  mergedSummary: SummaryOutput;
  providerTrace: ProviderTrace;
  schemaValidationTrace: SchemaValidationTrace;
}> {
  const gemini = (params.providers?.gemini as GeminiProvider | undefined) ?? new GeminiProvider();
  const chatpdf = params.providers?.chatpdf ?? new ChatPdfProvider();
  const geminiConfigured = gemini.isConfigured();
  const chatpdfConfigured = chatpdf.isConfigured();
  logProvidersConfigured(geminiConfigured, chatpdfConfigured);

  const urlByResourceId = new Map(params.parsedPdfs.map((pdf) => [pdf.resourceId, pdf.sourceUrl]));
  const attempts: ProviderTrace["attempts"] = [];

  // Deterministic shortcut
  if (params.provider === "deterministic") {
    const det = createDeterministicResult(params.chunks, params.courseName, params.provider);
    const items: PerMaterialSummaryItem[] = params.parsedPdfs.map((pdf) => ({ resourceId: pdf.resourceId, title: pdf.sourceTitle, url: pdf.sourceUrl, summary: det.summary }));
    return { materialSummaries: items, mergedSummary: det.summary, providerTrace: det.providerTrace, schemaValidationTrace: det.schemaValidationTrace };
  }

  // Split: PDFs needing native Gemini Files API vs text-based
  const nativeCandidates = params.parsedPdfs.filter((pdf) => pdf.rawBytes && pdf.rawBytes.length > 0);
  const textCandidates = params.parsedPdfs.filter((pdf) => pdf.text.trim().length > 0);

  if (nativeCandidates.length > 0 && geminiConfigured) {
    logInfo(`[provider-router] Using Gemini Files API for ${nativeCandidates.length} image-based PDF(s)`);
    const allItems: PerMaterialSummaryItem[] = [];
    const allErrors: string[] = [];
    let totalAttempts = 0;

    // Native path: one call per image-based PDF
    for (const pdf of nativeCandidates) {
      try {
        const { summary, schemaValidationTrace } = await summarizeOnePdfNative(gemini, pdf, params.courseName);
        allItems.push({ resourceId: pdf.resourceId, title: pdf.sourceTitle, url: pdf.sourceUrl, summary });
        totalAttempts += schemaValidationTrace.attempts;
        allErrors.push(...schemaValidationTrace.providerPayloadErrors);
        attempts.push({ provider: "gemini", ok: true });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logWarn(`[provider-router] Native PDF failed for "${pdf.sourceTitle}": ${reason}`);
        attempts.push({ provider: "gemini", ok: false, reason });
        // Deterministic fallback for this single document
        const det = generateDeterministicSummary(params.chunks, params.courseName);
        allItems.push({ resourceId: pdf.resourceId, title: pdf.sourceTitle, url: pdf.sourceUrl, summary: det });
        totalAttempts += 1;
      }
    }

    // Text-based path for docs where extraction succeeded
    if (textCandidates.length > 0) {
      const textPrompt = buildMultiMaterialPrompt(textCandidates, params.courseName);
      try {
        const { items, schemaValidationTrace } = await runMultiMaterialWithValidation(gemini, textPrompt, urlByResourceId);
        allItems.push(...items);
        totalAttempts += schemaValidationTrace.attempts;
        allErrors.push(...schemaValidationTrace.providerPayloadErrors);
        attempts.push({ provider: "gemini", ok: true });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logWarn(`[provider-router] Text multi-material call failed: ${reason}`);
        for (const pdf of textCandidates) {
          allItems.push({ resourceId: pdf.resourceId, title: pdf.sourceTitle, url: pdf.sourceUrl, summary: generateDeterministicSummary(params.chunks, params.courseName) });
        }
      }
    }

    if (allItems.length > 0) {
      return {
        materialSummaries: allItems,
        mergedSummary: composeMergedSummary(allItems),
        providerTrace: { requestedProvider: params.provider, finalProvider: "gemini", attempts },
        schemaValidationTrace: { attempts: totalAttempts, repairedAttempts: 0, providerPayloadErrors: allErrors },
      };
    }
  }

  // Text-only multi-material path
  const textDocs = params.parsedPdfs.filter((pdf) => pdf.text.trim().length > 0);
  if (textDocs.length === 0) {
    const det = createDeterministicResult(params.chunks, params.courseName, params.provider, attempts, "no_text_content");
    const items: PerMaterialSummaryItem[] = params.parsedPdfs.map((pdf) => ({ resourceId: pdf.resourceId, title: pdf.sourceTitle, url: pdf.sourceUrl, summary: det.summary }));
    return { materialSummaries: items, mergedSummary: det.summary, providerTrace: det.providerTrace, schemaValidationTrace: det.schemaValidationTrace };
  }

  const primaryProvider: LlmProvider | null =
    params.provider === "chatpdf" ? (chatpdfConfigured ? chatpdf : null) : geminiConfigured ? gemini : chatpdfConfigured ? chatpdf : null;

  if (primaryProvider) {
    const prompt = buildMultiMaterialPrompt(textDocs, params.courseName);
    try {
      const { items, schemaValidationTrace } = await runMultiMaterialWithValidation(primaryProvider, prompt, urlByResourceId);
      attempts.push({ provider: primaryProvider.name, ok: true });
      return { materialSummaries: items, mergedSummary: composeMergedSummary(items), providerTrace: { requestedProvider: params.provider, finalProvider: primaryProvider.name, attempts }, schemaValidationTrace };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      attempts.push({ provider: primaryProvider.name, ok: false, reason });
      logWarn(`Multi-material summarisation failed (${primaryProvider.name}): ${reason}`);
      if (!params.fallbackEnabled) throw new Error(`Provider failure (${primaryProvider.name}): ${reason}`);
    }
  }

  // Deterministic fallback
  const det = createDeterministicResult(params.chunks, params.courseName, params.provider, attempts, "all_providers_failed");
  const items: PerMaterialSummaryItem[] = params.parsedPdfs.map((pdf) => ({ resourceId: pdf.resourceId, title: pdf.sourceTitle, url: pdf.sourceUrl, summary: det.summary }));
  return { materialSummaries: items, mergedSummary: det.summary, providerTrace: det.providerTrace, schemaValidationTrace: det.schemaValidationTrace };
}
