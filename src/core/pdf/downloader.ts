import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../../config.js";

export interface DownloadedPdf {
  resourceId: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceType: "pdf" | "ppt";
  bytes: Buffer;
  plainText?: string;
}

function mockTextPathFromMaterialUrl(url: string): string {
  const noScheme = url.replace(/^mock:\/\//, "");
  const txtName = noScheme.replace(/\.(pdf|ppt|pptx)$/i, ".txt");
  return path.join(config.mockDir, "pdf-text", txtName);
}

export async function downloadPdf(params: {
  resourceId: string;
  title: string;
  url: string;
  type: "pdf" | "ppt";
}): Promise<DownloadedPdf> {
  if (params.url.startsWith("mock://")) {
    const file = mockTextPathFromMaterialUrl(params.url);
    const text = await fs.readFile(file, "utf8");
    return {
      resourceId: params.resourceId,
      sourceTitle: params.title,
      sourceUrl: params.url,
      sourceType: params.type,
      bytes: Buffer.from(text, "utf8"),
      plainText: text,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const response = await fetch(params.url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to download PDF (${response.status}): ${params.url}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return {
      resourceId: params.resourceId,
      sourceTitle: params.title,
      sourceUrl: params.url,
      sourceType: params.type,
      bytes: Buffer.from(arrayBuffer),
    };
  } finally {
    clearTimeout(timeout);
  }
}
