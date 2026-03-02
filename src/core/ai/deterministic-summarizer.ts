import type { SummaryOutput, TextChunk } from "../../types/domain.js";

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((value) => value.trim())
    .filter((value) => value.length >= 24);
}

function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function clip(input: string, max = 220): string {
  if (input.length <= max) {
    return input;
  }
  return `${input.slice(0, max - 3).trim()}...`;
}

function pickSentences(sentences: string[], keywords: string[], count: number): string[] {
  const matched = sentences.filter((sentence) => {
    const lower = sentence.toLowerCase();
    return keywords.some((keyword) => lower.includes(keyword));
  });

  if (matched.length >= count) {
    return matched.slice(0, count);
  }

  return unique([...matched, ...sentences]).slice(0, count);
}

export function generateDeterministicSummary(chunks: TextChunk[], courseName: string): SummaryOutput {
  const combined = chunks.map((chunk) => chunk.text).join("\n");
  const sentences = splitSentences(combined);

  const layer1 = unique(sentences.map((sentence) => clip(sentence, 140))).slice(0, 5);

  const conceptPoints = pickSentences(
    sentences,
    ["definition", "concept", "variable", "model", "distribution", "theorem"],
    4,
  ).map((value) => clip(value));

  const methodPoints = pickSentences(
    sentences,
    ["calculate", "method", "step", "formula", "algorithm", "compute"],
    4,
  ).map((value) => clip(value));

  const interpretationPoints = pickSentences(
    sentences,
    ["interpret", "application", "example", "context", "business", "decision"],
    4,
  ).map((value) => clip(value));

  const layer3 = chunks.slice(0, 12).map((chunk) => `${chunk.sourceTitle}: ${clip(chunk.text, 240)}`);

  const prepTips = [
    `Read Layer 1 and restate each concept in your own words for ${courseName}.`,
    "Solve one worked example before class and verify each step.",
    "Prepare one clarification question for the lecture.",
  ];

  const definitions = sentences
    .filter((sentence) => /\b(is|defined as|equals|=)\b/i.test(sentence))
    .slice(0, 5)
    .map((sentence) => clip(sentence));

  return {
    layer1KeyConcepts: layer1,
    layer2StructuredExplanation: [
      { heading: "Conceptual Overview", points: conceptPoints },
      { heading: "Methods and Procedures", points: methodPoints },
      { heading: "Interpretation and Application", points: interpretationPoints },
    ],
    layer3DetailedNotes: layer3,
    preparationTips: prepTips,
    keyEquationsOrDefinitions: definitions,
  };
}
