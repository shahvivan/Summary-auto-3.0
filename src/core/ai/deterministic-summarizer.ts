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

  // Overview: first 2-3 meaningful sentences
  const overviewSentences = sentences.slice(0, 3).map((s) => clip(s, 200));
  const overview =
    overviewSentences.join(" ") ||
    `This session covers key material for ${courseName}. Review the attached slides before class.`;

  // Key concepts: terms and definitions
  const keyConcepts = unique(
    pickSentences(sentences, ["definition", "concept", "term", "defined as", "refers to", "is the", "is a"], 6).map(
      (s) => clip(s, 180),
    ),
  );

  // Topic sections: grouped by content type
  const conceptPoints = pickSentences(
    sentences,
    ["concept", "variable", "model", "distribution", "theorem", "principle"],
    4,
  ).map((value) => clip(value));

  const methodPoints = pickSentences(
    sentences,
    ["calculate", "method", "step", "formula", "algorithm", "compute", "approach"],
    4,
  ).map((value) => clip(value));

  const applicationPoints = pickSentences(
    sentences,
    ["interpret", "application", "example", "context", "business", "decision", "result"],
    4,
  ).map((value) => clip(value));

  const topicSections = [
    { heading: "Core Concepts", points: conceptPoints.length > 0 ? conceptPoints : sentences.slice(0, 3).map((s) => clip(s)) },
    { heading: "Methods and Procedures", points: methodPoints.length > 0 ? methodPoints : sentences.slice(3, 6).map((s) => clip(s)) },
    { heading: "Applications and Examples", points: applicationPoints.length > 0 ? applicationPoints : sentences.slice(6, 9).map((s) => clip(s)) },
  ].filter((section) => section.points.length > 0);

  // Key definitions: sentences with equations or formal definitions
  const keyDefinitions = sentences
    .filter((sentence) => /\b(is|defined as|equals|=|formula|equation|≡|∝|∑|∫)\b/i.test(sentence))
    .slice(0, 5)
    .map((sentence) => clip(sentence));

  return {
    overview,
    keyConcepts: keyConcepts.length > 0 ? keyConcepts : [`${courseName}: Review the attached materials before class.`],
    topicSections: topicSections.length > 0 ? topicSections : [{ heading: "Session Content", points: sentences.slice(0, 4).map((s) => clip(s)) }],
    keyDefinitions,
  };
}
