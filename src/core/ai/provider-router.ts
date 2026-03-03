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
  parseMultiMaterialFromText,
  validateSummaryText,
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

function buildPrompt(chunks: TextChunk[], courseName: string): string {
  const context = chunks
    .slice(0, 28)
    .map((chunk, index) => `[[Chunk ${index + 1} | ${chunk.sourceTitle}]]\n${chunk.text.slice(0, 2200)}`)
    .join("\n\n");

  return [
    "You are preparing a pre-lecture brief for a university student.",
    `Course: ${courseName}`,
    "Return JSON only. Do not include markdown fences or extra text.",
    "Required JSON schema:",
    "{",
    '  "layer1KeyConcepts": string[],',
    '  "layer2StructuredExplanation": [{ "heading": string, "points": string[] }],',
    '  "layer3DetailedNotes": string[],',
    '  "preparationTips": string[],',
    '  "keyEquationsOrDefinitions": string[]',
    "}",
    "Constraints:",
    "- Deterministic academic tone; concise and factual.",
    "- Keep each bullet self-contained and specific to the provided material.",
    "- Never invent content outside the context.",
    "",
    "Context:",
    context,
  ].join("\n");
}

function logProvidersConfigured(geminiConfigured: boolean, chatpdfConfigured: boolean): void {
  if (providerConfigLogged) {
    return;
  }
  providerConfigLogged = true;
  logInfo(
    `Providers configured: gemini=${geminiConfigured}, chatpdf=${chatpdfConfigured}, deterministic=${config.deterministicEnabled}`,
  );
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
      return {
        summary,
        schemaValidationTrace: {
          attempts: attempt,
          repairedAttempts,
          providerPayloadErrors: payloadErrors,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      payloadErrors.push(`${provider.name}: ${message}`);
      if (attempt < maxAttempts) {
        repairedAttempts += 1;
        currentPrompt = [
          prompt,
          "",
          "Your previous output failed schema validation.",
          `Validation error: ${message}`,
          "Return corrected JSON only. Keep exact schema and required keys.",
        ].join("\n");
      }
    }
  }

  throw new Error(
    `schema_validation_failed:${provider.name}:${payloadErrors[payloadErrors.length - 1] ?? "unknown error"}`,
  );
}

function createDeterministicResult(
  chunks: TextChunk[],
  courseName: string,
  requestedProvider: SummaryProviderMode,
  attempts: ProviderTrace["attempts"] = [{ provider: "deterministic", ok: true }],
  fallbackReason?: string,
): {
  summary: SummaryOutput;
  providerTrace: ProviderTrace;
  schemaValidationTrace: SchemaValidationTrace;
} {
  const summary = generateDeterministicSummary(chunks, courseName);
  return {
    summary,
    providerTrace: {
      requestedProvider,
      finalProvider: "deterministic",
      attempts,
      fallbackReason,
    },
    schemaValidationTrace: {
      attempts: 1,
      repairedAttempts: 0,
      providerPayloadErrors: [],
    },
  };
}

function misconfiguredError(provider: "gemini" | "chatpdf"): Error {
  return new Error(`Provider misconfigured: ${provider} is not configured`);
}

async function attemptProvider(provider: LlmProvider, prompt: string) {
  return runProviderWithValidation(provider, prompt);
}

export async function summarizeWithProviderRouter(params: {
  chunks: TextChunk[];
  courseName: string;
  provider: SummaryProviderMode;
  fallbackEnabled: boolean;
  providers?: {
    gemini?: LlmProvider;
    chatpdf?: LlmProvider;
  };
}): Promise<{
  summary: SummaryOutput;
  providerTrace: ProviderTrace;
  schemaValidationTrace: SchemaValidationTrace;
}> {
  const requested = params.provider;
  const gemini = params.providers?.gemini ?? new GeminiProvider();
  const chatpdf = params.providers?.chatpdf ?? new ChatPdfProvider();

  const geminiConfigured = gemini.isConfigured();
  const chatpdfConfigured = chatpdf.isConfigured();
  logProvidersConfigured(geminiConfigured, chatpdfConfigured);

  if (requested === "deterministic") {
    return createDeterministicResult(params.chunks, params.courseName, requested);
  }

  const prompt = buildPrompt(params.chunks, params.courseName);
  const attempts: ProviderTrace["attempts"] = [];

  async function runGemini(): Promise<{
    summary: SummaryOutput;
    schemaValidationTrace: SchemaValidationTrace;
  }> {
    const out = await attemptProvider(gemini, prompt);
    attempts.push({ provider: "gemini", ok: true });
    return out;
  }

  async function runChatPdf(): Promise<{
    summary: SummaryOutput;
    schemaValidationTrace: SchemaValidationTrace;
  }> {
    const out = await attemptProvider(chatpdf, prompt);
    attempts.push({ provider: "chatpdf", ok: true });
    return out;
  }

  if (requested === "gemini") {
    if (!geminiConfigured) {
      attempts.push({ provider: "gemini", ok: false, reason: "gemini_not_configured" });
      if (!params.fallbackEnabled) {
        throw misconfiguredError("gemini");
      }
      if (chatpdfConfigured) {
        const out = await runChatPdf();
        return {
          summary: out.summary,
          providerTrace: {
            requestedProvider: requested,
            finalProvider: "chatpdf",
            attempts,
            fallbackReason: "gemini_not_configured",
          },
          schemaValidationTrace: out.schemaValidationTrace,
        };
      }

      return createDeterministicResult(params.chunks, params.courseName, requested, attempts, "gemini_not_configured");
    }

    try {
      const out = await runGemini();
      return {
        summary: out.summary,
        providerTrace: {
          requestedProvider: requested,
          finalProvider: "gemini",
          attempts,
        },
        schemaValidationTrace: out.schemaValidationTrace,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      attempts.push({ provider: "gemini", ok: false, reason });
      if (!params.fallbackEnabled) {
        throw new Error(`Provider failure (gemini): ${reason}`);
      }

      if (chatpdfConfigured) {
        const out = await runChatPdf();
        return {
          summary: out.summary,
          providerTrace: {
            requestedProvider: requested,
            finalProvider: "chatpdf",
            attempts,
            fallbackReason: reason,
          },
          schemaValidationTrace: out.schemaValidationTrace,
        };
      }

      return createDeterministicResult(params.chunks, params.courseName, requested, attempts, reason);
    }
  }

  if (requested === "chatpdf") {
    if (!chatpdfConfigured) {
      attempts.push({ provider: "chatpdf", ok: false, reason: "chatpdf_not_configured" });
      logWarn("Requested provider chatpdf is not configured; skipping ChatPDF");
      if (!params.fallbackEnabled) {
        throw misconfiguredError("chatpdf");
      }

      if (geminiConfigured) {
        const out = await runGemini();
        return {
          summary: out.summary,
          providerTrace: {
            requestedProvider: requested,
            finalProvider: "gemini",
            attempts,
            fallbackReason: "chatpdf_not_configured",
          },
          schemaValidationTrace: out.schemaValidationTrace,
        };
      }

      return createDeterministicResult(params.chunks, params.courseName, requested, attempts, "chatpdf_not_configured");
    }

    try {
      const out = await runChatPdf();
      return {
        summary: out.summary,
        providerTrace: {
          requestedProvider: requested,
          finalProvider: "chatpdf",
          attempts,
        },
        schemaValidationTrace: out.schemaValidationTrace,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      attempts.push({ provider: "chatpdf", ok: false, reason });
      if (!params.fallbackEnabled) {
        throw new Error(`Provider failure (chatpdf): ${reason}`);
      }

      if (geminiConfigured) {
        const out = await runGemini();
        return {
          summary: out.summary,
          providerTrace: {
            requestedProvider: requested,
            finalProvider: "gemini",
            attempts,
            fallbackReason: reason,
          },
          schemaValidationTrace: out.schemaValidationTrace,
        };
      }

      return createDeterministicResult(params.chunks, params.courseName, requested, attempts, reason);
    }
  }

  // auto mode: gemini first, then chatpdf only if configured.
  if (geminiConfigured) {
    try {
      const out = await runGemini();
      return {
        summary: out.summary,
        providerTrace: {
          requestedProvider: requested,
          finalProvider: "gemini",
          attempts,
        },
        schemaValidationTrace: out.schemaValidationTrace,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      attempts.push({ provider: "gemini", ok: false, reason });
      if (!params.fallbackEnabled) {
        throw new Error(`Provider failure (gemini): ${reason}`);
      }
      if (chatpdfConfigured) {
        try {
          const out = await runChatPdf();
          return {
            summary: out.summary,
            providerTrace: {
              requestedProvider: requested,
              finalProvider: "chatpdf",
              attempts,
              fallbackReason: reason,
            },
            schemaValidationTrace: out.schemaValidationTrace,
          };
        } catch (chatError) {
          const chatReason = chatError instanceof Error ? chatError.message : String(chatError);
          attempts.push({ provider: "chatpdf", ok: false, reason: chatReason });
          return createDeterministicResult(params.chunks, params.courseName, requested, attempts, chatReason);
        }
      }
      return createDeterministicResult(params.chunks, params.courseName, requested, attempts, reason);
    }
  }

  if (chatpdfConfigured) {
    try {
      const out = await runChatPdf();
      return {
        summary: out.summary,
        providerTrace: {
          requestedProvider: requested,
          finalProvider: "chatpdf",
          attempts,
        },
        schemaValidationTrace: out.schemaValidationTrace,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      attempts.push({ provider: "chatpdf", ok: false, reason });
      if (!params.fallbackEnabled) {
        throw new Error(`Provider failure (chatpdf): ${reason}`);
      }
      return createDeterministicResult(params.chunks, params.courseName, requested, attempts, reason);
    }
  }

  if (!params.fallbackEnabled) {
    throw new Error("Provider misconfigured: no providers configured");
  }

  return createDeterministicResult(params.chunks, params.courseName, requested, attempts, "no_provider_configured");
}

// ---------------------------------------------------------------------------
// Multi-material summarisation — ONE LLM call that returns a separate summary
// block per PDF/PPT document.
// ---------------------------------------------------------------------------

const MAX_CHARS_PER_DOC = 5_000; // chars of raw text sent per document

function buildMultiMaterialPrompt(parsedPdfs: ParsedPdf[], courseName: string): string {
  const docBlocks = parsedPdfs
    .map((pdf, i) => {
      const truncated = pdf.text.replace(/\s+/g, " ").trim().slice(0, MAX_CHARS_PER_DOC);
      return `[[Document ${i + 1} | resourceId: "${pdf.resourceId}" | Title: "${pdf.sourceTitle}"]]\n${truncated}`;
    })
    .join("\n\n---\n\n");

  const expectedList = parsedPdfs
    .map((pdf) => `  - resourceId: "${pdf.resourceId}", title: "${pdf.sourceTitle}"`)
    .join("\n");

  return [
    "You are preparing pre-lecture briefs for a university student.",
    `Course: ${courseName}`,
    `You will receive content from ${parsedPdfs.length} document(s).`,
    "Produce a SEPARATE structured summary for EACH document.",
    "",
    "Return JSON ONLY. No markdown fences or extra text. Use this exact schema:",
    "{",
    '  "materials": [',
    "    {",
    '      "resourceId": "<exact resourceId from the document header>",',
    '      "title": "<exact title from the document header>",',
    '      "layer1KeyConcepts": string[],',
    '      "layer2StructuredExplanation": [{ "heading": string, "points": string[] }],',
    '      "layer3DetailedNotes": string[],',
    '      "preparationTips": string[],',
    '      "keyEquationsOrDefinitions": string[]',
    "    }",
    "  ]",
    "}",
    "",
    "Expected entries in the materials array (one per document):",
    expectedList,
    "",
    "Constraints:",
    "- One materials entry per document — do NOT merge documents together.",
    "- Use the exact resourceId string from each document header.",
    "- Deterministic academic tone; concise and factual.",
    "- Keep each bullet self-contained and specific to the document it belongs to.",
    "- Never invent content outside the provided context.",
    "",
    "Documents:",
    docBlocks,
  ].join("\n");
}

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
      return {
        items,
        schemaValidationTrace: {
          attempts: attempt,
          repairedAttempts,
          providerPayloadErrors: payloadErrors,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      payloadErrors.push(`${provider.name}: ${message}`);
      if (attempt < maxAttempts) {
        repairedAttempts += 1;
        currentPrompt = [
          prompt,
          "",
          "Your previous output failed schema validation.",
          `Validation error: ${message}`,
          'Return corrected JSON only. The root object MUST have a "materials" array with one entry per document.',
        ].join("\n");
      }
    }
  }

  throw new Error(
    `multi_material_schema_failed:${provider.name}:${payloadErrors[payloadErrors.length - 1] ?? "unknown"}`,
  );
}

export async function summarizeMultiMaterialWithProviderRouter(params: {
  parsedPdfs: ParsedPdf[];
  courseName: string;
  provider: SummaryProviderMode;
  fallbackEnabled: boolean;
  chunks: TextChunk[]; // used only when falling back to deterministic / single-summary mode
  providers?: { gemini?: LlmProvider; chatpdf?: LlmProvider };
}): Promise<{
  materialSummaries: PerMaterialSummaryItem[];
  mergedSummary: SummaryOutput;
  providerTrace: ProviderTrace;
  schemaValidationTrace: SchemaValidationTrace;
}> {
  const gemini = params.providers?.gemini ?? new GeminiProvider();
  const chatpdf = params.providers?.chatpdf ?? new ChatPdfProvider();
  const geminiConfigured = gemini.isConfigured();
  const chatpdfConfigured = chatpdf.isConfigured();
  logProvidersConfigured(geminiConfigured, chatpdfConfigured);

  // Build URL lookup map so parseMultiMaterialFromText can attach URLs.
  const urlByResourceId = new Map(params.parsedPdfs.map((pdf) => [pdf.resourceId, pdf.sourceUrl]));

  // Deterministic shortcut — no LLM involved.
  if (params.provider === "deterministic") {
    const fallbackSingle = createDeterministicResult(params.chunks, params.courseName, params.provider);
    // Wrap each PDF as its own "material" using the deterministic summary for all.
    const items: PerMaterialSummaryItem[] = params.parsedPdfs.map((pdf) => ({
      resourceId: pdf.resourceId,
      title: pdf.sourceTitle,
      url: pdf.sourceUrl,
      summary: fallbackSingle.summary,
    }));
    return {
      materialSummaries: items,
      mergedSummary: fallbackSingle.summary,
      providerTrace: fallbackSingle.providerTrace,
      schemaValidationTrace: fallbackSingle.schemaValidationTrace,
    };
  }

  const prompt = buildMultiMaterialPrompt(params.parsedPdfs, params.courseName);
  const attempts: ProviderTrace["attempts"] = [];

  // Choose which LLM provider to try first.
  const primaryProvider: LlmProvider | null =
    params.provider === "chatpdf"
      ? chatpdfConfigured
        ? chatpdf
        : null
      : geminiConfigured
        ? gemini
        : chatpdfConfigured
          ? chatpdf
          : null;

  if (primaryProvider) {
    try {
      const { items, schemaValidationTrace } = await runMultiMaterialWithValidation(
        primaryProvider,
        prompt,
        urlByResourceId,
      );
      attempts.push({ provider: primaryProvider.name, ok: true });
      const mergedSummary = composeMergedSummary(items);
      return {
        materialSummaries: items,
        mergedSummary,
        providerTrace: {
          requestedProvider: params.provider,
          finalProvider: primaryProvider.name,
          attempts,
        },
        schemaValidationTrace,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      attempts.push({ provider: primaryProvider.name, ok: false, reason });
      logWarn(`Multi-material summarisation failed (${primaryProvider.name}): ${reason}`);

      if (!params.fallbackEnabled) {
        throw new Error(`Provider failure (${primaryProvider.name}): ${reason}`);
      }
    }
  }

  // All LLM paths failed — fall back to deterministic single summary and
  // clone it across every material so the UI still has something to show.
  const det = createDeterministicResult(params.chunks, params.courseName, params.provider, attempts, "all_providers_failed");
  const items: PerMaterialSummaryItem[] = params.parsedPdfs.map((pdf) => ({
    resourceId: pdf.resourceId,
    title: pdf.sourceTitle,
    url: pdf.sourceUrl,
    summary: det.summary,
  }));
  return {
    materialSummaries: items,
    mergedSummary: det.summary,
    providerTrace: det.providerTrace,
    schemaValidationTrace: det.schemaValidationTrace,
  };
}

