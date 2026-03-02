import { config } from "../../config.js";
import type {
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
import { validateSummaryText } from "./schema.js";

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

  return createDeterministicResult(params.chunks, params.courseName, requested, attempts, "no_provider_configured");
}
