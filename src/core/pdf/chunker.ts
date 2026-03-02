import type { ParsedPdf, TextChunk } from "../../types/domain.js";

function splitDeterministic(text: string, maxChars: number): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return [];
  }

  const words = cleaned.split(" ");
  const chunks: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current.length === 0 ? word : `${current} ${word}`;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }

    if (current.length > 0) {
      chunks.push(current);
    }
    current = word;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

export function chunkParsedPdfs(parsedPdfs: ParsedPdf[], maxChars: number): TextChunk[] {
  const out: TextChunk[] = [];
  let order = 0;

  for (const parsed of parsedPdfs) {
    const blocks = splitDeterministic(parsed.text, maxChars);
    for (const text of blocks) {
      out.push({
        chunkId: `${parsed.resourceId}-${order}`,
        resourceId: parsed.resourceId,
        sourceTitle: parsed.sourceTitle,
        order,
        text,
      });
      order += 1;
    }
  }

  return out;
}
