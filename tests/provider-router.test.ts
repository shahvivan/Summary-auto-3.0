import assert from "node:assert/strict";
import test from "node:test";
import { summarizeWithProviderRouter } from "../src/core/ai/provider-router.js";
import type { TextChunk } from "../src/types/domain.js";

const chunks: TextChunk[] = [
  {
    chunkId: "c1",
    resourceId: "r1",
    sourceTitle: "Topic notes",
    order: 0,
    text: "A distribution is defined by parameters. The method calculates expected value and variance.",
  },
  {
    chunkId: "c2",
    resourceId: "r2",
    sourceTitle: "Worked examples",
    order: 1,
    text: "Application example: compute variance step by step and interpret business impact.",
  },
];

function validSummaryJson(): string {
  return JSON.stringify({
    overview: "This session covers key concepts in probability and statistics.",
    keyConcepts: ["Key concept A: definition A", "Key concept B: definition B"],
    topicSections: [
      {
        heading: "Conceptual Overview",
        points: ["Point 1", "Point 2"],
      },
    ],
    keyDefinitions: ["Definition 1: formal definition here"],
  });
}

test("provider router chooses Gemini when ChatPDF is disabled (missing sourceId)", async () => {
  let chatpdfCalled = false;

  const out = await summarizeWithProviderRouter({
    chunks,
    courseName: "Descriptive Statistics & Probability",
    provider: "auto",
    fallbackEnabled: true,
    providers: {
      gemini: {
        name: "gemini",
        isConfigured: () => true,
        generate: async () => validSummaryJson(),
      },
      chatpdf: {
        name: "chatpdf",
        isConfigured: () => false,
        generate: async () => {
          chatpdfCalled = true;
          throw new Error("chatpdf should not be called when disabled");
        },
      },
    },
  });

  assert.equal(out.providerTrace.finalProvider, "gemini");
  assert.equal(chatpdfCalled, false);
  assert.ok(out.summary.keyConcepts.length > 0);
});

test("provider router fails clearly when chatpdf is requested but misconfigured and fallback disabled", async () => {
  await assert.rejects(
    () =>
      summarizeWithProviderRouter({
        chunks,
        courseName: "Descriptive Statistics & Probability",
        provider: "chatpdf",
        fallbackEnabled: false,
        providers: {
          gemini: {
            name: "gemini",
            isConfigured: () => true,
            generate: async () => validSummaryJson(),
          },
          chatpdf: {
            name: "chatpdf",
            isConfigured: () => false,
            generate: async () => {
              throw new Error("chatpdf should not be called when disabled");
            },
          },
        },
      }),
    /Provider misconfigured: chatpdf is not configured/,
  );
});

test("provider router fails clearly when auto mode has no configured providers and fallback disabled", async () => {
  await assert.rejects(
    () =>
      summarizeWithProviderRouter({
        chunks,
        courseName: "Descriptive Statistics & Probability",
        provider: "auto",
        fallbackEnabled: false,
        providers: {
          gemini: {
            name: "gemini",
            isConfigured: () => false,
            generate: async () => validSummaryJson(),
          },
          chatpdf: {
            name: "chatpdf",
            isConfigured: () => false,
            generate: async () => validSummaryJson(),
          },
        },
      }),
    /Provider misconfigured: no providers configured/,
  );
});
