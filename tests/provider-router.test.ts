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

test("provider router keeps offline workflows working when API keys are missing", async () => {
  const out = await summarizeWithProviderRouter({
    chunks,
    courseName: "Descriptive Statistics & Probability",
    provider: "auto",
    fallbackEnabled: true,
  });

  assert.equal(out.providerTrace.finalProvider, "deterministic");
  assert.ok(out.summary.layer1KeyConcepts.length > 0);
});
