import path from "node:path";
import { config } from "../../config.js";
import type { MaterialLink, ParsedPdf, TextChunk } from "../../types/domain.js";
import { ensureDir, readJsonFile, writeJsonFile } from "../../utils/fs.js";
import { shaLike } from "../../utils/text.js";
import { chunkParsedPdfs } from "./chunker.js";
import { downloadPdf } from "./downloader.js";
import { extractPdfText } from "./parser.js";

interface PdfCacheEntry {
  sourceUrl: string;
  sourceTitle: string;
  text: string;
  contentHash: string;
  updatedAt: string;
}

function cacheFile(courseKey: string, resourceId: string): string {
  return path.join(config.cacheDir, courseKey, `${resourceId}.json`);
}

export async function processPdfLinks(params: {
  courseKey: string;
  materialLinks: MaterialLink[];
}): Promise<{
  parsedPdfs: ParsedPdf[];
  chunks: TextChunk[];
  materialRecords: Array<{
    resourceId: string;
    title: string;
    url: string;
    contentHash: string;
    extractedText: string;
  }>;
}> {
  const parsedPdfs: ParsedPdf[] = [];
  const materialRecords: Array<{
    resourceId: string;
    title: string;
    url: string;
    contentHash: string;
    extractedText: string;
  }> = [];

  for (const link of params.materialLinks) {
    const file = cacheFile(params.courseKey, link.id);
    const cached = await readJsonFile<PdfCacheEntry | null>(file, null);
    if (cached && cached.sourceUrl === link.url && cached.text.trim().length > 0) {
      parsedPdfs.push({
        resourceId: link.id,
        sourceTitle: link.title,
        sourceUrl: link.url,
        text: cached.text,
      });
      materialRecords.push({
        resourceId: link.id,
        title: link.title,
        url: link.url,
        contentHash: cached.contentHash,
        extractedText: cached.text,
      });
      continue;
    }

    const downloaded = await downloadPdf({
      resourceId: link.id,
      title: link.title,
      url: link.url,
      type: link.type,
    });
    const text = await extractPdfText(downloaded);
    const contentHash = shaLike(text);

    await ensureDir(path.dirname(file));
    await writeJsonFile(file, {
      sourceUrl: link.url,
      sourceTitle: link.title,
      text,
      contentHash,
      updatedAt: new Date().toISOString(),
    } satisfies PdfCacheEntry);

    parsedPdfs.push({
      resourceId: link.id,
      sourceTitle: link.title,
      sourceUrl: link.url,
      text,
    });
    materialRecords.push({
      resourceId: link.id,
      title: link.title,
      url: link.url,
      contentHash,
      extractedText: text,
    });
  }

  const chunks = chunkParsedPdfs(parsedPdfs, config.maxChunkChars);
  return { parsedPdfs, chunks, materialRecords };
}
