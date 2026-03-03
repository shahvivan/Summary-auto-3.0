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
  cookieHeader?: string;
  /**
   * Bytes pre-downloaded inside the Playwright context — keyed by URL.
   * When present for a given URL, the fetch step is skipped entirely.
   */
  preDownloadedFiles?: Record<string, Buffer>;
}): Promise<{
  parsedPdfs: ParsedPdf[];
  chunks: TextChunk[];
  skipReasons: string[];   // per-file failure details for diagnostics
  materialRecords: Array<{
    resourceId: string;
    title: string;
    url: string;
    contentHash: string;
    extractedText: string;
  }>;
}> {
  const parsedPdfs: ParsedPdf[] = [];
  const skipReasons: string[] = [];
  const materialRecords: Array<{
    resourceId: string;
    title: string;
    url: string;
    contentHash: string;
    extractedText: string;
  }> = [];

  const preKeys = Object.keys(params.preDownloadedFiles ?? {});
  console.log(`[pdf-pipeline] materialLinks=${params.materialLinks.length}, preDownloadedFiles=${preKeys.length}`);
  if (preKeys.length > 0) {
    console.log(`[pdf-pipeline] preDownloaded URLs:`, preKeys.map(k => k.slice(0, 100)));
  }

  for (const link of params.materialLinks) {
    console.log(`[pdf-pipeline] Processing "${link.title}" | url="${link.url.slice(0, 100)}"`);

    const file = cacheFile(params.courseKey, link.id);
    const cached = await readJsonFile<PdfCacheEntry | null>(file, null);
    if (cached && cached.sourceUrl === link.url && cached.text.trim().length > 0) {
      console.log(`[pdf-pipeline] Cache hit for "${link.title}" (${cached.text.length} chars)`);
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

    // 1. Try pre-downloaded bytes from Playwright context (most reliable)
    const preDownloaded = params.preDownloadedFiles?.[link.url];
    let downloadedBytes: Buffer | undefined;

    if (preDownloaded && preDownloaded.length > 0) {
      console.log(`[pdf-pipeline] Using pre-downloaded bytes for "${link.title}" (${(preDownloaded.length / 1024).toFixed(0)} KB)`);
      downloadedBytes = preDownloaded;
    } else {
      // Log why the pre-download key didn't match
      if (preKeys.length > 0) {
        console.warn(`[pdf-pipeline] Pre-download URL mismatch for "${link.title}"`);
        console.warn(`  link.url    = "${link.url}"`);
        console.warn(`  preKeys[0]  = "${preKeys[0]}"`);
      } else {
        console.warn(`[pdf-pipeline] No pre-downloaded files available — falling back to fetch()`);
      }

      // 2. Fallback: fetch with session cookies
      try {
        const dl = await downloadPdf({
          resourceId: link.id,
          title: link.title,
          url: link.url,
          type: link.type,
          cookies: params.cookieHeader,
        });
        downloadedBytes = dl.bytes;
        console.log(`[pdf-pipeline] Fetch fallback succeeded for "${link.title}" (${(downloadedBytes.length / 1024).toFixed(0)} KB)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[pdf-pipeline] Skipping "${link.title}" — download failed: ${msg}`);
        skipReasons.push(`"${link.title}": ${msg}`);
        continue;
      }
    }

    // 3. Extract text
    let text = "";
    try {
      text = await extractPdfText({
        resourceId: link.id,
        sourceTitle: link.title,
        sourceUrl: link.url,
        sourceType: link.type ?? "pdf",
        bytes: downloadedBytes,
      });
      console.log(`[pdf-pipeline] Extracted ${text.length} chars from "${link.title}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[pdf-pipeline] Text extraction failed for "${link.title}": ${msg} — using raw bytes path`);
    }

    const contentHash = shaLike(text || downloadedBytes.toString("base64").slice(0, 256));

    if (text.trim().length > 0) {
      await ensureDir(path.dirname(file));
      await writeJsonFile(file, {
        sourceUrl: link.url,
        sourceTitle: link.title,
        text,
        contentHash,
        updatedAt: new Date().toISOString(),
      } satisfies PdfCacheEntry);
    }

    parsedPdfs.push({
      resourceId: link.id,
      sourceTitle: link.title,
      sourceUrl: link.url,
      text,
      rawBytes: text.trim().length === 0 ? downloadedBytes : undefined,
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
  console.log(`[pdf-pipeline] Done: parsedPdfs=${parsedPdfs.length}, chunks=${chunks.length}, skipped=${skipReasons.length}`);
  return { parsedPdfs, chunks, skipReasons, materialRecords };
}
